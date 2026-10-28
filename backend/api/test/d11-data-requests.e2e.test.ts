import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Prisma, adminDb, withWorkspace } from '@portal/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpsAlertService } from '../src/modules/alerts';
import { DATA_EXPORTS_PER_HOUR, DataRequestsModule } from '../src/modules/data-requests';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { registerWebhookRawBody } from '../src/modules/webhooks';
import { FakeAuth0Tenant } from './auth0-double';
import { CallsTestModule, type CallWorkspace, callId, createCallWorkspace } from './calls-fixtures';

/*
 * QA-080 and QA-081 (D11): the D5 credit-history filter and CSV export, the D6 "Export all
 * data" zip and the D6 "Delete workspace" request — against a real Nest app, real
 * Postgres under RLS and real Redis. Nothing is mocked but Auth0.
 */

@Module({ imports: [CallsTestModule, DataRequestsModule] })
class DataRequestsTestModule {}

let app: NestFastifyApplication;
let customerTenant: FakeAuth0Tenant;
let staffTenant: FakeAuth0Tenant;
let ws: CallWorkspace;
let other: CallWorkspace;
const members: Record<'admin' | 'editor' | 'viewer', string> = { admin: '', editor: '', viewer: '' };
const calls = { mine: callId(), theirs: callId() };
const LEDGER_ROWS = 600;

beforeAll(async () => {
  customerTenant = new FakeAuth0Tenant('customers', 'https://api.test');
  staffTenant = new FakeAuth0Tenant('staff', 'https://admin-api.test');
  await customerTenant.start();
  await staffTenant.start();
  process.env.AUTH0_CUSTOMER_DOMAIN = customerTenant.domain;
  process.env.AUTH0_CUSTOMER_AUDIENCE = customerTenant.audience;
  process.env.AUTH0_STAFF_DOMAIN = staffTenant.domain;
  process.env.AUTH0_STAFF_AUDIENCE = staffTenant.audience;
  const moduleRef = await Test.createTestingModule({ imports: [DataRequestsTestModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  registerWebhookRawBody(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ws = await createCallWorkspace('data-req');
  other = await createCallWorkspace('data-req-other');
  for (const role of ['admin', 'editor', 'viewer'] as const) members[role] = await addMember(ws.tenantId, role);
  await seed();
});

afterAll(async () => {
  await app?.close();
  await customerTenant?.stop();
  await staffTenant?.stop();
  await adminDb.$disconnect();
});

async function addMember(tenantId: string, role: 'admin' | 'editor' | 'viewer'): Promise<string> {
  const run = randomUUID().slice(0, 8);
  const user = await adminDb.user.create({ data: { authProviderId: `auth0|data-req-${role}-${run}`, email: `data-req-${role}-${run}@example.test`, name: `Data ${role}` } });
  await adminDb.membership.create({ data: { tenantId, userId: user.id, role } });
  return user.authProviderId;
}

/** A call each, and a ledger long enough to cross the export's 500-row batch. */
async function seed(): Promise<void> {
  const now = Date.now();
  await adminDb.call.createMany({
    data: [
      { id: calls.mine, tenantId: ws.tenantId, agentId: ws.agentId, numberId: ws.numberId, channel: 'phone', direction: 'inbound', fromNumber: '+19375550100', toNumber: ws.e164, startedAt: new Date(now - 3_600_000), endedAt: new Date(now - 3_540_000), durationS: 60, rate: new Prisma.Decimal(1), creditsCharged: new Prisma.Decimal(1), status: 'ended' },
      { id: calls.theirs, tenantId: other.tenantId, channel: 'phone', direction: 'inbound', startedAt: new Date(now - 600_000), endedAt: new Date(now - 540_000), durationS: 60, rate: new Prisma.Decimal(1), creditsCharged: new Prisma.Decimal(1), status: 'ended' },
    ],
  });
  const rows: Prisma.CreditLedgerCreateManyInput[] = [{ tenantId: ws.tenantId, delta: new Prisma.Decimal(1000), balanceAfter: new Prisma.Decimal(1000), reason: 'purchase', refType: 'purchase', createdAt: new Date(now - 10 * 86_400_000) }];
  for (let i = 0; i < LEDGER_ROWS - 1; i++) {
    rows.push({ tenantId: ws.tenantId, delta: new Prisma.Decimal(-1), balanceAfter: new Prisma.Decimal(999 - i), reason: 'call', refType: 'call', refId: `ledger_${randomUUID()}`, createdAt: new Date(now - 9 * 86_400_000 + i * 1_000) });
  }
  await adminDb.creditLedger.createMany({ data: rows });
  await adminDb.creditLedger.create({ data: { tenantId: other.tenantId, delta: new Prisma.Decimal(20), balanceAfter: new Prisma.Decimal(20), reason: 'trial', refType: 'tenant', refId: 'theirs-trial' } });
}

async function headers(sub = ws.sub, workspaceId = ws.tenantId, claims: { emailVerified?: boolean } = {}): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await customerTenant.mint(sub, claims)}`, 'x-workspace-id': workspaceId, 'content-type': 'application/json' };
}

const post = async (url: string, payload: unknown = {}, auth?: Record<string, string>) => app.inject({ method: 'POST', url, headers: auth ?? (await headers()), payload: JSON.stringify(payload) });
const get = async (url: string, auth?: Record<string, string>) => app.inject({ method: 'GET', url, headers: auth ?? (await headers()) });
const del = async (url: string, auth?: Record<string, string>) => {
  const { 'content-type': _ignored, ...h } = auth ?? (await headers());
  return app.inject({ method: 'DELETE', url, headers: h });
};
const jsonOrNull = (body: string): unknown => (body ? JSON.parse(body) : null);

// ------------------------------------------------------------------ QA-080
describe('D5 credit history: reason filter and Export CSV (QA-080)', () => {
  it('filters the list by reason', async () => {
    const page = (await get('/wallet/ledger?reason=purchase')).json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0].reason).toBe('purchase');
    expect((await get('/wallet/ledger?reason=nonsense')).statusCode).toBe(422);
  });

  it('streams the whole history newest first, across batches, this workspace only', async () => {
    const res = await post('/wallet/ledger/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="credit-history-.*\.csv"/);
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('entry_id,created_at,reason,delta,balance_after,ref_type,ref_id');
    expect(lines).toHaveLength(LEDGER_ROWS + 1);
    // Newest first: the oldest row (the purchase) is last, and amounts stay numbers.
    expect(lines.at(-1)).toMatch(/,purchase,1000,1000,purchase,$/);
    expect(lines[1]).toMatch(/,call,-1,/);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[0])).size).toBe(LEDGER_ROWS);
    expect(res.body).not.toContain('theirs-trial');
  });

  it('honours the reason filter', async () => {
    const lines = (await post('/wallet/ledger/export', { reason: 'purchase' })).body.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(',purchase,');
    expect((await post('/wallet/ledger/export', { reason: 'nonsense' })).statusCode).toBe(422);
  });

  it('is owner/admin only', async () => {
    expect((await post('/wallet/ledger/export', {}, await headers(members.admin))).statusCode).toBe(200);
    for (const role of ['editor', 'viewer'] as const) {
      const res = await post('/wallet/ledger/export', {}, await headers(members[role]));
      expect(res.statusCode).toBe(403);
    }
    // The other workspace's owner exports their own history and nothing of ours.
    const theirs = (await post('/wallet/ledger/export', {}, await headers(other.sub, other.tenantId))).body.trim().split('\r\n');
    expect(theirs).toHaveLength(2);
    expect(theirs[1]).toContain('theirs-trial');
  });
});

// ------------------------------------------------------------------ QA-081 export
describe('D6 Export all data (QA-081)', () => {
  async function unzip(res: { rawPayload: Buffer }) {
    const { default: JSZip } = await import('jszip');
    return JSZip.loadAsync(res.rawPayload, { checkCRC32: true });
  }

  it('answers a zip of the workspace’s own data and records the request', async () => {
    const before = await adminDb.dataRequest.count({ where: { tenantId: ws.tenantId, type: 'export' } });
    const res = await post('/workspace/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="workspace-export-.*\.zip"/);
    const zip = await unzip(res);
    expect(Object.keys(zip.files)).toEqual([
      'workspace.json',
      'members.csv',
      'invites.csv',
      'agents.json',
      'agent_versions.json',
      'knowledge_sources.csv',
      'numbers.csv',
      'calls.csv',
      'credit_history.csv',
      'purchases.csv',
      'invoices.csv',
      'audit_log.csv',
      'manifest.json',
    ]);

    const workspace = JSON.parse(await zip.file('workspace.json')!.async('string'));
    expect(workspace).toMatchObject({ id: ws.tenantId, country: 'CA', timezone: 'America/Toronto' });
    expect(workspace).not.toHaveProperty('stripe_customer_id');

    const membersCsv = await zip.file('members.csv')!.async('string');
    expect(membersCsv.split('\r\n')[0]).toBe('membership_id,user_id,name,email,role,joined_at');
    expect(membersCsv).toContain(',owner,');
    expect(membersCsv).toContain(',viewer,');

    const agents = JSON.parse(await zip.file('agents.json')!.async('string'));
    expect(agents.map((a: { id: string }) => a.id)).toEqual([ws.agentId]);
    expect(JSON.stringify(agents)).not.toContain(ws.retellAgentId);
    expect(JSON.stringify(agents)).not.toMatch(/retell/i);

    const numbers = await zip.file('numbers.csv')!.async('string');
    expect(numbers).toContain(ws.numberId);
    expect(numbers).not.toContain(ws.token); // the inbound webhook token never leaves
    expect(numbers).not.toMatch(/retell|twilio|telnyx/i); // no platform or carrier name

    const callsCsv = await zip.file('calls.csv')!.async('string');
    expect(callsCsv).toContain(calls.mine);
    expect(callsCsv).not.toContain(calls.theirs);

    const ledger = (await zip.file('credit_history.csv')!.async('string')).trim().split('\r\n');
    expect(ledger).toHaveLength(LEDGER_ROWS + 1);
    expect(ledger.join('\n')).not.toContain('theirs-trial');

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.workspace_id).toBe(ws.tenantId);
    const files = Object.fromEntries(manifest.files.map((f: { name: string; rows: number }) => [f.name, f.rows]));
    expect(files).toMatchObject({ 'members.csv': 4, 'agents.json': 1, 'numbers.csv': 1, 'calls.csv': 1, 'credit_history.csv': LEDGER_ROWS });

    // Recorded before the first byte: an executed `export` data request and an audit row.
    expect(await adminDb.dataRequest.count({ where: { tenantId: ws.tenantId, type: 'export', executedAt: { not: null } } })).toBe(before + 1);
    const audit = await adminDb.auditLog.findFirst({ where: { tenantId: ws.tenantId, action: 'workspace.data_exported' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.metaJson).toMatchObject({ data_request_id: manifest.export_id });
  });

  it('never carries another workspace’s rows', async () => {
    const zip = await unzip(await post('/workspace/export', {}, await headers(other.sub, other.tenantId)));
    const everything = (await Promise.all(Object.values(zip.files).map((f) => f.async('string')))).join('\n');
    expect(everything).toContain(calls.theirs);
    expect(everything).not.toContain(calls.mine);
    expect(everything).not.toContain(ws.tenantId);
    expect(everything).not.toContain(ws.agentId);
  });

  it('is owner/admin only, and verified email only', async () => {
    expect((await post('/workspace/export', {}, await headers(members.admin))).statusCode).toBe(200);
    expect((await post('/workspace/export', {}, await headers(members.editor))).statusCode).toBe(403);
    expect((await post('/workspace/export', {}, await headers(members.viewer))).statusCode).toBe(403);
    const unverified = await post('/workspace/export', {}, await headers(ws.sub, ws.tenantId, { emailVerified: false }));
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json().code).toBe('EMAIL_UNVERIFIED');
  });

  it(`refuses past ${DATA_EXPORTS_PER_HOUR} exports an hour with a JSON 429, recording nothing`, async () => {
    const busy = await createCallWorkspace('data-req-busy');
    const cache = app.get(RedisCache);
    for (let i = 0; i < DATA_EXPORTS_PER_HOUR; i++) await cache.increment(redisKeys.dataExportWindow(busy.tenantId), 3_600);
    const res = await post('/workspace/export', {}, await headers(busy.sub, busy.tenantId));
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMITED');
    expect(await adminDb.dataRequest.count({ where: { tenantId: busy.tenantId } })).toBe(0);
  });
});

// ------------------------------------------------------------------ QA-081 delete
describe('D6 Delete workspace request (QA-081)', () => {
  const nameOf = async (tenantId: string) => (await adminDb.tenant.findUniqueOrThrow({ where: { id: tenantId } })).name;

  it('has nothing open to begin with', async () => {
    const res = await get('/workspace/delete-request');
    expect(res.statusCode).toBe(200);
    expect(jsonOrNull(res.body)).toBeNull();
  });

  it('refuses everyone but a verified owner', async () => {
    const confirm = await nameOf(ws.tenantId);
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      expect((await post('/workspace/delete-request', { confirm }, await headers(members[role]))).statusCode).toBe(403);
    }
    const unverified = await post('/workspace/delete-request', { confirm }, await headers(ws.sub, ws.tenantId, { emailVerified: false }));
    expect(unverified.json().code).toBe('EMAIL_UNVERIFIED');
    expect(await adminDb.dataRequest.count({ where: { tenantId: ws.tenantId, type: 'delete' } })).toBe(0);
  });

  it('refuses a confirmation that is not the workspace name, on the confirm field', async () => {
    for (const confirm of ['', 'delete', (await nameOf(other.tenantId))]) {
      const res = await post('/workspace/delete-request', { confirm });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(res.json().fields[0].field).toBe('confirm');
    }
    expect((await post('/workspace/delete-request', {})).statusCode).toBe(422);
    expect(await adminDb.supportTicket.count({ where: { tenantId: ws.tenantId } })).toBe(0);
  });

  it('opens one request, a ticket, an audit row and an ops alert — and deletes nothing', async () => {
    const name = await nameOf(ws.tenantId);
    const alerts = app.get(OpsAlertService);
    const sent = alerts.recent.length;
    // Spaces and case are ignored, as the portal's dialog ignores them.
    const res = await post('/workspace/delete-request', { confirm: `  ${name.toUpperCase().replace(/ /g, '  ')} ` });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.requested_by).toBe('data-req');
    const due = new Date(body.due_at).getTime() - new Date(body.requested_at).getTime();
    expect(due).toBe(30 * 86_400_000);

    const row = await adminDb.dataRequest.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({ tenantId: ws.tenantId, type: 'delete', executedAt: null, cancelledAt: null, ticketId: body.ticket_id });
    const ticket = await adminDb.supportTicket.findUniqueOrThrow({ where: { id: body.ticket_id }, include: { messages: true } });
    expect(ticket).toMatchObject({ tenantId: ws.tenantId, category: 'account', priority: 'high', status: 'open' });
    expect(ticket.slaResolutionDue?.toISOString()).toBe(body.due_at);
    expect(ticket.messages[0]!.body).toContain(name);
    expect(await adminDb.auditLog.count({ where: { tenantId: ws.tenantId, action: 'workspace.deletion_requested', targetId: ws.tenantId } })).toBe(1);
    expect(alerts.recent.slice(sent).map((a) => a.kind)).toContain('workspace_deletion_requested');

    // Nothing moved: the number is still active, the tenant still there, no ledger row added.
    expect((await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: ws.numberId } })).status).toBe('active');
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId } })).toBe(LEDGER_ROWS);

    // Every member sees it; the neighbour does not.
    expect((jsonOrNull((await get('/workspace/delete-request', await headers(members.viewer))).body) as { id: string }).id).toBe(body.id);
    expect(jsonOrNull((await get('/workspace/delete-request', await headers(other.sub, other.tenantId))).body)).toBeNull();
  });

  it('answers the open request again instead of opening a second one', async () => {
    const open = jsonOrNull((await get('/workspace/delete-request')).body) as { id: string; ticket_id: number };
    const again = await post('/workspace/delete-request', { confirm: await nameOf(ws.tenantId) });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ id: open.id, ticket_id: open.ticket_id });
    expect(await adminDb.dataRequest.count({ where: { tenantId: ws.tenantId, type: 'delete' } })).toBe(1);
    expect(await adminDb.supportTicket.count({ where: { tenantId: ws.tenantId } })).toBe(1);
  });

  it('keeps one request when two presses race', async () => {
    const racing = await createCallWorkspace('data-req-race');
    const confirm = await nameOf(racing.tenantId);
    const auth = await headers(racing.sub, racing.tenantId);
    const [a, b] = await Promise.all([post('/workspace/delete-request', { confirm }, auth), post('/workspace/delete-request', { confirm }, auth)]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().id).toBe(b.json().id);
    expect(await adminDb.dataRequest.count({ where: { tenantId: racing.tenantId, type: 'delete' } })).toBe(1);
    expect(await adminDb.supportTicket.count({ where: { tenantId: racing.tenantId } })).toBe(1);
  });

  it('lets only the owner withdraw it, tells staff on the ticket, and allows a fresh request after', async () => {
    const open = jsonOrNull((await get('/workspace/delete-request')).body) as { id: string; ticket_id: number };
    expect((await del('/workspace/delete-request', await headers(members.admin))).statusCode).toBe(403);
    // The neighbour's owner has nothing open and cannot reach ours.
    expect((await del('/workspace/delete-request', await headers(other.sub, other.tenantId))).json()).toEqual({ revoked: false });

    const res = await del('/workspace/delete-request');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true });
    expect((await adminDb.dataRequest.findUniqueOrThrow({ where: { id: open.id } })).cancelledAt).not.toBeNull();
    const messages = await adminDb.ticketMessage.findMany({ where: { ticketId: open.ticket_id }, orderBy: { createdAt: 'asc' } });
    expect(messages.at(-1)!.body).toMatch(/withdrew/);
    expect(await adminDb.auditLog.count({ where: { tenantId: ws.tenantId, action: 'workspace.deletion_withdrawn' } })).toBe(1);
    expect(jsonOrNull((await get('/workspace/delete-request')).body)).toBeNull();
    expect((await del('/workspace/delete-request')).json()).toEqual({ revoked: false });

    const fresh = await post('/workspace/delete-request', { confirm: await nameOf(ws.tenantId) });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().id).not.toBe(open.id);
  });

  it('lets the app role withdraw a request but never mark one executed (RLS + column grant)', async () => {
    const scope = { workspaceId: ws.tenantId, userId: ws.userId };
    const open = await adminDb.dataRequest.findFirstOrThrow({ where: { tenantId: ws.tenantId, type: 'delete', executedAt: null, cancelledAt: null } });
    await expect(withWorkspace(scope, (db) => db.dataRequest.updateMany({ where: { id: open.id }, data: { executedAt: new Date() } }))).rejects.toThrow(/permission denied/i);
    await expect(
      withWorkspace(scope, (db) => db.dataRequest.create({ data: { tenantId: ws.tenantId, type: 'delete', executedAt: new Date(), cancelledAt: new Date() } })),
    ).rejects.toThrow(/row-level security/i);
    await expect(withWorkspace(scope, (db) => db.dataRequest.create({ data: { tenantId: other.tenantId, type: 'export', executedAt: new Date() } }))).rejects.toThrow(/row-level security/i);
    await expect(withWorkspace(scope, (db) => db.dataRequest.deleteMany({ where: { id: open.id } }))).rejects.toThrow(/permission denied/i);
    // The neighbour's rows are not there at all.
    expect(await withWorkspace({ workspaceId: other.tenantId, userId: other.userId }, (db) => db.dataRequest.count({ where: { tenantId: ws.tenantId } }))).toBe(0);
  });
});
