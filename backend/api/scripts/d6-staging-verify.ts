/**
 * D6 acceptance against the **real** providers (Retell dev workspace, Stripe test mode),
 * over HTTP, with SSE — ADR 0013 "the real run".
 *
 *   ngrok http 4000 --domain=<the host in API_PUBLIC_URL>          (terminal 1)
 *   stripe listen --forward-to localhost:4000/webhooks/stripe        (terminal 2, optional)
 *   pnpm --filter @portal/api verify:d6                              (terminal 3)
 *
 * It runs from a `tsc` build (`tsconfig.scripts.json`), not through `tsx`: esbuild emits no
 * decorator metadata, so a Nest DI graph booted under tsx resolves constructor parameters
 * to `undefined`. The other scripts instantiate services by hand and never noticed.
 *
 * What it does, in the order W4 → W6 → W7 → §13.8 prescribe:
 *
 *   1. boots the real AppModule graph on :4000 with the BullMQ workers in-process, Auth0
 *      replaced by the test double (a JWKS on localhost) so a token can be minted — the
 *      only substitution; Retell, Stripe, Postgres and Redis are real;
 *   2. workspace + owner, a paid Growth purchase and its credits (Stripe Checkout itself is
 *      D3's verified path; this run starts after it), a Stripe test customer with a saved
 *      card so auto top-up can be exercised;
 *   3. agent from the receptionist template, brief, a prompt written onto the draft (no LLM
 *      round trip — generation is D5's verified path), a text knowledge source → real KB;
 *   4. W6 plan: Option A, a US number ($2/month on the Retell bill — released at the end
 *      unless --keep);
 *   5. POST /agents/:id/activate → activation:{id} frames → LIVE;
 *   6. a real phone call from the D2 spike number (+16204459730, bound to the spike agent)
 *      to the new number: the inbound webhook authorises it, the agent answers, call_ended
 *      bills the workspace; the run waits for the `calls` row and the ledger debit;
 *   7. auto top-up: threshold above the balance → off-session PaymentIntent on the saved
 *      test card → `payment_intent.succeeded` (via `stripe listen`) → credits;
 *   8. teardown: release the number (DELETE /numbers/:id), delete the KB and the agent's
 *      platform objects; the workspace stays (ledger history).
 *
 * Every provider id and the activation progression are written to
 * `backend/api/.d6-verify.json` (gitignored) — never a secret.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { adminDb, assertRlsEnforced, disconnect } from '@portal/db';
import Stripe from 'stripe';
import { AppModule } from '../src/app.module';
import { SchedulerRegistrar, WorkerRuntime } from '../src/modules/jobs';
import { applyGuardrails } from '../src/modules/prompting';
import { RetellGateway } from '../src/modules/retell';
import { registerWebhookRawBody } from '../src/modules/webhooks';
import { WalletService } from '../src/modules/wallet';
import { FakeAuth0Tenant } from '../test/auth0-double';

/** Relative to the package, not to this file: the compiled copy runs from dist-scripts/. */
const PACKAGE_ROOT = process.cwd();
const OUT = resolve(PACKAGE_ROOT, '.d6-verify.json');
const PORT = Number(process.env.API_PORT ?? 4000);
const KEEP = process.argv.includes('--keep');
const SKIP_CALL = process.argv.includes('--no-call');
/** The D2 spike number, still bound to the spike agent; it places the test call. */
const CALLER_NUMBER = process.env.D6_CALLER_NUMBER ?? '+16204459730';
/**
 * The spike number has no *outbound* agent bound (`400 No outbound agent id set up for phone
 * number`, first real run), so the call names the agent that speaks on the caller leg: the
 * D2 spike receptionist, whose id `spike:retell` left in `.retell-spike.json`.
 */
const SPIKE_STATE = resolve(PACKAGE_ROOT, '.retell-spike.json');
const CALLER_AGENT_ID = process.env.D6_CALLER_AGENT_ID ?? (existsSync(SPIKE_STATE) ? (JSON.parse(readFileSync(SPIKE_STATE, 'utf8')) as { agent_id?: string }).agent_id : undefined);

const log = new Logger('d6-verify');
const report: Record<string, unknown> = { started_at: new Date().toISOString() };

function note(key: string, value: unknown): void {
  report[key] = value;
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log.log(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  if (!process.env.API_PUBLIC_URL || /localhost|127\.0\.0\.1/.test(process.env.API_PUBLIC_URL)) {
    throw new Error('API_PUBLIC_URL must be the tunnel hostname Retell can reach (docs/runbooks/provisioning.md §5).');
  }
  process.env.GENERATION_PROVIDER ||= 'scripted';
  process.env.SIP_CREDENTIALS_LOCAL_KEY ||= randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

  // ---- 1. the real app, Auth0 doubled
  const customerTenant = new FakeAuth0Tenant('customers', 'https://api.test');
  const staffTenant = new FakeAuth0Tenant('staff', 'https://admin-api.test');
  await customerTenant.start();
  await staffTenant.start();
  process.env.AUTH0_CUSTOMER_DOMAIN = customerTenant.domain;
  process.env.AUTH0_CUSTOMER_AUDIENCE = customerTenant.audience;
  process.env.AUTH0_STAFF_DOMAIN = staffTenant.domain;
  process.env.AUTH0_STAFF_AUDIENCE = staffTenant.audience;

  await assertRlsEnforced();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger: false }), { logger: ['log', 'warn', 'error'] });
  registerWebhookRawBody(app);
  await app.listen(PORT, '0.0.0.0');
  await app.get(SchedulerRegistrar).register();
  await app.get(WorkerRuntime).start();
  const base = `http://127.0.0.1:${PORT}`;
  const retell = app.get(RetellGateway);
  const wallet = app.get(WalletService);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { typescript: true });
  note('api', { base, public_url: process.env.API_PUBLIC_URL });

  const tunnelOk = await fetch(`${process.env.API_PUBLIC_URL}/health`).then((r) => r.ok).catch(() => false);
  note('tunnel_reaches_api', tunnelOk);
  if (!tunnelOk) throw new Error(`${process.env.API_PUBLIC_URL}/health is not reachable — is ngrok up on :${PORT}?`);

  // ---- 2. workspace, owner, paid purchase, Stripe customer with a saved test card
  const run = randomUUID().slice(0, 8);
  const sub = `auth0|d6-verify-${run}`;
  const user = await adminDb.user.create({ data: { authProviderId: sub, email: `d6-verify-${run}@example.test`, name: 'D6 verify' } });
  const customer = await stripe.customers.create({ email: user.email, name: `D6 verify ${run}`, metadata: { run, purpose: 'd6-verify' } });
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });

  const tenant = await adminDb.tenant.create({
    data: {
      name: `D6 verify ${run}`,
      country: 'US',
      timezone: 'America/Toronto',
      planTier: 'growth',
      concurrencyCap: 3,
      kbAllowance: 1,
      stripeCustomerId: customer.id,
      autoTopupJson: { enabled: false, pack_id: 'growth', threshold: null, payment_method_id: pm.id, card_last4: pm.card?.last4 ?? null },
    },
  });
  await adminDb.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'owner' } });
  const purchase = await adminDb.purchase.create({
    data: { tenantId: tenant.id, packId: 'growth', amountCents: 14_900, currency: 'USD', credits: 500, status: 'paid', stripeSessionId: `cs_test_d6verify_${run}` },
  });
  await wallet.grant(tenant.id, { credits: 500, reason: 'purchase', expiresAt: new Date(Date.now() + 365 * 86_400_000), purchaseId: purchase.id, refType: 'purchase', refId: purchase.id });
  note('workspace', { id: tenant.id, user_id: user.id, stripe_customer: customer.id, payment_method: pm.id, balance: await wallet.balance(tenant.id) });

  const token = await customerTenant.mint(sub, { email: user.email, name: 'D6 verify' });
  const headers = { authorization: `Bearer ${token}`, 'x-workspace-id': tenant.id };
  const call = async (method: string, path: string, body?: unknown) => {
    // No content-type on a bodiless request: Fastify answers 400 to `application/json` with an empty body.
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { raw: text };
    }
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return { status: res.status, body: json };
  };

  // Whatever exists when the run stops — a number, a KB, an agent — is released in `finally`
  // unless --keep, so a failed run cannot leave a $2/month number behind.
  const created: { agentId?: string; sourceId?: string; numberId?: string; kbId?: string | null } = {};
  let controller: AbortController | undefined;
  let pump: Promise<void> | undefined;
  try {
  // ---- 3. agent, brief, prompt, knowledge
  const agent = await call('POST', '/agents', { template_id: 'receptionist', industry: 'dental', name: `d6-verify-${run}` });
  const agentId = agent.body.id as string;
  created.agentId = agentId;
  await call('PATCH', `/agents/${agentId}/draft`, {
    brief: {
      about_business: 'Maple Dental, a family dental clinic in Laval with two dentists and one hygienist.',
      goal: 'Answer calls, share opening hours, and take detailed messages for the team.',
      services: ['Check-ups', 'Cleanings', 'Whitening'],
      agent_name: 'Sophie',
    },
    voice_id: '11labs-Adrian',
  });
  await adminDb.agentVersion.update({
    where: { agentId_versionNo: { agentId, versionNo: 1 } },
    data: {
      promptText: applyGuardrails(
        [
          '## Identity',
          'You are Sophie, the friendly receptionist for Maple Dental, a family dental clinic in Laval.',
          '',
          '## Goal',
          'Answer calls, share opening hours (Monday to Friday, 9am to 5pm), and take detailed messages including the caller name and callback number.',
          '',
          '## Style',
          'Warm, concise, professional. Confirm details back to the caller. Never give medical advice.',
          '',
          '## Knowledge',
          'Use what you know about the clinic to answer questions about parking, hours and services.',
        ].join('\n'),
      ),
      greeting: 'Thanks for calling Maple Dental, this is Sophie. How can I help you today?',
    },
  });
  note('agent', { id: agentId });

  const knowledge = await call('POST', `/agents/${agentId}/knowledge`, {
    type: 'text',
    name: 'Parking and hours',
    text: 'Maple Dental is open Monday to Friday from 9am to 5pm. Free parking is available behind the building. We accept new patients.',
  });
  const sourceId = knowledge.body.id as string;
  created.sourceId = sourceId;
  const source = await waitFor('knowledge source ready', async () => {
    const row = await adminDb.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
    return row.status === 'ready' || row.status === 'failed' ? row : null;
  }, 180_000);
  if (source.status !== 'ready') throw new Error(`knowledge source failed: ${source.error} ${JSON.stringify(source.syncJson)}`);
  const agentRow = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
  created.kbId = agentRow.retellKbId;
  note('knowledge', { source_id: sourceId, retell_source_id: source.retellSourceId, retell_kb_id: agentRow.retellKbId, sync: source.syncJson });

  // ---- 4. W6 plan: Option A, a US number
  const plan = await call('PUT', `/agents/${agentId}/phone-plan`, { option: 'new', country: 'US', hours_mode: 'always', nickname: `d6-verify-${run}` });
  note('phone_plan', plan.body);

  // ---- 5. activation, watched on SSE
  const frames: Array<{ topic: string; type: string; data: Record<string, unknown>; ts: string }> = [];
  controller = new AbortController();
  const stream = await fetch(`${base}/events`, { headers: { authorization: headers.authorization, 'x-workspace-id': tenant.id, accept: 'text/event-stream' }, signal: controller.signal });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) frames.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {
      /* aborted */
    }
  })();

  const accepted = await call('POST', `/agents/${agentId}/activate`, {});
  const activationId = accepted.body.job_id as string;
  note('activation_started', { job_id: activationId });
  const final = await waitFor('activation live or failed', async () => frames.find((f) => f.topic === `activation:${activationId}` && (f.type === 'live' || f.type === 'failed')) ?? null, 180_000);
  const progression = frames.filter((f) => f.topic === `activation:${activationId}`).map((f) => ({ ts: f.ts, type: f.type, status: f.data.status, step: f.data.step, progress: f.data.progress }));
  note('activation_progression', progression);
  const job = await adminDb.job.findUniqueOrThrow({ where: { id: activationId } });
  note('activation_job', { status: job.status, steps: job.stepsJson });
  const numberRow = await adminDb.phoneNumber.findFirst({ where: { agentId } });
  created.numberId = numberRow?.id;
  if (final.type !== 'live') throw new Error(`activation failed: ${JSON.stringify(final.data)}`);

  const number = numberRow!;
  const liveAgent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
  const platformNumber = await retell.getPhoneNumber(number.e164!);
  note('live', {
    agent_status: liveAgent.status,
    published_version: liveAgent.publishedVersion,
    retell_agent_id: liveAgent.retellAgentId,
    number_id: number.id,
    e164: number.e164,
    number_status: number.status,
    platform_binding: platformNumber.inbound_agents,
    platform_inbound_webhook: platformNumber.inbound_webhook_url,
    view: (await call('GET', `/agents/${agentId}/activation`)).body,
  });

  // ---- 6. a real call: the spike number dials the new number
  if (!SKIP_CALL) {
    if (!CALLER_AGENT_ID) throw new Error('no caller agent: set D6_CALLER_AGENT_ID or keep backend/api/.retell-spike.json');
    const placed = await retell.createPhoneCall({ fromNumber: CALLER_NUMBER, toNumber: number.e164!, agentId: CALLER_AGENT_ID, metadata: { purpose: 'd6-verify', run, caller_leg: true } });
    note('test_call_placed', { call_id: placed.call_id, from: CALLER_NUMBER, to: number.e164 });
    const inboundRow = await waitFor('the inbound calls row on the new number', async () => adminDb.call.findFirst({ where: { tenantId: tenant.id, numberId: number.id } }), 120_000);
    note('inbound_call_registered', { call_id: inboundRow.id, status: inboundRow.status, agent_version: inboundRow.agentVersion, rate: inboundRow.rate });
    // Let it talk for a bit, then hang up from the caller side by deleting nothing — Retell's
    // caller agent has its own max duration; we wait for call_ended on our side.
    const ended = await waitFor('call_ended on the new number', async () => {
      const row = await adminDb.call.findUniqueOrThrow({ where: { id: inboundRow.id } });
      return row.status === 'ended' || row.status === 'analyzed' ? row : null;
    }, 240_000);
    const debit = await adminDb.creditLedger.findFirst({ where: { tenantId: tenant.id, reason: 'call', refId: ended.id } });
    note('inbound_call_billed', { call_id: ended.id, status: ended.status, duration_s: ended.durationS, credits_charged: ended.creditsCharged, ledger_delta: debit?.delta ?? null, balance: await wallet.balance(tenant.id) });
  }

  // ---- 7. auto top-up against the saved test card
  const enabled = await call('PUT', '/wallet/auto-topup', { enabled: true, pack_id: 'growth', threshold: 10_000 });
  note('auto_topup_enabled', enabled.body);
  await wallet.debit(tenant.id, { credits: 1, reason: 'adjustment', refType: 'd6-verify', refId: run });
  const pending = await waitFor('the auto top-up purchase', async () => adminDb.purchase.findFirst({ where: { tenantId: tenant.id, isAutoTopup: true } }), 60_000);
  note('auto_topup_purchase', { purchase_id: pending.id, status: pending.status, payment_intent: pending.stripePaymentIntent });
  const settled = await waitFor('the top-up to settle (needs `stripe listen`)', async () => {
    const row = await adminDb.purchase.findUniqueOrThrow({ where: { id: pending.id } });
    return row.status !== 'pending' ? row : null;
  }, 90_000).catch(() => null);
  if (settled) {
    note('auto_topup_settled', { status: settled.status, failure_reason: settled.failureReason, balance: await wallet.balance(tenant.id), topup_rows: await adminDb.creditLedger.count({ where: { tenantId: tenant.id, reason: 'topup' } }) });
  } else {
    note('auto_topup_settled', 'pending — no payment_intent.succeeded arrived (is `stripe listen` running?); the auto-topup schedule reconciles it within 15 min');
  }
  const invoices = await adminDb.invoice.findMany({ where: { tenantId: tenant.id } });
  note('invoices', invoices.map((i) => ({ id: i.stripeInvoiceId, status: i.status, amount: i.amountCents })));
  await call('PUT', '/wallet/auto-topup', { enabled: false });

  note('finished_at', new Date().toISOString());
  } finally {
    // ---- 8. teardown, on success and on failure alike
    controller?.abort();
    await pump;
    if (KEEP) {
      note('teardown', 'kept (--keep): release the number and delete the agent by hand');
    } else {
      if (created.numberId) {
        const released = await call('DELETE', `/numbers/${created.numberId}`).catch((e: unknown) => ({ body: { error: String(e) } }));
        note('teardown_number', released.body);
      }
      if (created.sourceId) {
        await call('DELETE', `/knowledge/${created.sourceId}`).catch(() => null);
        await waitFor('knowledge deleted', async () => ((await adminDb.knowledgeSource.findUnique({ where: { id: created.sourceId! } })) ? null : true), 60_000).catch(() => null);
      }
      if (created.kbId) await retell.deleteKnowledgeBase(created.kbId).catch((e: unknown) => log.warn(`kb delete: ${String(e)}`));
      if (created.agentId) {
        const removed = await call('DELETE', `/agents/${created.agentId}`).catch((e: unknown) => ({ body: { error: String(e) } }));
        note('teardown_agent', removed.body);
      }
    }
  }

  await app.close();
  await customerTenant.stop();
  await staffTenant.stop();
  await disconnect();
  log.log(`report written to ${OUT}`);
}

async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

main().catch(async (error: unknown) => {
  note('error', error instanceof Error ? error.message : String(error));
  await disconnect().catch(() => undefined);
  process.exit(1);
});
