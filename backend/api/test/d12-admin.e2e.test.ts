import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import { type PricingConfig, pricingConfig } from '@portal/schemas';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StripeGateway } from '../src/modules/billing';
import { JOBS, JobRecordsService } from '../src/modules/jobs';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { WebhookEventsService } from '../src/modules/webhooks';
import { Auth0ManagementService } from '../src/modules/auth';
import { type D5Harness, startD5Harness } from './d5-fixtures';
import { paidWorkspace, type PaidWorkspace } from './d6-fixtures';

/*
 * D12 — the staff console's API (admin spec §2, §4, §5, §7.4, §9, §10).
 *
 * What this proves, end to end against real Postgres, Redis and two genuinely separate
 * Auth0 stand-ins:
 *   - the staff boundary: a customer token never reaches /admin/*, a staff token without
 *     the MFA claim is refused, a staff token never reaches a customer route, and the
 *     admin §2.2 matrix plus `staff_role_limits` are enforced server-side;
 *   - every sensitive action writes a `staff_audit_log` row with who, what, why;
 *   - credits move through the wallet (a ledger row + a credit_adjustments row, atomically);
 *   - pause/resume of tenant, agent and number change what the customer API answers;
 *   - jobs retry / discard, webhook replay, flags and kill switches;
 *   - pricing draft → preview → publish (with the Stripe sync, its failure and its resume)
 *     → rollback, and that `GET /pricing` shows the new version at once (the 60 s SLA);
 *   - read-only impersonation: reads work, every write is 403, the session ends and the
 *     credential dies with it.
 */

let h: D5Harness;
let ws: PaidWorkspace;
let staff: Record<
  'superAdmin' | 'ops' | 'finance' | 'support' | 'readOnly',
  { sub: string; id: string; token: string }
>;
let noMfaToken: string;
let agentId: string;
let numberId: string;
let originalPricing: PricingConfig;
let originalVersion = 0;

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: Record<string, unknown> & { code?: string; message?: string };
}> {
  const res = await h.app.inject({
    method: method as 'GET',
    url: path,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = res.body;
  return {
    status: res.statusCode,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const reason = { reason_code: 'service_issue', note: 'd12 e2e' };

async function lastAudit(action: string) {
  return adminDb.staffAuditLog.findFirst({ where: { action }, orderBy: { createdAt: 'desc' } });
}

beforeAll(async () => {
  h = await startD5Harness({ workers: false });
  const run = randomUUID().slice(0, 8);
  const make = async (
    label: string,
    role: 'super_admin' | 'ops' | 'finance' | 'support' | 'read_only',
  ) => {
    const row = await adminDb.staffUser.create({
      data: {
        authProviderId: `google-oauth2|${label}-${run}`,
        email: `${label}-${run}@metacognixion.test`,
        role,
      },
    });
    return {
      sub: row.authProviderId,
      id: row.id,
      token: await h.staffTenant.mint(row.authProviderId, { mfa: true }),
    };
  };
  staff = {
    superAdmin: await make('sa', 'super_admin'),
    ops: await make('ops', 'ops'),
    finance: await make('fin', 'finance'),
    support: await make('sup', 'support'),
    readOnly: await make('ro', 'read_only'),
  };
  noMfaToken = await h.staffTenant.mint(staff.ops.sub, { mfa: false });

  ws = await paidWorkspace(h.app, `d12-${run}`, 'growth');
  await adminDb.tenant.update({
    where: { id: ws.workspaceId },
    data: { name: `D12 Dental ${run}`, onboardingCompletedAt: new Date(), onboardingStep: 7 },
  });
  const agent = await adminDb.agent.create({
    data: {
      tenantId: ws.workspaceId,
      name: `Front desk ${run}`,
      status: 'live',
      tier: 'standard',
      publishedVersion: 1,
      draftVersion: 1,
      retellAgentId: `agent_${run}`,
      retellLlmId: `llm_${run}`,
    },
  });
  agentId = agent.id;
  await adminDb.agentVersion.create({ data: { agentId, versionNo: 1, source: 'generated', briefJson: {}, promptText: 'You are the front desk.', publishedAt: new Date() } });
  const number = await adminDb.phoneNumber.create({
    data: {
      tenantId: ws.workspaceId,
      agentId,
      e164: `+1450555${run.replace(/\D/g, '').padEnd(4, '1').slice(0, 4)}`,
      type: 'retell_twilio',
      status: 'active',
      inboundToken: `tok_${run}`,
      country: 'CA',
    },
  });
  numberId = number.id;
  const current = (await adminDb.pricingConfig.findFirst({ where: { effectiveAt: { lte: new Date() } }, orderBy: { version: 'desc' } }))!;
  originalPricing = pricingConfig.parse(current.configJson);
  originalVersion = current.version;
}, 60_000);

afterAll(async () => {
  await adminDb.pricingDraft.deleteMany({});
  // Versions are immutable in production; a test run is not, and the billing suite asserts on
  // the seed's version number. Put the table back the way it was found (price map rows cascade).
  await adminDb.pricingConfig.deleteMany({ where: { version: { gt: originalVersion } } });
  await h.app.get(RedisCache).del(redisKeys.pricingCurrent);
  await h?.stop();
  await adminDb.$disconnect();
});

// --------------------------------------------------------------------------- boundary

describe('the staff boundary', () => {
  it('refuses a customer token on /admin/* and a staff token on a customer route', async () => {
    const customer = await h.customerTenant.mint(ws.sub);
    expect((await call('GET', '/admin/me', customer)).status).toBe(401);
    const onCustomerRoute = await call('GET', '/workspace', staff.ops.token, undefined, {
      'x-workspace-id': ws.workspaceId,
    });
    expect(onCustomerRoute.status).toBe(401);
  });

  it('refuses a staff token without the MFA claim — the D12 exit check', async () => {
    const res = await call('GET', '/admin/me', noMfaToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
  });

  it('answers /admin/me with the role and its limits', async () => {
    const res = await call('GET', '/admin/me', staff.support.token);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('support');
    expect((res.body.limits as Record<string, unknown>).credit_adjust_max_per_action).toBe(50);
    expect((res.body.limits as Record<string, unknown>).can_publish_pricing).toBe(false);
  });

  it('enforces the admin §2.2 matrix on the route and the role limits inside it', async () => {
    const ro = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/pause`,
      staff.readOnly.token,
      reason,
    );
    expect(ro.status).toBe(403);
    expect(ro.body.code).toBe('FORBIDDEN_ROLE');
    const tooMuch = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/credits/adjust`,
      staff.support.token,
      { delta: 100, reason_code: 'goodwill' },
    );
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.code).toBe('STAFF_LIMIT_EXCEEDED');
    expect(tooMuch.body.message).toMatch(/50 credits per action/);
    const finance = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/pause`,
      staff.finance.token,
      reason,
    );
    expect(finance.status).toBe(403);
  });
});

// --------------------------------------------------------------------------- KPIs, search, health

describe('SA1, search and the health strip', () => {
  it('computes KPIs and the funnel', async () => {
    const kpis = await call('GET', '/admin/kpis?range=30d', staff.readOnly.token);
    expect(kpis.status).toBe(200);
    const customers = kpis.body.customers as Record<string, number>;
    expect(customers.total).toBeGreaterThanOrEqual(1);
    expect((kpis.body.series as unknown[]).length).toBeGreaterThan(25);
    const funnel = await call('GET', '/admin/kpis/funnel?range=7d', staff.readOnly.token);
    expect(funnel.status).toBe(200);
    expect((funnel.body.steps as Array<{ key: string }>).map((s) => s.key)).toContain('live');
  });

  it('finds the workspace, its owner and its number by name, email and digits', async () => {
    const byName = await call(
      'GET',
      `/admin/search?q=${encodeURIComponent((await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } })).name)}`,
      staff.support.token,
    );
    expect(
      (byName.body.results as Array<{ type: string; id: string }>).some(
        (r) => r.type === 'customer' && r.id === ws.workspaceId,
      ),
    ).toBe(true);
    const byEmail = await call(
      'GET',
      `/admin/search?q=${encodeURIComponent(ws.email)}`,
      staff.support.token,
    );
    expect(
      (byEmail.body.results as Array<{ type: string; id: string }>).some(
        (r) => r.type === 'user' && r.id === ws.userId,
      ),
    ).toBe(true);
    const number = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: numberId } });
    const byDigits = await call(
      'GET',
      `/admin/search?q=${encodeURIComponent(number.e164!)}`,
      staff.support.token,
    );
    expect(
      (byDigits.body.results as Array<{ type: string; id: string }>).some(
        (r) => r.type === 'number' && r.id === numberId,
      ),
    ).toBe(true);
  });

  it('reports the health strip without leaking anything', async () => {
    const res = await call('GET', '/admin/system/health', staff.readOnly.token);
    expect(res.status).toBe(200);
    expect((res.body.postgres as { signal: string }).signal).toBe('ok');
    expect((res.body.redis as { signal: string }).signal).toBe('ok');
    expect(JSON.stringify(res.body)).not.toMatch(/postgresql:\/\/|sk_test|key_/);
  });
});

// --------------------------------------------------------------------------- customers

describe('SA2 customers and the 360', () => {
  it('lists and details the customer with balance, owner and status', async () => {
    const list = await call(
      'GET',
      `/admin/customers?q=${encodeURIComponent('D12 Dental')}`,
      staff.readOnly.token,
    );
    expect(list.status).toBe(200);
    const row = (list.body.items as Array<Record<string, unknown>>).find(
      (r) => r.id === ws.workspaceId,
    )!;
    expect(row.balance).toBe(500);
    expect(row.owner_email).toBe(ws.email);
    expect(row.status).toBe('active');
    const detail = await call('GET', `/admin/customers/${ws.workspaceId}`, staff.readOnly.token);
    expect(detail.body.purchases_paid).toBe(1);
    expect(detail.body.members).toBe(1);
    const members = await call(
      'GET',
      `/admin/customers/${ws.workspaceId}/members`,
      staff.readOnly.token,
    );
    expect((members.body as unknown as Array<{ role: string }>)[0]!.role).toBe('owner');
    expect((await call('GET', `/admin/customers/not-a-uuid`, staff.readOnly.token)).status).toBe(
      404,
    );
  });

  it('QA 28 Sep: a ticket number with no ticket row is kept as a reference, not a 500', async () => {
    const res = await call('POST', `/admin/customers/${ws.workspaceId}/credits/adjust`, staff.ops.token, { delta: 1, reason_code: 'goodwill', ticket_id: 987654 });
    expect(res.status).toBe(201);
    const record = await adminDb.creditAdjustment.findUniqueOrThrow({ where: { id: res.body.adjustment_id as string } });
    expect(record.ticketId).toBeNull();
    const audit = await lastAudit('credits.adjusted');
    expect((audit?.afterJson as { ticket_id: number; ticket_linked: boolean })).toMatchObject({ ticket_id: 987654, ticket_linked: false });
    await call('POST', `/admin/customers/${ws.workspaceId}/credits/adjust`, staff.ops.token, { delta: -1, reason_code: 'testing_internal' });
  });

  it('QA 28 Sep: the same idempotency key moves credits once, even racing itself', async () => {
    const key = randomUUID();
    const body = { delta: 3, reason_code: 'goodwill', idempotency_key: key };
    const before = await adminDb.creditAdjustment.count({ where: { tenantId: ws.workspaceId } });
    const [a, b] = await Promise.all([
      call('POST', `/admin/customers/${ws.workspaceId}/credits/adjust`, staff.ops.token, body),
      call('POST', `/admin/customers/${ws.workspaceId}/credits/adjust`, staff.ops.token, body),
    ]);
    const c = await call('POST', `/admin/customers/${ws.workspaceId}/credits/adjust`, staff.ops.token, body);
    expect([a.body.adjustment_id, b.body.adjustment_id, c.body.adjustment_id]).toEqual([key, key, key]);
    expect(await adminDb.creditAdjustment.count({ where: { tenantId: ws.workspaceId } })).toBe(before + 1);
    expect(await adminDb.creditLedger.count({ where: { refId: key } })).toBe(1);
    await call('POST', `/admin/customers/${ws.workspaceId}/credits/adjust`, staff.ops.token, { delta: -3, reason_code: 'testing_internal' });
  });

  it('adjusts credits through the wallet with a reason, a record and an audit row', async () => {
    const missing = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/credits/adjust`,
      staff.ops.token,
      { delta: 25 },
    );
    expect(missing.status).toBe(422);
    const otherNoNote = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/credits/adjust`,
      staff.ops.token,
      { delta: 25, reason_code: 'other' },
    );
    expect(otherNoNote.status).toBe(422);

    const up = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/credits/adjust`,
      staff.ops.token,
      { delta: 25, reason_code: 'goodwill', customer_text: 'Sorry about the outage' },
    );
    expect(up.status).toBe(201);
    expect(up.body.balance_after).toBe(525);
    const ledger = await adminDb.creditLedger.findUniqueOrThrow({
      where: { id: up.body.ledger_id as string },
    });
    expect(ledger.reason).toBe('adjustment');
    expect(ledger.delta.toNumber()).toBe(25);
    const record = await adminDb.creditAdjustment.findUniqueOrThrow({
      where: { id: up.body.adjustment_id as string },
    });
    expect(record.staffId).toBe(staff.ops.id);
    expect(record.ledgerId).toBe(ledger.id);
    const audit = await lastAudit('credits.adjusted');
    expect(audit?.staffId).toBe(staff.ops.id);
    expect(audit?.reasonCode).toBe('goodwill');
    expect(audit?.tenantId).toBe(ws.workspaceId);

    const down = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/credits/adjust`,
      staff.ops.token,
      { delta: -30, reason_code: 'billing_error', note: 'double comp' },
    );
    expect(down.body.balance_after).toBe(495);
    const wallet = await call(
      'GET',
      `/admin/customers/${ws.workspaceId}/wallet`,
      staff.readOnly.token,
    );
    expect(wallet.body.balance).toBe(495);
    const ids = (wallet.body.adjustments as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([up.body.adjustment_id, down.body.adjustment_id]));
    const customerView = await call(
      'GET',
      '/wallet',
      await h.customerTenant.mint(ws.sub),
      undefined,
      { 'x-workspace-id': ws.workspaceId },
    );
    expect(customerView.body.balance).toBe(495);
  });

  it('pauses and resumes the workspace, visible to the customer and audited twice', async () => {
    const supportNoTicket = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/pause`,
      staff.support.token,
      reason,
    );
    expect(supportNoTicket.status).toBe(403);
    expect(supportNoTicket.body.code).toBe('STAFF_LIMIT_EXCEEDED');
    // review 28 Sep: a ticket number that is not one of this workspace's does not count.
    const supportBogusTicket = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/pause`,
      staff.support.token,
      { ...reason, ticket_id: 2_000_000_000 },
    );
    expect(supportBogusTicket.status).toBe(403);
    expect(supportBogusTicket.body.message).toMatch(/not one of this workspace/);

    const paused = await call('POST', `/admin/customers/${ws.workspaceId}/pause`, staff.ops.token, {
      reason_code: 'fraud_suspected',
      note: 'card testing',
    });
    expect(paused.status).toBe(200);
    expect(paused.body.paused).toBe(true);
    const customer = await call(
      'GET',
      '/workspace',
      await h.customerTenant.mint(ws.sub),
      undefined,
      { 'x-workspace-id': ws.workspaceId },
    );
    expect(customer.body.paused).toBe(true);
    expect(customer.body.paused_reason).toMatch(/fraud_suspected/);
    expect((await lastAudit('customer.paused'))?.reasonCode).toBe('fraud_suspected');
    expect(
      await adminDb.auditLog.findFirst({
        where: { tenantId: ws.workspaceId, action: 'workspace.paused' },
      }),
    ).not.toBeNull();

    const again = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/pause`,
      staff.ops.token,
      reason,
    );
    expect(again.body.paused).toBe(true);
    const resumed = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/resume`,
      staff.support.token,
      { reason_code: 'customer_request', ticket_id: 12 },
    );
    expect(resumed.body.paused).toBe(false);
    expect((await lastAudit('customer.resumed'))?.staffId).toBe(staff.support.id);
  });
});

// --------------------------------------------------------------------------- agents, numbers, users

describe('agent, number and user controls', () => {
  it('pauses and resumes an agent (local state, no platform call) and refuses to resume an unpublished one', async () => {
    const paused = await call(
      'POST',
      `/admin/agents/${agentId}/pause`,
      staff.support.token,
      reason,
    );
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('paused');
    expect(h.retell.calls.some((c) => /update|publish/i.test(c.method))).toBe(false);
    expect((await lastAudit('agent.paused'))?.targetId).toBe(agentId);
    const resumed = await call('POST', `/admin/agents/${agentId}/resume`, staff.ops.token, reason);
    expect(resumed.body.status).toBe('live');
    const draft = await adminDb.agent.create({
      data: { tenantId: ws.workspaceId, name: 'Never published', status: 'paused' },
    });
    const refused = await call('POST', `/admin/agents/${draft.id}/resume`, staff.ops.token, reason);
    expect(refused.status).toBe(409);
  });

  it('pauses and resumes a number', async () => {
    const paused = await call('POST', `/admin/numbers/${numberId}/pause`, staff.ops.token, reason);
    expect(paused.body.status).toBe('paused');
    expect(paused.body.paused_at).not.toBeNull();
    const list = await call('GET', `/admin/numbers?status=paused`, staff.readOnly.token);
    expect((list.body.items as Array<{ id: string }>).some((n) => n.id === numberId)).toBe(true);
    const resumed = await call(
      'POST',
      `/admin/numbers/${numberId}/resume`,
      staff.ops.token,
      reason,
    );
    expect(resumed.body.status).toBe('active');
    expect(resumed.body.paused_at).toBeNull();
  });

  it('QA 28 Sep: force logout refuses the token the person already holds; a new sign-in works', async () => {
    const live = await h.customerTenant.mint(ws.sub);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call('GET', '/workspace', live, undefined, { 'x-workspace-id': ws.workspaceId })).status).toBe(200);
    const res = await call('POST', `/admin/users/${ws.userId}/force-logout`, staff.support.token, reason);
    expect((res.body.user as { sessions_revoked_at: string | null }).sessions_revoked_at).not.toBeNull();
    const dead = await call('GET', '/workspace', live, undefined, { 'x-workspace-id': ws.workspaceId });
    expect(dead.status).toBe(401);
    expect(dead.body.code).toBe('INVALID_TOKEN');
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call('GET', '/workspace', await h.customerTenant.mint(ws.sub), undefined, { 'x-workspace-id': ws.workspaceId })).status).toBe(200);
  });

  it('QA 28 Sep: force logout holds even when the identity provider refuses', async () => {
    const auth0 = h.app.get(Auth0ManagementService);
    const spy = vi.spyOn(auth0, 'revokeSessions').mockRejectedValueOnce(new Error('Auth0 Management API answered 403'));
    const live = await h.customerTenant.mint(ws.sub);
    await new Promise((r) => setTimeout(r, 1100));
    const res = await call('POST', `/admin/users/${ws.userId}/force-logout`, staff.support.token, reason);
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('failed');
    expect((await call('GET', '/workspace', live, undefined, { 'x-workspace-id': ws.workspaceId })).status).toBe(401);
    // The revoke and its audit row commit together; the provider's answer is a second row.
    expect(((await lastAudit('user.force_logout'))?.afterJson as { sessions_revoked_at: string }).sessions_revoked_at).toBeTruthy();
    expect(((await lastAudit('user.force_logout_provider_failed'))?.afterJson as { provider: string }).provider).toBe('failed');
    spy.mockRestore();
    await new Promise((r) => setTimeout(r, 1100));
  });

  it('locks a user (refused by the API at once), unlocks, resets MFA — provider skipped, all audited', async () => {
    const before = await call('GET', `/admin/users/${ws.userId}`, staff.support.token);
    expect(before.body.email).toBe(ws.email);
    expect(before.body.email_verified).toBeNull();

    const locked = await call('POST', `/admin/users/${ws.userId}/lock`, staff.support.token, {
      reason_code: 'abuse_policy',
      note: 'spam sign-ups',
    });
    expect(locked.status).toBe(200);
    expect(locked.body.provider).toBe('skipped');
    expect((locked.body.user as { locked_at: string | null }).locked_at).not.toBeNull();
    const asCustomer = await call(
      'GET',
      '/workspace',
      await h.customerTenant.mint(ws.sub),
      undefined,
      { 'x-workspace-id': ws.workspaceId },
    );
    expect(asCustomer.status).toBe(403);
    expect(asCustomer.body.code).toBe('ACCOUNT_LOCKED');

    const unlocked = await call(
      'POST',
      `/admin/users/${ws.userId}/unlock`,
      staff.support.token,
      reason,
    );
    expect((unlocked.body.user as { locked_at: string | null }).locked_at).toBeNull();
    expect(
      (
        await call('GET', '/workspace', await h.customerTenant.mint(ws.sub), undefined, {
          'x-workspace-id': ws.workspaceId,
        })
      ).status,
    ).toBe(200);

    await adminDb.user.update({ where: { id: ws.userId }, data: { mfaEnabled: true } });
    const reset = await call(
      'POST',
      `/admin/users/${ws.userId}/reset-mfa`,
      staff.ops.token,
      reason,
    );
    expect((reset.body.user as { mfa_enabled: boolean }).mfa_enabled).toBe(false);
    expect((await lastAudit('user.mfa_reset'))?.staffId).toBe(staff.ops.id);
    expect(
      (await call('POST', `/admin/users/${ws.userId}/force-logout`, staff.support.token, reason))
        .status,
    ).toBe(200);
    expect(
      (await call('POST', `/admin/users/${ws.userId}/lock`, staff.readOnly.token, reason)).status,
    ).toBe(403);
  });
});

// --------------------------------------------------------------------------- jobs and webhooks

describe('SA12 jobs and webhook events', () => {
  it('retries a failed job with its stored payload and refuses invalid transitions', async () => {
    const records = h.app.get(JobRecordsService);
    const jobId = await records.create({
      workspaceId: ws.workspaceId,
      type: JOBS.generateAgent,
      steps: { agent_id: agentId },
    });
    await records.recordPayload(jobId, {
      jobId,
      workspaceId: ws.workspaceId,
      agentId,
      userId: ws.userId,
      mode: 'generate',
    });
    await records.fail(
      jobId,
      'provider exploded',
      { agent_id: agentId, customer_reason: 'try again' },
      0,
    );

    expect(
      (await call('POST', `/admin/jobs/${jobId}/retry`, staff.support.token, reason)).status,
    ).toBe(403);
    const retried = await call('POST', `/admin/jobs/${jobId}/retry`, staff.ops.token, reason);
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('queued');
    expect(['waiting', 'delayed', 'prioritized']).toContain(retried.body.queue_state);
    expect((await lastAudit('job.retried'))?.targetId).toBe(jobId);
    expect((await call('POST', `/admin/jobs/${jobId}/retry`, staff.ops.token, reason)).status).toBe(
      409,
    );

    const discarded = await call('POST', `/admin/jobs/${jobId}/discard`, staff.ops.token, reason);
    expect(discarded.body.status).toBe('failed');
    expect(discarded.body.customer_reason).toMatch(/cancelled by support/);
    const list = await call(
      'GET',
      `/admin/jobs?status=failed&tenant_id=${ws.workspaceId}`,
      staff.readOnly.token,
    );
    expect((list.body.items as Array<{ id: string }>).some((j) => j.id === jobId)).toBe(true);
  });

  it('replays a stored webhook through its handler and audits it', async () => {
    const events = h.app.get(WebhookEventsService);
    const sub = `auth0|replay-${randomUUID().slice(0, 8)}`;
    const stored = await events.store({
      provider: 'auth',
      externalId: sub,
      eventType: 'user.registered',
      payload: {
        event_type: 'user.registered',
        external_id: sub,
        email: `${sub.replace(/\W/g, '')}@example.test`,
        email_verified: true,
        name: 'Replayed',
      },
    });
    expect(stored.kind).toBe('new');
    const pending = await call(
      'GET',
      `/admin/webhook-events?status=pending&provider=auth`,
      staff.readOnly.token,
    );
    expect((pending.body.items as Array<{ id: string }>).some((e) => e.id === stored.id)).toBe(
      true,
    );

    const replay = await call(
      'POST',
      `/admin/webhook-events/${stored.id}/replay`,
      staff.ops.token,
      reason,
    );
    expect(replay.status).toBe(200);
    expect((replay.body.event as { status: string }).status).toBe('processed');
    expect(await adminDb.user.findUnique({ where: { authProviderId: sub } })).not.toBeNull();
    const again = await call(
      'POST',
      `/admin/webhook-events/${stored.id}/replay`,
      staff.ops.token,
      reason,
    );
    expect(again.status).toBe(200);
    expect(await adminDb.user.count({ where: { authProviderId: sub } })).toBe(1);
    expect((await lastAudit('webhook.replayed'))?.targetId).toBe(stored.id);
    expect((await lastAudit('webhook.replay_requested'))?.targetId).toBe(stored.id);
    const detail = await call('GET', `/admin/webhook-events/${stored.id}`, staff.readOnly.token);
    expect((detail.body.payload as { external_id: string }).external_id).toBe(sub);
  });
});

// --------------------------------------------------------------------------- flags and kill switches

describe('SA12 flags and kill switches', () => {
  it('creates, lists and deletes a feature flag', async () => {
    const key = `d12_flag_${randomUUID().slice(0, 6)}`;
    expect(
      (await call('PUT', `/admin/flags/${key}`, staff.support.token, { default_on: true })).status,
    ).toBe(403);
    const created = await call('PUT', `/admin/flags/${key}`, staff.ops.token, {
      description: 'e2e',
      default_on: true,
      rollout_pct: 50,
      tenant_overrides: { [ws.workspaceId]: false },
    });
    expect(created.status).toBe(200);
    expect(created.body.rollout_pct).toBe(50);
    const list = await call('GET', '/admin/flags', staff.readOnly.token);
    expect((list.body.flags as Array<{ key: string }>).some((f) => f.key === key)).toBe(true);
    expect(
      (list.body.kill_switches as Array<{ key: string; description: string }>).find(
        (s) => s.key === 'reject_inbound',
      )?.description,
    ).toMatch(/inbound/);
    const createdAudit = await lastAudit('flag.created');
    expect(createdAudit?.targetId).toBe(key);
    // review 28 Sep: `key` is the flag's identifier, not a secret — it must survive redaction.
    expect((createdAudit?.afterJson as { key: string }).key).toBe(key);
    // review 28 Sep: a delete is a customer-affecting write and needs its reason code.
    expect((await call('DELETE', `/admin/flags/${key}`, staff.ops.token)).status).toBe(422);
    expect((await call('DELETE', `/admin/flags/${key}`, staff.ops.token, reason)).body.deleted).toBe(true);
    expect((await lastAudit('flag.deleted'))?.reasonCode).toBe('service_issue');
    expect(await adminDb.featureFlag.count({ where: { key } })).toBe(0);
  });

  it('flips a kill switch with a reason, projects reject_inbound to the hot path, and audits both directions', async () => {
    const noReason = await call('PUT', '/admin/kill-switches/pause_web_tests', staff.ops.token, {
      on: true,
    });
    expect(noReason.status).toBe(422);
    const on = await call('PUT', '/admin/kill-switches/reject_inbound', staff.superAdmin.token, {
      on: true,
      reason_code: 'service_issue',
      note: 'd12 e2e',
    });
    expect(on.status).toBe(200);
    expect(on.body.active).toBe(true);
    expect(on.body.set_by).toBe(staff.superAdmin.id);
    expect(on.body.reason).toBe('service_issue: d12 e2e');
    expect(await h.app.get(RedisCache).get(redisKeys.rejectInbound)).toBe('1');
    const onAudit = await lastAudit('kill_switch.on');
    expect(onAudit?.targetId).toBe('reject_inbound');
    expect(onAudit?.reasonCode).toBe('service_issue');
    // review 28 Sep: turning a switch off is a customer-affecting write too.
    expect(
      (await call('PUT', '/admin/kill-switches/reject_inbound', staff.superAdmin.token, { on: false })).status,
    ).toBe(422);
    const off = await call('PUT', '/admin/kill-switches/reject_inbound', staff.superAdmin.token, {
      on: false,
      reason_code: 'service_issue',
    });
    expect(off.body.active).toBe(false);
    expect(await h.app.get(RedisCache).get(redisKeys.rejectInbound)).toBe('0');
    expect((await lastAudit('kill_switch.off'))?.reasonCode).toBe('service_issue');
    expect(
      (
        await call('PUT', '/admin/kill-switches/nope', staff.superAdmin.token, {
          on: true,
          reason_code: 'service_issue',
        })
      ).status,
    ).toBe(404);
  });
});

// --------------------------------------------------------------------------- pricing

describe('SA5 pricing: draft → preview → publish → rollback', () => {
  let publishedVersion = 0;

  it('saves a draft (finance), previews the diff and the planned Stripe actions', async () => {
    const draft = await call('GET', '/admin/pricing/draft', staff.finance.token);
    expect(draft.body.id).toBeNull();
    const config = pricingConfig.parse(draft.body.config);
    const next: PricingConfig = {
      ...config,
      rates: { ...config.rates, premium_per_min: config.rates.premium_per_min + 0.25 },
      packs: config.packs.map((p) =>
        p.id === 'growth' ? { ...p, price_cents: p.price_cents + 1_000 } : p,
      ),
    };
    expect(
      (await call('PUT', '/admin/pricing/draft', staff.support.token, { config: next })).status,
    ).toBe(403);
    const saved = await call('PUT', '/admin/pricing/draft', staff.finance.token, { config: next });
    expect(saved.status).toBe(200);
    expect(saved.body.id).not.toBeNull();

    const preview = await call('GET', '/admin/pricing/preview', staff.finance.token);
    expect(preview.status).toBe(200);
    const paths = (preview.body.changes as Array<{ path: string }>).map((c) => c.path);
    expect(paths).toContain('rates.premium_per_min');
    expect(paths).toContain('packs.growth.price_cents');
    expect(preview.body.packs).toMatchObject({ changed: ['growth'] });
    const stripe = preview.body.stripe as Array<{ pack_id: string; action: string }>;
    expect(stripe.find((a) => a.pack_id === 'growth')?.action).toBe('create');
    expect(Array.isArray(preview.body.warnings)).toBe(true);
  });

  it('refuses publish below the margin floor unless overridden by a super admin', async () => {
    await call('PUT', '/admin/retell-costs', staff.finance.token, {
      standard_cents_per_min: 500,
      premium_cents_per_min: 900,
      margin_floor_pct: 60,
    });
    const preview = await call('GET', '/admin/pricing/preview', staff.finance.token);
    expect((preview.body.blockers as string[]).length).toBeGreaterThan(0);
    const blocked = await call('POST', '/admin/pricing/publish', staff.superAdmin.token, {});
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('MARGIN_FLOOR');
    expect(
      (
        await call('POST', '/admin/pricing/publish', staff.ops.token, {
          override_margin: true,
          note: 'x',
        })
      ).status,
    ).toBe(403);
    await call('PUT', '/admin/retell-costs', staff.finance.token, {
      standard_cents_per_min: 5,
      premium_cents_per_min: 9,
      margin_floor_pct: 40,
    });
  });

  it('keeps the version unpublished when Stripe refuses, then resumes it on the next publish', async () => {
    const stripe = h.app.get(StripeGateway);
    const before = await call('GET', '/pricing', null);
    const ensure = vi.spyOn(stripe, 'ensureProduct').mockResolvedValue('prod_d12');
    const find = vi.spyOn(stripe, 'findPriceByLookupKey').mockResolvedValue(null);
    const create = vi.spyOn(stripe, 'createPrice').mockRejectedValueOnce(new Error('rate limited'));
    const archive = vi.spyOn(stripe, 'archivePrice').mockResolvedValue(undefined);

    const failed = await call('POST', '/admin/pricing/publish', staff.superAdmin.token, {
      change_summary: 'growth +$10, premium +0.25',
    });
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('STRIPE_SYNC_FAILED');
    const pending = await adminDb.pricingConfig.findFirst({
      where: { effectiveAt: null },
      orderBy: { version: 'desc' },
    });
    expect(pending).not.toBeNull();
    expect((await call('GET', '/pricing', null)).body.version).toBe(before.body.version);
    expect((await lastAudit('pricing.publish_failed'))?.targetId).toBe(String(pending!.version));

    create.mockImplementation(async (input) => `price_${input.pack.id}_${input.pack.currency}`);
    const ok = await call('POST', '/admin/pricing/publish', staff.superAdmin.token, {
      change_summary: 'growth +$10, premium +0.25',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.version).toBe(pending!.version);
    publishedVersion = ok.body.version as number;
    expect((ok.body.stripe_sync as { status: string }).status).toBe('synced');
    // A rerun finds the Product from an earlier version's rows, so only the Price is certain to be created.
    expect(ensure.mock.calls.length + find.mock.calls.length).toBeGreaterThan(0);
    expect(create).toHaveBeenCalled();
    // Nothing was archived while the previous version was still what checkout sold (the first
    // attempt died after creating nothing; archiving then would have broken every purchase).
    // The previous version had no Stripe rows (the seed predates the sync), so there is nothing
    // to archive after the flip either.
    expect(archive).not.toHaveBeenCalled();
    const rows = await adminDb.stripePriceMap.findMany({
      where: { configVersion: publishedVersion },
    });
    expect(rows.length).toBe(originalPricing.packs.filter((p) => p.active).length);
    expect(rows.find((r) => r.packId === 'growth')?.stripePriceId).toBe('price_growth_USD');

    // The 60 s SLA: the portal reads the new version on its very next request.
    const after = await call('GET', '/pricing', null);
    expect(after.body.version).toBe(publishedVersion);
    expect((after.body.rates as { premium_per_min: number }).premium_per_min).toBe(
      originalPricing.rates.premium_per_min + 0.25,
    );
    expect((await call('GET', '/admin/pricing/draft', staff.finance.token)).body.id).toBeNull();
    expect((await lastAudit('pricing.published'))?.staffId).toBe(staff.superAdmin.id);
    const versions = await call('GET', '/admin/pricing/versions', staff.readOnly.token);
    expect(
      (versions.body as unknown as Array<{ version: number; is_current: boolean }>).find(
        (v) => v.is_current,
      )?.version,
    ).toBe(publishedVersion);
  });

  it('review 28 Sep: apply_now caps are refused with a future effective date', async () => {
    await call('PUT', '/admin/pricing/draft', staff.finance.token, { config: originalPricing });
    const res = await call('POST', '/admin/pricing/publish', staff.superAdmin.token, {
      grandfather_mode: 'apply_now',
      effective_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    });
    expect(res.status).toBe(422);
    expect((res.body.fields as Array<{ field: string }>)[0]?.field).toBe('grandfather_mode');
    await call('DELETE', '/admin/pricing/draft', staff.finance.token);
  });

  it('rolls back to the previous version as a new version, keeping history', async () => {
    const stripe = h.app.get(StripeGateway);
    const archive = vi.spyOn(stripe, 'archivePrice').mockResolvedValue(undefined);
    vi.spyOn(stripe, 'ensureProduct').mockResolvedValue('prod_d12');
    vi.spyOn(stripe, 'findPriceByLookupKey').mockResolvedValue(null);
    vi.spyOn(stripe, 'createPrice').mockImplementation(async (input) => `price_rb_${input.pack.id}_${input.lookupKey}`);
    const target = publishedVersion - 1;
    expect(
      (
        await call(
          'POST',
          `/admin/pricing/rollback/${publishedVersion}`,
          staff.superAdmin.token,
          {},
        )
      ).status,
    ).toBe(409);
    const rolled = await call('POST', `/admin/pricing/rollback/${target}`, staff.superAdmin.token, {
      note: 'back out',
    });
    expect(rolled.status).toBe(201);
    expect(rolled.body.version).toBe(publishedVersion + 1);
    expect(rolled.body.change_summary).toMatch(new RegExp(`Rollback to v${target}`));
    const live = await call('GET', '/pricing', null);
    expect(live.body.version).toBe(publishedVersion + 1);
    expect((live.body.rates as { premium_per_min: number }).premium_per_min).toBe(
      originalPricing.rates.premium_per_min,
    );
    expect(await adminDb.pricingConfig.count({ where: { version: publishedVersion } })).toBe(1);
    expect((await lastAudit('pricing.rolled_back'))?.staffId).toBe(staff.superAdmin.id);
    // review 28 Sep: planned against the version in effect, not the target's own rows. Growth was
    // re-priced by the abandoned version, so the rollback needs a fresh Price for it — never the
    // id the abandoned version had archived — and the abandoned version's growth Price is
    // archived only now, once the rollback is what checkout sells.
    const rolledRows = await adminDb.stripePriceMap.findMany({ where: { configVersion: publishedVersion + 1 } });
    expect(rolledRows.find((r) => r.packId === 'growth')?.stripePriceId).toMatch(/^price_rb_growth_/);
    expect(rolledRows.find((r) => r.packId === 'starter')?.stripePriceId).toBe('price_starter_USD');
    expect(archive).toHaveBeenCalledWith('price_growth_USD');
    expect(
      (await adminDb.stripePriceMap.findUnique({ where: { packId_currency_configVersion: { packId: 'growth', currency: 'USD', configVersion: publishedVersion } } }))?.active,
    ).toBe(false);
    // Checkout still finds an active Price for every pack of the version in effect.
    for (const p of originalPricing.packs.filter((p) => p.active))
      expect(rolledRows.find((r) => r.packId === p.id)?.active).toBe(true);
  });
});

// --------------------------------------------------------------------------- impersonation

describe('read-only impersonation (admin §7.4)', () => {
  let key = '';
  let sessionId = '';

  it('starts a session for an allowed role and answers the portal link', async () => {
    const refused = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/impersonate`,
      staff.readOnly.token,
      {},
    );
    expect(refused.status).toBe(403);
    // review 28 Sep: the reason is the staff member's, never defaulted.
    expect(
      (await call('POST', `/admin/customers/${ws.workspaceId}/impersonate`, staff.support.token, { note: 'ticket 42' })).status,
    ).toBe(422);
    const started = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/impersonate`,
      staff.support.token,
      { reason_code: 'support_investigation', note: 'ticket 42' },
    );
    expect(started.status).toBe(201);
    expect(started.body.mode).toBe('view');
    const url = new URL(started.body.portal_url as string);
    expect(url.pathname).toBe('/impersonate/');
    // review 28 Sep: the credential rides in the fragment, which never reaches an access log.
    expect(url.search).toBe('');
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
    key = fragment.get('key')!;
    sessionId = fragment.get('session')!;
    expect(key.startsWith('imp_')).toBe(true);
    const startedAudit = await lastAudit('impersonation.started');
    expect(startedAudit?.impersonationId).toBe(sessionId);
    expect(startedAudit?.reasonCode).toBe('support_investigation');
    const again = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/impersonate`,
      staff.support.token,
      { reason_code: 'support_investigation', note: 'second look' },
    );
    expect(again.body.id).toBe(sessionId);
    // review 28 Sep: the reuse mints a fresh credential, so it is audited with its own reason.
    const reused = await lastAudit('impersonation.reused');
    expect(reused?.impersonationId).toBe(sessionId);
    expect(reused?.note).toBe('second look');
  });

  it('review 28 Sep: the console banner re-mints the link for its own open session only', async () => {
    const other = await call('POST', `/admin/impersonations/${sessionId}/open`, staff.ops.token, undefined);
    expect(other.status).toBe(403);
    const reopened = await call('POST', `/admin/impersonations/${sessionId}/open`, staff.support.token, undefined);
    expect(reopened.status).toBe(201);
    const url = new URL(reopened.body.portal_url as string);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
    expect(fragment.get('session')).toBe(sessionId);
    const freshKey = fragment.get('key')!;
    expect(freshKey.startsWith('imp_')).toBe(true);
    expect((await call('GET', '/impersonation', freshKey)).body.id).toBe(sessionId);
    expect((await lastAudit('impersonation.reopened'))?.impersonationId).toBe(sessionId);
  });

  it('reads as the workspace and refuses every write, another workspace, and recordings', async () => {
    const wsHeader = { 'x-workspace-id': ws.workspaceId };
    const workspace = await call('GET', '/workspace', key, undefined, wsHeader);
    expect(workspace.status).toBe(200);
    expect(workspace.body.id).toBe(ws.workspaceId);
    const mine = await call('GET', '/workspaces', key);
    expect(mine.body).toEqual([{ id: ws.workspaceId, name: expect.any(String), role: 'owner' }]);
    expect((await call('GET', '/agents', key, undefined, wsHeader)).status).toBe(200);
    expect((await call('GET', '/wallet', key, undefined, wsHeader)).body.balance).toBe(495);
    const context = await call('GET', '/impersonation', key);
    expect(context.body.tenant_id).toBe(ws.workspaceId);
    expect(context.body.staff_email).toMatch(/^sup-/);

    const patch = await call('PATCH', '/workspace', key, { name: 'Hacked' }, wsHeader);
    expect(patch.status).toBe(403);
    expect(patch.body.code).toBe('IMPERSONATION_READ_ONLY');
    expect(
      (await call('POST', '/wallet/checkout', key, { pack_id: 'growth' }, wsHeader)).body.code,
    ).toBe('IMPERSONATION_READ_ONLY');
    expect((await call('POST', `/agents/${agentId}/pause`, key, {}, wsHeader)).body.code).toBe(
      'IMPERSONATION_READ_ONLY',
    );
    expect(
      (await call('GET', `/calls/${randomUUID()}/recording`, key, undefined, wsHeader)).body.code,
    ).toBe('IMPERSONATION_READ_ONLY');
    const other = await call('GET', '/workspace', key, undefined, {
      'x-workspace-id': randomUUID(),
    });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('NOT_A_MEMBER');
    expect(
      (await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } })).name,
    ).not.toBe('Hacked');
    expect((await call('GET', '/admin/me', key)).status).toBe(401);
  });

  it('ends from the portal, after which the credential is dead and the end is audited', async () => {
    const ended = await call('POST', '/impersonation/end', key);
    expect(ended.status).toBe(200);
    expect(ended.body.ended).toBe(true);
    const after = await call('GET', '/workspace', key, undefined, {
      'x-workspace-id': ws.workspaceId,
    });
    expect(after.status).toBe(401);
    const audit = await lastAudit('impersonation.ended');
    expect(audit?.impersonationId).toBe(sessionId);
    expect((audit?.afterJson as { ended_via: string }).ended_via).toBe('portal');
    expect(
      (await call('DELETE', `/admin/impersonations/${sessionId}`, staff.support.token)).body.ended,
    ).toBe(false);
    const me = await call('GET', '/admin/me', staff.support.token);
    expect((me.body.impersonations as unknown[]).length).toBe(0);
  });

  it('ends from the console too, and only the owner of the session or a super admin may', async () => {
    const started = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/impersonate`,
      staff.ops.token,
      { reason_code: 'support_investigation' },
    );
    expect(started.status).toBe(201);
    const id = started.body.id as string;
    expect((await call('DELETE', `/admin/impersonations/${id}`, staff.support.token)).status).toBe(
      403,
    );
    expect(
      (await call('DELETE', `/admin/impersonations/${id}`, staff.superAdmin.token)).body.ended,
    ).toBe(true);
    const key2 = new URLSearchParams(new URL(started.body.portal_url as string).hash.replace(/^#/, '')).get('key')!;
    // An ended session cannot be re-opened either.
    expect((await call('POST', `/admin/impersonations/${id}/open`, staff.ops.token, undefined)).status).toBe(409);
    expect(
      (await call('GET', '/workspace', key2, undefined, { 'x-workspace-id': ws.workspaceId }))
        .status,
    ).toBe(401);
  });
});

// --------------------------------------------------------------------------- audit

describe('SA14 audit log', () => {
  it('lists the rows above, filterable by workspace and action', async () => {
    const byTenant = await call(
      'GET',
      `/admin/audit?tenant_id=${ws.workspaceId}&limit=100`,
      staff.readOnly.token,
    );
    expect(byTenant.status).toBe(200);
    const actions = (
      byTenant.body.items as Array<{
        action: string;
        staff_email: string;
        request_id: string | null;
      }>
    ).map((r) => r.action);
    for (const a of [
      'credits.adjusted',
      'customer.paused',
      'customer.resumed',
      'agent.paused',
      'number.paused',
      'impersonation.started',
      'impersonation.ended',
    ])
      expect(actions).toContain(a);
    expect((byTenant.body.items as Array<{ staff_email: string }>)[0]!.staff_email).toMatch(
      /@metacognixion\.test$/,
    );
    expect(
      (byTenant.body.items as Array<{ request_id: string | null }>).every((r) => r.request_id),
    ).toBe(true);
    const byAction = await call('GET', `/admin/audit?action=kill_switch`, staff.readOnly.token);
    expect(
      (byAction.body.items as Array<{ action: string }>).every((r) =>
        r.action.startsWith('kill_switch'),
      ),
    ).toBe(true);
  });
});
