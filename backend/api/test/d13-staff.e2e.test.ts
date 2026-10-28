import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import type { AdminStaffLimitsResponse, StaffLimitsMatrix } from '@portal/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STAFF_INVITE_PREFIX } from '../src/modules/auth';
import { JOBS } from '../src/modules/jobs';
import { REDIS, type RedisLike, redisKeys } from '../src/modules/redis';
import { type D5Harness, startD5Harness } from './d5-fixtures';
import { paidWorkspace, type PaidWorkspace } from './d6-fixtures';

/*
 * D13 — SA13 staff & settings, and the SA7 provisioning queue + concurrency views
 * (admin spec §4 SA13 / SA7, §2.1, §2.2, §10).
 *
 * Against real Postgres, real Redis and the fake staff tenant:
 *   - the staff list, and an invite by a super admin with its audit row; an invite by
 *     ops refused on the route, a foreign domain refused with a field error;
 *   - the first sign-in of the invited email binds the row to that `sub`, and a second
 *     identity for the same email is refused;
 *   - role changes with before/after audit; self-demotion and the last active super
 *     admin are 409s; a deactivated member is refused on their very next request;
 *   - the limits matrix round trip with audit, the super-admin lock-out guard, and that
 *     a changed limit is what `/admin/me` reports;
 *   - the provisioning list shows an activation job with its step view and filters;
 *   - concurrency answers numeric `live` and a tenant entry from an `active:{ws}` field.
 */

/** Set before the harness boots and read lazily by the service, so a developer's `.env` value does not steer the test. */
const STAFF_DOMAIN = 'metacognixion.test';
process.env.STAFF_ALLOWED_EMAIL_DOMAIN = STAFF_DOMAIN;

let h: D5Harness;
let ws: PaidWorkspace;
let run: string;
let staff: Record<
  'superAdmin' | 'ops' | 'support',
  { sub: string; id: string; token: string; email: string }
>;
let originalLimits: StaffLimitsMatrix;

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{
  status: number;
  body: Record<string, unknown> & {
    code?: string;
    message?: string;
    fields?: Array<{ field: string; message: string }>;
  };
}> {
  const res = await h.app.inject({
    method: method as 'GET',
    url: path,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

async function lastAudit(action: string) {
  return adminDb.staffAuditLog.findFirst({ where: { action }, orderBy: { createdAt: 'desc' } });
}

beforeAll(async () => {
  h = await startD5Harness({ workers: false });
  run = randomUUID().slice(0, 8);
  const make = async (label: string, role: 'super_admin' | 'ops' | 'support') => {
    const email = `${label}-${run}@${STAFF_DOMAIN}`;
    const row = await adminDb.staffUser.create({
      data: { authProviderId: `google-oauth2|${label}-${run}`, email, role },
    });
    return {
      sub: row.authProviderId,
      id: row.id,
      email,
      token: await h.staffTenant.mint(row.authProviderId, { mfa: true }),
    };
  };
  staff = {
    superAdmin: await make('d13sa', 'super_admin'),
    ops: await make('d13ops', 'ops'),
    support: await make('d13sup', 'support'),
  };
  ws = await paidWorkspace(h.app, `d13-${run}`, 'growth');
  originalLimits = (
    (await call('GET', '/admin/staff/limits', staff.ops.token))
      .body as unknown as AdminStaffLimitsResponse
  ).limits;
}, 60_000);

afterAll(async () => {
  // Put the seed's matrix back exactly as it was found: d12 asserts on the support caps.
  if (originalLimits) {
    const restored = await call('PUT', '/admin/staff/limits', staff.superAdmin.token, {
      limits: originalLimits,
      note: 'd13 afterAll restore',
    });
    if (restored.status !== 200)
      throw new Error(`could not restore staff_role_limits: ${JSON.stringify(restored.body)}`);
  }
  await h?.stop();
  await adminDb.$disconnect();
});

// --------------------------------------------------------------------------- SA13 members

describe('SA13 staff members', () => {
  let invitedEmail: string;
  let invitedId: string;

  it('lists every staff member for any role, newest first, with `bound`', async () => {
    const res = await call('GET', '/admin/staff', staff.support.token);
    expect(res.status).toBe(200);
    const rows = res.body as unknown as Array<{
      id: string;
      email: string;
      bound: boolean;
      role: string;
    }>;
    const me = rows.find((r) => r.id === staff.superAdmin.id);
    expect(me).toMatchObject({ email: staff.superAdmin.email, role: 'super_admin', bound: true });
  });

  it('refuses an invite from ops on the route matrix', async () => {
    const res = await call('POST', '/admin/staff', staff.ops.token, {
      email: `x-${run}@${STAFF_DOMAIN}`,
      role: 'read_only',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('refuses an invite outside the staff domain with a field error', async () => {
    const res = await call('POST', '/admin/staff', staff.superAdmin.token, {
      email: `outsider-${run}@gmail.com`,
      role: 'ops',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.fields?.[0]?.field).toBe('email');
    expect(res.body.fields?.[0]?.message).toMatch(new RegExp(STAFF_DOMAIN));
  });

  it('invites a colleague as a super admin, unbound, with an audit row', async () => {
    invitedEmail = `Invitee-${run}@${STAFF_DOMAIN}`.toLowerCase();
    const res = await call('POST', '/admin/staff', staff.superAdmin.token, {
      email: `Invitee-${run}@${STAFF_DOMAIN}`,
      name: 'New Colleague',
      role: 'support',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: invitedEmail,
      name: 'New Colleague',
      role: 'support',
      active: true,
      bound: false,
      last_login_at: null,
    });
    invitedId = res.body.id as string;
    const row = await adminDb.staffUser.findUniqueOrThrow({ where: { id: invitedId } });
    expect(row.authProviderId).toBe(`${STAFF_INVITE_PREFIX}${invitedEmail}`);
    const audit = await lastAudit('staff.invited');
    expect(audit?.targetId).toBe(invitedId);
    expect(audit?.staffId).toBe(staff.superAdmin.id);
    expect(audit?.tenantId).toBeNull();

    const again = await call('POST', '/admin/staff', staff.superAdmin.token, {
      email: invitedEmail,
      role: 'ops',
    });
    expect(again.status).toBe(409);
  });

  it('binds the invite on first sign-in and refuses a second identity for the same email', async () => {
    const sub = `google-oauth2|invitee-${run}`;
    // A token that carries the email only as a bare `email` claim is not trusted: unknown subject.
    const untrusted = await h.staffTenant.mint(sub, { mfa: true });
    expect((await call('GET', '/admin/me', untrusted)).status).toBe(403);
    expect(
      (await adminDb.staffUser.findUniqueOrThrow({ where: { id: invitedId } })).authProviderId,
    ).toBe(`${STAFF_INVITE_PREFIX}${invitedEmail}`);

    const first = await h.staffTenant.mint(sub, { mfa: true, email: invitedEmail, name: 'Provider Name' });
    const me = await call('GET', '/admin/me', first);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: invitedId, email: invitedEmail, role: 'support' });
    expect(
      (await adminDb.staffUser.findUniqueOrThrow({ where: { id: invitedId } })).authProviderId,
    ).toBe(sub);
    const listed = (await call('GET', '/admin/staff', staff.ops.token)).body as unknown as Array<{
      id: string;
      bound: boolean;
    }>;
    expect(listed.find((r) => r.id === invitedId)?.bound).toBe(true);
    // The inviter typed a name: the identity provider's does not replace it (QA-065).
    expect((await adminDb.staffUser.findUniqueOrThrow({ where: { id: invitedId } })).name).toBe('New Colleague');

    const other = await h.staffTenant.mint(`google-oauth2|impostor-${run}`, {
      mfa: true,
      email: invitedEmail,
    });
    const refused = await call('GET', '/admin/me', other);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('STAFF_ONLY');
    expect(
      (await adminDb.staffUser.findUniqueOrThrow({ where: { id: invitedId } })).authProviderId,
    ).toBe(sub);
  });

  it('names an unnamed invite from the identity provider, and SA13 can correct it (QA-065)', async () => {
    const email = `unnamed-${run}@${STAFF_DOMAIN}`;
    const created = await call('POST', '/admin/staff', staff.superAdmin.token, { email, role: 'support' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBeNull();
    const id = created.body.id as string;

    const token = await h.staffTenant.mint(`google-oauth2|unnamed-${run}`, { mfa: true, email, name: 'Padma V' });
    expect((await call('GET', '/admin/me', token)).body).toMatchObject({ id, name: 'Padma V' });

    const renamed = await call('PATCH', `/admin/staff/${id}`, staff.superAdmin.token, { name: 'Padmavathi' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Padmavathi');
    expect((await lastAudit('staff.updated'))?.targetId).toBe(id);
    expect((await call('GET', '/admin/me', token)).body.name).toBe('Padmavathi');
  });

  it('changes a role with before/after in the audit row', async () => {
    const res = await call('PATCH', `/admin/staff/${invitedId}`, staff.superAdmin.token, {
      role: 'ops',
      note: 'joined the on-call rota',
    });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('ops');
    const audit = await lastAudit('staff.updated');
    expect(audit?.targetId).toBe(invitedId);
    expect(audit?.note).toBe('joined the on-call rota');
    expect((audit?.beforeJson as { role: string }).role).toBe('support');
    expect((audit?.afterJson as { role: string }).role).toBe('ops');
    expect(
      (await call('PATCH', `/admin/staff/${invitedId}`, staff.ops.token, { role: 'support' }))
        .status,
    ).toBe(403);
    expect(
      (await call('PATCH', `/admin/staff/${invitedId}`, staff.superAdmin.token, {})).status,
    ).toBe(422);
  });

  it('refuses self-demotion and self-deactivation', async () => {
    const demote = await call(
      'PATCH',
      `/admin/staff/${staff.superAdmin.id}`,
      staff.superAdmin.token,
      { role: 'ops' },
    );
    expect(demote.status).toBe(409);
    expect(demote.body.message).toMatch(/your own role/i);
    const off = await call('PATCH', `/admin/staff/${staff.superAdmin.id}`, staff.superAdmin.token, {
      active: false,
    });
    expect(off.status).toBe(409);
    // A rename of oneself is fine.
    expect(
      (
        await call('PATCH', `/admin/staff/${staff.superAdmin.id}`, staff.superAdmin.token, {
          name: 'D13 Super',
        })
      ).status,
    ).toBe(200);
  });

  it('refuses to demote or deactivate the last active super admin', async () => {
    // Every other active super admin (the seed's, earlier suites') is stood down for the assertion and restored after.
    const others = await adminDb.staffUser.findMany({
      where: { role: 'super_admin', active: true, id: { not: staff.superAdmin.id } },
      select: { id: true },
    });
    await adminDb.staffUser.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { active: false },
    });
    try {
      const demote = await call(
        'PATCH',
        `/admin/staff/${staff.superAdmin.id}`,
        staff.superAdmin.token,
        { role: 'finance' },
      );
      expect(demote.status).toBe(409);
      expect(demote.body.message).toMatch(/last active super admin/i);
      const off = await call(
        'PATCH',
        `/admin/staff/${staff.superAdmin.id}`,
        staff.superAdmin.token,
        { active: false },
      );
      expect(off.status).toBe(409);
      expect(off.body.message).toMatch(/last active super admin/i);
    } finally {
      await adminDb.staffUser.updateMany({
        where: { id: { in: others.map((o) => o.id) } },
        data: { active: true },
      });
    }
  });

  it('refuses a deactivated member on their very next request, and lets them back in on reactivation', async () => {
    const token = await h.staffTenant.mint(`google-oauth2|invitee-${run}`, { mfa: true });
    expect((await call('GET', '/admin/me', token)).status).toBe(200);
    const off = await call('PATCH', `/admin/staff/${invitedId}`, staff.superAdmin.token, {
      active: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    const refused = await call('GET', '/admin/me', token);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('STAFF_ONLY');
    expect(
      (await call('PATCH', `/admin/staff/${invitedId}`, staff.superAdmin.token, { active: true }))
        .status,
    ).toBe(200);
    expect((await call('GET', '/admin/me', token)).status).toBe(200);
  });
});

// --------------------------------------------------------------------------- SA13 limits

describe('SA13 role limits', () => {
  it('answers the whole matrix to any role and refuses a write from ops', async () => {
    const res = await call('GET', '/admin/staff/limits', staff.support.token);
    expect(res.status).toBe(200);
    const limits = (res.body as unknown as AdminStaffLimitsResponse).limits;
    expect(Object.keys(limits).sort()).toEqual([
      'finance',
      'ops',
      'read_only',
      'super_admin',
      'support',
    ]);
    expect(limits.super_admin.can_manage_staff).toBe(true);
    expect(limits.support.credit_adjust_max_per_action).toBe(50);
    const put = await call('PUT', '/admin/staff/limits', staff.ops.token, { limits });
    expect(put.status).toBe(403);
    expect(put.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('keeps the super admin able to manage staff', async () => {
    const limits: StaffLimitsMatrix = structuredClone(originalLimits);
    limits.super_admin.can_manage_staff = false;
    const res = await call('PUT', '/admin/staff/limits', staff.superAdmin.token, { limits });
    expect(res.status).toBe(409);
    expect((await call('GET', '/admin/staff/limits', staff.ops.token)).body).toMatchObject({
      limits: { super_admin: { can_manage_staff: true } },
    });
  });

  it('rewrites the matrix with audit, and /admin/me reports the new limits', async () => {
    const limits: StaffLimitsMatrix = structuredClone(originalLimits);
    limits.support.credit_adjust_max_per_action = 75;
    limits.support.refund_max_cents = 12_345;
    limits.read_only.can_export = true;
    const res = await call('PUT', '/admin/staff/limits', staff.superAdmin.token, {
      limits,
      note: 'd13 e2e',
    });
    expect(res.status).toBe(200);
    const body = res.body as unknown as AdminStaffLimitsResponse;
    expect(body.limits.support.credit_adjust_max_per_action).toBe(75);
    expect(body.limits.support.refund_max_cents).toBe(12_345);
    expect(body.limits.read_only.can_export).toBe(true);
    expect(body.updated_at).not.toBeNull();
    const audit = await lastAudit('staff.limits_updated');
    expect(audit?.staffId).toBe(staff.superAdmin.id);
    expect((audit?.beforeJson as StaffLimitsMatrix).support.credit_adjust_max_per_action).toBe(50);
    expect((audit?.afterJson as StaffLimitsMatrix).support.refund_max_cents).toBe(12_345);

    const me = await call('GET', '/admin/me', staff.support.token);
    expect(
      (me.body.limits as { credit_adjust_max_per_action: number; refund_max_cents: number })
        .credit_adjust_max_per_action,
    ).toBe(75);
    expect((me.body.limits as { refund_max_cents: number }).refund_max_cents).toBe(12_345);

    // A blank cap is "no ceiling"; a negative one is a validation failure.
    limits.support.credit_adjust_max_per_action = null;
    expect(
      (await call('PUT', '/admin/staff/limits', staff.superAdmin.token, { limits })).status,
    ).toBe(200);
    expect((await call('GET', '/admin/me', staff.support.token)).body.limits).toMatchObject({
      credit_adjust_max_per_action: null,
    });
    limits.support.credit_adjust_max_per_action = -1;
    expect(
      (await call('PUT', '/admin/staff/limits', staff.superAdmin.token, { limits })).status,
    ).toBe(422);
  });
});

// --------------------------------------------------------------------------- SA7 provisioning

describe('SA7 provisioning queue', () => {
  it('lists an activation job with its step view and filters by status', async () => {
    const agent = await adminDb.agent.create({
      data: {
        tenantId: ws.workspaceId,
        name: `Reception ${run}`,
        status: 'draft',
        tier: 'standard',
      },
    });
    const number = await adminDb.phoneNumber.create({
      data: {
        tenantId: ws.workspaceId,
        agentId: agent.id,
        type: 'retell_twilio',
        status: 'failed',
        country: 'CA',
        inboundToken: `tok13_${run}`,
      },
    });
    const job = await adminDb.job.create({
      data: {
        tenantId: ws.workspaceId,
        type: JOBS.activateAgent,
        status: 'failed',
        error: 'retell 503 on create-phone-number',
        payloadJson: {
          jobId: 'x',
          workspaceId: ws.workspaceId,
          agentId: agent.id,
          userId: ws.userId,
        },
        stepsJson: {
          agent_id: agent.id,
          activation_status: 'failed',
          activation_step: 'provision',
          attempt: 3,
          max_attempts: 3,
          number_id: number.id,
          customer_reason:
            'We could not get a phone number from the carrier. Try again in a few minutes.',
          error_kind: 'platform_5xx',
          steps: {
            publish: { status: 'completed' },
            provision: { status: 'failed', last_error: 'secret detail' },
            bind: { status: 'pending' },
            mark_live: { status: 'pending' },
            notify: { status: 'pending' },
          },
        },
      },
    });
    // The payload is set after the row exists so the deterministic id is the row's own.
    await adminDb.job.update({
      where: { id: job.id },
      data: {
        payloadJson: {
          jobId: job.id,
          workspaceId: ws.workspaceId,
          agentId: agent.id,
          userId: ws.userId,
        },
      },
    });

    const res = await call(
      'GET',
      `/admin/provisioning?tenant_id=${ws.workspaceId}`,
      staff.support.token,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const item = (res.body.items as Array<Record<string, unknown>>).find((j) => j.id === job.id)!;
    expect(item).toMatchObject({
      type: 'activate-agent',
      status: 'failed',
      retryable: true,
      tenant: { id: ws.workspaceId },
      agent: { id: agent.id, name: `Reception ${run}` },
      number: { id: number.id, e164: null, status: 'failed' },
      activation: {
        status: 'failed',
        step: 'provision',
        progress: 20,
        attempt: 3,
        max_attempts: 3,
        error: 'We could not get a phone number from the carrier. Try again in a few minutes.',
      },
    });
    expect(JSON.stringify(item)).not.toContain('secret detail');
    expect(JSON.stringify(item)).not.toContain('retell 503');

    const queued = await call(
      'GET',
      `/admin/provisioning?tenant_id=${ws.workspaceId}&status=queued`,
      staff.support.token,
    );
    expect(queued.body.total).toBe(0);
    expect(queued.body.items).toEqual([]);
    const failed = await call('GET', `/admin/provisioning?status=failed`, staff.support.token);
    expect((failed.body.items as Array<{ id: string }>).some((j) => j.id === job.id)).toBe(true);
  });
});

// --------------------------------------------------------------------------- SA7 concurrency

describe('SA7 concurrency', () => {
  it('answers numeric live calls and a tenant entry from an active:{ws} field', async () => {
    const redis = h.app.get<RedisLike>(REDIS);
    const key = redisKeys.activeCalls(ws.workspaceId);
    const callId = `call_d13_${run}`;
    try {
      await redis.hset(key, callId, `1.5|${Date.now() + 60_000}`);
      // An expired entry must be ignored, like the monitor does.
      await redis.hset(key, `${callId}_stale`, `1|${Date.now() - 1_000}`);
      await redis.expire(key, 120);
      const res = await call('GET', '/admin/concurrency', staff.support.token);
      expect(res.status).toBe(200);
      expect(typeof res.body.live).toBe('number');
      expect(res.body.complete).toBe(true);
      expect(res.body.live as number).toBeGreaterThanOrEqual(1);
      expect(['ok', 'warn', 'down']).toContain(res.body.signal);
      expect(typeof res.body.alert_threshold_pct).toBe('number');
      const mine = (res.body.tenants as Array<Record<string, unknown>>).find(
        (t) => t.tenant_id === ws.workspaceId,
      );
      expect(mine).toMatchObject({ live: 1, cap: 3, plan_tier: 'growth', pct_of_cap: 33 });
      expect(typeof mine?.tenant_name).toBe('string');
    } finally {
      await redis.del(key);
    }
  });
});
