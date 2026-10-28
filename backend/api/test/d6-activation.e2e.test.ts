import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Retell from 'retell-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripeGateway } from '../src/modules/billing';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { type CapturingAlerts, type FakeRetellGateway, startD5Harness, waitFor, waitForJob } from './d5-fixtures';
import { authFor, caller, paidWorkspace, publishedAgent, waitForNumber } from './d6-fixtures';

/*
 * §13.8 activation (D6), the exit check of the day:
 *
 *   paid workspace → published agent → W6 plan → POST /activate → 202
 *     → publish → provision → bind → mark_live → notify
 *     → SSE activation:{id} frames → agent live, number active, plan executed
 *
 * Then the parts that only matter when something goes wrong: a retryable platform
 * failure converging on one purchase, three failures ending FAILED with an alert, a
 * permanent failure ending on the first attempt, and duplicate requests joining one job.
 */

let app: NestFastifyApplication;
let retell: FakeRetellGateway;
let alerts: CapturingAlerts;
let stop: () => Promise<void>;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;
let baseUrl = '';

beforeAll(async () => {
  const harness = await startD5Harness({ listen: true, workers: true });
  app = harness.app;
  retell = harness.retell;
  alerts = harness.alerts;
  stop = harness.stop;
  auth = authFor(harness.customerTenant);
  call = caller(app);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

async function openStream(headers: Record<string, string>, topics?: string) {
  const controller = new AbortController();
  const frames: Array<{ topic: string; type: string; data: Record<string, unknown> }> = [];
  const response = await fetch(`${baseUrl}/events${topics ? `?topics=${encodeURIComponent(topics)}` : ''}`, { headers: { ...headers, accept: 'text/event-stream' }, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`SSE open failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
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
  return {
    frames,
    waitForType: (type: string, timeoutMs = 20_000) => waitFor(`SSE ${type}`, async () => frames.find((f) => f.type === type) ?? null, timeoutMs),
    close: async () => {
      controller.abort();
      await pump;
    },
  };
}

describe('the activation workflow', () => {
  it('goes publish → provision → bind → mark_live → notify and the customer watches it on activation:{id}', async () => {
    const ws = await paidWorkspace(app, 'act', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    // Published once already (that is what W5's test call needs); activation republishes idempotently.
    const agentId = await publishedAgent(call, headers);
    expect((await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA', area_code: '450' })).status).toBe(200);
    const stream = await openStream(headers);

    try {
      const accepted = await call('POST', `/agents/${agentId}/activate`, headers, {});
      expect(accepted.status).toBe(202);
      const jobId = accepted.body.job_id as string;

      // A second click while it runs joins the same job.
      expect((await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id).toBe(jobId);

      const started = await stream.waitForType('started');
      expect(started.topic).toBe(`activation:${jobId}`);
      const live = await stream.waitForType('live');
      expect(live.data).toMatchObject({ activation_id: jobId, agent_id: agentId, status: 'live', progress: 100, error: null });
      expect(live.data.e164).toMatch(/^\+1450\d{7}$/);

      const statuses = stream.frames.filter((f) => f.topic === `activation:${jobId}`).map((f) => f.data.status);
      // In order, and never `live` before binding finished.
      expect(statuses.indexOf('publishing')).toBeLessThan(statuses.indexOf('provisioning'));
      expect(statuses.indexOf('provisioning')).toBeLessThan(statuses.indexOf('binding'));
      expect(statuses.indexOf('binding')).toBeLessThan(statuses.indexOf('marking_live'));
      expect(statuses.at(-1)).toBe('live');
      for (const frame of stream.frames) expect(JSON.stringify(frame)).not.toMatch(/retell|tok_|last_error|requested_by/i);

      const job = await waitForJob(jobId);
      expect(job.status).toBe('succeeded');
      const steps = job.stepsJson as { activation_status: string; steps: Record<string, { status: string }> };
      expect(steps.activation_status).toBe('live');
      expect(Object.fromEntries(Object.entries(steps.steps).map(([k, v]) => [k, v.status]))).toEqual({ publish: 'completed', provision: 'completed', bind: 'completed', mark_live: 'completed', notify: 'completed' });

      // One authoritative state in Postgres, and the hot path agrees.
      const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
      expect(agent.status).toBe('live');
      const number = await adminDb.phoneNumber.findFirstOrThrow({ where: { agentId } });
      expect(number.status).toBe('active');
      expect(number.e164).toBe(live.data.e164);
      expect((await adminDb.phonePlan.findFirstOrThrow({ where: { agentId } })).status).toBe('executed');
      expect((await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } })).onboardingCompletedAt).toBeTruthy();
      expect(await app.get(RedisCache).getJson<{ agent_live: boolean; number_active: boolean }>(redisKeys.number(number.e164!))).toMatchObject({ agent_live: true, number_active: true });
      const platform = retell.phoneNumbers.get(number.e164!)!;
      expect(platform.inbound_agents[0]).toMatchObject({ agent_id: agent.retellAgentId, agent_version: 'latest_published' });

      // The polling fallbacks say the same thing, in the whitelisted shape.
      const view = await call('GET', `/agents/${agentId}/activation`, headers);
      expect(view.body).toMatchObject({ activation_id: jobId, status: 'live', progress: 100, number_id: number.id, e164: number.e164 });
      const poll = await call('GET', `/jobs/${jobId}`, headers);
      expect(poll.body.progress).toMatchObject({ activation_status: 'live', e164: number.e164, number_id: number.id });

      // A second activation later (a republish) skips the number steps and stays live.
      const again = await call('POST', `/agents/${agentId}/activate`, headers, {});
      const againJob = await waitForJob(again.body.job_id as string);
      expect(againJob.status).toBe('succeeded');
      const againSteps = againJob.stepsJson as { steps: Record<string, { status: string }> };
      expect(againSteps.steps.provision?.status).toBe('skipped');
      expect(againSteps.steps.bind?.status).toBe('skipped');
      expect(await adminDb.phoneNumber.count({ where: { agentId } })).toBe(1);
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('refuses an agent that was never generated with AGENT_NOT_GENERATED and queues nothing (QA-021)', async () => {
    const ws = await paidWorkspace(app, 'act-ungenerated', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const created = await call('POST', '/agents', headers, { template_id: 'receptionist', industry: 'dental' });
    const agentId = created.body.id as string;
    const res = await call('POST', `/agents/${agentId}/activate`, headers, {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AGENT_NOT_GENERATED');
    expect(await adminDb.job.count({ where: { tenantId: ws.workspaceId, type: 'activate-agent' } })).toBe(0);
  });

  it('a workspace cannot activate or watch another workspace\'s agent', async () => {
    const owner = await paidWorkspace(app, 'act-owner', 'growth');
    const agentId = await publishedAgent(call, await auth(owner.sub, owner.workspaceId));
    const other = await paidWorkspace(app, 'act-other', 'growth');
    const otherAuth = await auth(other.sub, other.workspaceId);
    expect((await call('POST', `/agents/${agentId}/activate`, otherAuth, {})).status).toBe(404);
    expect((await call('GET', `/agents/${agentId}/activation`, otherAuth)).status).toBe(404);
  });
});

describe('retries and failure', () => {
  it('a platform outage during provision is retried and ends live with exactly one number bought', async () => {
    const ws = await paidWorkspace(app, 'act-retry', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'US' });
    const before = retell.countOf('createPhoneNumber');
    retell.failNext('createPhoneNumber', 2, new Error('retell is having a moment'));

    const jobId = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
    const job = await waitForJob(jobId, 30_000);
    expect(job.status).toBe('succeeded');
    const steps = job.stepsJson as { attempt: number; steps: Record<string, { status: string }> };
    expect(steps.attempt).toBe(3);
    expect(steps.steps.publish!.status).toBe('completed'); // done on attempt 1, never redone
    expect(retell.countOf('createPhoneNumber') - before).toBe(3); // two failures, one purchase
    expect(retell.countOf('publishAgent')).toBeGreaterThan(0);
    expect(await adminDb.phoneNumber.count({ where: { agentId } })).toBe(1);
    expect((await adminDb.phoneNumber.findFirstOrThrow({ where: { agentId } })).status).toBe('active');
    expect(alerts.alerts.filter((a) => a.kind === 'activation_failed' && a.fields.agent_id === agentId)).toHaveLength(0);
  }, 60_000);

  it('a crash between buying and binding does not buy again: the retry adopts the platform number by nickname', async () => {
    const ws = await paidWorkspace(app, 'act-adopt', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA' });
    const before = retell.countOf('createPhoneNumber');
    // Bind's first read fails after the purchase succeeded and was persisted.
    retell.failNext('getPhoneNumber', 1, new Error('socket hang up'));
    const jobId = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
    const job = await waitForJob(jobId, 30_000);
    expect(job.status).toBe('succeeded');
    expect(retell.countOf('createPhoneNumber') - before).toBe(1);
    const steps = job.stepsJson as { steps: Record<string, Record<string, unknown>> };
    expect(steps.steps.provision).toMatchObject({ status: 'completed' });
    expect(steps.steps.bind).toMatchObject({ status: 'completed' });
  }, 60_000);

  it('after three failed attempts the activation is FAILED, the number row is failed, the stream is told once, and ops are alerted', async () => {
    const ws = await paidWorkspace(app, 'act-fail', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA' });
    retell.failNext('createPhoneNumber', 3, new Error('retell is down'));
    const stream = await openStream(headers);
    try {
      const jobId = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
      const failed = await stream.waitForType('failed', 30_000);
      expect(failed.data).toMatchObject({ activation_id: jobId, status: 'failed', step: 'provision', attempt: 3, max_attempts: 3 });
      expect(typeof failed.data.error).toBe('string');
      expect(failed.data.error as string).not.toMatch(/retell/i);
      expect(stream.frames.filter((f) => f.type === 'failed')).toHaveLength(1);

      const job = await waitForJob(jobId);
      expect(job.status).toBe('failed');
      const steps = job.stepsJson as { activation_status: string; customer_reason: string; steps: Record<string, Record<string, unknown>> };
      expect(steps.activation_status).toBe('failed');
      expect(steps.steps.provision!.status).toBe('failed');
      expect(steps.steps.mark_live!.status).toBe('pending');

      // The agent is published (that step succeeded) but the plan is not executed, the number row is failed.
      expect((await adminDb.phonePlan.findFirstOrThrow({ where: { agentId } })).status).toBe('pending');
      const number = await adminDb.phoneNumber.findFirstOrThrow({ where: { agentId } });
      expect(number.status).toBe('failed');
      expect(number.error).toBe(steps.customer_reason);

      const alert = alerts.alerts.find((a) => a.kind === 'activation_failed' && a.fields.activation_job_id === jobId)!;
      expect(alert).toBeTruthy();
      expect(alert.severity).toBe('critical');
      expect(alert.fields).toMatchObject({ workspace_id: ws.workspaceId, agent_id: agentId, failed_step: 'provision', attempts: 3, error_kind: 'internal' });
      expect(alert.fields.error).toContain('retell is down'); // ops may see the platform; the customer may not

      const view = await call('GET', `/agents/${agentId}/activation`, headers);
      expect(view.body).toMatchObject({ status: 'failed', step: 'provision' });
      expect(JSON.stringify(view.body)).not.toMatch(/retell is down/);

      // The customer can try again: the failed job no longer blocks a new one.
      retell.reset();
      // reset wiped the platform agent; re-create it by publishing once more through the route.
      await adminDb.agent.update({ where: { id: agentId }, data: { retellAgentId: null, retellLlmId: null, publishedVersion: null, status: 'draft' } });
      await adminDb.agentVersion.update({ where: { agentId_versionNo: { agentId, versionNo: 1 } }, data: { publishedAt: null, retellAgentVersion: null } });
      await adminDb.phoneNumber.deleteMany({ where: { agentId, status: 'failed' } });
      const retried = await call('POST', `/agents/${agentId}/activate`, headers, {});
      expect(retried.status).toBe(202);
      expect(retried.body.job_id).not.toBe(jobId);
      expect((await waitForJob(retried.body.job_id as string, 30_000)).status).toBe('succeeded');
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('an area code out of stock at the default carrier is bought from the other one, in the same code', async () => {
    const ws = await paidWorkspace(app, 'act-telnyx', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA', area_code: '647' });
    // The platform's answer on staging, 30 Sep.
    const noStock = 'No phone numbers of this area code.';
    retell.failNext('createPhoneNumber', 1, Retell.APIError.generate(404, { message: noStock }, noStock, new Headers()));

    const before = retell.calls.length;
    const jobId = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
    expect((await waitForJob(jobId, 30_000)).status).toBe('succeeded');
    const asked = retell.calls.slice(before).filter((c) => c.method === 'createPhoneNumber').map((c) => c.args[0] as { areaCode?: number; provider?: string });
    expect(asked.map((a) => [a.provider, a.areaCode])).toEqual([
      ['twilio', 647],
      ['telnyx', 647],
    ]);
    const row = await adminDb.phoneNumber.findFirstOrThrow({ where: { agentId } });
    expect(row).toMatchObject({ status: 'active', type: 'retell_telnyx', areaCode: '647', error: null });
  }, 60_000);

  it('a region out of stock everywhere falls back to any local number', async () => {
    const ws = await paidWorkspace(app, 'act-anycode', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA', area_code: '647' });
    const noStock = 'No phone numbers of this area code.';
    // 647, 416, 437, 942 at both carriers.
    retell.failNext('createPhoneNumber', 8, Retell.APIError.generate(404, { message: noStock }, noStock, new Headers()));

    const before = retell.calls.length;
    const jobId = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
    expect((await waitForJob(jobId, 30_000)).status).toBe('succeeded');
    const asked = retell.calls.slice(before).filter((c) => c.method === 'createPhoneNumber').map((c) => c.args[0] as { areaCode?: number; provider?: string });
    expect(asked).toHaveLength(9);
    expect(asked[8]).toMatchObject({ provider: 'twilio', areaCode: undefined });
    const numbers = await adminDb.phoneNumber.findMany({ where: { agentId } });
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ status: 'active', type: 'retell_twilio', requestedAreaCode: '647' });
    // The customer is told the number is not in the code they asked for (QA-076).
    const shown = (await call('GET', `/numbers/${numbers[0]!.id}`, headers)).body;
    expect(shown.requested_area_code).toBe('647');
    expect(shown.area_code).not.toBe('647');
  }, 60_000);

  it('no stock anywhere fails once, says so, and a retry after W6 picks another code buys in the new one', async () => {
    const ws = await paidWorkspace(app, 'act-areacode', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA', area_code: '236' });
    const noStock = 'No phone numbers of this area code.';
    // 236, 604, 778, 672 at both carriers, then any number at both.
    retell.failNext('createPhoneNumber', 10, Retell.APIError.generate(404, { message: noStock }, noStock, new Headers()));

    const first = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
    const failed = await waitForJob(first, 30_000);
    expect(failed.status).toBe('failed');
    const steps = failed.stepsJson as { attempt: number; error_kind: string; customer_reason: string };
    expect(steps.attempt).toBe(1); // permanent: no retries against an empty inventory
    expect(steps.error_kind).toBe('area_code_unavailable');
    expect(steps.customer_reason).toMatch(/Canada/);
    expect(steps.customer_reason).not.toMatch(/platform|retell|twilio|telnyx|404/i);
    const row = await adminDb.phoneNumber.findFirstOrThrow({ where: { agentId } });
    expect(row).toMatchObject({ status: 'failed', areaCode: '236', e164: null });

    // W6: another area code. The failed row is the plan's (plan_id is unique) and must follow it.
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA', area_code: '514' });
    const before = retell.calls.length;
    const second = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
    expect((await waitForJob(second, 30_000)).status).toBe('succeeded');
    const bought = retell.calls.slice(before).filter((c) => c.method === 'createPhoneNumber');
    expect(bought).toHaveLength(1);
    expect((bought[0]!.args[0] as { areaCode?: number }).areaCode).toBe(514);
    const numbers = await adminDb.phoneNumber.findMany({ where: { agentId } });
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ id: row.id, status: 'active', areaCode: '514', error: null });
    expect(numbers[0]!.e164).toMatch(/^\+1514/);
  }, 60_000);

  it('a permanent problem — no phone plan — fails on the first attempt without touching the platform for a number', async () => {
    const ws = await paidWorkspace(app, 'act-noplan', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const before = retell.countOf('createPhoneNumber');
    const jobId = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
    const job = await waitForJob(jobId);
    expect(job.status).toBe('failed');
    const steps = job.stepsJson as { attempt: number; error_kind: string; customer_reason: string };
    expect(steps.attempt).toBe(1);
    expect(steps.error_kind).toBe('no_plan');
    expect(steps.customer_reason).toMatch(/Choose a phone number option/);
    expect(retell.countOf('createPhoneNumber') - before).toBe(0);
    expect(alerts.alerts.some((a) => a.fields.activation_job_id === jobId && a.fields.attempts === 1)).toBe(true);
  }, 30_000);

  it('a lint failure on publish is permanent and names the problem to the customer', async () => {
    const ws = await paidWorkspace(app, 'act-lint', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers, { publish: false });
    // No greeting is a §9.5 lint *error* (DEFAULT_SEVERITIES.no_greeting), so publish refuses.
    await adminDb.agentVersion.update({ where: { agentId_versionNo: { agentId, versionNo: 1 } }, data: { greeting: null } });
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA' });
    const jobId = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
    const job = await waitForJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.stepsJson).toMatchObject({ attempt: 1, error_kind: 'lint_failed', activation_step: 'publish' });
    expect((job.stepsJson as { customer_reason: string }).customer_reason).toMatch(/cannot go live yet/);
    expect((await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } })).status).toBe('draft');
    expect(await adminDb.phoneNumber.count({ where: { agentId } })).toBe(0);
  }, 30_000);

  it('no paid purchase means no number, even with a plan', async () => {
    const { createWorkspace } = await import('./d5-fixtures');
    const ws = await createWorkspace('act-unpaid');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA' });
    // The route itself refuses: trial has no paid purchase and the agent is fine.
    const accepted = await call('POST', `/agents/${agentId}/activate`, headers, {});
    expect(accepted.status).toBe(202);
    const job = await waitForJob(accepted.body.job_id as string);
    expect(job.status).toBe('failed');
    expect(job.stepsJson).toMatchObject({ error_kind: 'no_purchase' });
    expect(await adminDb.phoneNumber.count({ where: { agentId } })).toBe(0);
  }, 30_000);
});

describe('the billing hook', () => {
  it('a paid checkout.session.completed that carries agent_id starts the activation on the owner\'s behalf', async () => {
    const ws = await paidWorkspace(app, 'act-checkout', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA' });
    const purchase = await adminDb.purchase.create({ data: { tenantId: ws.workspaceId, packId: 'growth', amountCents: 14_900, currency: 'USD', credits: 500, status: 'pending' } });
    const stripe = app.get(StripeGateway);
    const event = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      object: 'event',
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: `cs_test_${randomUUID().replace(/-/g, '')}`,
          object: 'checkout.session',
          mode: 'payment',
          status: 'complete',
          payment_status: 'paid',
          currency: 'usd',
          amount_total: 14_900,
          customer: ws.stripeCustomerId,
          payment_intent: `pi_${randomUUID().slice(0, 14)}`,
          invoice: null,
          client_reference_id: purchase.id,
          metadata: { workspace_id: ws.workspaceId, purchase_id: purchase.id, pack_id: 'growth', config_version: '1', auto_topup: 'false', auto_topup_threshold: '', agent_id: agentId, env: 'dev' },
        },
      },
    };
    const body = JSON.stringify(event);
    const res = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signForTest(body) }, payload: body });
    expect(res.statusCode).toBe(200);

    const job = await waitFor('the activation job', async () => adminDb.job.findFirst({ where: { tenantId: ws.workspaceId, type: 'activate-agent' } }), 20_000);
    const done = await waitForJob(job.id, 30_000);
    expect(done.status).toBe('succeeded');
    expect(done.stepsJson).toMatchObject({ requested_by: ws.userId, activation_status: 'live' });
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe('paid');
    expect((await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } })).status).toBe('live');
  }, 60_000);
});
