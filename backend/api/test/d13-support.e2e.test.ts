import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOBS } from '../src/modules/jobs';
import { type D5Harness, createUser, startD5Harness } from './d5-fixtures';
import { paidWorkspace, type PaidWorkspace } from './d6-fixtures';

/*
 * D13 — SA4 support tickets (admin spec §4 SA4, §9, §10, §11 P1 "built-in tickets + macros")
 * and the customer side of the same rows (D7 Help "My tickets", spec §16 additions).
 *
 * What this proves against real Postgres, Redis and the two Auth0 stand-ins:
 *   - the queue: list, search by subject / number / customer, filter by status, priority,
 *     assignee ("me"), the §16 page with a total;
 *   - a ticket opened by staff carries the SLA clocks and a `ticket.created` audit row;
 *   - a ticket the customer opens through `/support/tickets` lands in the staff queue under
 *     the right workspace, and another workspace never sees it (RLS);
 *   - an internal note is invisible on the customer route (the RLS policy, not the UI);
 *   - a staff public reply sets `first_responded_at` and moves open → pending; a customer
 *     message reopens it;
 *   - PATCH transitions set and clear resolved_at / closed_at with a before/after audit row;
 *   - the macros: comp_credits moves credits through the wallet (a ledger row, a
 *     `credit_adjustments` row carrying this ticket's id, an audit row, a system line on the
 *     thread) and read-only staff are 403; refund_call credits the call's charge once and
 *     is 409 on a repeat, from any ticket; rerun_activation is 409 with no agent and queues the job otherwise;
 *   - canned responses: list, create, delete, audited;
 *   - a ticket id that is not a number is a 404, never a cast error.
 */

let h: D5Harness;
let ws: PaidWorkspace;
let other: PaidWorkspace;
let customerToken: string;
let viewerToken: string;
let otherToken: string;
let staff: Record<
  'superAdmin' | 'ops' | 'finance' | 'support' | 'readOnly',
  { sub: string; id: string; token: string }
>;
let callId: string;
let run: string;

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

const asCustomer = (workspaceId: string) => ({ 'x-workspace-id': workspaceId });

async function lastAudit(action: string, targetId?: string) {
  return adminDb.staffAuditLog.findFirst({
    where: { action, ...(targetId ? { targetId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

beforeAll(async () => {
  h = await startD5Harness({ workers: false });
  run = randomUUID().slice(0, 8);
  const make = async (
    label: string,
    role: 'super_admin' | 'ops' | 'finance' | 'support' | 'read_only',
  ) => {
    const row = await adminDb.staffUser.create({
      data: {
        authProviderId: `google-oauth2|${label}-${run}`,
        email: `${label}-${run}@metacognixion.test`,
        name: `${label.toUpperCase()} Person`,
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

  ws = await paidWorkspace(h.app, `d13-${run}`, 'growth');
  await adminDb.tenant.update({
    where: { id: ws.workspaceId },
    data: { name: `D13 Plumbing ${run}`, onboardingCompletedAt: new Date(), onboardingStep: 7 },
  });
  customerToken = await h.customerTenant.mint(ws.sub);
  const viewer = await createUser(`d13-viewer-${run}`);
  await adminDb.membership.create({
    data: { tenantId: ws.workspaceId, userId: viewer.userId, role: 'viewer' },
  });
  viewerToken = await h.customerTenant.mint(viewer.sub);

  other = await paidWorkspace(h.app, `d13-other-${run}`, 'starter');
  otherToken = await h.customerTenant.mint(other.sub);

  callId = `call_d13${run}`;
  await adminDb.call.create({
    data: {
      id: callId,
      tenantId: ws.workspaceId,
      channel: 'phone',
      direction: 'inbound',
      status: 'ended',
      fromNumber: '+14165550100',
      toNumber: '+14505550199',
      startedAt: new Date(Date.now() - 600_000),
      endedAt: new Date(Date.now() - 450_000),
      durationS: 150,
      tier: 'standard',
      rate: 1,
      creditsCharged: 2.5,
    },
  });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await adminDb.$disconnect();
});

// --------------------------------------------------------------------------- staff-opened tickets

describe('SA4 — staff open, list and search tickets', () => {
  let ticketId = 0;

  it('opens a ticket with the SLA clocks, a first staff message and a ticket.created audit row', async () => {
    const res = await call('POST', '/admin/tickets', staff.support.token, {
      tenant_id: ws.workspaceId,
      subject: `Missed calls on Monday ${run}`,
      category: 'calls',
      priority: 'urgent',
      body: 'We are looking into the missed calls you reported.',
      requester_user_id: ws.userId,
      linked_call_ids: [callId],
      note: 'opened from a phone call',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ticketId = res.body.id as number;
    expect(Number.isInteger(ticketId)).toBe(true);
    expect(res.body.status).toBe('open');
    expect(res.body.priority).toBe('urgent');
    expect(res.body.tenant_name).toContain('D13 Plumbing');
    expect((res.body.requester as { id: string }).id).toBe(ws.userId);
    expect(res.body.linked_call_ids).toEqual([callId]);
    const created = new Date(res.body.created_at as string).getTime();
    // Urgent: first response within the hour; resolution three business days out.
    expect(new Date(res.body.sla_first_response_due as string).getTime() - created).toBe(3_600_000);
    const resolution = new Date(res.body.sla_resolution_due as string);
    expect(resolution.getTime()).toBeGreaterThanOrEqual(created + 3 * 86_400_000);
    expect([0, 6]).not.toContain(resolution.getUTCDay());
    expect(res.body.first_responded_at).not.toBeNull();
    expect((res.body.messages as unknown[]).length).toBe(1);
    expect((res.body.tenant as { balance: number }).balance).toBe(500);
    const audit = await lastAudit('ticket.created', String(ticketId));
    expect(audit).not.toBeNull();
    expect(audit?.staffId).toBe(staff.support.id);
    expect(audit?.tenantId).toBe(ws.workspaceId);
    expect(audit?.note).toBe('opened from a phone call');
  });

  it('refuses a requester who is not a member, and a linked call of another workspace', async () => {
    const stranger = await call('POST', '/admin/tickets', staff.ops.token, {
      tenant_id: ws.workspaceId,
      subject: 'x',
      requester_user_id: other.userId,
    });
    expect(stranger.status).toBe(422);
    const foreignCall = await call('POST', '/admin/tickets', staff.ops.token, {
      tenant_id: other.workspaceId,
      subject: 'x',
      linked_call_ids: [callId],
    });
    expect(foreignCall.status).toBe(422);
    const noTenant = await call('POST', '/admin/tickets', staff.ops.token, {
      tenant_id: randomUUID(),
      subject: 'x',
    });
    expect(noTenant.status).toBe(404);
  });

  it('lists newest first with a total, and searches by subject, number and customer name', async () => {
    const all = await call(
      'GET',
      `/admin/tickets?tenant_id=${ws.workspaceId}`,
      staff.readOnly.token,
    );
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(1);
    const items = all.body.items as Array<Record<string, unknown>>;
    expect(items[0]?.id).toBe(ticketId);
    expect(items[0]?.message_count).toBe(1);
    expect(items[0]?.last_message_at).not.toBeNull();

    const bySubject = await call(
      'GET',
      `/admin/tickets?q=${encodeURIComponent(`Monday ${run}`)}`,
      staff.readOnly.token,
    );
    expect((bySubject.body.items as Array<{ id: number }>).map((t) => t.id)).toEqual([ticketId]);
    const byNumber = await call('GET', `/admin/tickets?q=${ticketId}`, staff.readOnly.token);
    expect((byNumber.body.items as Array<{ id: number }>).some((t) => t.id === ticketId)).toBe(
      true,
    );
    const byCustomer = await call(
      'GET',
      `/admin/tickets?q=${encodeURIComponent(`Plumbing ${run}`)}`,
      staff.readOnly.token,
    );
    expect((byCustomer.body.items as Array<{ id: number }>).map((t) => t.id)).toEqual([ticketId]);
    const byPriority = await call(
      'GET',
      `/admin/tickets?tenant_id=${ws.workspaceId}&priority=low`,
      staff.readOnly.token,
    );
    expect(byPriority.body.total).toBe(0);
  });

  it('a ticket id that is not a number is a 404, not a cast error', async () => {
    expect((await call('GET', '/admin/tickets/abc', staff.readOnly.token)).status).toBe(404);
    expect((await call('GET', '/admin/tickets/999999999', staff.readOnly.token)).status).toBe(404);
    expect(
      (await call('PATCH', '/admin/tickets/not-a-number', staff.ops.token, { status: 'closed' }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          'POST',
          '/support/tickets/x/messages',
          customerToken,
          { body: 'hi' },
          asCustomer(ws.workspaceId),
        )
      ).status,
    ).toBe(404);
  });

  it('read-only staff may read but not write', async () => {
    expect((await call('GET', `/admin/tickets/${ticketId}`, staff.readOnly.token)).status).toBe(
      200,
    );
    const create = await call('POST', '/admin/tickets', staff.readOnly.token, {
      tenant_id: ws.workspaceId,
      subject: 'x',
    });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('FORBIDDEN_ROLE');
    expect(
      (await call('PATCH', `/admin/tickets/${ticketId}`, staff.readOnly.token, { priority: 'low' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/admin/tickets/${ticketId}/messages`, staff.readOnly.token, {
          body: 'x',
        })
      ).status,
    ).toBe(403);
  });
});

// --------------------------------------------------------------------------- the customer's side

describe('D7 Help — the customer opens a ticket and the two sides talk', () => {
  let ticketId = 0;

  it('a customer ticket appears in the staff queue under the right workspace', async () => {
    const viewer = await call(
      'POST',
      '/support/tickets',
      viewerToken,
      { subject: 'x', body: 'y' },
      asCustomer(ws.workspaceId),
    );
    expect(viewer.status).toBe(403);
    expect(viewer.body.code).toBe('FORBIDDEN_ROLE');

    const res = await call(
      'POST',
      '/support/tickets',
      customerToken,
      {
        subject: `Billing question ${run}`,
        body: 'Why was I charged for a call that did not connect?',
        category: 'billing',
        linked_call_id: callId,
      },
      asCustomer(ws.workspaceId),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ticketId = res.body.id as number;
    expect(res.body.status).toBe('open');
    expect(res.body.assignee_name).toBe('Support');
    expect(res.body.requester_user_id).toBe(ws.userId);
    expect(res.body.linked_call_ids).toEqual([callId]);
    const messages = res.body.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.author_type).toBe('customer');
    // Nothing staff-only on the wire.
    expect(JSON.stringify(res.body)).not.toContain('is_internal');
    expect(JSON.stringify(res.body)).not.toContain('metacognixion');

    const admin = await call('GET', `/admin/tickets/${ticketId}`, staff.support.token);
    expect(admin.status).toBe(200);
    expect(admin.body.tenant_id).toBe(ws.workspaceId);
    expect((admin.body.requester as { id: string }).id).toBe(ws.userId);
    expect(admin.body.first_responded_at).toBeNull();
    expect(admin.body.priority).toBe('normal');
    const foreignCall = await call(
      'POST',
      '/support/tickets',
      customerToken,
      { subject: 'x', body: 'y', linked_call_id: 'call_not_ours' },
      asCustomer(ws.workspaceId),
    );
    expect(foreignCall.status).toBe(422);
  });

  it('another workspace cannot see or reply on it', async () => {
    const list = await call(
      'GET',
      '/support/tickets',
      otherToken,
      undefined,
      asCustomer(other.workspaceId),
    );
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(0);
    expect((list.body.items as unknown[]).length).toBe(0);
    const reply = await call(
      'POST',
      `/support/tickets/${ticketId}/messages`,
      otherToken,
      { body: 'hello?' },
      asCustomer(other.workspaceId),
    );
    expect(reply.status).toBe(404);
    // Our own workspace sees exactly its two tickets.
    const mine = await call(
      'GET',
      '/support/tickets',
      customerToken,
      undefined,
      asCustomer(ws.workspaceId),
    );
    expect(mine.body.total).toBe(2);
  });

  it('an internal note is invisible to the customer; a public reply sets first_responded_at and moves open → pending', async () => {
    const note = await call('POST', `/admin/tickets/${ticketId}/messages`, staff.support.token, {
      body: 'Internal: looks like a caller-leg attribution bug',
      is_internal: true,
    });
    expect(note.status).toBe(201);
    expect(note.body.status).toBe('open');
    expect(note.body.first_responded_at).toBeNull();
    const noted = await lastAudit('ticket.noted', String(ticketId));
    expect(noted?.staffId).toBe(staff.support.id);

    const reply = await call('POST', `/admin/tickets/${ticketId}/messages`, staff.support.token, {
      body: 'Thanks — we are refunding that call now.',
    });
    expect(reply.status).toBe(201);
    expect(reply.body.status).toBe('pending');
    expect(reply.body.first_responded_at).not.toBeNull();
    const adminMessages = reply.body.messages as Array<{
      is_internal: boolean;
      author_type: string;
      author: { email: string } | null;
    }>;
    expect(adminMessages.filter((m) => m.is_internal).length).toBe(1);
    expect(adminMessages.at(-1)?.author?.email).toContain(`sup-${run}`);
    expect((await lastAudit('ticket.replied', String(ticketId)))?.tenantId).toBe(ws.workspaceId);

    const mine = await call(
      'GET',
      `/support/tickets?limit=5`,
      customerToken,
      undefined,
      asCustomer(ws.workspaceId),
    );
    const ticket = (mine.body.items as Array<Record<string, unknown>>).find(
      (t) => t.id === ticketId,
    )!;
    expect(ticket.status).toBe('pending');
    const messages = ticket.messages as Array<{
      body: string;
      author_type: string;
      author_name: string | null;
    }>;
    expect(messages.length).toBe(2);
    expect(messages.map((m) => m.body).join(' ')).not.toContain('attribution bug');
    expect(messages[1]?.author_type).toBe('staff');
    expect(messages[1]?.author_name).toBe('Support');
    // The database, not the shape, hides the note: a raw count on the customer connection says one.
    const { withWorkspace } = await import('@portal/db');
    const visible = await withWorkspace(ws.workspaceId, (db) =>
      db.ticketMessage.count({ where: { ticketId } }),
    );
    expect(visible).toBe(2);
    expect(await adminDb.ticketMessage.count({ where: { ticketId } })).toBe(3);
  });

  it('a customer message reopens a pending ticket; a closed ticket refuses one', async () => {
    const reply = await call(
      'POST',
      `/support/tickets/${ticketId}/messages`,
      customerToken,
      { body: 'Great, thank you.' },
      asCustomer(ws.workspaceId),
    );
    expect(reply.status).toBe(201);
    expect(reply.body.status).toBe('open');
    expect((reply.body.messages as unknown[]).length).toBe(3);

    const closed = await call('PATCH', `/admin/tickets/${ticketId}`, staff.support.token, {
      status: 'closed',
    });
    expect(closed.status).toBe(200);
    const refused = await call(
      'POST',
      `/support/tickets/${ticketId}/messages`,
      customerToken,
      { body: 'one more thing' },
      asCustomer(ws.workspaceId),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CONFLICT');
    const staffRefused = await call(
      'POST',
      `/admin/tickets/${ticketId}/messages`,
      staff.support.token,
      { body: 'public on closed' },
    );
    expect(staffRefused.status).toBe(409);
    const noteOk = await call('POST', `/admin/tickets/${ticketId}/messages`, staff.support.token, {
      body: 'closing note',
      is_internal: true,
    });
    expect(noteOk.status).toBe(201);
    await call('PATCH', `/admin/tickets/${ticketId}`, staff.support.token, { status: 'open' });
  });

  it('the assignee is a first name on the customer side and an email on the staff side', async () => {
    const assigned = await call('PATCH', `/admin/tickets/${ticketId}`, staff.support.token, {
      assignee_staff_id: 'me',
    });
    expect(assigned.status).toBe(200);
    expect((assigned.body.assignee as { id: string; email: string }).id).toBe(staff.support.id);
    const mine = await call(
      'GET',
      '/support/tickets',
      customerToken,
      undefined,
      asCustomer(ws.workspaceId),
    );
    const ticket = (mine.body.items as Array<Record<string, unknown>>).find(
      (t) => t.id === ticketId,
    )!;
    expect(ticket.assignee_name).toBe('SUP');
    expect(JSON.stringify(ticket)).not.toContain(staff.support.id);
    const byMe = await call('GET', '/admin/tickets?assignee_staff_id=me', staff.support.token);
    expect((byMe.body.items as Array<{ id: number }>).map((t) => t.id)).toContain(ticketId);
    const byOther = await call('GET', '/admin/tickets?assignee_staff_id=me', staff.ops.token);
    expect((byOther.body.items as Array<{ id: number }>).map((t) => t.id)).not.toContain(ticketId);
  });
});

// --------------------------------------------------------------------------- transitions

describe('SA4 — PATCH transitions', () => {
  it('resolved sets resolved_at, closed sets closed_at, reopening clears both, each with a before/after audit row', async () => {
    const created = await call('POST', '/admin/tickets', staff.ops.token, {
      tenant_id: ws.workspaceId,
      subject: `Transitions ${run}`,
    });
    const id = created.body.id as number;

    const resolved = await call('PATCH', `/admin/tickets/${id}`, staff.ops.token, {
      status: 'resolved',
      priority: 'high',
      tags: ['billing', 'refund'],
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('resolved');
    expect(resolved.body.resolved_at).not.toBeNull();
    expect(resolved.body.closed_at).toBeNull();
    expect(resolved.body.priority).toBe('high');
    expect(resolved.body.tags).toEqual(['billing', 'refund']);
    const audit = await lastAudit('ticket.updated', String(id));
    expect(audit?.beforeJson).toMatchObject({ status: 'open', priority: 'normal' });
    expect(audit?.afterJson).toMatchObject({
      status: 'resolved',
      priority: 'high',
      tags: ['billing', 'refund'],
    });

    const closed = await call('PATCH', `/admin/tickets/${id}`, staff.ops.token, {
      status: 'closed',
    });
    expect(closed.body.closed_at).not.toBeNull();
    expect(closed.body.resolved_at).toBe(resolved.body.resolved_at);

    const reopened = await call('PATCH', `/admin/tickets/${id}`, staff.ops.token, {
      status: 'open',
      assignee_staff_id: null,
      category: 'billing',
    });
    expect(reopened.body.status).toBe('open');
    expect(reopened.body.resolved_at).toBeNull();
    expect(reopened.body.closed_at).toBeNull();
    expect(reopened.body.assignee).toBeNull();
    expect(reopened.body.category).toBe('billing');

    expect((await call('PATCH', `/admin/tickets/${id}`, staff.ops.token, {})).status).toBe(422);
    expect(
      (
        await call('PATCH', `/admin/tickets/${id}`, staff.ops.token, {
          assignee_staff_id: randomUUID(),
        })
      ).status,
    ).toBe(422);
  });
});

// --------------------------------------------------------------------------- macros

describe('SA4 macros', () => {
  let ticketId = 0;

  beforeAll(async () => {
    const created = await call('POST', '/admin/tickets', staff.ops.token, {
      tenant_id: ws.workspaceId,
      subject: `Macros ${run}`,
      linked_call_ids: [callId],
    });
    ticketId = created.body.id as number;
  });

  it('comp_credits moves credits through the wallet with a credit_adjustments row carrying the ticket id, an audit row and a system line', async () => {
    const before = await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId } });
    const ro = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/comp_credits`,
      staff.readOnly.token,
      { credits: 5, reason_code: 'goodwill' },
    );
    expect(ro.status).toBe(403);
    expect(ro.body.code).toBe('FORBIDDEN_ROLE');
    const noReason = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/comp_credits`,
      staff.ops.token,
      { credits: 5 },
    );
    expect(noReason.status).toBe(422);
    const noCredits = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/comp_credits`,
      staff.ops.token,
      { reason_code: 'goodwill' },
    );
    expect(noCredits.status).toBe(422);
    const otherNoNote = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/comp_credits`,
      staff.ops.token,
      { credits: 5, reason_code: 'other' },
    );
    expect(otherNoNote.status).toBe(422);
    // Support's per-action cap is 50 (the seed): the existing limit path answers.
    const overCap = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/comp_credits`,
      staff.support.token,
      { credits: 100, reason_code: 'goodwill' },
    );
    expect(overCap.status).toBe(403);
    expect(overCap.body.code).toBe('STAFF_LIMIT_EXCEEDED');

    const key = randomUUID();
    const res = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/comp_credits`,
      staff.ops.token,
      { credits: 5, reason_code: 'goodwill', note: 'sorry about Monday', idempotency_key: key },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.macro).toBe('comp_credits');
    const adjustment = res.body.adjustment as {
      adjustment_id: string;
      delta: number;
      balance_after: number;
    };
    expect(adjustment.delta).toBe(5);
    expect(adjustment.balance_after).toBe(505);
    const record = await adminDb.creditAdjustment.findUniqueOrThrow({
      where: { id: adjustment.adjustment_id },
    });
    expect(record.ticketId).toBe(ticketId);
    expect(record.tenantId).toBe(ws.workspaceId);
    expect(record.staffId).toBe(staff.ops.id);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId } })).toBe(
      before + 1,
    );
    const ticket = res.body.ticket as {
      messages: Array<{ author_type: string; body: string }>;
      adjustments: Array<{ delta: number }>;
      tenant: { balance: number };
    };
    expect(ticket.messages.at(-1)?.author_type).toBe('system');
    expect(ticket.messages.at(-1)?.body).toContain('Comped 5 credits');
    expect(ticket.adjustments.map((a) => a.delta)).toEqual([5]);
    expect(ticket.tenant.balance).toBe(505);
    const audit = await lastAudit('ticket.macro.comp_credits', String(ticketId));
    expect(audit?.reasonCode).toBe('goodwill');
    expect(audit?.afterJson).toMatchObject({ credits: 5, adjustment_id: adjustment.adjustment_id });
    expect((await lastAudit('credits.adjusted'))?.afterJson).toMatchObject({
      ticket_id: ticketId,
      ticket_linked: true,
    });

    // The same client key on the same ticket is the same adjustment.
    const again = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/comp_credits`,
      staff.ops.token,
      { credits: 5, reason_code: 'goodwill', idempotency_key: key },
    );
    expect(again.status).toBe(200);
    expect((again.body.adjustment as { adjustment_id: string }).adjustment_id).toBe(
      adjustment.adjustment_id,
    );
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId } })).toBe(
      before + 1,
    );
    // review 28 Sep: …and a replay posts no second "Comped" line and no second audit row.
    const messages = (again.body.ticket as { messages: Array<{ body: string }> }).messages;
    expect(messages.filter((m) => m.body.includes('Comped 5 credits'))).toHaveLength(1);
    expect(
      await adminDb.staffAuditLog.count({
        where: { action: 'ticket.macro.comp_credits', targetId: String(ticketId) },
      }),
    ).toBe(1);
  });

  it('refund_call credits the call’s charge once and is 409 on a repeat', async () => {
    const missing = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/refund_call`,
      staff.finance.token,
      { reason_code: 'billing_error' },
    );
    expect(missing.status).toBe(422);
    const foreign = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/refund_call`,
      staff.finance.token,
      { reason_code: 'billing_error', call_id: 'call_nope' },
    );
    expect(foreign.status).toBe(404);

    const res = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/refund_call`,
      staff.finance.token,
      { reason_code: 'billing_error', call_id: callId },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const adjustment = res.body.adjustment as {
      adjustment_id: string;
      delta: number;
      balance_after: number;
    };
    expect(adjustment.delta).toBe(2.5);
    expect(adjustment.balance_after).toBe(507.5);
    const record = await adminDb.creditAdjustment.findUniqueOrThrow({
      where: { id: adjustment.adjustment_id },
    });
    expect(record.ticketId).toBe(ticketId);
    expect(record.note).toContain(callId);
    expect(record.customerText).toMatch(/Refund for the call/);
    const ticket = res.body.ticket as { messages: Array<{ author_type: string; body: string }> };
    expect(ticket.messages.at(-1)?.body).toContain(`Refunded 2.5 credits for call ${callId}`);
    expect(
      (await lastAudit('ticket.macro.refund_call', String(ticketId)))?.afterJson,
    ).toMatchObject({ call_id: callId, credits: 2.5 });

    const repeat = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/refund_call`,
      staff.finance.token,
      { reason_code: 'billing_error', call_id: callId },
    );
    expect(repeat.status).toBe(409);
    expect(repeat.body.code).toBe('CONFLICT');
    expect(await adminDb.creditAdjustment.count({ where: { ticketId } })).toBe(2);

    // review 28 Sep: the same call on another ticket (a duplicate) is not refunded again.
    const second = await call('POST', '/admin/tickets', staff.ops.token, {
      tenant_id: ws.workspaceId,
      subject: `Second refund ${run}`,
    });
    const onAnother = await call(
      'POST',
      `/admin/tickets/${second.body.id}/macros/refund_call`,
      staff.finance.token,
      { reason_code: 'billing_error', call_id: callId },
    );
    expect(onAnother.status).toBe(409);
    expect(onAnother.body.message).toContain(`ticket #${ticketId}`);
    expect(await adminDb.creditAdjustment.count({ where: { ticketId: second.body.id as number } })).toBe(0);
  });

  it('rerun_activation is 409 with no agent, excludes finance, and otherwise queues the activation job once', async () => {
    const finance = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/rerun_activation`,
      staff.finance.token,
      { reason_code: 'service_issue' },
    );
    expect(finance.status).toBe(403);
    expect(finance.body.code).toBe('FORBIDDEN_ROLE');
    const noAgent = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/rerun_activation`,
      staff.support.token,
      { reason_code: 'service_issue' },
    );
    expect(noAgent.status).toBe(409);
    expect(noAgent.body.code).toBe('CONFLICT');

    const agent = await adminDb.agent.create({
      data: {
        tenantId: ws.workspaceId,
        name: `Front desk ${run}`,
        status: 'draft',
        tier: 'standard',
        draftVersion: 1,
        retellAgentId: `agent_${run}`,
        retellLlmId: `llm_${run}`,
      },
    });
    await adminDb.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNo: 1,
        source: 'generated',
        briefJson: {},
        promptText: 'You are the front desk.',
      },
    });
    const res = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/rerun_activation`,
      staff.support.token,
      { reason_code: 'service_issue', note: 'number never bound' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const jobId = res.body.job_id as string;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    const job = await adminDb.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.type).toBe(JOBS.activateAgent);
    expect(job.tenantId).toBe(ws.workspaceId);
    expect(['queued', 'running']).toContain(job.status);
    expect(
      (res.body.ticket as { messages: Array<{ body: string }> }).messages.at(-1)?.body,
    ).toContain(jobId);
    expect(
      (await lastAudit('ticket.macro.rerun_activation', String(ticketId)))?.afterJson,
    ).toMatchObject({ job_id: jobId });

    const running = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/rerun_activation`,
      staff.support.token,
      { reason_code: 'service_issue' },
    );
    expect(running.status).toBe(409);
    expect(running.body.code).toBe('ACTIVATION_IN_PROGRESS');
    await adminDb.job.update({
      where: { id: jobId },
      data: { status: 'failed', error: 'd13 cleanup' },
    });
  });

  it('an unknown macro is a 404 and a closed ticket refuses every macro', async () => {
    expect(
      (
        await call('POST', `/admin/tickets/${ticketId}/macros/delete_everything`, staff.ops.token, {
          reason_code: 'goodwill',
        })
      ).status,
    ).toBe(404);
    await call('PATCH', `/admin/tickets/${ticketId}`, staff.ops.token, { status: 'closed' });
    const closed = await call(
      'POST',
      `/admin/tickets/${ticketId}/macros/comp_credits`,
      staff.ops.token,
      { credits: 1, reason_code: 'goodwill' },
    );
    expect(closed.status).toBe(409);
  });
});

// --------------------------------------------------------------------------- canned responses

describe('SA4 canned responses', () => {
  it('create, list, delete — audited, support and above', async () => {
    const denied = await call('POST', '/admin/canned-responses', staff.finance.token, {
      title: 'x',
      body: 'y',
    });
    expect(denied.status).toBe(403);
    const created = await call('POST', '/admin/canned-responses', staff.support.token, {
      title: `Refund done ${run}`,
      body: 'We have refunded the call. The credits are back in your wallet.',
      category: 'billing',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body.category).toBe('billing');
    expect((await lastAudit('canned_response.created', id))?.staffId).toBe(staff.support.id);

    const list = await call('GET', '/admin/canned-responses', staff.readOnly.token);
    expect(list.status).toBe(200);
    expect((list.body as unknown as Array<{ id: string }>).some((c) => c.id === id)).toBe(true);

    const invalid = await call('POST', '/admin/canned-responses', staff.support.token, {
      title: '',
      body: 'y',
    });
    expect(invalid.status).toBe(422);

    const deleted = await call('DELETE', `/admin/canned-responses/${id}`, staff.ops.token);
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    expect((await lastAudit('canned_response.deleted', id))?.beforeJson).toMatchObject({
      title: `Refund done ${run}`,
    });
    expect((await call('DELETE', `/admin/canned-responses/${id}`, staff.ops.token)).status).toBe(
      404,
    );
    expect(
      (await call('DELETE', `/admin/canned-responses/not-a-uuid`, staff.ops.token)).status,
    ).toBe(404);
    const again = await call('GET', '/admin/canned-responses', staff.readOnly.token);
    expect((again.body as unknown as Array<{ id: string }>).some((c) => c.id === id)).toBe(false);
  });
});
