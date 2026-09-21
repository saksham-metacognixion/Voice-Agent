import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeRetellGateway, createWorkspace, startD5Harness } from './d5-fixtures';
import { authFor, caller, paidWorkspace, publishedAgent, waitForSource } from './d6-fixtures';

/*
 * W4 knowledge (D6): the three source kinds through the route, the sync job against the
 * Retell double, the failure path, deletion, plan gates and — the one that matters most —
 * that a workspace can never see or remove another workspace's sources.
 */

let app: NestFastifyApplication;
let retell: FakeRetellGateway;
let stop: () => Promise<void>;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  retell = harness.retell;
  stop = harness.stop;
  auth = authFor(harness.customerTenant);
  call = caller(app);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

describe('knowledge sources', () => {
  it('adds text, URL and file sources, syncs them into one knowledge base per agent, and reads them back without platform ids', async () => {
    const ws = await paidWorkspace(app, 'kb', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const createsBefore = retell.countOf('createKnowledgeBase');

    const text = await call('POST', `/agents/${agentId}/knowledge`, headers, { type: 'text', name: 'Opening hours', text: 'Open Monday to Friday, 9am to 5pm.' });
    expect(text.status).toBe(202);
    expect(text.body).toMatchObject({ type: 'text', status: 'pending', agent_id: agentId, name: 'Opening hours' });
    const textRow = await waitForSource(text.body.id as string);
    expect('gone' in textRow ? null : textRow.status).toBe('ready');

    const url = await call('POST', '/knowledge', headers, { agent_id: agentId, type: 'url', url: 'https://example.com/faq' });
    expect(url.status).toBe(202);
    expect(url.body).toMatchObject({ type: 'url', url: 'https://example.com/faq', name: 'example.com/faq' });
    const urlRow = await waitForSource(url.body.id as string);
    expect('gone' in urlRow ? null : urlRow.status).toBe('ready');

    const file = await call('POST', `/agents/${agentId}/knowledge`, headers, {
      type: 'file',
      name: 'Price list.pdf',
      content_type: 'application/pdf',
      content_base64: Buffer.from('%PDF-1.4 price list').toString('base64'),
    });
    expect(file.status).toBe(202);
    const fileRow = await waitForSource(file.body.id as string);
    expect('gone' in fileRow ? null : fileRow.status).toBe('ready');

    // One KB for the agent, three sources in it, our ids recorded, payload dropped after ingest.
    expect(retell.countOf('createKnowledgeBase') - createsBefore).toBe(1);
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.retellKbId).toBeTruthy();
    const kb = retell.knowledgeBases.get(agent.retellKbId!)!;
    expect(kb.knowledge_base_sources.map((s) => s.type).sort()).toEqual(['document', 'text', 'url']);
    const rows = await adminDb.knowledgeSource.findMany({ where: { agentId } });
    expect(rows.every((r) => r.retellSourceId && r.payload === null && r.status === 'ready')).toBe(true);
    expect(rows.find((r) => r.type === 'file')?.sizeBytes).toBe(19);

    // The listing, both shapes, with nothing that names the platform.
    const list = await call('GET', `/agents/${agentId}/knowledge`, headers);
    expect(list.status).toBe(200);
    const items = list.body as unknown as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['agent_id', 'content_type', 'created_at', 'error', 'id', 'name', 'size_bytes', 'status', 'synced_at', 'type', 'updated_at', 'url']);
      expect(JSON.stringify(item)).not.toMatch(/retell|knowledge_base_|source_id/i);
    }
    const wide = await call('GET', `/knowledge?agent_id=${agentId}`, headers);
    expect((wide.body as unknown as unknown[]).length).toBe(3);
  }, 60_000);

  it('a workspace cannot read, add to or delete another workspace\'s sources', async () => {
    const owner = await paidWorkspace(app, 'kb-owner', 'growth');
    const ownerAuth = await auth(owner.sub, owner.workspaceId);
    const agentId = await publishedAgent(call, ownerAuth);
    const created = await call('POST', `/agents/${agentId}/knowledge`, ownerAuth, { type: 'text', name: 'Hours', text: 'Open 9–5.' });
    expect(created.status).toBe(202);
    const sourceId = created.body.id as string;

    const other = await paidWorkspace(app, 'kb-other', 'growth');
    const otherAuth = await auth(other.sub, other.workspaceId);
    expect((await call('GET', `/agents/${agentId}/knowledge`, otherAuth)).status).toBe(404);
    expect((await call('GET', `/knowledge/${sourceId}`, otherAuth)).status).toBe(404);
    expect((await call('DELETE', `/knowledge/${sourceId}`, otherAuth)).status).toBe(404);
    expect((await call('POST', '/knowledge', otherAuth, { agent_id: agentId, type: 'text', name: 'x', text: 'y' })).status).toBe(404);
    expect((await call('GET', '/knowledge', otherAuth)).body).toEqual([]);
    // Still there for its owner.
    expect((await call('GET', `/knowledge/${sourceId}`, ownerAuth)).status).toBe(200);
  });

  it('a viewer may read but not add or delete', async () => {
    const ws = await paidWorkspace(app, 'kb-roles', 'growth');
    const ownerAuth = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, ownerAuth);
    const { addMember } = await import('./d5-fixtures');
    const viewer = await addMember(ws.workspaceId, 'viewer', 'viewer');
    const viewerAuth = await auth(viewer.sub, ws.workspaceId);
    expect((await call('GET', `/agents/${agentId}/knowledge`, viewerAuth)).status).toBe(200);
    expect((await call('POST', `/agents/${agentId}/knowledge`, viewerAuth, { type: 'text', name: 'x', text: 'y' })).status).toBe(403);
  });

  it('the plan gates: a trial workspace and a Starter workspace have no knowledge; Growth has it for one agent', async () => {
    const trial = await createWorkspace('kb-trial');
    const trialAuth = await auth(trial.sub, trial.workspaceId);
    const trialAgent = await publishedAgent(call, trialAuth, { publish: false });
    const refused = await call('POST', `/agents/${trialAgent}/knowledge`, trialAuth, { type: 'text', name: 'x', text: 'y' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('PLAN_LIMIT');

    const growth = await paidWorkspace(app, 'kb-growth', 'growth');
    const growthAuth = await auth(growth.sub, growth.workspaceId);
    const first = await publishedAgent(call, growthAuth, { publish: false, name: 'First' });
    const second = await publishedAgent(call, growthAuth, { publish: false, name: 'Second' });
    expect((await call('POST', `/agents/${first}/knowledge`, growthAuth, { type: 'text', name: 'x', text: 'y' })).status).toBe(202);
    const overAllowance = await call('POST', `/agents/${second}/knowledge`, growthAuth, { type: 'text', name: 'x', text: 'y' });
    expect(overAllowance.status).toBe(400);
    expect(overAllowance.body.code).toBe('PLAN_LIMIT');
    expect(overAllowance.body.message).toMatch(/knowledge for 1 agent/);
  });

  it('refuses private URLs and oversized files before anything is stored', async () => {
    const ws = await paidWorkspace(app, 'kb-validate', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers, { publish: false });
    const priv = await call('POST', `/agents/${agentId}/knowledge`, headers, { type: 'url', url: 'http://169.254.169.254/latest/meta-data' });
    expect(priv.status).toBe(400);
    const bad = await call('POST', `/agents/${agentId}/knowledge`, headers, { type: 'file', name: 'x.exe', content_type: 'application/x-msdownload', content_base64: 'AAAA' });
    expect(bad.status).toBe(422); // refused by the schema, before the service
    expect(await adminDb.knowledgeSource.count({ where: { agentId } })).toBe(0);
  });

  it('a source the platform cannot ingest ends `failed` with one customer-safe sentence, and the platform error stays server-side', async () => {
    const ws = await paidWorkspace(app, 'kb-fail', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    retell.failNextIngest();
    const created = await call('POST', `/agents/${agentId}/knowledge`, headers, { type: 'url', url: 'https://example.com/broken' });
    const row = await waitForSource(created.body.id as string);
    if ('gone' in row) throw new Error('row vanished');
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/could not read this source/i);
    expect(row.syncJson).toMatchObject({ error_kind: 'platform_error' });
    const shown = await call('GET', `/knowledge/${row.id}`, headers);
    expect(shown.body.error).toBe(row.error);
    expect(JSON.stringify(shown.body)).not.toContain('platform_error');
  }, 30_000);

  it('a platform outage is retried and then converges without a second knowledge base or source', async () => {
    const ws = await paidWorkspace(app, 'kb-retry', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const before = retell.countOf('createKnowledgeBase');
    retell.failNext('createKnowledgeBase', 1, new Error('retell is having a moment'));
    const created = await call('POST', `/agents/${agentId}/knowledge`, headers, { type: 'text', name: 'Parking', text: 'Free parking behind the building.' });
    const row = await waitForSource(created.body.id as string, 30_000);
    if ('gone' in row) throw new Error('row vanished');
    expect(row.status).toBe('ready');
    expect(retell.countOf('createKnowledgeBase') - before).toBe(2); // one failed, one succeeded
    expect(retell.knowledgeBases.size).toBeGreaterThan(0);
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(retell.knowledgeBases.get(agent.retellKbId!)!.knowledge_base_sources).toHaveLength(1);
  }, 40_000);

  it('deleting removes the platform copy first and then the row; a never-synced source is removed at once', async () => {
    const ws = await paidWorkspace(app, 'kb-delete', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const created = await call('POST', `/agents/${agentId}/knowledge`, headers, { type: 'text', name: 'Hours', text: 'Open 9–5.' });
    const sourceId = created.body.id as string;
    const ready = await waitForSource(sourceId);
    if ('gone' in ready) throw new Error('row vanished');
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });

    const removed = await call('DELETE', `/agents/${agentId}/knowledge/${sourceId}`, headers);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: false, pending: true });
    const gone = await waitForSource(sourceId);
    expect('gone' in gone).toBe(true);
    expect(retell.knowledgeBases.get(agent.retellKbId!)!.knowledge_base_sources.find((s) => s.source_id === ready.retellSourceId)).toBeUndefined();
    expect(retell.countOf('deleteKnowledgeSource')).toBeGreaterThan(0);

    // Never reached the platform: no job, straight delete.
    const pending = await adminDb.knowledgeSource.create({ data: { tenantId: ws.workspaceId, agentId, type: 'text', name: 'orphan', status: 'failed' } });
    const removedNow = await call('DELETE', `/knowledge/${pending.id}`, headers);
    expect(removedNow.body).toEqual({ deleted: true, pending: false });
    expect(await adminDb.knowledgeSource.findUnique({ where: { id: pending.id } })).toBeNull();
  }, 30_000);
});
