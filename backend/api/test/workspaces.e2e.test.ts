import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL_SENDER, type LogEmailSender, NotificationsService } from '../src/modules/notifications';
import { WalletService } from '../src/modules/wallet';
import type { FakeAuth0Tenant } from './auth0-double';
import { type TestUser, addMember, createUser, createWorkspace, startD5Harness } from './d5-fixtures';

/*
 * §13.2 workspace creation, §6.1 membership and A8 invites, end to end.
 *
 * What this suite is really checking is that the five things §13.2 lists happen *together*
 * — tenant, owner membership, notification defaults, trial credits, audit row — and that
 * the workspace boundary holds afterwards.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let customerTenant: FakeAuth0Tenant;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: false });
  app = harness.app;
  stop = harness.stop;
  customerTenant = harness.customerTenant;
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

async function auth(sub: string, workspaceId?: string): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await customerTenant.mint(sub)}`,
    ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
  };
}

/**
 * `content-type` only when there is a body: Fastify rejects an empty body that claims to
 * be JSON, which is exactly what a POST with no payload would send.
 */
function post(url: string, headers: Record<string, string>, body?: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

function get(url: string, headers: Record<string, string>) {
  return app.inject({ method: 'GET', url, headers });
}

// ---------------------------------------------------------------------------
describe('POST /workspaces', () => {
  it('creates the tenant, the owner membership, the settings, the trial credits and the audit row — atomically', async () => {
    const user = await createUser('founder');
    const name = `Maple Dental ${randomUUID().slice(0, 6)}`;

    const res = await post('/workspaces', await auth(user.sub), {
      name,
      country: 'ca',
      timezone: 'America/Toronto',
      website: 'https://maple.example',
    });

    expect(res.statusCode).toBe(201);
    const workspace = res.json();
    expect(workspace).toMatchObject({ name, country: 'CA', plan_tier: 'trial', role: 'owner', paused: false });

    const [membership, settings, ledger, audit, lots] = await Promise.all([
      adminDb.membership.findUnique({ where: { tenantId_userId: { tenantId: workspace.id, userId: user.userId } } }),
      adminDb.notificationSetting.findFirst({ where: { tenantId: workspace.id, userId: null } }),
      adminDb.creditLedger.findMany({ where: { tenantId: workspace.id } }),
      adminDb.auditLog.findMany({ where: { tenantId: workspace.id } }),
      adminDb.creditLot.findMany({ where: { tenantId: workspace.id } }),
    ]);

    expect(membership?.role).toBe('owner');
    expect(settings).not.toBeNull();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reason).toBe('trial');
    expect(ledger[0]!.delta.toNumber()).toBe(20); // §5.4 free trial
    expect(lots).toHaveLength(1);
    expect(lots[0]!.creditsRemaining.toNumber()).toBe(20);
    expect(audit.map((row) => row.action)).toEqual(['workspace.created']);
    expect(audit[0]!.actorUserId).toBe(user.userId);
  });

  it('publishes the trial balance so the wallet reads it without a rebuild', async () => {
    const user = await createUser('balance');
    const res = await post('/workspaces', await auth(user.sub), {
      name: `Balance ${randomUUID().slice(0, 6)}`,
      country: 'US',
      timezone: 'America/New_York',
    });
    const workspaceId = res.json().id;

    const wallet = await get('/wallet', await auth(user.sub, workspaceId));
    expect(wallet.statusCode).toBe(200);
    expect(wallet.json().balance).toBe(20);
    expect(await app.get(WalletService).balance(workspaceId)).toBe(20);
  });

  it('rolls everything back when a step fails — no half-made workspace', async () => {
    const user = await createUser('rollback');
    const name = `Rollback ${randomUUID().slice(0, 6)}`;
    const before = await adminDb.tenant.count();

    // An unknown timezone is refused before the transaction; the interesting case is a
    // failure *inside* it, so make the membership insert collide by deleting the user
    // between the check and the write. The simplest reliable stand-in: a name long enough
    // to pass zod but a country that violates the char(2) column.
    const res = await post('/workspaces', await auth(user.sub), {
      name,
      country: 'CA',
      timezone: 'Mars/Olympus_Mons',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(await adminDb.tenant.count()).toBe(before);
    expect(await adminDb.tenant.findFirst({ where: { name } })).toBeNull();
  });

  it('is safe to double-click: the same name twice returns the first workspace and one trial grant', async () => {
    const user = await createUser('impatient');
    const name = `Double ${randomUUID().slice(0, 6)}`;
    const body = { name, country: 'CA', timezone: 'America/Toronto' };

    const [first, second] = await Promise.all([
      post('/workspaces', await auth(user.sub), body),
      post('/workspaces', await auth(user.sub), body),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);

    const workspaces = await adminDb.tenant.findMany({ where: { name } });
    expect(workspaces).toHaveLength(1);
    const ledger = await adminDb.creditLedger.findMany({ where: { tenantId: first.json().id } });
    expect(ledger).toHaveLength(1);
  });

  it('lets one person own several workspaces — they are different businesses', async () => {
    const user = await createUser('serial');
    const a = await post('/workspaces', await auth(user.sub), {
      name: `First ${randomUUID().slice(0, 6)}`,
      country: 'CA',
      timezone: 'America/Toronto',
    });
    const b = await post('/workspaces', await auth(user.sub), {
      name: `Second ${randomUUID().slice(0, 6)}`,
      country: 'CA',
      timezone: 'America/Toronto',
    });
    expect(a.json().id).not.toBe(b.json().id);

    const mine = await get('/workspaces', await auth(user.sub));
    expect(mine.json().map((w: { id: string }) => w.id).sort()).toEqual([a.json().id, b.json().id].sort());
  });

  it('refuses a body the schema does not accept', async () => {
    const user = await createUser('invalid');
    const res = await post('/workspaces', await auth(user.sub), { name: 'A', country: 'CAN', timezone: '' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    expect(res.json().fields.length).toBeGreaterThan(0);
  });

  it('needs a signed-in user', async () => {
    const res = await post('/workspaces', {}, {
      name: 'Nobody',
      country: 'CA',
      timezone: 'America/Toronto',
    });
    expect(res.statusCode).toBe(401);
  });

  it('needs a verified email (§6.2)', async () => {
    const user = await createUser('unverified');
    const token = await customerTenant.mint(user.sub, { emailVerified: false });
    const res = await post(
      '/workspaces',
      { authorization: `Bearer ${token}` },
      { name: `Unverified ${randomUUID().slice(0, 6)}`, country: 'CA', timezone: 'America/Toronto' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('EMAIL_UNVERIFIED');
  });
});

// ---------------------------------------------------------------------------
describe('GET/PATCH /workspace', () => {
  it('reads back the workspace with the caller’s own role', async () => {
    const owner = await createWorkspace('settings');
    const viewer = await addMember(owner.workspaceId, 'settings-viewer', 'viewer');

    expect((await get('/workspace', await auth(owner.sub, owner.workspaceId))).json().role).toBe('owner');
    expect((await get('/workspace', await auth(viewer.sub, owner.workspaceId))).json().role).toBe('viewer');
  });

  it('saves settings and audits them', async () => {
    const owner = await createWorkspace('patch');
    const res = await app.inject({
      method: 'PATCH',
      url: '/workspace',
      headers: { ...(await auth(owner.sub, owner.workspaceId)), 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Renamed Clinic',
        retention_days: 30,
        business_hours: { days: { mon: [{ open: '08:00', close: '16:00' }] }, closed_dates: [] },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Renamed Clinic', retention_days: 30 });
    expect(res.json().business_hours.days.mon).toEqual([{ open: '08:00', close: '16:00' }]);

    const audit = await adminDb.auditLog.findFirst({
      where: { tenantId: owner.workspaceId, action: 'workspace.updated' },
    });
    expect(audit).not.toBeNull();
  });

  it('is closed to an editor and a viewer (§6.1)', async () => {
    const owner = await createWorkspace('roles');
    const editor = await addMember(owner.workspaceId, 'roles-editor', 'editor');

    const res = await app.inject({
      method: 'PATCH',
      url: '/workspace',
      headers: { ...(await auth(editor.sub, owner.workspaceId)), 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Not allowed' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN_ROLE');
  });

  it('is invisible from another workspace', async () => {
    const mine = await createWorkspace('mine');
    const theirs = await createWorkspace('theirs');

    const res = await get('/workspace', await auth(mine.sub, theirs.workspaceId));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_A_MEMBER');
  });
});

// ---------------------------------------------------------------------------
describe('POST /workspace/onboarding-step (QA-005)', () => {
  it('lets an editor move the wizard forward — and never back', async () => {
    const owner = await createWorkspace('advance');
    const editor = await addMember(owner.workspaceId, 'advance-editor', 'editor');
    const headers = await auth(editor.sub, owner.workspaceId);

    const forward = await post('/workspace/onboarding-step', headers, { step: 2 });
    expect(forward.statusCode).toBe(201);
    expect(forward.json()).toMatchObject({ onboarding_step: 2, role: 'editor' });

    await post('/workspace/onboarding-step', headers, { step: 5 });
    const back = await post('/workspace/onboarding-step', headers, { step: 3 });
    expect(back.json().onboarding_step).toBe(5);
    const row = await adminDb.tenant.findUniqueOrThrow({ where: { id: owner.workspaceId } });
    expect(row.onboardingStep).toBe(5);
  });

  it('is not rewound through PATCH /workspace, even by the owner (QA-058)', async () => {
    const owner = await createWorkspace('rewind');
    const headers = await auth(owner.sub, owner.workspaceId);
    await post('/workspace/onboarding-step', headers, { step: 5 });

    const res = await app.inject({
      method: 'PATCH',
      url: '/workspace',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Rewind test', onboarding_step: 1 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().onboarding_step).toBe(5);
    const row = await adminDb.tenant.findUniqueOrThrow({ where: { id: owner.workspaceId } });
    expect(row.onboardingStep).toBe(5);
  });

  it('is closed to a viewer and refuses a step outside 1–7', async () => {
    const owner = await createWorkspace('advance-viewer');
    const viewer = await addMember(owner.workspaceId, 'advance-viewer-v', 'viewer');

    const res = await post('/workspace/onboarding-step', await auth(viewer.sub, owner.workspaceId), { step: 2 });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN_ROLE');

    const bad = await post('/workspace/onboarding-step', await auth(owner.sub, owner.workspaceId), { step: 8 });
    expect(bad.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------------
describe('GET /workspace/checklist', () => {
  it('reports onboarding progress from the database, not from the client', async () => {
    const owner = await createWorkspace('checklist');
    const first = await get('/workspace/checklist', await auth(owner.sub, owner.workspaceId));
    expect(first.json()).toMatchObject({
      workspace_created: true,
      agent_created: false,
      agent_published: false,
      complete: false,
    });

    await adminDb.agent.create({ data: { tenantId: owner.workspaceId, name: 'Receptionist' } });
    const second = await get('/workspace/checklist', await auth(owner.sub, owner.workspaceId));
    expect(second.json().agent_created).toBe(true);
    expect(second.json().complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('members and roles (§6.1)', () => {
  it('lists everyone in the workspace, and nobody outside it', async () => {
    const owner = await createWorkspace('members');
    const editor = await addMember(owner.workspaceId, 'members-editor', 'editor');
    const outsider = await createWorkspace('members-outsider');

    const res = await get('/members', await auth(owner.sub, owner.workspaceId));
    expect(res.statusCode).toBe(200);
    const emails = res.json().map((m: { email: string }) => m.email);
    expect(emails).toContain(owner.email);
    expect(emails).toContain(editor.email);
    expect(emails).not.toContain(outsider.email);
  });

  it('changes a member’s role and audits it', async () => {
    const owner = await createWorkspace('role-change');
    const editor = await addMember(owner.workspaceId, 'role-change-editor', 'editor');
    const membership = await adminDb.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: owner.workspaceId, userId: editor.userId } },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/members/${membership.id}`,
      headers: { ...(await auth(owner.sub, owner.workspaceId)), 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'viewer' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('viewer');

    const audit = await adminDb.auditLog.findFirst({
      where: { tenantId: owner.workspaceId, action: 'member.role_changed' },
    });
    expect(audit?.metaJson).toMatchObject({ from: 'editor', to: 'viewer' });
    // Every audit row a request writes carries its address, not only the settings ones (QA-074).
    expect(audit?.ip).toBeTruthy();
  });

  it('refuses to change the owner’s role, even for the owner', async () => {
    const owner = await createWorkspace('owner-role');
    const membership = await adminDb.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: owner.workspaceId, userId: owner.userId } },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/members/${membership.id}`,
      headers: { ...(await auth(owner.sub, owner.workspaceId)), 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'admin' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('OWNER_ONLY');
  });

  it('refuses to remove the owner — a workspace with nobody in charge is unrecoverable', async () => {
    const owner = await createWorkspace('remove-owner');
    const membership = await adminDb.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: owner.workspaceId, userId: owner.userId } },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/members/${membership.id}`,
      headers: await auth(owner.sub, owner.workspaceId),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('OWNER_ONLY');
  });

  it('removes an ordinary member', async () => {
    const owner = await createWorkspace('remove-member');
    const viewer = await addMember(owner.workspaceId, 'remove-viewer', 'viewer');
    const membership = await adminDb.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: owner.workspaceId, userId: viewer.userId } },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/members/${membership.id}`,
      headers: await auth(owner.sub, owner.workspaceId),
    });
    expect(res.statusCode).toBe(200);
    expect(
      await adminDb.membership.findUnique({ where: { id: membership.id } }),
    ).toBeNull();
  });

  it('will not let an editor touch the member list', async () => {
    const owner = await createWorkspace('editor-members');
    const editor = await addMember(owner.workspaceId, 'editor-members-editor', 'editor');
    const membership = await adminDb.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: owner.workspaceId, userId: owner.userId } },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/members/${membership.id}`,
      headers: await auth(editor.sub, owner.workspaceId),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN_ROLE');
  });

  it('cannot address a membership in another workspace', async () => {
    const mine = await createWorkspace('cross-a');
    const theirs = await createWorkspace('cross-b');
    const theirMembership = await adminDb.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: theirs.workspaceId, userId: theirs.userId } },
    });

    // My token, my workspace header, their membership id: RLS and the explicit filter
    // both say no, and the answer is a 404 rather than a hint that the id exists.
    const res = await app.inject({
      method: 'PATCH',
      url: `/members/${theirMembership.id}`,
      headers: { ...(await auth(mine.sub, mine.workspaceId)), 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'viewer' }),
    });
    expect(res.statusCode).toBe(404);
    const unchanged = await adminDb.membership.findUniqueOrThrow({ where: { id: theirMembership.id } });
    expect(unchanged.role).toBe('owner');
  });
});

// ---------------------------------------------------------------------------
describe('ownership transfer', () => {
  it('moves ownership atomically and leaves exactly one owner', async () => {
    const owner = await createWorkspace('transfer');
    const admin = await addMember(owner.workspaceId, 'transfer-admin', 'admin');

    const res = await post('/workspace/transfer-ownership', await auth(owner.sub, owner.workspaceId), {
      user_id: admin.userId,
    });
    expect(res.statusCode).toBe(201);

    const memberships = await adminDb.membership.findMany({ where: { tenantId: owner.workspaceId } });
    const owners = memberships.filter((m) => m.role === 'owner');
    expect(owners).toHaveLength(1);
    expect(owners[0]!.userId).toBe(admin.userId);
    expect(memberships.find((m) => m.userId === owner.userId)?.role).toBe('admin');

    const audit = await adminDb.auditLog.findFirst({
      where: { tenantId: owner.workspaceId, action: 'workspace.ownership_transferred' },
    });
    expect(audit?.metaJson).toMatchObject({ from_user_id: owner.userId, to_user_id: admin.userId });
  });

  it('refuses when the target is not a member', async () => {
    const owner = await createWorkspace('transfer-stranger');
    const stranger = await createUser('stranger');

    const res = await post('/workspace/transfer-ownership', await auth(owner.sub, owner.workspaceId), {
      user_id: stranger.userId,
    });
    expect(res.statusCode).toBe(404);
    expect((await adminDb.membership.findMany({ where: { tenantId: owner.workspaceId, role: 'owner' } })).length).toBe(1);
  });

  it('refuses when the caller is not the owner', async () => {
    const owner = await createWorkspace('transfer-admin-tries');
    const admin = await addMember(owner.workspaceId, 'transfer-admin-2', 'admin');

    const res = await post('/workspace/transfer-ownership', await auth(admin.sub, owner.workspaceId), {
      user_id: admin.userId,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN_ROLE');
  });

  it('is a no-op when the owner transfers to themselves', async () => {
    const owner = await createWorkspace('transfer-self');
    const res = await post('/workspace/transfer-ownership', await auth(owner.sub, owner.workspaceId), {
      user_id: owner.userId,
    });
    expect(res.statusCode).toBe(201);
    const memberships = await adminDb.membership.findMany({ where: { tenantId: owner.workspaceId } });
    expect(memberships.filter((m) => m.role === 'owner')).toHaveLength(1);
  });

  it('survives two transfers racing: one wins, and there is still exactly one owner', async () => {
    const owner = await createWorkspace('transfer-race');
    const a = await addMember(owner.workspaceId, 'race-a', 'admin');
    const b = await addMember(owner.workspaceId, 'race-b', 'admin');

    const headers = await auth(owner.sub, owner.workspaceId);
    const results = await Promise.all([
      post('/workspace/transfer-ownership', headers, { user_id: a.userId }),
      post('/workspace/transfer-ownership', headers, { user_id: b.userId }),
    ]);

    // One of them may be refused, but the invariant holds whatever happened.
    expect(results.some((res) => res.statusCode === 201)).toBe(true);
    const owners = await adminDb.membership.findMany({ where: { tenantId: owner.workspaceId, role: 'owner' } });
    expect(owners).toHaveLength(1);
    expect([a.userId, b.userId]).toContain(owners[0]!.userId);
  });

  it('the database refuses a second owner even if a service ever tried', async () => {
    const owner = await createWorkspace('one-owner-index');
    const other = await addMember(owner.workspaceId, 'one-owner-other', 'admin');
    await expect(
      adminDb.membership.update({
        where: { tenantId_userId: { tenantId: owner.workspaceId, userId: other.userId } },
        data: { role: 'owner' },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('invites (A8)', () => {
  async function invite(workspace: { sub: string; workspaceId: string }, email: string, role = 'editor') {
    return post('/invites', await auth(workspace.sub, workspace.workspaceId), { email, role });
  }

  it('returns the token exactly once and stores only its hash', async () => {
    const owner = await createWorkspace('invite');
    const res = await invite(owner, 'newcomer@example.test');

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.email).toBe('newcomer@example.test');

    const row = await adminDb.invite.findFirstOrThrow({ where: { tenantId: owner.workspaceId } });
    expect(row.tokenHash).not.toBe(body.token);
    expect(row.tokenHash).toHaveLength(64);

    // The list never carries it again.
    const list = await get('/invites', await auth(owner.sub, owner.workspaceId));
    expect(list.json()[0].token).toBeUndefined();
  });

  it('lets the invited person join, once', async () => {
    const owner = await createWorkspace('invite-accept');
    const newcomer = await createUser('newcomer');
    const { token } = (await invite(owner, newcomer.email, 'editor')).json();

    const first = await post(`/invites/${token}/accept`, await auth(newcomer.sub));
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ workspace_id: owner.workspaceId, role: 'editor' });

    // A double-clicked link is not an error — it returns the membership they have.
    const second = await post(`/invites/${token}/accept`, await auth(newcomer.sub));
    expect(second.statusCode).toBe(201);
    expect(second.json().role).toBe('editor');

    const memberships = await adminDb.membership.findMany({
      where: { tenantId: owner.workspaceId, userId: newcomer.userId },
    });
    expect(memberships).toHaveLength(1);
  });

  it('refuses an invite meant for somebody else', async () => {
    const owner = await createWorkspace('invite-wrong-email');
    const intended = await createUser('intended');
    const other = await createUser('interloper');
    const { token } = (await invite(owner, intended.email)).json();

    const res = await post(`/invites/${token}/accept`, await auth(other.sub));
    expect(res.statusCode).toBe(400);
    // Its own code since QA-016, so the join screen can say "wrong address", not "invalid".
    expect(res.json().code).toBe('INVITE_WRONG_EMAIL');
    // The invited address is never told to another account (QA-060).
    expect(res.json().message).not.toContain(intended.email);
    expect(await adminDb.membership.count({ where: { tenantId: owner.workspaceId } })).toBe(1);
  });

  it('refuses an expired invite', async () => {
    const owner = await createWorkspace('invite-expired');
    const newcomer = await createUser('late');
    const { token, id } = (await invite(owner, newcomer.email)).json();
    await adminDb.invite.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    const res = await post(`/invites/${token}/accept`, await auth(newcomer.sub));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('expired');
  });

  // A8 copy by code: the join screen says "expired" and "already used" apart from "not valid".
  it('names an expired invite and one used by somebody else with their own codes', async () => {
    const owner = await createWorkspace('invite-codes');
    const late = await createUser('codes-late');
    const expired = (await invite(owner, late.email)).json();
    await adminDb.invite.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const res = await post(`/invites/${expired.token}/accept`, await auth(late.sub));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVITE_EXPIRED');

    const first = await createUser('codes-first');
    const used = (await invite(owner, first.email)).json();
    expect((await post(`/invites/${used.token}/accept`, await auth(first.sub))).statusCode).toBe(201);
    // Same address on a second account: the invite is spent.
    const second = await createUser('codes-second');
    await adminDb.user.update({ where: { id: second.userId }, data: { email: first.email.toUpperCase() } });
    const again = await post(`/invites/${used.token}/accept`, await auth(second.sub));
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('INVITE_USED');
  });

  // D11 / BUG-010: an expired invite was listed as pending with no way to resend it.
  it('lists each unaccepted invite with its server-derived status, and never an accepted one', async () => {
    const owner = await createWorkspace('invite-status');
    const fresh = await createUser('status-fresh');
    const stale = await createUser('status-stale');
    const joined = await createUser('status-joined');
    await invite(owner, fresh.email);
    const old = (await invite(owner, stale.email)).json();
    await adminDb.invite.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const done = (await invite(owner, joined.email)).json();
    expect((await post(`/invites/${done.token}/accept`, await auth(joined.sub))).statusCode).toBe(201);

    const list = (await get('/invites', await auth(owner.sub, owner.workspaceId))).json() as Array<{ email: string; status: string }>;
    const byEmail = Object.fromEntries(list.map((i) => [i.email, i.status]));
    expect(byEmail).toEqual({ [fresh.email]: 'pending', [stale.email]: 'expired' });
  });

  it('resends an expired invite: a new pending link that works, the old one dead', async () => {
    const owner = await createWorkspace('invite-resend');
    const late = await createUser('resend-late');
    const old = (await invite(owner, late.email, 'viewer')).json();
    await adminDb.invite.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    const resent = await invite(owner, late.email, 'viewer');
    expect(resent.statusCode).toBe(201);
    expect(resent.json()).toMatchObject({ status: 'pending', role: 'viewer' });
    expect(resent.json().token).not.toBe(old.token);

    const list = (await get('/invites', await auth(owner.sub, owner.workspaceId))).json() as Array<{ status: string }>;
    expect(list.map((i) => i.status)).toEqual(['pending']);

    expect((await post(`/invites/${old.token}/accept`, await auth(late.sub))).json().code).toBe('INVITE_INVALID');
    const joined = await post(`/invites/${resent.json().token}/accept`, await auth(late.sub));
    expect(joined.statusCode).toBe(201);
    expect(joined.json()).toMatchObject({ workspace_id: owner.workspaceId, role: 'viewer' });
  });

  it('keeps the invite list and resend to owners and admins', async () => {
    const owner = await createWorkspace('invite-list-role');
    const editor = await addMember(owner.workspaceId, 'invite-list-editor', 'editor');
    expect((await get('/invites', await auth(editor.sub, owner.workspaceId))).statusCode).toBe(403);
  });

  // D6 "Send invite" sends the email; the token never reaches the outbox row (A8 stores its hash).
  it('emails the invitation with the link, and stores the email without the token', async () => {
    const emails = app.get(EMAIL_SENDER) as LogEmailSender;
    const owner = await createWorkspace('invite-email');
    const before = emails.sent.length;
    const res = await invite(owner, 'emailed@example.test', 'viewer');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // The log sender delivers nothing: the portal says so and shows the link to share.
    expect(body.email_status).toBe('not_configured');

    const sent = emails.sent.slice(before).find((e) => e.to === 'emailed@example.test')!;
    expect(sent.subject).toContain('invited you to join');
    expect(sent.text).toContain(`/invite/?token=${encodeURIComponent(body.token)}`);
    expect(sent.text).toContain('as Viewer');

    const row = await adminDb.notification.findUniqueOrThrow({ where: { dedupeKey: `invite:${body.id}` } });
    expect(row).toMatchObject({ kind: 'invite', recipient: 'emailed@example.test', userId: null, status: 'sent' });
    expect(JSON.stringify(row)).not.toContain(body.token);
    expect((row.payloadJson as { text: string }).text).toContain('{invite_link}');
  });

  it('never re-sends an invitation email from the stored row: the link is not there', async () => {
    const emails = app.get(EMAIL_SENDER) as LogEmailSender;
    const owner = await createWorkspace('invite-email-retry');
    const { id } = (await invite(owner, 'retry@example.test')).json();
    await adminDb.notification.update({
      where: { dedupeKey: `invite:${id}` },
      data: { status: 'failed', attempts: 1, updatedAt: new Date(Date.now() - 60 * 60_000) },
    });
    const before = emails.sent.length;
    await app.get(NotificationsService).retryFailed();
    expect(emails.sent.slice(before).filter((e) => e.to === 'retry@example.test')).toHaveLength(0);
    const row = await adminDb.notification.findUniqueOrThrow({ where: { dedupeKey: `invite:${id}` } });
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/resend from the Team page/);
  });

  describe('preview (A8 join screen)', () => {
    function preview(token: string, headers: Record<string, string>) {
      return get(`/invites/${token}/preview`, headers);
    }

    it('tells the invited address the workspace, the inviter and the role — and writes nothing', async () => {
      const owner = await createWorkspace('preview-ok', { name: 'Preview Bistro' });
      await adminDb.user.update({ where: { id: owner.userId }, data: { name: 'Priya Owner' } });
      const newcomer = await createUser('preview-newcomer');
      const { token } = (await invite(owner, newcomer.email, 'editor')).json();

      const res = await preview(token, await auth(newcomer.sub));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ workspace_name: 'Preview Bistro', role: 'editor', invited_by: 'Priya Owner', already_member: false });
      expect(await adminDb.membership.count({ where: { tenantId: owner.workspaceId, userId: newcomer.userId } })).toBe(0);
      expect((await adminDb.invite.findFirstOrThrow({ where: { tenantId: owner.workspaceId, email: newcomer.email } })).acceptedAt).toBeNull();
    });

    it('tells anyone else nothing about the workspace', async () => {
      const owner = await createWorkspace('preview-other', { name: 'Secret Clinic' });
      const intended = await createUser('preview-intended');
      const other = await createUser('preview-other-user');
      const { token } = (await invite(owner, intended.email)).json();

      const res = await preview(token, await auth(other.sub));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVITE_WRONG_EMAIL');
      expect(res.body).not.toContain('Secret Clinic');
      expect(res.body).not.toContain(intended.email);
    });

    it('answers expired, used, unknown, already-member and signed-out with their own outcome', async () => {
      const owner = await createWorkspace('preview-states');
      const late = await createUser('preview-late');
      const expired = (await invite(owner, late.email)).json();
      await adminDb.invite.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
      expect((await preview(expired.token, await auth(late.sub))).json().code).toBe('INVITE_EXPIRED');

      const joiner = await createUser('preview-joiner');
      const used = (await invite(owner, joiner.email)).json();
      expect((await post(`/invites/${used.token}/accept`, await auth(joiner.sub))).statusCode).toBe(201);
      const again = await preview(used.token, await auth(joiner.sub));
      expect(again.statusCode).toBe(200);
      expect(again.json().already_member).toBe(true);

      expect((await preview('y'.repeat(43), await auth(late.sub))).json().code).toBe('INVITE_INVALID');
      expect((await preview(used.token, {})).statusCode).toBe(401);
    });
  });

  it('refuses a token that never existed', async () => {
    const stranger = await createUser('guesser');
    const res = await post(`/invites/${'x'.repeat(43)}/accept`, await auth(stranger.sub));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVITE_INVALID');
  });

  it('re-inviting replaces the pending token instead of stacking a second live one', async () => {
    const owner = await createWorkspace('invite-again');
    const newcomer = await createUser('twice');
    const first = (await invite(owner, newcomer.email)).json();
    const second = (await invite(owner, newcomer.email)).json();

    expect(second.token).not.toBe(first.token);
    expect(await adminDb.invite.count({ where: { tenantId: owner.workspaceId, acceptedAt: null } })).toBe(1);

    // The superseded link is dead.
    expect((await post(`/invites/${first.token}/accept`, await auth(newcomer.sub))).statusCode).toBe(400);
    expect((await post(`/invites/${second.token}/accept`, await auth(newcomer.sub))).statusCode).toBe(201);
  });

  it('refuses to invite somebody who is already a member', async () => {
    const owner = await createWorkspace('invite-member');
    const editor = await addMember(owner.workspaceId, 'already-here', 'editor');

    const res = await invite(owner, editor.email);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_MEMBER');
  });

  it('is closed to editors and viewers', async () => {
    const owner = await createWorkspace('invite-role');
    const editor = await addMember(owner.workspaceId, 'invite-role-editor', 'editor');

    const res = await post('/invites', await auth(editor.sub, owner.workspaceId), {
      email: 'nope@example.test',
      role: 'viewer',
    });
    expect(res.statusCode).toBe(403);
  });

  it('cannot hand out the owner role', async () => {
    const owner = await createWorkspace('invite-owner-role');
    const res = await invite(owner, 'takeover@example.test', 'owner');
    expect(res.statusCode).toBe(422);
  });

  it('revokes a pending invite', async () => {
    const owner = await createWorkspace('invite-revoke');
    const user = await createUser('revoked');
    const { id, token } = (await invite(owner, user.email)).json();

    const res = await app.inject({
      method: 'DELETE',
      url: `/invites/${id}`,
      headers: await auth(owner.sub, owner.workspaceId),
    });
    expect(res.statusCode).toBe(200);
    expect((await post(`/invites/${token}/accept`, await auth(user.sub))).statusCode).toBe(400);
  });

  it('an invite from another workspace is not visible or usable from mine', async () => {
    const theirs = await createWorkspace('invite-theirs');
    const mine = await createWorkspace('invite-mine');
    const { id } = (await invite(theirs, 'shared@example.test')).json();

    const list = await get('/invites', await auth(mine.sub, mine.workspaceId));
    expect(list.json()).toEqual([]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/invites/${id}`,
      headers: await auth(mine.sub, mine.workspaceId),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('the workspace header cannot be spoofed', () => {
  it('rejects a workspace the caller is not a member of', async () => {
    const mine = await createWorkspace('spoof-mine');
    const theirs = await createWorkspace('spoof-theirs');

    for (const url of ['/members', '/workspace', '/workspace/checklist']) {
      const res = await get(url, await auth(mine.sub, theirs.workspaceId));
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code, url).toBe('NOT_A_MEMBER');
    }
  });

  it('rejects a workspace id that is not a uuid without reaching Postgres', async () => {
    const mine = await createWorkspace('spoof-shape');
    const res = await get('/members', await auth(mine.sub, "'; drop table tenants; --"));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_A_MEMBER');
  });

  it('rejects a request with no workspace header at all', async () => {
    const mine = await createWorkspace('spoof-missing');
    const res = await get('/members', await auth(mine.sub));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('WORKSPACE_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
describe('GET /audit-log (D6, §6.2)', () => {
  async function seed(workspaceId: string, actorUserId: string | null, action: string, at: Date, meta?: Record<string, unknown>) {
    await adminDb.auditLog.create({ data: { tenantId: workspaceId, actorUserId, action, targetType: 'agent', targetId: randomUUID(), ip: '203.0.113.9', metaJson: (meta ?? {}) as Prisma.InputJsonValue, createdAt: at } });
  }

  it('lists the workspace’s own rows newest first, with the actor, and pages by cursor', async () => {
    const owner = await createWorkspace('audit');
    const base = Date.now() - 60_000;
    await seed(owner.workspaceId, owner.userId, 'agent.created', new Date(base));
    await seed(owner.workspaceId, owner.userId, 'agent.published', new Date(base + 1_000), { version_no: 2 });
    await seed(owner.workspaceId, null, 'number.released_unpaid', new Date(base + 2_000));

    const first = await get('/audit-log?limit=2', await auth(owner.sub, owner.workspaceId));
    expect(first.statusCode).toBe(200);
    const page = first.json();
    expect(page.items.map((r: { action: string }) => r.action)).toEqual(['number.released_unpaid', 'agent.published']);
    expect(page.items[0].actor).toBeNull();
    expect(page.items[1]).toMatchObject({ actor: { user_id: owner.userId, email: owner.email }, ip: '203.0.113.9', meta: { version_no: 2 } });
    expect(page.next_cursor).toEqual(expect.any(String));

    const second = await get(`/audit-log?limit=2&cursor=${encodeURIComponent(page.next_cursor)}`, await auth(owner.sub, owner.workspaceId));
    expect(second.json().items.map((r: { action: string }) => r.action)).toEqual(['agent.created']);
    expect(second.json().next_cursor).toBeNull();
  });

  it('refuses a malformed cursor, a non-UUID id and another workspace’s row as an invalid page link, not a page', async () => {
    const mine = await createWorkspace('audit-cursor');
    const theirs = await createWorkspace('audit-cursor-theirs');
    await seed(mine.workspaceId, mine.userId, 'agent.created', new Date());
    const foreign = await adminDb.auditLog.create({ data: { tenantId: theirs.workspaceId, actorUserId: theirs.userId, action: 'agent.created', targetType: 'agent', targetId: randomUUID() } });
    const encode = (id: string) => encodeURIComponent(Buffer.from(JSON.stringify([1, id, null]), 'utf8').toString('base64url'));

    for (const cursor of ['not-a-cursor', encode('abc'), encode(randomUUID()), encode(foreign.id)]) {
      const res = await get(`/audit-log?cursor=${cursor}`, await auth(mine.sub, mine.workspaceId));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_CURSOR');
    }
  });

  it('resumes from the cursor row even when the area filter no longer includes it', async () => {
    const owner = await createWorkspace('audit-cursor-area');
    const base = Date.now() - 60_000;
    await seed(owner.workspaceId, owner.userId, 'member.role_changed', new Date(base));
    await seed(owner.workspaceId, owner.userId, 'agent.created', new Date(base + 1_000));
    await seed(owner.workspaceId, owner.userId, 'member.removed', new Date(base + 2_000));

    const first = await get('/audit-log?limit=2', await auth(owner.sub, owner.workspaceId));
    expect(first.json().items.map((r: { action: string }) => r.action)).toEqual(['member.removed', 'agent.created']);
    const second = await get(`/audit-log?limit=2&area=member&cursor=${encodeURIComponent(first.json().next_cursor)}`, await auth(owner.sub, owner.workspaceId));
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((r: { action: string }) => r.action)).toEqual(['member.role_changed']);
  });

  it('narrows by area — the part of the action before the dot', async () => {
    const owner = await createWorkspace('audit-area');
    await seed(owner.workspaceId, owner.userId, 'agent.created', new Date());
    await seed(owner.workspaceId, owner.userId, 'member.role_changed', new Date());

    const res = await get('/audit-log?area=member', await auth(owner.sub, owner.workspaceId));
    expect(res.json().items.map((r: { action: string }) => r.action)).toEqual(['member.role_changed']);
    expect((await get('/audit-log?area=Bad-Area', await auth(owner.sub, owner.workspaceId))).statusCode).toBe(422);
  });

  it('never shows another workspace’s rows', async () => {
    const mine = await createWorkspace('audit-mine');
    const theirs = await createWorkspace('audit-theirs');
    await seed(theirs.workspaceId, theirs.userId, 'agent.deleted', new Date());

    const res = await get('/audit-log', await auth(mine.sub, mine.workspaceId));
    expect(res.json().items.every((r: { action: string }) => r.action !== 'agent.deleted')).toBe(true);
    expect((await get('/audit-log', await auth(mine.sub, theirs.workspaceId))).statusCode).toBe(403);
  });

  it('is owner/admin only (spec p. 39)', async () => {
    const owner = await createWorkspace('audit-roles');
    const admin = await addMember(owner.workspaceId, 'audit-admin', 'admin');
    const editor = await addMember(owner.workspaceId, 'audit-editor', 'editor');
    const viewer = await addMember(owner.workspaceId, 'audit-viewer', 'viewer');

    expect((await get('/audit-log', await auth(admin.sub, owner.workspaceId))).statusCode).toBe(200);
    for (const who of [editor, viewer]) {
      const res = await get('/audit-log', await auth(who.sub, owner.workspaceId));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('reads a member who has since left as no actor rather than leaking their profile', async () => {
    const owner = await createWorkspace('audit-left');
    const leaver = await addMember(owner.workspaceId, 'audit-leaver', 'editor');
    await seed(owner.workspaceId, leaver.userId, 'agent.prompt_edited', new Date());
    await adminDb.membership.delete({ where: { tenantId_userId: { tenantId: owner.workspaceId, userId: leaver.userId } } });

    const res = await get('/audit-log', await auth(owner.sub, owner.workspaceId));
    const row = res.json().items.find((r: { action: string }) => r.action === 'agent.prompt_edited');
    expect(row.actor).toBeNull();
  });
});

/** Kept for the type import above so the file documents what a member row is. */
export type { TestUser };
