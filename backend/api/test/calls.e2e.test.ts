import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { InboundAuthorizationService } from '../src/modules/calls';
import { EventsService } from '../src/modules/events';
import { PlatformConfigService } from '../src/modules/config';
import { JobQueues, QUEUES } from '../src/modules/jobs';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { RetellGateway } from '../src/modules/retell';
import { RuntimeCacheService } from '../src/modules/runtime-cache';
import { WalletService } from '../src/modules/wallet';
import { WebhookProcessingService } from '../src/modules/webhooks';
import { type CallWorkspace, callId, createCallWorkspace, inboundEvent, ledgerSum, lifecycleEvent, startHarness, waitFor, waitForBilled } from './calls-fixtures';

/*
 * The D4 money path, end to end (§13.9, §13.10, §14): a real signed webhook arrives, the
 * six checks run against real Redis, the answer goes back to Retell, and a real BullMQ
 * worker writes the `calls` row and moves credits — exactly once, whatever arrives twice.
 *
 * Needs Postgres, Redis and the seed:
 *   pnpm infra:up && pnpm db:roles && pnpm db:deploy && pnpm db:seed
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let retell: RetellGateway;
let runtimeCache: RuntimeCacheService;
let wallet: WalletService;
let config: PlatformConfigService;
let cache: RedisCache;

beforeAll(async () => {
  const harness = await startHarness();
  app = harness.app;
  stop = harness.stop;
  retell = app.get(RetellGateway);
  runtimeCache = app.get(RuntimeCacheService);
  wallet = app.get(WalletService);
  config = app.get(PlatformConfigService);
  cache = app.get(RedisCache);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

/** Posts a body to a webhook route with a signature Retell itself would accept. */
async function post(url: string, body: unknown, signature?: string) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signature ?? (await retell.signWebhookBody(payload)) },
    payload,
  });
}

async function inbound(ws: CallWorkspace, body: unknown, token = ws.token, signature?: string) {
  return post(`/webhooks/retell/inbound/${token}`, body, signature);
}

const callRow = (id: string) => adminDb.call.findUnique({ where: { id } });

async function readyWorkspace(label: string, credits = 200, options: Parameters<typeof createCallWorkspace>[1] = {}): Promise<CallWorkspace> {
  const ws = await createCallWorkspace(label, options);
  await wallet.grant(ws.tenantId, { credits, reason: 'purchase', expiresAt: new Date(Date.now() + 365 * 86_400_000) });
  await runtimeCache.refresh(ws.tenantId);
  return ws;
}

// ---------------------------------------------------------------------------
describe('POST /webhooks/retell/inbound/:number_token — the six checks (§13.9)', () => {
  it('allows a healthy call, sizes its duration from the balance, and writes the row from the queue', async () => {
    const ws = await readyWorkspace('allow', 5); // 5 credits at 1/min = 5 minutes, under the 10-minute agent max
    const id = callId();

    const res = await inbound(ws, inboundEvent({ callId: id, to: ws.e164 }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.call_inbound.override_agent_id).toBe(ws.retellAgentId);
    expect(body.call_inbound.agent_override.agent.max_call_duration_ms).toBe(300_000);
    expect(body.call_inbound.metadata).toMatchObject({ tenant_id: ws.tenantId, number_id: ws.numberId, tier: 'standard' });
    expect(body.call_inbound.dynamic_variables.business_name).toContain('allow');

    // The slot is taken before the answer goes out, so the next call sees it.
    const active = await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId));
    expect(Object.keys(active)).toEqual([id]);

    const row = await waitFor('the calls row', () => callRow(id));
    expect(row).toMatchObject({ tenantId: ws.tenantId, numberId: ws.numberId, agentId: ws.agentId, status: 'registered', channel: 'phone', direction: 'inbound' });
    expect(row.rate.toNumber()).toBe(1);
    expect(row.configVersion).toBeGreaterThanOrEqual(1);
    expect(row.declineReason).toBeNull();
  });

  it('declines on balance once the wallet is past the grace overdraft, and the row is Missed', async () => {
    const ws = await readyWorkspace('balance', 5);
    await wallet.debit(ws.tenantId, { credits: 20, reason: 'adjustment' }); // → −15, past the 10-credit grace
    await runtimeCache.refresh(ws.tenantId);
    const id = callId();

    const res = await inbound(ws, inboundEvent({ callId: id, to: ws.e164 }));
    expect(res.json()).toEqual({ call_inbound: { reject: true } });

    const row = await waitFor('the declined row', () => callRow(id));
    expect(row).toMatchObject({ status: 'declined', declineReason: 'balance' });
    expect(row.creditsCharged?.toNumber()).toBe(0);
    expect(row.endedAt).not.toBeNull();
    // A decline costs nothing: no Retell call object, no ledger movement.
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, reason: 'call' } })).toBe(0);
  });

  it('declines a paused workspace, a paused number and a number with no live agent', async () => {
    const paused = await readyWorkspace('paused-ws');
    await adminDb.tenant.update({ where: { id: paused.tenantId }, data: { pausedAt: new Date(), pausedReason: 'e2e' } });
    await runtimeCache.refresh(paused.tenantId);
    const a = callId();
    expect((await inbound(paused, inboundEvent({ callId: a, to: paused.e164 }))).json()).toEqual({ call_inbound: { reject: true } });
    expect(await waitFor('paused row', () => callRow(a))).toMatchObject({ status: 'declined', declineReason: 'paused' });

    const number = await readyWorkspace('paused-num');
    await adminDb.phoneNumber.update({ where: { id: number.numberId }, data: { pausedAt: new Date() } });
    await runtimeCache.refresh(number.tenantId);
    const b = callId();
    expect((await inbound(number, inboundEvent({ callId: b, to: number.e164 }))).json()).toEqual({ call_inbound: { reject: true } });
    expect(await waitFor('paused number row', () => callRow(b))).toMatchObject({ status: 'declined', declineReason: 'paused' });

    const draft = await readyWorkspace('draft-agent');
    await adminDb.agent.update({ where: { id: draft.agentId }, data: { status: 'draft' } });
    await runtimeCache.refresh(draft.tenantId);
    const c = callId();
    expect((await inbound(draft, inboundEvent({ callId: c, to: draft.e164 }))).json()).toEqual({ call_inbound: { reject: true } });
    expect(await waitFor('draft agent row', () => callRow(c))).toMatchObject({ status: 'declined', declineReason: 'paused' });
  });

  it('declines a blocklisted caller, from the number and from the platform blocklist', async () => {
    const ws = await readyWorkspace('blocked');
    await adminDb.phoneNumber.update({ where: { id: ws.numberId }, data: { blocklist: ['+19375550100'] } });
    await runtimeCache.refresh(ws.tenantId);
    const id = callId();
    expect((await inbound(ws, inboundEvent({ callId: id, to: ws.e164, from: '+19375550100' }))).json()).toEqual({ call_inbound: { reject: true } });
    expect(await waitFor('blocked row', () => callRow(id))).toMatchObject({ status: 'declined', declineReason: 'blocked', fromNumber: '+19375550100' });

    // Another caller on the same number still gets through.
    const other = callId();
    expect((await inbound(ws, inboundEvent({ callId: other, to: ws.e164, from: '+19375550199' }))).json().call_inbound.reject).toBeUndefined();

    const global = await readyWorkspace('blocked-global');
    const spammer = `+1937555${Math.floor(Math.random() * 9000) + 1000}`;
    await adminDb.blocklist.create({ data: { type: 'phone', value: spammer, reason: 'e2e fraud' } });
    await runtimeCache.refresh(global.tenantId);
    const g = callId();
    expect((await inbound(global, inboundEvent({ callId: g, to: global.e164, from: spammer }))).json()).toEqual({ call_inbound: { reject: true } });
    expect(await waitFor('global blocked row', () => callRow(g))).toMatchObject({ declineReason: 'blocked' });
  });

  it('declines on the concurrency cap once the plan’s slots are full', async () => {
    const ws = await readyWorkspace('cap');
    const caps = await config.capsFor(ws.tenantId);
    expect(caps.concurrency_cap).toBeGreaterThan(0);
    const allowed: string[] = [];
    for (let i = 0; i < caps.concurrency_cap; i += 1) {
      const id = callId();
      const res = await inbound(ws, inboundEvent({ callId: id, to: ws.e164 }));
      expect(res.json().call_inbound.reject, `call ${i + 1} of ${caps.concurrency_cap}`).toBeUndefined();
      allowed.push(id);
    }
    const overflow = callId();
    expect((await inbound(ws, inboundEvent({ callId: overflow, to: ws.e164 }))).json()).toEqual({ call_inbound: { reject: true } });
    expect(await waitFor('cap row', () => callRow(overflow))).toMatchObject({ status: 'declined', declineReason: 'cap' });

    // Ending one call frees exactly one slot.
    await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: allowed[0], start_timestamp: Date.now() - 1_000, end_timestamp: Date.now(), disconnection_reason: 'user_hangup', metadata: { tenant_id: ws.tenantId } }));
    await waitFor('the slot to be released', async () => Object.keys(await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId))).length < caps.concurrency_cap);
    const after = callId();
    expect((await inbound(ws, inboundEvent({ callId: after, to: ws.e164 }))).json().call_inbound.reject).toBeUndefined();
  });

  it('declines outside business hours and allows a 24/7 number at the same instant', async () => {
    const ws = await readyWorkspace('hours');
    // A schedule that is closed all week, in the workspace timezone.
    await adminDb.tenant.update({ where: { id: ws.tenantId }, data: { businessHoursJson: { days: {}, closed_dates: [] } } });
    await adminDb.phoneNumber.update({ where: { id: ws.numberId }, data: { hoursMode: 'business' } });
    await runtimeCache.refresh(ws.tenantId);
    const id = callId();
    expect((await inbound(ws, inboundEvent({ callId: id, to: ws.e164 }))).json()).toEqual({ call_inbound: { reject: true } });
    expect(await waitFor('hours row', () => callRow(id))).toMatchObject({ status: 'declined', declineReason: 'hours' });

    await adminDb.phoneNumber.update({ where: { id: ws.numberId }, data: { hoursMode: 'always' } });
    await runtimeCache.refresh(ws.tenantId);
    const open = callId();
    expect((await inbound(ws, inboundEvent({ callId: open, to: ws.e164 }))).json().call_inbound.reject).toBeUndefined();
  });

  it('answers 200 {} and writes nothing for an unknown number, an unknown token or a forged signature', async () => {
    const ws = await readyWorkspace('unknown');
    const before = await adminDb.call.count();

    const unknownNumber = await inbound(ws, inboundEvent({ callId: callId(), to: '+15005550000' }));
    expect(unknownNumber.statusCode).toBe(200);
    expect(unknownNumber.json()).toEqual({});

    const wrongToken = await inbound(ws, inboundEvent({ callId: callId(), to: ws.e164 }), 'tok_not_the_right_token_at_all');
    expect(wrongToken.json()).toEqual({});

    const forged = await inbound(ws, inboundEvent({ callId: callId(), to: ws.e164 }), ws.token, 'v=1,d=deadbeef');
    expect(forged.statusCode).toBe(200);
    expect(forged.json()).toEqual({});

    const malformed = await post(`/webhooks/retell/inbound/${ws.token}`, { event: 'call_inbound' });
    expect(malformed.statusCode).toBe(200);
    expect(malformed.json()).toEqual({});

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await adminDb.call.count()).toBe(before);
  });

  it('answers within the 300 ms budget, warm and cold', async () => {
    const ws = await readyWorkspace('latency');
    const timings: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const started = process.hrtime.bigint();
      const res = await inbound(ws, inboundEvent({ callId: callId(), to: ws.e164 }));
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      expect(res.statusCode).toBe(200);
      // Keep the concurrency cap out of it: this measures latency, not authorisation.
      await cache.client.del(redisKeys.activeCalls(ws.tenantId));
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)]!;
    expect(p95, `p95 ${p95.toFixed(1)} ms over ${timings.length} calls`).toBeLessThan(300);
  });

  it('fails open when Redis does not answer, and closed when the operator says so (ADR 0003 §12)', async () => {
    const ws = await readyWorkspace('redis-down');
    // A client pointed at a port nothing listens on: every command errors inside the budget.
    const dead = new Redis({ host: '127.0.0.1', port: 6399, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy: () => null });
    dead.on('error', () => undefined);
    void dead.connect().catch(() => undefined);
    const queues = app.get(JobQueues);

    const open = new InboundAuthorizationService(dead, queues);
    const started = Date.now();
    const outcome = await open.authorize(ws.token, { call_inbound: { call_id: callId(), to_number: ws.e164, from_number: '+19375550100' } } as never);
    expect(outcome.body).toEqual({});
    expect(outcome.answered).toBe('fail_open');
    expect(Date.now() - started).toBeLessThan(300);
    expect(open.metrics.redisDown).toBe(1);

    process.env.INBOUND_REDIS_DOWN_POLICY = 'closed';
    const closed = new InboundAuthorizationService(dead, queues);
    const declined = await closed.authorize(ws.token, { call_inbound: { call_id: callId(), to_number: ws.e164 } } as never);
    expect(declined.body).toEqual({ call_inbound: { reject: true } });
    delete process.env.INBOUND_REDIS_DOWN_POLICY;
    dead.disconnect();
  });

  it('lets exactly cap calls through when twenty arrive at once — the race is closed, not narrowed', async () => {
    const ws = await readyWorkspace('concurrency-race', 500);
    const caps = await config.capsFor(ws.tenantId);
    const ids = Array.from({ length: 20 }, () => callId());

    // All twenty in flight together: each one reads the same `active:{ws}` before any of
    // them has written to it. Without the check-and-reserve script every one of them would
    // see a free slot and be allowed (ADR 0011 §1).
    const answers = await Promise.all(ids.map((id) => inbound(ws, inboundEvent({ callId: id, to: ws.e164 }))));
    const allowed = answers.filter((res) => res.json().call_inbound?.reject === undefined);
    const declined = answers.filter((res) => res.json().call_inbound?.reject === true);

    expect(allowed).toHaveLength(caps.concurrency_cap);
    expect(declined).toHaveLength(20 - caps.concurrency_cap);
    expect(Object.keys(await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId)))).toHaveLength(caps.concurrency_cap);

    // Every refusal is recorded as a Missed call with a reason, like any other decline.
    const rows = await waitFor('all twenty rows', async () => {
      const found = await adminDb.call.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, declineReason: true } });
      return found.length === 20 ? found : null;
    });
    expect(rows.filter((r) => r.status === 'declined').every((r) => r.declineReason === 'cap')).toBe(true);
  });

  it('never authorises more credits than the wallet plus the grace can cover, under a burst', async () => {
    // 5 credits and a 10-credit grace: the other live calls' reservations may total at most
    // 15 before the next call is declined on balance. Twenty calls arrive at once.
    const ws = await readyWorkspace('credit-race', 5);
    await adminDb.tenantOverride.create({ data: { tenantId: ws.tenantId, concurrencyCap: 50, reason: 'e2e credit race' } });
    await runtimeCache.refresh(ws.tenantId);

    const ids = Array.from({ length: 20 }, () => callId());
    const answers = await Promise.all(ids.map((id) => inbound(ws, inboundEvent({ callId: id, to: ws.e164 }))));
    const allowed = answers.filter((res) => res.json().call_inbound?.reject === undefined).length;
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(20);

    const hash = await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId));
    const reserved = Object.values(hash).reduce((sum, entry) => sum + Number(entry.split('|')[0]), 0);
    // The last call admitted may cross the ceiling by its own reservation and no more,
    // which is what the grace overdraft is for (§5.4).
    expect(reserved).toBeLessThanOrEqual(15 + 5);
  });

  it('still reserves and sizes the call when pricing:current has expired', async () => {
    // `pricing:current` carries the 60 s config TTL (admin §5.2's "portal re-reads within
    // 60 s") while `runtime-cache-refresh` runs every five minutes, so for most of every
    // cycle the hot path found no rate. A decision without a rate reserves nothing and
    // sizes the call from `plan_max_ms` alone, which stops concurrent calls from seeing
    // each other's spend and lets a workspace run to several times the grace. The rate is
    // now written into `num:{e164}` beside `plan_max_ms`, so both halves of
    // `min(planMax, remainingCredits/rate × 60000)` live and expire together.
    const ws = await readyWorkspace('cold-pricing', 4);
    await runtimeCache.refresh(ws.tenantId);
    await cache.del(redisKeys.pricingCurrent);
    expect(await cache.get(redisKeys.pricingCurrent)).toBeNull();

    const id = callId();
    const res = await inbound(ws, inboundEvent({ callId: id, to: ws.e164 }));
    expect(res.statusCode).toBe(200);
    const answer = res.json().call_inbound;
    expect(answer.reject).toBeUndefined();
    // 4 credits at 1 credit/min = 4 minutes, below the workspace's 10-minute plan maximum.
    expect(answer.agent_override.agent.max_call_duration_ms).toBe(240_000);

    const hash = await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId));
    expect(Number(hash[id]?.split('|')[0])).toBe(4);
  });

  it('writes no row for an allowed call that arrived without a call_id — call_started owns that row', async () => {
    const ws = await readyWorkspace('no-call-id');
    const before = await adminDb.call.count({ where: { tenantId: ws.tenantId } });

    const res = await inbound(ws, inboundEvent({ to: ws.e164 }));
    expect(res.statusCode).toBe(200);
    expect(res.json().call_inbound.override_agent_id).toBe(ws.retellAgentId);

    // A synthetic id here would be a phantom `registered` row nothing ever finishes, plus
    // a duplicate of the real row once Retell names the call in call_started.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await adminDb.call.count({ where: { tenantId: ws.tenantId } })).toBe(before);

    const id = callId();
    await post(
      '/webhooks/retell',
      lifecycleEvent('call_started', {
        call_id: id,
        start_timestamp: Date.now(),
        call_status: 'ongoing',
        from_number: '+19375550100',
        to_number: ws.e164,
        metadata: { tenant_id: ws.tenantId, number_id: ws.numberId, agent_id: ws.agentId },
      }),
    );
    const row = await waitFor('the started row', () => callRow(id));
    expect(row.status).toBe('in_progress');
    expect(await adminDb.call.count({ where: { tenantId: ws.tenantId } })).toBe(before + 1);
  });

  it('is deduped by call_id: Retell’s three retries of one webhook make one row', async () => {
    const ws = await readyWorkspace('retries');
    const id = callId();
    const event = inboundEvent({ callId: id, to: ws.e164 });
    const answers = await Promise.all([inbound(ws, event), inbound(ws, event), inbound(ws, event)]);
    for (const res of answers) expect(res.statusCode).toBe(200);
    await waitFor('the row', () => callRow(id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await adminDb.call.count({ where: { id } })).toBe(1);
    expect(Object.keys(await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId)))).toEqual([id]);
  });
});

// ---------------------------------------------------------------------------
describe('what Retell sends more than once, and what an operator can stop (§13.9)', () => {
  it('gives a retried call_inbound the slot it already holds, not a busy tone', async () => {
    // Retell re-sends `call_inbound` with an identical `call_id` up to three times when it
    // does not get an answer it likes — the `call_inbound-decline_timeout-attempt{1,2,3}`
    // fixtures are one caller, one call id, three POSTs. The timeout case is exactly the one
    // where attempt 1 reserved before giving up on us, so by attempt 2 the call's own
    // reservation is in `active:{ws}`. Counted against itself it is a `cap` decline for a
    // slot being held for this very caller, or a duration sized from credits it is holding.
    const ws = await readyWorkspace('inbound-retry', 20);
    await adminDb.tenantOverride.create({ data: { tenantId: ws.tenantId, concurrencyCap: 1, reason: 'e2e inbound retry' } });
    await runtimeCache.refresh(ws.tenantId);
    const id = callId();

    const durations: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await inbound(ws, inboundEvent({ callId: id, to: ws.e164 }));
      expect(res.statusCode).toBe(200);
      const answer = res.json().call_inbound;
      expect(answer.reject, `attempt ${attempt} was declined`).toBeUndefined();
      durations.push(answer.agent_override.agent.max_call_duration_ms);
    }

    // The same answer every time — never the 60 s floor — and one slot held, not three.
    expect(new Set(durations).size).toBe(1);
    expect(durations[0]).toBe(600_000);
    expect(Object.keys(await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId)))).toEqual([id]);

    // And one row, because `inbound-<call_id>` is the job id for all three attempts.
    await waitFor('the row for the retried call', async () => callRow(id));
    expect(await adminDb.call.count({ where: { tenantId: ws.tenantId } })).toBe(1);
  });

  it('obeys the reject_inbound kill switch from a key that outlives the config TTL', async () => {
    // The veto used to be read from `flags:global`, which carries the 60 s config TTL while
    // `runtime-cache-refresh` republishes every five minutes: absent for four minutes in
    // five, and a miss reads as "off", so the switch quietly did nothing. It now has its
    // own projection, written on every flip and kept alive by that same schedule.
    const ws = await readyWorkspace('kill-switch');

    // Flipping the switch republishes the projection even when the flags cache is cold.
    await cache.del(redisKeys.rejectInbound, redisKeys.flagsGlobal);
    await config.setKillSwitch('reject_inbound', { on: false, reason: 'e2e baseline' });
    expect(await cache.get(redisKeys.rejectInbound)).toBe('0');

    // On, with `flags:global` gone — the state the hot path spends most of its life in.
    await cache.set(redisKeys.rejectInbound, '1', 60);
    await cache.del(redisKeys.flagsGlobal);
    try {
      const declined = await inbound(ws, inboundEvent({ callId: callId(), to: ws.e164 }));
      expect(declined.statusCode).toBe(200);
      expect(declined.json()).toEqual({ call_inbound: { reject: true } });
    } finally {
      await cache.set(redisKeys.rejectInbound, '0', 60);
    }

    const allowed = await inbound(ws, inboundEvent({ callId: callId(), to: ws.e164 }));
    expect(allowed.json().call_inbound.reject).toBeUndefined();
  });
});

describe('POST /webhooks/retell — lifecycle and metering (§13.10, §14.2)', () => {
  it('refuses an unsigned or forged event with 401 and stores nothing', async () => {
    const ws = await readyWorkspace('signature');
    const id = callId();
    const event = lifecycleEvent('call_started', { call_id: id, start_timestamp: Date.now(), metadata: { tenant_id: ws.tenantId } });

    const unsigned = await app.inject({ method: 'POST', url: '/webhooks/retell', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(event) });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().code).toBe('INVALID_SIGNATURE');
    expect((await post('/webhooks/retell', event, 'v=1,d=00')).statusCode).toBe(401);

    // Signed for different bytes: the raw-body check catches it.
    const tampered = await post('/webhooks/retell', { ...event, event: 'call_ended' }, await retell.signWebhookBody(JSON.stringify(event)));
    expect(tampered.statusCode).toBe(401);
    expect(await adminDb.webhookEvent.count({ where: { provider: 'retell', externalId: id } })).toBe(0);
  });

  it('runs a whole call: started captures the rate, ended bills once, analyzed only annotates', async () => {
    const ws = await readyWorkspace('lifecycle', 100);
    const id = callId();
    const start = Date.now() - 75_549;
    const end = Date.now();

    const started = await post('/webhooks/retell', lifecycleEvent('call_started', { call_id: id, start_timestamp: start, agent_id: ws.retellAgentId, agent_version: 1, to_number: ws.e164, metadata: { tenant_id: ws.tenantId, number_id: ws.numberId, tier: 'standard' } }));
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({ received: true });

    const inProgress = await waitFor('in_progress', async () => {
      const row = await callRow(id);
      return row?.status === 'in_progress' ? row : null;
    });
    expect(inProgress.rate.toNumber()).toBe(1);
    expect(inProgress.configVersion).toBeGreaterThanOrEqual(1);
    expect(Object.keys(await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId)))).toContain(id);

    const before = await ledgerSum(ws.tenantId);
    await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: end, duration_ms: end - start, disconnection_reason: 'user_hangup', call_status: 'ended', recording_url: 'https://recordings.test/one.mp3', transcript: 'Agent: hello.', metadata: { tenant_id: ws.tenantId } }));

    const ended = await waitFor('the debit', async () => {
      const row = await callRow(id);
      return row && row.creditsCharged !== null && row.status === 'ended' ? row : null;
    });
    // 75 549 ms at 1 credit/min = 1.26 (§14.2, the D2 fixture's own number).
    expect(ended.creditsCharged!.toNumber()).toBe(1.26);
    expect(ended.durationS).toBe(76);
    expect(ended.disconnectionReason).toBe('user_hangup');
    expect(ended.recordingUrl).toBe('https://recordings.test/one.mp3');
    expect(await ledgerSum(ws.tenantId)).toBe(before - 1.26);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, reason: 'call', refId: id } })).toBe(1);
    // The slot is released.
    expect(Object.keys(await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId)))).not.toContain(id);

    const afterEnded = await ledgerSum(ws.tenantId);
    await post('/webhooks/retell', lifecycleEvent('call_analyzed', { call_id: id, start_timestamp: start, end_timestamp: end, call_status: 'ended', disconnection_reason: 'user_hangup', call_cost: { combined_cost: 17.0266692, total_duration_seconds: 76 }, call_analysis: { call_summary: 'Asked about hours.', call_successful: true, in_voicemail: false, custom_analysis_data: { caller_name: 'Sam', call_reason: 'question' } }, metadata: { tenant_id: ws.tenantId } }));

    const analyzed = await waitFor('analysis', async () => {
      const row = await callRow(id);
      return row?.status === 'analyzed' ? row : null;
    });
    expect(analyzed.retellCostCents).toBe(17);
    expect(analyzed.analysisJson).toMatchObject({ call_successful: true });
    expect(analyzed.outcome).toBe('question');
    // The money did not move: call_analyzed never bills (§14.2).
    expect(analyzed.creditsCharged!.toNumber()).toBe(1.26);
    expect(await ledgerSum(ws.tenantId)).toBe(afterEnded);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, reason: 'call', refId: id } })).toBe(1);
  });

  it('a replayed call_ended is a 204 and moves nothing; a re-sent one under a new event id still bills once', async () => {
    const ws = await readyWorkspace('replay', 50);
    const id = callId();
    const start = Date.now() - 60_000;
    const end = Date.now();
    const event = lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: end, disconnection_reason: 'user_hangup', call_status: 'ended', metadata: { tenant_id: ws.tenantId } });

    expect((await post('/webhooks/retell', event)).statusCode).toBe(200);
    await waitForBilled(id);
    const after = await ledgerSum(ws.tenantId);
    expect(after).toBe(49);

    // Byte-identical replay: the (provider, call_id, event_type) key answers 204.
    expect((await post('/webhooks/retell', event)).statusCode).toBe(204);
    expect((await post('/webhooks/retell', event)).statusCode).toBe(204);

    // Same call, a payload that differs (a later re-send): stored as a new row, processed,
    // and the ledger's partial unique index refuses the second debit.
    const resent = { ...event, event_timestamp: Date.now() + 1 };
    expect((await post('/webhooks/retell', resent)).statusCode).toBe(204);

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, reason: 'call', refId: id } })).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(after);
  });

  it('three concurrent call_ended for one call debit exactly once', async () => {
    const ws = await readyWorkspace('race', 50);
    const id = callId();
    const start = Date.now() - 120_000;
    const end = Date.now();
    const base = { call_id: id, start_timestamp: start, end_timestamp: end, disconnection_reason: 'user_hangup', call_status: 'ended', metadata: { tenant_id: ws.tenantId } };

    // Three different event payloads for one call: three stored rows, three jobs, one debit.
    await Promise.all([
      post('/webhooks/retell', { ...lifecycleEvent('call_ended', base), event_timestamp: 1 }),
      post('/webhooks/retell', { ...lifecycleEvent('call_ended', base), event_timestamp: 2 }),
      post('/webhooks/retell', { ...lifecycleEvent('call_ended', base), event_timestamp: 3 }),
    ]);

    await waitForBilled(id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, reason: 'call', refId: id } })).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(48); // 2 minutes at 1 credit/min
    expect((await callRow(id))!.creditsCharged!.toNumber()).toBe(2);
  });

  it('call_ended and call_analyzed in the same instant leave the row analyzed, finalised and billed once', async () => {
    // Retell was seen delivering both in the same millisecond (24 Sep): call_ended read the
    // row as in_progress, call_analyzed committed, and call_ended wrote `ended` over it.
    const ws = await readyWorkspace('ended-analyzed-race', 100);
    const ids = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const id = callId();
        const start = Date.now() - 60_000;
        const facts = { call_id: id, start_timestamp: start, end_timestamp: start + 60_000, disconnection_reason: 'user_hangup', call_status: 'ended', metadata: { tenant_id: ws.tenantId } };
        // Half with a call_started row already there, half where the two race to create it.
        if (i % 2 === 0) {
          await post('/webhooks/retell', lifecycleEvent('call_started', { call_id: id, start_timestamp: start, metadata: { tenant_id: ws.tenantId } }));
          await waitFor('started', async () => (await callRow(id)) ?? null);
        }
        await Promise.all([
          post('/webhooks/retell', lifecycleEvent('call_ended', facts)),
          post('/webhooks/retell', lifecycleEvent('call_analyzed', { ...facts, call_analysis: { call_summary: 'Booked a table.', call_successful: true } })),
        ]);
        return id;
      }),
    );

    for (const id of ids) {
      const row = await waitFor('analyzed and billed', async () => {
        const r = await callRow(id);
        return r?.creditsCharged != null && r.analysisJson ? r : null;
      });
      expect(row.status).toBe('analyzed');
      expect(row.durationS).toBe(60);
      expect(row.disconnectionReason).toBe('user_hangup');
      expect(row.creditsCharged!.toNumber()).toBe(1);
    }
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, reason: 'call' } })).toBe(ids.length);
  });

  it('never bills a call that did not connect, or one with no duration', async () => {
    const ws = await readyWorkspace('not-connected', 30);
    const before = await ledgerSum(ws.tenantId);

    const busy = callId();
    await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: busy, start_timestamp: Date.now(), end_timestamp: Date.now(), duration_ms: 0, call_status: 'not_connected', disconnection_reason: 'dial_busy', metadata: { tenant_id: ws.tenantId } }));
    const busyRow = await waitForBilled(busy);
    expect(busyRow.creditsCharged!.toNumber()).toBe(0);

    const zero = callId();
    const at = Date.now();
    await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: zero, start_timestamp: at, end_timestamp: at, duration_ms: 0, call_status: 'ended', disconnection_reason: 'user_hangup', metadata: { tenant_id: ws.tenantId } }));
    const zeroRow = await waitForBilled(zero);
    expect(zeroRow.creditsCharged!.toNumber()).toBe(0);

    expect(await ledgerSum(ws.tenantId)).toBe(before);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, reason: 'call' } })).toBe(0);
  });

  it('bills a call whose call_started never arrived, capturing the rate at call_ended', async () => {
    const ws = await readyWorkspace('out-of-order', 40);
    const id = callId();
    const start = Date.now() - 90_000;

    await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: start + 90_000, disconnection_reason: 'user_hangup', call_status: 'ended', metadata: { tenant_id: ws.tenantId, tier: 'standard' } }));
    const ended = await waitForBilled(id);
    expect(ended.creditsCharged!.toNumber()).toBe(1.5);
    expect(ended.rate.toNumber()).toBe(1);

    // call_started arriving afterwards must not re-open or re-bill the call.
    await post('/webhooks/retell', lifecycleEvent('call_started', { call_id: id, start_timestamp: start, metadata: { tenant_id: ws.tenantId } }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await callRow(id);
    expect(after!.status).toBe('ended');
    expect(after!.creditsCharged!.toNumber()).toBe(1.5);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, reason: 'call', refId: id } })).toBe(1);
  });

  it('bills at the rate captured when the call started, not the one in force when it ended', async () => {
    const ws = await readyWorkspace('rate-capture', 100);
    const id = callId();
    const start = Date.now() - 60_000;
    await post('/webhooks/retell', lifecycleEvent('call_started', { call_id: id, start_timestamp: start, metadata: { tenant_id: ws.tenantId, tier: 'standard' } }));
    await waitFor('in_progress', async () => (await callRow(id))?.status === 'in_progress');

    // Stand in for a pricing publish mid-call by putting a doubled Standard rate in
    // `pricing:current`, which is what every later read would see. Done through the cache
    // rather than a real publish so this suite leaves no new pricing version behind.
    const current = await config.currentPricing();
    await cache.setJson(redisKeys.pricingCurrent, { ...current, version: current.version + 99, config: { ...current.config, rates: { ...current.config.rates, standard_per_min: 2 } } }, 60);
    expect((await config.rateFor('standard')).rate).toBe(2);

    try {
      await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: start + 60_000, disconnection_reason: 'user_hangup', call_status: 'ended', metadata: { tenant_id: ws.tenantId } }));
      const row = await waitForBilled(id);
      // One minute at the captured 1 credit/min, not the new 2.
      expect(row.creditsCharged!.toNumber()).toBe(1);
      expect(row.rate.toNumber()).toBe(1);
      expect(row.configVersion).toBe(current.version);
    } finally {
      await cache.del(redisKeys.pricingCurrent);
    }
  });

  it('stores an unsupported event type and a malformed payload without retrying either forever', async () => {
    const ws = await readyWorkspace('odd-events');
    const id = callId();
    const transfer = await post('/webhooks/retell', { event: 'transfer_started', call: { call_id: id }, event_timestamp: Date.now() });
    expect(transfer.statusCode).toBe(200);
    const stored = await waitFor('the stored transfer event', async () => {
      const row = await adminDb.webhookEvent.findFirst({ where: { provider: 'retell', externalId: id, eventType: 'transfer_started' } });
      return row?.processedAt ? row : null;
    });
    expect(stored.error).toBeNull();

    // No call_id at all: deduped on the bytes, so a replay is still exactly once.
    const headless = { event: 'call_ended', call: { start_timestamp: 1, end_timestamp: 2 }, event_timestamp: Date.now() };
    expect((await post('/webhooks/retell', headless)).statusCode).toBe(200);
    const byBytes = await waitFor('the digest-keyed row', async () => {
      const row = await adminDb.webhookEvent.findFirst({ where: { provider: 'retell', eventType: 'call_ended', externalId: { startsWith: 'body:' } } });
      return row?.processedAt ? row : null;
    });
    expect(byBytes.error).toBeNull();
    // 204 is for a duplicate of a *processed* event; a replay that overtakes the job is a
    // retry (200) on purpose, so one transient failure cannot make an event undeliverable.
    expect((await post('/webhooks/retell', headless)).statusCode).toBe(204);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, reason: 'call' } })).toBe(0);
  });

  it('bills a premium agent at the premium rate', async () => {
    const ws = await readyWorkspace('premium', 60, { tier: 'premium' });
    const id = callId();
    const start = Date.now() - 120_000;
    await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: start + 120_000, disconnection_reason: 'user_hangup', call_status: 'ended', metadata: { tenant_id: ws.tenantId, tier: 'premium' } }));
    const row = await waitForBilled(id);
    // 2 minutes at 1.5 credits/min.
    expect(row.creditsCharged!.toNumber()).toBe(3);
    expect(row.rate.toNumber()).toBe(1.5);
  });

  it('bills a fail-open call that carries no metadata, identified by the number it was dialled on', async () => {
    // The §13.9 path answered 200 {} — Redis down, or a number it could not identify (ADR
    // 0011 §2) — so Retell answered with the bound agent and the payload carries no
    // metadata at all. "Let call_ended bill as usual" only holds if we can still say whose
    // call it is (ADR 0003 §12).
    const ws = await readyWorkspace('fail-open-number', 30);
    const id = callId();
    const start = Date.now() - 60_000;
    await post(
      '/webhooks/retell',
      lifecycleEvent('call_ended', {
        call_id: id,
        start_timestamp: start,
        end_timestamp: start + 60_000,
        disconnection_reason: 'user_hangup',
        call_status: 'ended',
        from_number: '+19375550100',
        to_number: ws.e164,
      }),
    );

    const row = await waitForBilled(id);
    expect(row).toMatchObject({ tenantId: ws.tenantId, numberId: ws.numberId, agentId: ws.agentId });
    expect(row.creditsCharged!.toNumber()).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(29);
  });

  it('bills a metadata-less call identified by the Retell agent that took it', async () => {
    const ws = await readyWorkspace('fail-open-agent', 30);
    const id = callId();
    const start = Date.now() - 30_000;
    await post(
      '/webhooks/retell',
      lifecycleEvent('call_ended', {
        call_id: id,
        agent_id: ws.retellAgentId,
        start_timestamp: start,
        end_timestamp: start + 30_000,
        disconnection_reason: 'user_hangup',
        call_status: 'ended',
      }),
    );

    const row = await waitForBilled(id);
    expect(row).toMatchObject({ tenantId: ws.tenantId, agentId: ws.agentId });
    expect(row.creditsCharged!.toNumber()).toBe(0.5);
  });

  it('sizes a web test call’s reservation to what it can spend, not Retell’s two-hour ceiling', async () => {
    const ws = await readyWorkspace('web-reservation', 30);
    const id = callId();
    await post(
      '/webhooks/retell',
      lifecycleEvent('call_started', {
        call_id: id,
        call_type: 'web_call',
        call_status: 'ongoing',
        start_timestamp: Date.now(),
        metadata: { tenant_id: ws.tenantId, agent_id: ws.agentId },
      }),
    );

    const hash = await waitFor('the reservation', async () => {
      const entries = await cache.client.hgetall(redisKeys.activeCalls(ws.tenantId));
      return entries[id] ? entries : null;
    });
    // The agent's own 10-minute maximum at 1 credit/min. Retell's ceiling would be 120 —
    // more than the wallet holds, which would decline every inbound call on `balance`.
    expect(Number(hash[id]!.split('|')[0])).toBe(10);

    const next = await inbound(ws, inboundEvent({ callId: callId(), to: ws.e164 }));
    expect(next.json().call_inbound?.reject).toBeUndefined();
  });

  it('ignores a lifecycle event whose workspace cannot be established', async () => {
    const id = callId();
    const res = await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: id, start_timestamp: Date.now() - 1_000, end_timestamp: Date.now(), disconnection_reason: 'user_hangup' }));
    expect(res.statusCode).toBe(200);
    const stored = await waitFor('the stored event', async () => {
      const row = await adminDb.webhookEvent.findFirst({ where: { provider: 'retell', externalId: id } });
      return row?.processedAt ? row : null;
    });
    expect(stored.error).toBeNull();
    expect(await callRow(id)).toBeNull();
  });

  it('will not bill against a declined (missed) row even if a call_ended names it', async () => {
    const ws = await readyWorkspace('declined-then-ended', 5);
    await wallet.debit(ws.tenantId, { credits: 20, reason: 'adjustment' });
    await runtimeCache.refresh(ws.tenantId);
    const id = callId();
    await inbound(ws, inboundEvent({ callId: id, to: ws.e164 }));
    await waitFor('the declined row', async () => {
      const row = await callRow(id);
      return row?.status === 'declined' ? row : null;
    });
    const before = await ledgerSum(ws.tenantId);

    await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: id, start_timestamp: Date.now() - 60_000, end_timestamp: Date.now(), disconnection_reason: 'user_hangup', call_status: 'ended', metadata: { tenant_id: ws.tenantId } }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await callRow(id))!.status).toBe('declined');
    expect(await ledgerSum(ws.tenantId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('SSE (§16) carries the call and the money it moved', () => {
  it('publishes call:{id} for each lifecycle step and a wallet frame for the debit', async () => {
    const ws = await readyWorkspace('sse', 40);
    const id = callId();
    const events = app.get(EventsService);
    const frames: Array<{ topic: string; type: string; data: Record<string, unknown> }> = [];
    // What an SSE client attached to GET /events receives — the controller writes exactly
    // these frames to the socket.
    const unsubscribe = events.subscribe(ws.tenantId, (event) =>
      frames.push({ topic: event.topic, type: event.type, data: (event.data ?? {}) as Record<string, unknown> }),
    );

    try {
      const start = Date.now() - 60_000;
      await inbound(ws, inboundEvent({ callId: id, to: ws.e164 }));
      await waitFor('the registered frame', async () => frames.some((f) => f.type === 'registered'));

      await post('/webhooks/retell', lifecycleEvent('call_started', { call_id: id, start_timestamp: start, metadata: { tenant_id: ws.tenantId } }));
      await waitFor('the in_progress frame', async () => frames.some((f) => f.type === 'in_progress'));

      await post('/webhooks/retell', lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: start + 60_000, disconnection_reason: 'user_hangup', call_status: 'ended', metadata: { tenant_id: ws.tenantId } }));
      await waitFor('the ended frame', async () => frames.some((f) => f.type === 'ended'));
      await waitFor('the wallet frame', async () => frames.some((f) => f.topic === 'wallet'));

      const onThisCall = frames.filter((f) => f.topic === `call:${id}`);
      expect(onThisCall.map((f) => f.type)).toEqual(['registered', 'in_progress', 'ended']);
      expect(onThisCall.at(-1)!.data).toMatchObject({ call_id: id, credits_charged: 1, duration_s: 60, disconnection_reason: 'user_hangup' });

      const wallet = frames.filter((f) => f.topic === 'wallet').at(-1)!;
      expect(wallet).toMatchObject({ type: 'ledger', data: { delta: -1, balance_after: 39, reason: 'call', ref_id: id } });
    } finally {
      unsubscribe();
    }
  });

  it('publishes a missed frame for a declined call, so the dashboard shows it immediately', async () => {
    const ws = await readyWorkspace('sse-missed', 5);
    await wallet.debit(ws.tenantId, { credits: 20, reason: 'adjustment' });
    await runtimeCache.refresh(ws.tenantId);
    const id = callId();
    const events = app.get(EventsService);
    const frames: Array<{ topic: string; type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = events.subscribe(ws.tenantId, (event) =>
      frames.push({ topic: event.topic, type: event.type, data: (event.data ?? {}) as Record<string, unknown> }),
    );

    try {
      await inbound(ws, inboundEvent({ callId: id, to: ws.e164 }));
      await waitFor('the missed frame', async () => frames.some((f) => f.type === 'missed'));
      expect(frames.find((f) => f.type === 'missed')!.data).toMatchObject({ call_id: id, decline_reason: 'balance' });
      // A decline moves no money, so nothing lands on the wallet topic.
      expect(frames.filter((f) => f.topic === 'wallet')).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------------
describe('the webhook sweeper (§13.11)', () => {
  it('re-enqueues an event that was stored but never queued', async () => {
    const ws = await readyWorkspace('sweeper', 30);
    const id = callId();
    const start = Date.now() - 60_000;
    // Stored directly, as if the enqueue had failed after the commit.
    const stored = await adminDb.webhookEvent.create({
      data: {
        provider: 'retell',
        externalId: id,
        eventType: 'call_ended',
        payloadJson: lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: start + 60_000, disconnection_reason: 'user_hangup', call_status: 'ended', metadata: { tenant_id: ws.tenantId } }) as Prisma.InputJsonValue,
        receivedAt: new Date(Date.now() - 120_000),
      },
    });

    const { found, queued } = await app.get(WebhookProcessingService).sweep();
    expect(found).toBeGreaterThanOrEqual(1);
    expect(queued).toBeGreaterThanOrEqual(1);

    await waitFor('the swept event to be processed', async () => (await adminDb.webhookEvent.findUnique({ where: { id: stored.id } }))?.processedAt);
    expect((await callRow(id))!.creditsCharged!.toNumber()).toBe(1);
  });

  it('replaces a job whose id is still held by one that had failed for good', async () => {
    // What the sweeper would otherwise run into: a `wh-<id>` job that burns its eight
    // attempts keeps its id in the failed set for a week (SA12 "Jobs"). BullMQ answers a
    // re-`add()` for that id with the *existing* job, built locally and so indistinguishable
    // from a fresh one — the sweeper would report a re-enqueue every 60 s, nothing would
    // ever run, and that `call_ended` would never bill. `no-such-job` stands in for the
    // failure: no handler is registered for it, so the worker fails it on its one attempt.
    const queues = app.get(JobQueues);
    const queue = queues.queue(QUEUES.calls);
    const jobId = `spent-${randomUUID().slice(0, 8)}`;

    expect(await queues.add(QUEUES.calls, 'no-such-job', { probe: jobId }, { jobId, attempts: 1 }, 2_000, true)).toBe('queued');
    await waitFor('the job to fail for good', async () => {
      const job = await queue.getJob(jobId);
      return job?.finishedOn && (await job.isFailed()) ? job : null;
    });

    expect(await queues.add(QUEUES.calls, 'no-such-job', { probe: jobId }, { jobId, attempts: 1 }, 2_000, true)).toBe('requeued');
    await waitFor('the replacement to run', async () => {
      const job = await queue.getJob(jobId);
      return job?.finishedOn ? job : null;
    });
    await (await queue.getJob(jobId))?.remove();

    // A job that is merely pending is left alone: dedup is still the point of the id.
    const pending = `pending-${randomUUID().slice(0, 8)}`;
    expect(await queues.add(QUEUES.calls, 'no-such-job', {}, { jobId: pending, attempts: 1, delay: 60_000 }, 2_000, true)).toBe('queued');
    expect(await queues.add(QUEUES.calls, 'no-such-job', {}, { jobId: pending, attempts: 1, delay: 60_000 }, 2_000, true)).toBe('exists');
    await (await queue.getJob(pending))?.remove();
  });
});
