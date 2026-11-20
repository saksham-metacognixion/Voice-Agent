import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationsFeedService } from '../src/modules/notifications';
import { type D5Harness, addMember, createUser, createWorkspace, startD5Harness } from './d5-fixtures';
import { type PaidWorkspace, authFor, caller, paidWorkspace, publishedAgent } from './d6-fixtures';

/*
 * D1 Home and the §7.2 shell (ADR 0041): staff announcements by audience and window, the
 * Today card's messages and sentiment, the checklist's forwarding and team rows, the
 * pause ticket on the workspace and on an agent (staff vs customer), the notifications
 * bell as a read over the outbox with a per-member unread marker, and the §6.1 refusals
 * a viewer meets on the routes the Home buttons lead to.
 */

let h: D5Harness;
let app: NestFastifyApplication;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;
let ws: PaidWorkspace;
let other: PaidWorkspace;
let owner: Record<string, string>;
let viewerAuth: Record<string, string>;
let agentId: string;
let staffToken: string;

const reason = { reason_code: 'service_issue', note: 'd21 e2e' };

beforeAll(async () => {
  h = await startD5Harness({ workers: false });
  app = h.app;
  auth = authFor(h.customerTenant, { mfa: true });
  call = caller(app);
  const run = randomUUID().slice(0, 8);
  ws = await paidWorkspace(app, `d21-${run}`, 'growth');
  other = await paidWorkspace(app, `d21o-${run}`, 'starter');
  await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { onboardingCompletedAt: new Date(), onboardingStep: 7 } });
  owner = await auth(ws.sub, ws.workspaceId);
  const viewer = await addMember(ws.workspaceId, `d21v-${run}`, 'viewer');
  viewerAuth = await auth(viewer.sub, ws.workspaceId);
  agentId = await publishedAgent(call, owner);
  const staffRow = await adminDb.staffUser.create({ data: { authProviderId: `google-oauth2|d21-${run}`, email: `d21-${run}@metacognixion.test`, role: 'ops' } });
  staffToken = await h.staffTenant.mint(staffRow.authProviderId, { mfa: true });
});

afterAll(async () => {
  await h?.stop();
  await adminDb.$disconnect();
});

const staffCall = (method: string, path: string, body?: unknown) => call(method, path, { authorization: `Bearer ${staffToken}` }, body);

// --------------------------------------------------------------------------- announcements

describe('GET /announcements/active (H-03)', () => {
  it('answers the banners whose audience and window include the workspace, newest first, to every role', async () => {
    const stamp = randomUUID().slice(0, 6);
    const mk = (over: Partial<Prisma.AnnouncementCreateInput>) =>
      adminDb.announcement.create({ data: { type: 'banner', severity: 'info', ...over, body: `d21 ${stamp} ${over.body ?? ''}` } });
    const everyone = await mk({ body: 'everyone', severity: 'warning' });
    const growthOnly = await mk({ body: 'growth', audienceJson: { plans: ['growth'] }, createdAt: new Date(Date.now() - 60_000) });
    const starterOnly = await mk({ body: 'starter', audienceJson: { plans: ['starter'] } });
    const ended = await mk({ body: 'ended', endsAt: new Date(Date.now() - 1000) });
    const future = await mk({ body: 'future', startsAt: new Date(Date.now() + 3_600_000) });
    const email = await mk({ body: 'email', type: 'email' });
    const listed = await mk({ body: 'listed', audienceJson: { tenant_ids: [ws.workspaceId] }, dismissible: false });
    try {
      const res = await call('GET', '/announcements/active', owner);
      expect(res.status).toBe(200);
      const items = (res.body.items as Array<{ id: string; severity: string; body: string; dismissible: boolean }>).filter((a) => a.body.includes(`d21 ${stamp}`));
      expect(items.map((a) => a.id)).toEqual([listed.id, everyone.id, growthOnly.id]);
      expect(items[1]).toMatchObject({ severity: 'warning', dismissible: true });
      expect(items[0]!.dismissible).toBe(false);

      const asViewer = await call('GET', '/announcements/active', viewerAuth);
      expect(asViewer.status).toBe(200);
      expect((asViewer.body.items as Array<{ id: string }>).some((a) => a.id === everyone.id)).toBe(true);

      const starter = await call('GET', '/announcements/active', await auth(other.sub, other.workspaceId));
      const starterIds = (starter.body.items as Array<{ id: string }>).map((a) => a.id);
      expect(starterIds).toContain(starterOnly.id);
      expect(starterIds).not.toContain(growthOnly.id);
      expect(starterIds).not.toContain(listed.id);
    } finally {
      await adminDb.announcement.deleteMany({ where: { id: { in: [everyone.id, growthOnly.id, starterOnly.id, ended.id, future.id, email.id, listed.id] } } });
    }
  });
});

// --------------------------------------------------------------------------- stats

describe('GET /stats messages_taken and sentiment (H-07)', () => {
  it('counts captured messages and the sentiment split over today’s real analysed calls', async () => {
    const now = new Date();
    const mk = (id: string, analysis: Prisma.InputJsonValue | null, over: Partial<Prisma.CallUncheckedCreateInput> = {}) =>
      adminDb.call.create({
        data: { id, tenantId: ws.workspaceId, agentId, channel: 'phone', direction: 'inbound', status: 'analyzed', startedAt: now, endedAt: now, durationS: 30, analysisJson: analysis ?? Prisma.DbNull, ...over },
      });
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `d21stat_${randomUUID().slice(0, 8)}_${n}`);
    // Not messages for `messageCaptured()`, so not for the card either: a blank and a non-string callback.
    await mk(ids[6]!, { custom_analysis_data: { callback_number: ' \t' } });
    await mk(ids[7]!, { custom_analysis_data: { callback_number: 4165550101 } });
    await mk(ids[0]!, { user_sentiment: 'Positive', custom_analysis_data: { message_taken: true } });
    await mk(ids[1]!, { user_sentiment: 'Positive', custom_analysis_data: { callback_number: '+1 416 555 0100' } });
    await mk(ids[2]!, { user_sentiment: 'Negative', custom_analysis_data: { message_taken: false, callback_number: '' } });
    await mk(ids[3]!, { user_sentiment: 'Unknown', custom_analysis_data: {} });
    await mk(ids[4]!, { user_sentiment: 'Positive', custom_analysis_data: { message_taken: true } }, { isTest: true, channel: 'web' });
    await mk(ids[5]!, null, { status: 'ended' });
    try {
      const res = await call('GET', '/stats?range=today', owner);
      expect(res.status).toBe(200);
      expect(res.body.messages_taken).toBe(2);
      expect(res.body.sentiment).toEqual({ positive: 2, neutral: 0, negative: 1, unknown: 1 });
    } finally {
      await adminDb.call.deleteMany({ where: { id: { in: ids } } });
    }
  });
});

// --------------------------------------------------------------------------- checklist

describe('GET /workspace/checklist forwarding and team rows (H-10)', () => {
  it('has no forwarding row without a forwarding number, and follows the test and the invitation', async () => {
    const fresh = await createWorkspace(`d21c-${randomUUID().slice(0, 8)}`);
    const freshOwner = await auth(fresh.sub, fresh.workspaceId);
    let res = await call('GET', '/workspace/checklist', freshOwner);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ forwarding_tested: null, team_invited: false, all_done: false, complete: false });

    const number = await adminDb.phoneNumber.create({
      data: { tenantId: fresh.workspaceId, type: 'retell_twilio', status: 'active', e164: `+1416555${String(Math.floor(Math.random() * 9000) + 1000)}`, inboundToken: randomUUID(), forwardingFrom: '+14165550199', forwardingStatus: 'waiting_for_customer' },
    });
    res = await call('GET', '/workspace/checklist', freshOwner);
    expect(res.body.forwarding_tested).toBe(false);

    await adminDb.phoneNumber.update({ where: { id: number.id }, data: { forwardingTestJson: { status: 'landed', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), caller_id: 'ours' } } });
    res = await call('GET', '/workspace/checklist', freshOwner);
    expect(res.body.forwarding_tested).toBe(true);

    const invited = await call('POST', '/invites', freshOwner, { email: `d21i-${randomUUID().slice(0, 6)}@example.test`, role: 'viewer' });
    expect(invited.status).toBe(201);
    res = await call('GET', '/workspace/checklist', freshOwner);
    expect(res.body.team_invited).toBe(true);
    expect(res.body.all_done).toBe(false);
  });
});

// --------------------------------------------------------------------------- pause ticket

describe('paused by staff names the ticket (H-02)', () => {
  it('carries the ticket on the workspace and on an agent, and tells a customer pause apart', async () => {
    const opened = await call('POST', '/support/tickets', owner, { subject: 'd21 pause', body: 'Please look into this.' });
    expect(opened.status).toBe(201);
    const ticketId = opened.body.id as number;

    const paused = await staffCall('POST', `/admin/customers/${ws.workspaceId}/pause`, { ...reason, ticket_id: ticketId });
    expect(paused.status).toBe(200);
    let w = await call('GET', '/workspace', owner);
    expect(w.body).toMatchObject({ paused: true, paused_ticket_id: ticketId });
    expect(await staffCall('POST', `/admin/customers/${ws.workspaceId}/resume`, reason)).toMatchObject({ status: 200 });
    w = await call('GET', '/workspace', owner);
    expect(w.body).toMatchObject({ paused: false, paused_ticket_id: null });

    // A ticket of another workspace is not recorded.
    const foreign = await call('POST', '/support/tickets', await auth(other.sub, other.workspaceId), { subject: 'other', body: 'Not this workspace.' });
    expect(await staffCall('POST', `/admin/customers/${ws.workspaceId}/pause`, { ...reason, ticket_id: foreign.body.id })).toMatchObject({ status: 200 });
    w = await call('GET', '/workspace', owner);
    expect(w.body).toMatchObject({ paused: true, paused_ticket_id: null });
    await staffCall('POST', `/admin/customers/${ws.workspaceId}/resume`, reason);

    // An agent: staff with the ticket, then the customer's own pause.
    expect(await staffCall('POST', `/admin/agents/${agentId}/pause`, { ...reason, ticket_id: ticketId })).toMatchObject({ status: 200 });
    let agents = await call('GET', '/agents', owner);
    let row = (agents.body.items as Array<Record<string, unknown>>).find((a) => a.id === agentId)!;
    expect(row).toMatchObject({ status: 'paused', paused_by: 'staff', paused_ticket_id: ticketId });
    expect(await staffCall('POST', `/admin/agents/${agentId}/resume`, reason)).toMatchObject({ status: 200 });
    agents = await call('GET', '/agents', owner);
    row = (agents.body.items as Array<Record<string, unknown>>).find((a) => a.id === agentId)!;
    expect(row).toMatchObject({ status: 'live', paused_by: null, paused_ticket_id: null });

    expect(await call('POST', `/agents/${agentId}/pause`, owner, {})).toMatchObject({ status: 201 });
    agents = await call('GET', '/agents', owner);
    row = (agents.body.items as Array<Record<string, unknown>>).find((a) => a.id === agentId)!;
    expect(row).toMatchObject({ status: 'paused', paused_by: 'customer', paused_ticket_id: null });
    expect(await call('POST', `/agents/${agentId}/resume`, owner, {})).toMatchObject({ status: 201 });
  });

  it('answers the D1 card facts on the list: the number, and whether the draft has a script', async () => {
    const agents = await call('GET', '/agents', owner);
    const row = (agents.body.items as Array<Record<string, unknown>>).find((a) => a.id === agentId)!;
    expect(row.draft_has_prompt).toBe(true);
    expect(row.number_e164).toBeNull();
    expect(JSON.stringify(row).toLowerCase()).not.toContain('retell');
  });
});

// --------------------------------------------------------------------------- the bell

describe('GET /notifications and POST /notifications/seen (S-04)', () => {
  it('lists the member’s outbox rows with an unread count, marks them seen per member, and records an event once', async () => {
    const feed = app.get(NotificationsFeedService);
    const numberId = randomUUID();
    const first = await feed.record({ workspaceId: ws.workspaceId, kind: 'number_active', dedupeKey: `number_active:${numberId}`, payload: { number_id: numberId, e164: '+14165550123', secret_text: 'never shown' } });
    const again = await feed.record({ workspaceId: ws.workspaceId, kind: 'number_active', dedupeKey: `number_active:${numberId}`, payload: { number_id: numberId, e164: '+14165550123' } });
    expect(first).toEqual({ recorded: true });
    expect(again).toEqual({ recorded: false });
    // An email the owner was sent (the D7 outbox) is the owner's bell row, nobody else's.
    await adminDb.notification.create({
      data: { tenantId: ws.workspaceId, userId: ws.userId, kind: 'low_balance', dedupeKey: `d21-low-${randomUUID()}`, channel: 'email', status: 'sent', recipient: ws.email, subject: 'Low balance', payloadJson: { balance: 12.5, pct: 20, text: 'Dear owner, …' } },
    });
    // A decision not to send is not news.
    await adminDb.notification.create({ data: { tenantId: ws.workspaceId, kind: 'daily_digest', dedupeKey: `d21-digest-${randomUUID()}`, channel: 'none', status: 'skipped' } });

    const mine = await call('GET', '/notifications', owner);
    expect(mine.status).toBe(200);
    const items = mine.body.items as Array<{ kind: string; meta: Record<string, unknown> | null; unread: boolean }>;
    expect(items.map((i) => i.kind)).toEqual(['low_balance', 'number_active']);
    expect(items[0]!.meta).toEqual({ balance: 12.5, pct: 20 });
    expect(items[1]!.meta).toEqual({ number_id: numberId, e164: '+14165550123' });
    expect(JSON.stringify(mine.body)).not.toContain('Dear owner');
    expect(mine.body.unread).toBe(2);
    expect(mine.body.seen_at).toBeNull();

    const theirs = await call('GET', '/notifications', viewerAuth);
    expect((theirs.body.items as Array<{ kind: string }>).map((i) => i.kind)).toEqual(['number_active']);
    expect(theirs.body.unread).toBe(1);

    const seen = await call('POST', '/notifications/seen', owner, {});
    expect(seen.status).toBe(201);
    expect(typeof seen.body.seen_at).toBe('string');
    const after = await call('GET', '/notifications', owner);
    expect(after.body.unread).toBe(0);
    expect((after.body.items as Array<{ unread: boolean }>).every((i) => !i.unread)).toBe(true);
    // The viewer's marker is their own.
    expect((await call('GET', '/notifications', viewerAuth)).body.unread).toBe(1);

    // Another workspace sees none of it.
    const elsewhere = await call('GET', '/notifications', await auth(other.sub, other.workspaceId));
    expect((elsewhere.body.items as unknown[]).length).toBe(0);
  });

  it('lets an owner under the money-at-risk rule mark the bell read without a second factor', async () => {
    const bound = await paidWorkspace(app, `d21m-${randomUUID().slice(0, 8)}`, 'growth');
    await adminDb.tenant.update({
      where: { id: bound.workspaceId },
      data: { autoTopupJson: { enabled: true, pack_id: 'growth', threshold: 50, payment_method_id: 'pm_d21', card_last4: '4242' } },
    });
    const noFactor = await authFor(h.customerTenant)(bound.sub, bound.workspaceId);
    // The rule does bind this session…
    expect((await call('PATCH', '/workspace', noFactor, { name: 'd21 renamed' })).body.code).toBe('MFA_REQUIRED');
    // …and the bell is exempt from it.
    const seen = await call('POST', '/notifications/seen', noFactor, {});
    expect(seen.status).toBe(201);
    expect(typeof seen.body.seen_at).toBe('string');
  });

  it('writes a member_joined row when an invitation is accepted', async () => {
    const invitee = await createUser(`d21j-${randomUUID().slice(0, 6)}`);
    const invited = await call('POST', '/invites', owner, { email: invitee.email, role: 'viewer' });
    expect(invited.status).toBe(201);
    const token = invited.body.token as string;
    expect(token).toBeTruthy();
    const accepted = await call('POST', `/invites/${encodeURIComponent(token)}/accept`, await auth(invitee.sub), {});
    expect(accepted.status).toBe(201);
    const feed = await call('GET', '/notifications', owner);
    const joined = (feed.body.items as Array<{ kind: string; meta: Record<string, unknown> | null }>).find((i) => i.kind === 'member_joined');
    expect(joined?.meta).toEqual({ email: invitee.email, role: 'viewer' });
  });
});

// --------------------------------------------------------------------------- viewer refusals

describe('a viewer on the routes the Home buttons lead to (H-09)', () => {
  it('may read the dashboard and is refused Top up and Publish by the API', async () => {
    expect((await call('GET', '/wallet', viewerAuth)).status).toBe(200);
    expect((await call('GET', '/stats?range=today', viewerAuth)).status).toBe(200);
    expect((await call('GET', '/workspace/checklist', viewerAuth)).status).toBe(200);
    expect((await call('GET', '/agents', viewerAuth)).status).toBe(200);
    const checkout = await call('POST', '/wallet/checkout', viewerAuth, { pack_id: 'growth' });
    expect(checkout.status).toBe(403);
    expect(checkout.body.code).toBe('FORBIDDEN_ROLE');
    const publish = await call('POST', `/agents/${agentId}/publish`, viewerAuth, {});
    expect(publish.status).toBe(403);
    expect(publish.body.code).toBe('FORBIDDEN_ROLE');
    const test = await call('POST', `/agents/${agentId}/test/web`, viewerAuth, {});
    expect(test.status).toBe(403);
  });
});
