import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CallReconciliationService, ConcurrencyMonitorService, encodeActive } from '../src/modules/calls';
import { JobQueues, QUEUES, SCHEDULES, SchedulerRegistrar, bullConnection, bullPrefix } from '../src/modules/jobs';
import { NumberRentalService } from '../src/modules/numbers';
import { EMAIL_SENDER, type LogEmailSender } from '../src/modules/notifications';
import { REDIS, RedisCache, type RedisLike, redisKeys } from '../src/modules/redis';
import { ScheduledJobsService } from '../src/modules/scheduled';
import { SKIP_ALERT_AFTER } from '../src/modules/scheduled/scheduled.service';
import { RENTAL_REF_TYPE, WalletService } from '../src/modules/wallet';
import { type CapturingAlerts, type FakeRetellGateway, startD5Harness } from './d5-fixtures';
import { type PaidWorkspace, paidWorkspace } from './d6-fixtures';

/*
 * D7 recurring operations (§13.11): scheduler registration across restarts, the tick
 * lock, §5.3 number rental → overdue → release, credit expiry, call reconciliation and
 * the §14.3 concurrency monitor. Real Postgres, real Redis, real BullMQ; Retell is the
 * D5 double, email is the log sender.
 *
 * Every scenario is run twice where it matters, because "what happens if it runs twice"
 * is the question these jobs exist to answer well.
 */

delete process.env.RESEND_API_KEY;

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let retell: FakeRetellGateway;
let alerts: CapturingAlerts;
let wallet: WalletService;
let rental: NumberRentalService;
let scheduled: ScheduledJobsService;
let reconciliation: CallReconciliationService;
let concurrency: ConcurrencyMonitorService;
let redis: RedisLike;
let emails: LogEmailSender;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  stop = harness.stop;
  retell = harness.retell;
  alerts = harness.alerts;
  wallet = app.get(WalletService);
  rental = app.get(NumberRentalService);
  scheduled = app.get(ScheduledJobsService);
  reconciliation = app.get(CallReconciliationService);
  concurrency = app.get(ConcurrencyMonitorService);
  redis = app.get(REDIS);
  emails = app.get(EMAIL_SENDER) as LogEmailSender;
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

const monthAgo = () => new Date(Date.now() - 30 * 86_400_000);
const ledgerSum = async (ws: string) => (await adminDb.creditLedger.aggregate({ where: { tenantId: ws }, _sum: { delta: true } }))._sum.delta?.toNumber() ?? 0;
const rentalRows = (ws: string) => adminDb.creditLedger.findMany({ where: { tenantId: ws, reason: 'rental', refType: RENTAL_REF_TYPE }, orderBy: { createdAt: 'asc' } });

/** A bought, bound, active number whose anniversary has passed — as the D6 bind step leaves it, a month later. */
async function boughtNumber(ws: PaidWorkspace, over: Partial<{ type: 'retell_twilio' | 'custom_sip'; status: 'active' | 'paused' | 'released' | 'releasing'; nextRentalAt: Date | null; rentalOverdueSince: Date | null }> = {}) {
  const e164 = `+1450${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const row = await adminDb.phoneNumber.create({
    data: {
      tenantId: ws.workspaceId,
      e164,
      type: over.type ?? 'retell_twilio',
      status: over.status ?? 'active',
      inboundToken: `tok_${randomUUID().replace(/-/g, '')}`,
      country: 'CA',
      rentalCredits: over.type === 'custom_sip' ? 0 : 15,
      nextRentalAt: over.nextRentalAt === undefined ? monthAgo() : over.nextRentalAt,
      rentalOverdueSince: over.rentalOverdueSince ?? null,
      releasedAt: over.status === 'released' ? new Date() : null,
    },
  });
  if (over.type !== 'custom_sip') retell.phoneNumbers.set(e164, { phone_number: e164, phone_number_type: 'retell-twilio', phone_number_pretty: e164, nickname: 'dev-num', inbound_agents: [], inbound_webhook_url: 'x' });
  return row;
}

// ---------------------------------------------------------------------------

describe('scheduler registration (§13.11, architecture §12)', () => {
  it('registers every schedule exactly once across restarts and removes one the code no longer knows', async () => {
    const registrar = app.get(SchedulerRegistrar);
    const queue = app.get(JobQueues).queue(QUEUES.scheduled);
    // An `every` schedule enqueues its first tick at once, and this harness runs a worker:
    // unpaused, a real digest or low-balance sweep would run in the background and email
    // workspaces the later tests are counting emails for.
    await queue.pause();

    const first = await registrar.register();
    expect(first.registered.sort()).toEqual(SCHEDULES.map((s) => s.name).sort());
    expect(first.present).toBe(SCHEDULES.length);

    // A "restart": the same registration from a fresh Queue on the same prefix.
    const second = await registrar.register();
    expect(second.present).toBe(SCHEDULES.length);
    expect(second.removed).toEqual([]);

    // A schedule from a previous deploy that no longer exists in SCHEDULES is swept.
    await queue.upsertJobScheduler('ghost-schedule', { every: 60_000 }, { name: 'ghost-schedule', data: {} });
    expect((await queue.getJobSchedulers(0, -1, true)).length).toBe(SCHEDULES.length + 1);
    const third = await registrar.register();
    expect(third.removed).toEqual(['ghost-schedule']);
    expect(third.present).toBe(SCHEDULES.length);

    // Seen from a brand-new connection, as the next process would see it.
    const fresh = new Queue(QUEUES.scheduled, { connection: bullConnection(process.env.REDIS_URL, 'producer'), prefix: bullPrefix() });
    try {
      const ids = (await fresh.getJobSchedulers(0, -1, true)).map((s) => s.key ?? s.name).sort();
      expect(ids).toEqual(SCHEDULES.map((s) => s.name).sort());
    } finally {
      await fresh.close();
      // Leave nothing ticking behind this suite.
      for (const spec of SCHEDULES) await queue.removeJobScheduler(spec.name);
      await queue.drain(true);
      await queue.resume();
    }
  });

  it('runs a tick under a per-schedule lock: a second worker meeting a running tick skips, and the lock frees for the next', async () => {
    const spec = SCHEDULES.find((s) => s.name === 'number-rental')!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = scheduled.runLocked(spec, 'worker-a', async () => {
      await gate;
      return { did: 'work' };
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await scheduled.runLocked(spec, 'worker-b', async () => ({ did: 'duplicate work' }))).toEqual({ outcome: 'skipped', reason: 'locked' });
    release();
    expect(await first).toMatchObject({ outcome: 'ran', result: { did: 'work' } });
    expect(await scheduled.runLocked(spec, 'worker-b', async () => 1)).toMatchObject({ outcome: 'ran', result: 1 });
    // A failing tick releases the lock too.
    await expect(scheduled.runLocked(spec, 'worker-c', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await redis.get(redisKeys.scheduleLock(spec.name))).toBeNull();
  });

  it('pages ops once when one schedule skips three ticks in a row, and a tick that runs resets the count', async () => {
    const spec = SCHEDULES.find((s) => s.name === 'credit-expiry')!;
    const key = redisKeys.scheduleLock(spec.name);
    const skipAlerts = () => alerts.alerts.filter((a) => a.kind === 'schedule_skipped' && a.fields.schedule === spec.name).length;
    const before = skipAlerts();
    let ran = 0;
    await redis.set(key, 'a-stuck-worker', 'EX', 60);
    try {
      for (let i = 1; i <= SKIP_ALERT_AFTER + 1; i += 1) {
        expect(await scheduled.runLocked(spec, `worker-${i}`, async () => (ran += 1))).toEqual({ outcome: 'skipped', reason: 'locked' });
        // Silent below the threshold, one alert at it, and no second alert while the streak continues.
        expect(skipAlerts()).toBe(before + (i >= SKIP_ALERT_AFTER ? 1 : 0));
      }
    } finally {
      await redis.del(key);
    }
    expect(ran).toBe(0);
    expect(await scheduled.runLocked(spec, 'worker-z', async () => (ran += 1))).toMatchObject({ outcome: 'ran', result: 1 });
    // The streak is over: the next skip starts counting from one again.
    await redis.set(key, 'a-stuck-worker', 'EX', 60);
    try {
      expect(await scheduled.runLocked(spec, 'worker-y', async () => 0)).toEqual({ outcome: 'skipped', reason: 'locked' });
      expect(skipAlerts()).toBe(before + 1);
    } finally {
      await redis.del(key);
    }
  });
});

// ---------------------------------------------------------------------------

describe('number rental (§5.3, §13.11 number-rental)', () => {
  it('charges a due bought number once, advances the anniversary, and a second run charges nothing', async () => {
    const ws = await paidWorkspace(app, 'rental', 'growth');
    const number = await boughtNumber(ws);
    const due = number.nextRentalAt!;

    const first = await rental.chargeDue();
    expect(first.charged).toBeGreaterThanOrEqual(1);
    const rows = await rentalRows(ws.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta.toNumber()).toBe(-15); // pricing v1 recurring.number_rental_credits
    expect(rows[0]!.refId).toBe(`${number.id}:${due.toISOString()}`);
    expect(await ledgerSum(ws.workspaceId)).toBe(485);

    const after = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: number.id } });
    expect(after.lastRentalAt).toEqual(due);
    expect(after.nextRentalAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after.rentalOverdueSince).toBeNull();

    // Same job again: nothing is due, nothing moves.
    await rental.chargeDue();
    expect(await rentalRows(ws.workspaceId)).toHaveLength(1);
    expect(await ledgerSum(ws.workspaceId)).toBe(485);

    // A replayed period (a restored backup, a manual re-run): the ledger's unique index says no.
    await adminDb.phoneNumber.update({ where: { id: number.id }, data: { nextRentalAt: due } });
    const replay = await rental.chargeOne(number.id);
    expect(replay).toMatchObject({ outcome: 'charged', duplicate: true });
    expect(await rentalRows(ws.workspaceId)).toHaveLength(1);
    expect(await ledgerSum(ws.workspaceId)).toBe(485);
  });

  it('never charges a SIP number, a released number, or one that was released between the sweep and the lock', async () => {
    const ws = await paidWorkspace(app, 'rental-skip', 'growth');
    await boughtNumber(ws, { type: 'custom_sip' });
    await boughtNumber(ws, { status: 'released', nextRentalAt: null });
    const releasing = await boughtNumber(ws, { status: 'releasing' });
    await rental.chargeDue();
    expect(await rentalRows(ws.workspaceId)).toHaveLength(0);
    expect(await ledgerSum(ws.workspaceId)).toBe(500);
    expect(await rental.chargeOne(releasing.id)).toMatchObject({ outcome: 'not_due' });
  });

  it('two workers charging the same number at once produce one debit', async () => {
    const ws = await paidWorkspace(app, 'rental-race', 'growth');
    const number = await boughtNumber(ws);
    const results = await Promise.all([rental.chargeOne(number.id), rental.chargeOne(number.id), rental.chargeOne(number.id)]);
    expect(results.filter((r) => r.outcome === 'charged' && !r.duplicate)).toHaveLength(1);
    expect(await rentalRows(ws.workspaceId)).toHaveLength(1);
    expect(await ledgerSum(ws.workspaceId)).toBe(485);
  });

  it('goes overdue instead of debiting past the grace, warns once, charges when credits arrive, and clears the alert', async () => {
    const ws = await paidWorkspace(app, 'rental-overdue', 'growth');
    await wallet.debit(ws.workspaceId, { credits: 497, reason: 'adjustment' }); // → 3: 3 − 15 = −12, past the 10-credit grace
    const number = await boughtNumber(ws);
    const sentBefore = emails.sent.length;

    const first = await rental.chargeOne(number.id);
    expect(first).toMatchObject({ outcome: 'overdue', balance: 3, daysOverdue: 0, warned: [0] });
    const row = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: number.id } });
    expect(row.rentalOverdueSince).toBeTruthy();
    expect(row.nextRentalAt).toEqual(number.nextRentalAt); // the period stays owed
    expect(await rentalRows(ws.workspaceId)).toHaveLength(0);
    const open = await adminDb.alert.findMany({ where: { tenantId: ws.workspaceId, type: 'rental_overdue', resolvedAt: null } });
    expect(open.map((a) => a.key)).toEqual([`rental_overdue:${number.id}:0`]);
    expect(emails.sent.length - sentBefore).toBe(1);
    expect(emails.sent.at(-1)!.subject).toMatch(/rental is unpaid/);

    // Same day, run again: still overdue, no new alert, no new email.
    expect(await rental.chargeOne(number.id)).toMatchObject({ outcome: 'overdue', warned: [] });
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'rental_overdue' } })).toBe(1);
    expect(emails.sent.length - sentBefore).toBe(1);

    // A week later: the 7-day warning, once.
    await adminDb.phoneNumber.update({ where: { id: number.id }, data: { rentalOverdueSince: new Date(Date.now() - 7.5 * 86_400_000) } });
    expect((await rental.chargeOne(number.id)) as { warned: number[] }).toMatchObject({ warned: [7] });
    expect((await rental.chargeOne(number.id)) as { warned: number[] }).toMatchObject({ warned: [] });
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'rental_overdue' } })).toBe(2);

    // Credits arrive: the owed period is charged, the clock and the alerts clear.
    await wallet.grant(ws.workspaceId, { credits: 100, reason: 'purchase', expiresAt: new Date(Date.now() + 365 * 86_400_000) });
    const charged = await rental.chargeOne(number.id);
    expect(charged).toMatchObject({ outcome: 'charged', credits: 15, duplicate: false });
    expect((await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: number.id } })).rentalOverdueSince).toBeNull();
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'rental_overdue', resolvedAt: null } })).toBe(0);
    expect(await ledgerSum(ws.workspaceId)).toBe(88);
  });
});

describe('number release (§5.3, §13.11 number-release)', () => {
  it('releases a number unpaid past the policy window — platform first — and never marks one released when the platform refused', async () => {
    const ws = await paidWorkspace(app, 'release', 'growth');
    const number = await boughtNumber(ws, { rentalOverdueSince: new Date(Date.now() - 31 * 86_400_000) });
    const young = await boughtNumber(ws, { rentalOverdueSince: new Date(Date.now() - 3 * 86_400_000) });

    // The platform is down for the first attempt.
    retell.failNext('deletePhoneNumber', 1, new Error('retell answered 503'));
    const failed = await rental.releaseOverdue();
    expect(failed).toMatchObject({ candidates: 1, released: 0, failed: 1 });
    const afterFail = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: number.id } });
    expect(afterFail.status).toBe('releasing');
    expect(afterFail.releasedAt).toBeNull();
    expect(retell.phoneNumbers.has(number.e164!)).toBe(true);
    expect(alerts.alerts.some((a) => a.kind === 'number_release_failed')).toBe(true);

    // Next day: succeeds, exactly once, with the trail.
    const ok = await rental.releaseOverdue();
    expect(ok).toMatchObject({ candidates: 1, released: 1, failed: 0 });
    const released = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: number.id } });
    expect(released.status).toBe('released');
    expect(released.releasedAt).toBeTruthy();
    expect(released.nextRentalAt).toBeNull();
    expect(retell.phoneNumbers.has(number.e164!)).toBe(false);
    expect(await adminDb.auditLog.count({ where: { tenantId: ws.workspaceId, action: 'number.released_unpaid', targetId: number.id } })).toBe(1);
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'number_released' } })).toBe(1);
    expect(emails.sent.at(-1)!.subject).toMatch(/has been released/);

    // The young one is untouched, and a released row is not charged rent.
    expect((await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: young.id } })).status).toBe('active');
    await rental.chargeDue();
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'rental', refId: { startsWith: number.id } } })).toBe(0);

    // Run again: nothing left to release.
    expect(await rental.releaseOverdue()).toMatchObject({ candidates: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('credit expiry (§5.4, §13.11 credit-expiry)', () => {
  it('writes off a lapsed lot exactly once however many times the schedule runs', async () => {
    const ws = await paidWorkspace(app, 'expiry', 'starter'); // 150 credits, expiring in a year
    await wallet.grant(ws.workspaceId, { credits: 40, reason: 'purchase', expiresAt: new Date(Date.now() - 1_000) });
    expect(await ledgerSum(ws.workspaceId)).toBe(190);

    const first = await scheduled.creditExpiry();
    expect(first.rows).toBeGreaterThanOrEqual(1);
    expect(await ledgerSum(ws.workspaceId)).toBe(150);
    const expiry = await adminDb.creditLedger.findMany({ where: { tenantId: ws.workspaceId, reason: 'expiry' } });
    expect(expiry).toHaveLength(1);
    expect(expiry[0]!.delta.toNumber()).toBe(-40);
    expect((await adminDb.creditLot.findUniqueOrThrow({ where: { id: expiry[0]!.lotId! } })).creditsRemaining.toNumber()).toBe(0);

    await scheduled.creditExpiry();
    await scheduled.creditExpiry();
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'expiry' } })).toBe(1);
    expect(await ledgerSum(ws.workspaceId)).toBe(150);
    // The still-valid lot is untouched.
    expect(await adminDb.creditLot.count({ where: { tenantId: ws.workspaceId, creditsRemaining: { gt: 0 } } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('call reconciliation (§14.2, §13.11 reconcile-calls)', () => {
  /** A unique window in the past, so parallel runs of this suite never share a `reconciliation_runs` row. */
  function window() {
    const start = new Date(Date.UTC(2020, 0, 1) + Math.floor(Math.random() * 3_000) * 86_400_000);
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
  async function ourCall(ws: string, at: Date, seconds: number, cents: number | null) {
    const id = `call_${randomUUID().replace(/-/g, '')}`;
    await adminDb.call.create({ data: { id, tenantId: ws, channel: 'phone', status: 'ended', startedAt: at, endedAt: new Date(at.getTime() + seconds * 1000), durationS: seconds, retellCostCents: cents, rate: new Prisma.Decimal(1), creditsCharged: new Prisma.Decimal(seconds / 60) } });
    return id;
  }
  function theirCall(id: string, at: Date, seconds: number, cents: number, ws: string) {
    retell.providerCalls.push({ call_id: id, call_type: 'phone_call', call_status: 'ended', start_timestamp: at.getTime(), end_timestamp: at.getTime() + seconds * 1000, duration_s: seconds, disconnection_reason: 'user_hangup', cost_cents: cents, workspace_id: ws });
  }
  const alertsOf = (kind: string) => alerts.alerts.filter((a) => a.kind === kind).length;

  it('records an OK run with no drift, and tolerates small drift under the threshold', async () => {
    const ws = await paidWorkspace(app, 'recon-ok', 'growth');
    const w = window();
    const at = new Date(w.start.getTime() + 3_600_000);
    const ids = await Promise.all([ourCall(ws.workspaceId, at, 60, 10), ourCall(ws.workspaceId, at, 120, 20), ourCall(ws.workspaceId, at, 30, 5)]);
    ids.forEach((id, i) => theirCall(id, at, [60, 120, 30][i]!, [10, 20, 5][i]!, ws.workspaceId));

    const run = await reconciliation.run(new Date(), w, 5);
    expect(run.status).toBe('ok');
    expect(run.metrics).toMatchObject({ provider_calls: 3, internal_calls: 3, matched: 3, missing: [], extra: [], drift_pct: 0 });
    expect(run.alerted).toBe(false);
    const row = await adminDb.reconciliationRun.findUniqueOrThrow({ where: { windowStart_windowEnd: { windowStart: w.start, windowEnd: w.end } } });
    expect(row.status).toBe('ok');
    expect(row.alertedAt).toBeNull();

    // A few seconds of drift on one call stays under 5%.
    retell.providerCalls.find((c) => c.call_id === ids[1])!.duration_s = 126;
    retell.providerCalls.find((c) => c.call_id === ids[1])!.end_timestamp = at.getTime() + 126_000;
    const small = await reconciliation.run(new Date(), w, 5);
    expect(small.status).toBe('ok');
    expect(small.metrics!.seconds_drift_pct).toBeCloseTo(2.778, 2); // |216 − 210| / 216
    expect(await adminDb.reconciliationRun.count({ where: { windowStart: w.start } })).toBe(1); // upserted, not duplicated
  });

  it('alerts once on excessive drift, persists the ids to investigate, and a rerun of the same window does not alert again', async () => {
    const ws = await paidWorkspace(app, 'recon-drift', 'growth');
    const w = window();
    const at = new Date(w.start.getTime() + 7_200_000);
    const shared = await ourCall(ws.workspaceId, at, 60, 10);
    theirCall(shared, at, 60, 10, ws.workspaceId);
    theirCall(`call_${randomUUID().replace(/-/g, '')}`, at, 90, 15, ws.workspaceId); // never reached us: unbilled
    const extra = await ourCall(ws.workspaceId, at, 45, null); // ours, unknown to them
    const before = alertsOf('reconcile_drift');

    const run = await reconciliation.run(new Date(), w, 5);
    expect(run.status).toBe('drift');
    expect(run.metrics!.missing).toHaveLength(1);
    expect(run.metrics!.extra).toEqual([extra]);
    expect(run.metrics!.drift_pct).toBe(100);
    expect(run.alerted).toBe(true);
    expect(alertsOf('reconcile_drift')).toBe(before + 1);
    const row = await adminDb.reconciliationRun.findUniqueOrThrow({ where: { id: run.runId } });
    expect(row.alertedAt).toBeTruthy();
    expect(row.missingIds).toEqual(run.metrics!.missing);
    expect((row.detailsJson as { by_workspace: Record<string, unknown> }).by_workspace[ws.workspaceId]).toMatchObject({ provider: 2, internal: 2, missing: 1, extra: 1 });

    // Rerun (or a second worker): same row, no second page.
    const again = await reconciliation.run(new Date(), w, 5);
    expect(again.runId).toBe(run.runId);
    expect(again.alerted).toBe(false);
    expect(alertsOf('reconcile_drift')).toBe(before + 1);

    // Two concurrent runs of a fresh drifting window: exactly one alert.
    const w2 = window();
    theirCall(`call_${randomUUID().replace(/-/g, '')}`, new Date(w2.start.getTime() + 1_000), 10, 1, ws.workspaceId);
    const both = await Promise.all([reconciliation.run(new Date(), w2, 5), reconciliation.run(new Date(), w2, 5)]);
    expect(both.filter((r) => r.alerted)).toHaveLength(1);
    expect(await adminDb.reconciliationRun.count({ where: { windowStart: w2.start } })).toBe(1);
  });

  it('records a provider failure as such — never as "every call is extra" — and alerts on it once', async () => {
    const ws = await paidWorkspace(app, 'recon-down', 'growth');
    const w = window();
    await ourCall(ws.workspaceId, new Date(w.start.getTime() + 1_000), 60, 10);
    retell.failNext('listCallsInWindow', 1, new Error('retell answered 502'));
    const before = alertsOf('reconcile_provider_error');
    const run = await reconciliation.run(new Date(), w, 5);
    expect(run.status).toBe('provider_error');
    expect(run.metrics).toBeNull();
    expect(run.alerted).toBe(true);
    expect(alertsOf('reconcile_drift')).toBe(alerts.alerts.filter((a) => a.kind === 'reconcile_drift').length);
    const row = await adminDb.reconciliationRun.findUniqueOrThrow({ where: { id: run.runId } });
    expect(row.error).toMatch(/502/);
    expect(row.internalCalls).toBe(1);
    // The provider is back: the same window is reconciled properly, and this time it is genuine drift (they have nothing).
    const recovered = await reconciliation.run(new Date(), w, 5);
    expect(recovered.runId).toBe(run.runId);
    expect(recovered.status).toBe('drift');
    expect(recovered.alerted).toBe(false); // the window already alerted once
    expect(alertsOf('reconcile_provider_error')).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------

describe('concurrency monitor (§14.3, §13.11 concurrency-monitor)', () => {
  const live = (ws: string, n: number) =>
    Promise.all(Array.from({ length: n }, (_, i) => redis.hset(redisKeys.activeCalls(ws), `call_live_${i}`, encodeActive(5, Date.now() + 600_000))));
  const openAlerts = (ws: string) => adminDb.alert.findMany({ where: { tenantId: ws, type: 'concurrency', resolvedAt: null } });

  it('alerts at the configured share of the plan cap, once, resolves on recovery, and alerts again on the next crossing', async () => {
    const ws = await paidWorkspace(app, 'concurrency', 'growth'); // cap 3 → threshold ceil(3 × 0.8) = 3
    const key = redisKeys.activeCalls(ws.workspaceId);
    // Other suites leave live reservations in Redis for their own workspaces; count ours only.
    const opsFor = () => alerts.alerts.filter((a) => a.kind === 'workspace_concurrency' && a.fields.workspace_id === ws.workspaceId).length;
    const opsBefore = opsFor();

    await live(ws.workspaceId, 2);
    let tick = await concurrency.tick(Date.now(), 80);
    expect(tick.opened).not.toContain(ws.workspaceId);
    expect(await openAlerts(ws.workspaceId)).toHaveLength(0);

    // Exactly at the threshold: alert.
    await live(ws.workspaceId, 3);
    tick = await concurrency.tick(Date.now(), 80);
    expect(tick.opened).toContain(ws.workspaceId);
    expect(await openAlerts(ws.workspaceId)).toHaveLength(1);
    expect((await openAlerts(ws.workspaceId))[0]!.metaJson).toMatchObject({ live: 3, cap: 3, threshold: 3 });
    expect(opsFor()).toBe(opsBefore + 1);

    // Above it, repeatedly: no spam.
    await redis.hset(key, 'call_live_extra', encodeActive(5, Date.now() + 600_000));
    await concurrency.tick(Date.now(), 80);
    await concurrency.tick(Date.now(), 80);
    expect(await openAlerts(ws.workspaceId)).toHaveLength(1);
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'concurrency' } })).toBe(1);
    expect(opsFor()).toBe(opsBefore + 1);

    // Recovery: two calls end.
    await redis.hdel(key, 'call_live_extra', 'call_live_2');
    tick = await concurrency.tick(Date.now(), 80);
    expect(tick.resolved).toContain(ws.workspaceId);
    expect(await openAlerts(ws.workspaceId)).toHaveLength(0);

    // Crossing again is a new alert.
    await live(ws.workspaceId, 3);
    tick = await concurrency.tick(Date.now(), 80);
    expect(tick.opened).toContain(ws.workspaceId);
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'concurrency' } })).toBe(2);

    // Every call ended and the hash expired away: the second pass still resolves it.
    await redis.del(key);
    tick = await concurrency.tick(Date.now(), 80);
    expect(tick.resolved).toContain(ws.workspaceId);
    expect(await openAlerts(ws.workspaceId)).toHaveLength(0);
  });

  it('resolves nothing when the scan did not answer or did not finish: an absent hash proves nothing then', async () => {
    const ws = await paidWorkspace(app, 'concurrency-scan', 'growth');
    const key = redisKeys.activeCalls(ws.workspaceId);
    const cache = app.get(RedisCache);
    await live(ws.workspaceId, 3);
    expect((await concurrency.tick(Date.now(), 80)).opened).toContain(ws.workspaceId);
    expect(await openAlerts(ws.workspaceId)).toHaveLength(1);

    // The calls end and the hash goes away — but Redis does not answer the SCAN.
    await redis.del(key);
    const scan = vi.spyOn(cache, 'scanKeys');
    try {
      scan.mockResolvedValueOnce(null);
      let tick = await concurrency.tick(Date.now(), 80);
      expect(tick.resolved).toEqual([]);
      expect(await openAlerts(ws.workspaceId)).toHaveLength(1);

      // A walk that stopped at its cap: what it saw is judged, absence is not.
      scan.mockResolvedValueOnce({ keys: [], complete: false });
      tick = await concurrency.tick(Date.now(), 80);
      expect(tick.resolved).toEqual([]);
      expect(await openAlerts(ws.workspaceId)).toHaveLength(1);
    } finally {
      scan.mockRestore();
    }

    // The next complete scan resolves it.
    const tick = await concurrency.tick(Date.now(), 80);
    expect(tick.resolved).toContain(ws.workspaceId);
    expect(await openAlerts(ws.workspaceId)).toHaveLength(0);
  });

  it('ignores expired reservations and does not alert a workspace under the threshold', async () => {
    const ws = await paidWorkspace(app, 'concurrency-stale', 'growth');
    const key = redisKeys.activeCalls(ws.workspaceId);
    for (let i = 0; i < 5; i += 1) await redis.hset(key, `stale_${i}`, encodeActive(5, Date.now() - 1_000));
    await redis.hset(key, 'fresh', encodeActive(5, Date.now() + 60_000));
    const tick = await concurrency.tick(Date.now(), 80);
    expect(tick.opened).not.toContain(ws.workspaceId);
    expect(await openAlerts(ws.workspaceId)).toHaveLength(0);
    await redis.del(key);
  });
});
