import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallsService, RECOVER_ANALYSIS_MAX_CHECKS, encodeActive } from '../src/modules/calls';
import { QUEUES, bullConnection, bullPrefix } from '../src/modules/jobs';
import { REDIS, type RedisLike, redisKeys } from '../src/modules/redis';
import type { RetellCallFacts } from '../src/modules/retell';
import { CallRecoveryService, RECOVER_NOT_FOUND_CHECKS_IN_PROGRESS, WebhookEventsService } from '../src/modules/webhooks';
import { type FakeRetellGateway, startD5Harness } from './d5-fixtures';
import { type PaidWorkspace, authFor, paidWorkspace } from './d6-fixtures';

/*
 * §13.11 `call-recovery` (ADR 0011 §7): a call whose `call_ended` / `call_analyzed` the
 * platform never delivered is settled from `get-call`, through the ordinary webhook path,
 * exactly once — and a real webhook arriving afterwards is a duplicate, not a second
 * charge. Real Postgres, Redis and worker; the platform is the D5 double.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let retell: FakeRetellGateway;
let recovery: CallRecoveryService;
let events: WebhookEventsService;
let calls: CallsService;
let auth: ReturnType<typeof authFor>;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  stop = harness.stop;
  retell = harness.retell;
  recovery = app.get(CallRecoveryService);
  events = app.get(WebhookEventsService);
  calls = app.get(CallsService);
  auth = authFor(harness.customerTenant);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const newCallId = () => `call_${randomUUID().replace(/-/g, '')}`;
const debits = (ws: string, id: string) => adminDb.creditLedger.findMany({ where: { tenantId: ws, reason: 'call', refId: id } });

/** A row as `call_started` leaves it, `startedMinutesAgo` ago, with nothing after it. */
async function startedCall(ws: PaidWorkspace, startedMinutesAgo: number, status: 'in_progress' | 'ended' = 'in_progress') {
  const id = newCallId();
  const startedAt = minutesAgo(startedMinutesAgo);
  await adminDb.call.create({
    data: {
      id,
      tenantId: ws.workspaceId,
      channel: 'web',
      isTest: true,
      status,
      startedAt,
      createdAt: startedAt,
      rate: new Prisma.Decimal(1),
      configVersion: 1,
      ...(status === 'ended' ? { endedAt: new Date(startedAt.getTime() + 60_000), durationS: 60, creditsCharged: new Prisma.Decimal(1) } : {}),
    },
  });
  return { id, startedAt };
}

function platformCall(id: string, ws: PaidWorkspace, startedAt: Date, over: Partial<RetellCallFacts> = {}): RetellCallFacts {
  const start = startedAt.getTime();
  return {
    call_id: id,
    call_type: 'web_call',
    call_status: 'ended',
    agent_version: 0,
    start_timestamp: start,
    end_timestamp: start + 90_000,
    duration_ms: 90_000,
    disconnection_reason: 'user_hangup',
    metadata: { tenant_id: ws.workspaceId, version_no: 3, tier: 'standard', test: true },
    transcript: 'Agent: Hello.\nUser: Table for ten.',
    call_analysis: { call_summary: 'Caller asked for a table for ten.', call_successful: true, custom_analysis_data: { party_size: 10 } },
    call_cost: { combined_cost: 12.5 },
    ...over,
  };
}

async function settled(id: string, types: string[]) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = await adminDb.webhookEvent.findMany({ where: { provider: 'retell', externalId: id, eventType: { in: types } }, select: { processedAt: true } });
    if (rows.length === types.length && rows.every((r) => r.processedAt)) return;
    if (Date.now() > deadline) throw new Error(`${id}: ${types.join(', ')} not processed in time`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('call-recovery (§13.11, ADR 0011 §7)', () => {
  it('bills a call whose call_ended never arrived, once, and stores its analysis', async () => {
    const ws = await paidWorkspace(app, 'recover-ended', 'growth');
    const { id, startedAt } = await startedCall(ws, 10);
    retell.callObjects.set(id, platformCall(id, ws, startedAt));

    const first = await recovery.recover();
    expect(first.recovered.call_ended).toBeGreaterThanOrEqual(1);
    await settled(id, ['call_ended', 'call_analyzed']);

    const row = await adminDb.call.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('analyzed');
    expect(row.durationS).toBe(90);
    expect(row.creditsCharged?.toNumber()).toBe(1.5);
    expect((row.analysisJson as { call_summary?: string }).call_summary).toMatch(/table for ten/);
    expect(await debits(ws.workspaceId, id)).toHaveLength(1);
    const stored = await adminDb.webhookEvent.findFirstOrThrow({ where: { provider: 'retell', externalId: id, eventType: 'call_ended' } });
    expect((stored.payloadJson as { recovered_by?: string }).recovered_by).toBe('call-recovery');

    // A second tick finds nothing to do for it.
    const asked = retell.countOf('retrieveCallFacts');
    await recovery.recover();
    expect(retell.calls.slice(asked).some((c) => c.args[0] === id)).toBe(false);

    // The platform's own delivery, arriving late, is a duplicate of a processed event — not a second charge.
    const late = await events.store({ provider: 'retell', externalId: id, eventType: 'call_ended', payload: { event: 'call_ended', call: platformCall(id, ws, startedAt) } });
    expect(late.kind).toBe('duplicate');
    expect(await debits(ws.workspaceId, id)).toHaveLength(1);
  });

  it('leaves a call alone while the platform says it is still running, or ended moments ago', async () => {
    const ws = await paidWorkspace(app, 'recover-live', 'growth');
    const live = await startedCall(ws, 10);
    retell.callObjects.set(live.id, platformCall(live.id, ws, live.startedAt, { call_status: 'ongoing', end_timestamp: null }));
    const justEnded = await startedCall(ws, 10);
    retell.callObjects.set(justEnded.id, platformCall(justEnded.id, ws, justEnded.startedAt, { end_timestamp: Date.now() - 30_000 }));
    const young = await startedCall(ws, 1); // too new to ask about at all

    const asked = retell.countOf('retrieveCallFacts');
    await recovery.recover();
    const askedAbout = retell.calls.slice(asked).map((c) => c.args[0]);
    expect(askedAbout).toContain(live.id);
    expect(askedAbout).toContain(justEnded.id);
    expect(askedAbout).not.toContain(young.id);
    for (const id of [live.id, justEnded.id, young.id]) {
      expect(await adminDb.webhookEvent.count({ where: { provider: 'retell', externalId: id } })).toBe(0);
      expect((await adminDb.call.findUniqueOrThrow({ where: { id } })).status).toBe('in_progress');
    }
  });

  it('does not ask about a call whose call_ended is already stored — that one is the queue’s', async () => {
    const ws = await paidWorkspace(app, 'recover-stored', 'growth');
    const { id, startedAt } = await startedCall(ws, 10);
    retell.callObjects.set(id, platformCall(id, ws, startedAt));
    await adminDb.webhookEvent.create({ data: { provider: 'retell', externalId: id, eventType: 'call_ended', payloadJson: { event: 'call_ended', call: platformCall(id, ws, startedAt) } as Prisma.InputJsonValue } });

    const asked = retell.countOf('retrieveCallFacts');
    await recovery.recover();
    expect(retell.calls.slice(asked).some((c) => c.args[0] === id)).toBe(false);
  });

  it('fills in a lost call_analyzed without billing again', async () => {
    const ws = await paidWorkspace(app, 'recover-analysis', 'growth');
    const { id, startedAt } = await startedCall(ws, 30, 'ended');
    retell.callObjects.set(id, platformCall(id, ws, startedAt, { end_timestamp: startedAt.getTime() + 60_000 }));

    const tick = await recovery.recover();
    expect(tick.recovered.call_analyzed).toBeGreaterThanOrEqual(1);
    await settled(id, ['call_analyzed']);
    const row = await adminDb.call.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('analyzed');
    expect(row.retellCostCents).toBe(13);
    expect(await debits(ws.workspaceId, id)).toHaveLength(0); // call_analyzed never bills
    expect(await adminDb.webhookEvent.count({ where: { provider: 'retell', externalId: id, eventType: 'call_ended' } })).toBe(0);
  });

  it('counts a provider failure or an unknown call and carries on with the rest', async () => {
    const ws = await paidWorkspace(app, 'recover-errors', 'growth');
    const unknown = await startedCall(ws, 10); // no platform copy → not found
    const outcome = await recovery.recover();
    expect(outcome.not_found).toBeGreaterThanOrEqual(1);
    // An in_progress row the platform cannot find is given a second ask before it is settled.
    const row = await adminDb.call.findUniqueOrThrow({ where: { id: unknown.id } });
    expect(row.status).toBe('in_progress');
    expect(row.recoveryChecks).toBe(1);
    expect(row.recoveryCheckedAt).not.toBeNull();

    const flaky = await startedCall(ws, 10);
    retell.callObjects.set(flaky.id, platformCall(flaky.id, ws, flaky.startedAt));
    retell.failNext('retrieveCallFacts', 1, new Error('retell answered 502'));
    const failed = await recovery.recover();
    expect(failed.failed).toBe(1);
    // A provider failure is not an ask: nothing was learned, so the row is not marked.
    expect((await adminDb.call.findUniqueOrThrow({ where: { id: flaky.id } })).recoveryChecks).toBe(0);
    // The next tick settles it.
    await recovery.recover();
    await settled(flaky.id, ['call_ended', 'call_analyzed']);
    expect(await debits(ws.workspaceId, flaky.id)).toHaveLength(1);
  });

  it('asks about a row once per recheck interval, never-asked rows first', async () => {
    const ws = await paidWorkspace(app, 'recover-recheck', 'growth');
    const long = await startedCall(ws, 10);
    retell.callObjects.set(long.id, platformCall(long.id, ws, long.startedAt, { call_status: 'ongoing', end_timestamp: null }));

    await recovery.recover();
    const asked = retell.countOf('retrieveCallFacts');
    await recovery.recover(); // the same tick again: the row was asked a moment ago
    expect(retell.calls.slice(asked).some((c) => c.args[0] === long.id)).toBe(false);

    // Fifteen minutes on, it is asked again.
    await adminDb.call.update({ where: { id: long.id }, data: { recoveryCheckedAt: minutesAgo(16) } });
    const later = retell.countOf('retrieveCallFacts');
    await recovery.recover();
    expect(retell.calls.slice(later).some((c) => c.args[0] === long.id)).toBe(true);
    expect((await adminDb.call.findUniqueOrThrow({ where: { id: long.id } })).recoveryChecks).toBe(2);
  });

  it('settles a call the platform never created as not connected, charging nothing and freeing its slot', async () => {
    const ws = await paidWorkspace(app, 'recover-phantom', 'growth');
    const redis = app.get<RedisLike>(REDIS);
    // As the inbound allow leaves it: a registered row and a reservation, and then the caller hung up before the platform made the call.
    const id = newCallId();
    const at = minutesAgo(10);
    await adminDb.call.create({ data: { id, tenantId: ws.workspaceId, channel: 'phone', status: 'registered', createdAt: at, rate: new Prisma.Decimal(1), configVersion: 1 } });
    await redis.hset(redisKeys.activeCalls(ws.workspaceId), id, encodeActive(5, Date.now() + 3_600_000));

    const outcome = await recovery.recover();
    expect(outcome.not_found).toBeGreaterThanOrEqual(1);
    expect(outcome.recovered.call_ended).toBeGreaterThanOrEqual(1);
    await settled(id, ['call_ended']);
    const row = await adminDb.call.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ended');
    expect(row.creditsCharged?.toNumber() ?? 0).toBe(0);
    expect(row.disconnectionReason).toBe('call_not_found');
    expect(await debits(ws.workspaceId, id)).toHaveLength(0);
    expect(await redis.hgetall(redisKeys.activeCalls(ws.workspaceId))).not.toHaveProperty(id);
    const stored = await adminDb.webhookEvent.findFirstOrThrow({ where: { provider: 'retell', externalId: id, eventType: 'call_ended' } });
    expect(stored.payloadJson).toMatchObject({ recovered_by: 'call-recovery', recovery_reason: 'not_found', call: { call_status: 'not_connected' } });

    // An in_progress row — call_started proved the call existed — is settled only when the platform has said so twice.
    const started = await startedCall(ws, 10);
    await recovery.recover();
    expect((await adminDb.call.findUniqueOrThrow({ where: { id: started.id } })).status).toBe('in_progress');
    await adminDb.call.update({ where: { id: started.id }, data: { recoveryCheckedAt: minutesAgo(16) } });
    await recovery.recover();
    await settled(started.id, ['call_ended']);
    const gone = await adminDb.call.findUniqueOrThrow({ where: { id: started.id } });
    expect(gone.status).toBe('ended');
    expect(gone.recoveryChecks).toBe(RECOVER_NOT_FOUND_CHECKS_IN_PROGRESS);
    expect(await debits(ws.workspaceId, started.id)).toHaveLength(0);
  });

  it('gives up on a missing analysis after a few asks instead of one per tick for six hours', async () => {
    const ws = await paidWorkspace(app, 'recover-no-analysis', 'growth');
    const { id, startedAt } = await startedCall(ws, 30, 'ended');
    retell.callObjects.set(id, platformCall(id, ws, startedAt, { end_timestamp: startedAt.getTime() + 60_000, call_analysis: null }));

    for (let i = 0; i < RECOVER_ANALYSIS_MAX_CHECKS; i += 1) {
      const before = retell.countOf('retrieveCallFacts');
      await recovery.recover();
      expect(retell.calls.slice(before).filter((c) => c.args[0] === id)).toHaveLength(1);
      await adminDb.call.update({ where: { id }, data: { recoveryCheckedAt: minutesAgo(16) } });
    }
    const before = retell.countOf('retrieveCallFacts');
    await recovery.recover();
    expect(retell.calls.slice(before).some((c) => c.args[0] === id)).toBe(false);
    expect((await recovery.recoverOne(id)).checked).toBe(0);
    expect((await adminDb.call.findUniqueOrThrow({ where: { id } })).recoveryChecks).toBe(RECOVER_ANALYSIS_MAX_CHECKS);
  });
});

describe('recover-call: one call someone is looking at (ADR 0011 §7)', () => {
  it('settles a call ended 20 s ago with nothing delivered — no 3-minute floor, no 5-minute tick', async () => {
    const ws = await paidWorkspace(app, 'recover-one', 'growth');
    const startedAt = new Date(Date.now() - 60_000);
    const id = newCallId();
    await adminDb.call.create({ data: { id, tenantId: ws.workspaceId, channel: 'web', isTest: true, status: 'in_progress', startedAt, createdAt: startedAt, rate: new Prisma.Decimal(1), configVersion: 1 } });
    retell.callObjects.set(id, platformCall(id, ws, startedAt, { end_timestamp: Date.now() - 20_000, duration_ms: 40_000 }));

    // The schedule would not touch it yet: the row is a minute old.
    const asked = retell.countOf('retrieveCallFacts');
    await recovery.recover();
    expect(retell.calls.slice(asked).some((c) => c.args[0] === id)).toBe(false);

    const outcome = await recovery.recoverOne(id);
    expect(outcome.recovered).toEqual({ call_ended: 1, call_analyzed: 1 });
    await settled(id, ['call_ended', 'call_analyzed']);
    expect((await adminDb.call.findUniqueOrThrow({ where: { id } })).status).toBe('analyzed');
    expect(await debits(ws.workspaceId, id)).toHaveLength(1);

    // Asked again — a poll after the job settled — it is settled and asks nothing.
    const before = retell.countOf('retrieveCallFacts');
    expect((await recovery.recoverOne(id)).checked).toBe(0);
    expect(retell.countOf('retrieveCallFacts')).toBe(before);
  });

  it('asks nothing when the missing analysis is already stored and only waiting for the queue', async () => {
    const ws = await paidWorkspace(app, 'recover-one-stored', 'growth');
    const { id, startedAt } = await startedCall(ws, 5, 'ended');
    await adminDb.webhookEvent.create({ data: { provider: 'retell', externalId: id, eventType: 'call_analyzed', payloadJson: { event: 'call_analyzed', call: platformCall(id, ws, startedAt) } as Prisma.InputJsonValue } });
    const before = retell.countOf('retrieveCallFacts');
    expect((await recovery.recoverOne(id)).checked).toBe(0);
    expect(retell.countOf('retrieveCallFacts')).toBe(before);
  });

  it('waits a minute for the analysis before spending an ask on it', async () => {
    const ws = await paidWorkspace(app, 'recover-one-analysis', 'growth');
    const fresh = await startedCall(ws, 1, 'ended'); // ended a few seconds ago (startedCall ends it a minute after start)
    await adminDb.call.update({ where: { id: fresh.id }, data: { endedAt: new Date(Date.now() - 10_000) } });
    retell.callObjects.set(fresh.id, platformCall(fresh.id, ws, fresh.startedAt));
    expect((await recovery.recoverOne(fresh.id)).checked).toBe(0);

    await adminDb.call.update({ where: { id: fresh.id }, data: { endedAt: new Date(Date.now() - 90_000) } });
    const outcome = await recovery.recoverOne(fresh.id);
    expect(outcome.recovered.call_analyzed).toBe(1);
    await settled(fresh.id, ['call_analyzed']);
    // Asked again straight away it waits for the last ask to age, whatever the card's polling does.
    const again = await startedCall(ws, 5, 'ended');
    await adminDb.call.update({ where: { id: again.id }, data: { recoveryCheckedAt: new Date(), recoveryChecks: 1 } });
    expect((await recovery.recoverOne(again.id)).checked).toBe(0);
  });

  it('leaves a call the platform ended seconds ago for its own webhook', async () => {
    const ws = await paidWorkspace(app, 'recover-one-fresh', 'growth');
    const { id, startedAt } = await startedCall(ws, 1);
    retell.callObjects.set(id, platformCall(id, ws, startedAt, { end_timestamp: Date.now() - 3_000 }));

    const outcome = await recovery.recoverOne(id);
    expect(outcome.live).toBe(1);
    expect(await adminDb.webhookEvent.count({ where: { provider: 'retell', externalId: id } })).toBe(0);
  });

  it('GET /calls/:id queues it for an unsettled row, and not for a settled one', async () => {
    const ws = await paidWorkspace(app, 'recover-one-route', 'growth');
    const open = await startedCall(ws, 1);
    const done = await startedCall(ws, 30, 'ended');
    await adminDb.call.update({ where: { id: done.id }, data: { status: 'analyzed', analysisJson: { call_summary: 'done' } } });
    const queue = new Queue(QUEUES.webhooks, { connection: bullConnection(process.env.REDIS_URL, 'producer'), prefix: bullPrefix() });
    try {
      for (const id of [open.id, done.id]) {
        const res = await app.inject({ method: 'GET', url: `/calls/${id}`, headers: await auth(ws.sub, ws.workspaceId) });
        expect(res.statusCode).toBe(200);
      }
      const deadline = Date.now() + 2_000;
      let job = await queue.getJob(`recover-${open.id}`);
      while (!job && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        job = await queue.getJob(`recover-${open.id}`);
      }
      expect(job?.name).toBe('recover-call');
      expect(await queue.getJob(`recover-${done.id}`)).toBeUndefined();
      await job?.remove();
    } finally {
      await queue.close();
    }
  });
});

describe('calls.agent_version is our version number, not the platform’s', () => {
  it('takes metadata.version_no, and never stores the platform counter', async () => {
    const ws = await paidWorkspace(app, 'agent-version', 'growth');
    const tagged = newCallId();
    await calls.handleLifecycle({ event: 'call_started', call: { call_id: tagged, call_type: 'web_call', agent_version: 0, start_timestamp: Date.now(), metadata: { tenant_id: ws.workspaceId, version_no: 3, tier: 'standard', test: true } } });
    expect((await adminDb.call.findUniqueOrThrow({ where: { id: tagged } })).agentVersion).toBe(3);

    const untagged = newCallId();
    await calls.handleLifecycle({ event: 'call_started', call: { call_id: untagged, call_type: 'web_call', agent_version: 7, start_timestamp: Date.now(), metadata: { tenant_id: ws.workspaceId, tier: 'standard' } } });
    expect((await adminDb.call.findUniqueOrThrow({ where: { id: untagged } })).agentVersion).toBeNull();
  });
});
