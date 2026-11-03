import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PURGED } from '../src/common/webhook-payload';
import { CallRetentionService, CallsQueryService, PURGE_ALERT_AFTER_ATTEMPTS } from '../src/modules/calls';
import { SCHEDULED_JOBS, SCHEDULES } from '../src/modules/jobs';
import { ScheduledJobsService } from '../src/modules/scheduled';
import { WebhookProcessingService } from '../src/modules/webhooks';
import { type CapturingAlerts, type FakeRetellGateway, createWorkspace, startD5Harness } from './d5-fixtures';

/*
 * §17 data retention (ADR 0035, audit 29 Oct §6.1 #2): the hourly `data-retention` job
 * purges transcripts, recording links and the stored webhook bodies of calls older than
 * their workspace's `retention_days`, and asks the platform to delete its copy. Real
 * Postgres, real Redis; the platform is the D5 double.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let retell: FakeRetellGateway;
let alerts: CapturingAlerts;
let retention: CallRetentionService;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  stop = harness.stop;
  retell = harness.retell;
  alerts = harness.alerts;
  retention = app.get(CallRetentionService);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

const DAY = 86_400_000;
const daysAgo = (days: number, now = new Date()) => new Date(now.getTime() - days * DAY);
const TRANSCRIPT = 'Agent: Hello, Maple Dental. User: I would like to book a cleaning.';
const RECORDING = 'https://recordings.test/kept.mp3';

async function workspace(label: string, retentionDays: number) {
  const ws = await createWorkspace(label);
  await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { retentionDays } });
  return ws;
}

/** An ended, analysed call as the lifecycle handlers leave it, plus its stored `call_ended` and `call_analyzed` bodies. */
async function endedCall(workspaceId: string, endedAt: Date, over: { status?: 'ended' | 'analyzed' | 'declined'; id?: string } = {}) {
  const id = over.id ?? `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  await adminDb.call.create({
    data: {
      id,
      tenantId: workspaceId,
      channel: 'phone',
      status: over.status ?? 'analyzed',
      startedAt: new Date(endedAt.getTime() - 60_000),
      endedAt,
      durationS: 60,
      creditsCharged: 1,
      transcriptText: TRANSCRIPT,
      transcriptJson: [{ role: 'agent', content: 'Hello, Maple Dental.' }],
      recordingUrl: RECORDING,
      analysisJson: { call_summary: 'Booked a cleaning.', custom_analysis_data: { caller_name: 'Jane' } },
      outcome: 'booked',
      createdAt: endedAt,
      ...(over.status === 'declined' ? { declineReason: 'hours' } : {}),
    },
  });
  if (over.status !== 'declined') {
    for (const event of ['call_ended', 'call_analyzed'] as const) {
      await adminDb.webhookEvent.create({
        data: {
          provider: 'retell',
          externalId: id,
          eventType: event,
          tenantId: workspaceId,
          processedAt: endedAt,
          payloadJson: {
            event,
            call: { call_id: id, call_type: 'phone_call', transcript: TRANSCRIPT, transcript_object: [{ role: 'agent', content: 'Hello' }], recording_url: RECORDING, public_log_url: 'https://logs.test/x', metadata: { tenant_id: workspaceId }, call_analysis: event === 'call_analyzed' ? { call_summary: 'Booked a cleaning.' } : undefined },
          },
        },
      });
    }
  }
  return id;
}

const deleteCalls = (id: string) => retell.calls.filter((c) => c.method === 'deleteCall' && c.args[0] === id).length;
const row = (id: string) => adminDb.call.findUniqueOrThrow({ where: { id } });
const bodies = (id: string) => adminDb.webhookEvent.findMany({ where: { provider: 'retell', externalId: id }, select: { payloadJson: true } });

describe('the data-retention schedule (§17, §13.11)', () => {
  it('is registered as a live hourly schedule and dispatched by the scheduled module', async () => {
    const spec = SCHEDULES.find((s) => s.name === SCHEDULED_JOBS.dataRetention)!;
    expect(spec).toMatchObject({ status: 'live', pattern: '40 * * * *' });
    expect(await app.get(ScheduledJobsService).dataRetention()).toMatchObject({ candidates: expect.any(Number), purged: expect.any(Number), failed: expect.any(Number) });
  });

  it('purges a call past its workspace retention: transcript, recording link and the stored bodies go, billing facts and analysis stay, the platform is asked once', async () => {
    const ws = await workspace('ret-ok', 90);
    const old = await endedCall(ws.workspaceId, daysAgo(91));
    const tick = await retention.purgeExpired();
    expect(tick.purged).toBeGreaterThanOrEqual(1);

    const after = await row(old);
    expect(after.purgedAt).toBeTruthy();
    expect(after.transcriptText).toBeNull();
    expect(after.transcriptJson).toBeNull();
    expect(after.recordingUrl).toBeNull();
    expect(after.purgeAttempts).toBe(0);
    expect(after.purgeError).toBeNull();
    // What the customer keeps: the ledger history and what was captured.
    expect(after.creditsCharged!.toNumber()).toBe(1);
    expect(after.durationS).toBe(60);
    expect(after.outcome).toBe('booked');
    expect(after.analysisJson).toMatchObject({ custom_analysis_data: { caller_name: 'Jane' } });
    // The stored webhook bodies no longer carry the conversation, so a replay has nothing to restore.
    for (const { payloadJson } of await bodies(old)) {
      const text = JSON.stringify(payloadJson);
      expect(text).not.toContain('Maple Dental');
      expect(text).not.toContain('recordings.test');
      expect(text).not.toContain('logs.test');
      expect(text).toContain(PURGED);
      expect((payloadJson as { call: { call_id: string } }).call.call_id).toBe(old);
    }
    expect(deleteCalls(old)).toBe(1);
    expect(retell.deletedCalls.has(old)).toBe(true);

    // The recording route is closed for good.
    const query = app.get(CallsQueryService);
    await expect(query.recordingLink({ userId: ws.userId, workspaceId: ws.workspaceId, role: 'owner' }, old, 'https://api.test')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Run again: nothing left to do, and the platform is not asked a second time.
    await retention.purgeExpired();
    expect(deleteCalls(old)).toBe(1);
    expect((await row(old)).purgedAt).toEqual(after.purgedAt);
  });

  it('never touches a call still inside its retention, and honours each workspace’s own window', async () => {
    const short = await workspace('ret-30', 30);
    const long = await workspace('ret-365', 365);
    const now = new Date();
    const keep30 = await endedCall(short.workspaceId, daysAgo(29.5, now));
    const purge30 = await endedCall(short.workspaceId, daysAgo(30.5, now));
    const keep365 = await endedCall(long.workspaceId, daysAgo(200, now));
    const purge365 = await endedCall(long.workspaceId, daysAgo(366, now));
    await retention.purgeExpired(now);
    expect((await row(keep30)).purgedAt).toBeNull();
    expect((await row(keep30)).transcriptText).toBe(TRANSCRIPT);
    expect((await row(purge30)).purgedAt).toBeTruthy();
    expect((await row(keep365)).purgedAt).toBeNull();
    expect((await row(purge365)).purgedAt).toBeTruthy();
    expect(deleteCalls(keep30) + deleteCalls(keep365)).toBe(0);
    // A row that never ended ages from its creation.
    const stuck = await endedCall(short.workspaceId, daysAgo(40, now), { status: 'ended' });
    await adminDb.call.update({ where: { id: stuck }, data: { endedAt: null } });
    await retention.purgeExpired(now);
    expect((await row(stuck)).purgedAt).toBeTruthy();
  });

  it('a platform refusal leaves the call unpurged with the attempt and the error on the row, retries next tick, and pages ops at the third failure', async () => {
    const ws = await workspace('ret-fail', 30);
    const id = await endedCall(ws.workspaceId, daysAgo(40));
    retell.failNext('deleteCall', PURGE_ALERT_AFTER_ATTEMPTS, new Error('retell is having a moment'));
    const pageCount = () => alerts.alerts.filter((a) => a.kind === 'retention_purge_failed' && a.fields.call_id === id).length;

    for (let attempt = 1; attempt <= PURGE_ALERT_AFTER_ATTEMPTS; attempt += 1) {
      const tick = await retention.purgeExpired();
      expect(tick.failed).toBeGreaterThanOrEqual(1);
      const after = await row(id);
      expect(after.purgedAt).toBeNull();
      expect(after.transcriptText).toBe(TRANSCRIPT);
      expect(after.recordingUrl).toBe(RECORDING);
      expect(after.purgeAttempts).toBe(attempt);
      expect(after.purgeError).toContain('retell is having a moment');
      expect(pageCount()).toBe(attempt >= PURGE_ALERT_AFTER_ATTEMPTS ? 1 : 0);
      // The stored bodies are untouched while the platform still holds the call.
      expect(JSON.stringify((await bodies(id))[0]!.payloadJson)).toContain('Maple Dental');
    }
    // The platform recovers: the next tick finishes the job, and no second page.
    await retention.purgeExpired();
    const done = await row(id);
    expect(done.purgedAt).toBeTruthy();
    expect(done.purgeError).toBeNull();
    expect(done.purgeAttempts).toBe(PURGE_ALERT_AFTER_ATTEMPTS);
    expect(pageCount()).toBe(1);
    expect(deleteCalls(id)).toBe(PURGE_ALERT_AFTER_ATTEMPTS + 1);
  });

  it('a call the platform no longer has (404) counts as deleted; a declined call is purged without asking the platform', async () => {
    const ws = await workspace('ret-404', 30);
    const gone = await endedCall(ws.workspaceId, daysAgo(31));
    retell.deletedCalls.add(gone); // a second delete answers 404
    const missed = await endedCall(ws.workspaceId, daysAgo(31), { status: 'declined', id: `dec_${randomUUID()}` });
    await retention.purgeExpired();
    expect((await row(gone)).purgedAt).toBeTruthy();
    expect((await row(gone)).purgeError).toBeNull();
    expect((await row(missed)).purgedAt).toBeTruthy();
    expect(deleteCalls(missed)).toBe(0);
  });

  it('a replay of the stored event after the purge restores nothing', async () => {
    const ws = await workspace('ret-replay', 30);
    const id = await endedCall(ws.workspaceId, daysAgo(31));
    await retention.purgeExpired();
    const stored = await adminDb.webhookEvent.findFirstOrThrow({ where: { provider: 'retell', externalId: id, eventType: 'call_analyzed' } });
    await app.get(WebhookProcessingService).replay(stored.id);
    const after = await row(id);
    expect(after.purgedAt).toBeTruthy();
    expect(after.transcriptText).toBeNull();
    expect(after.transcriptJson).toBeNull();
    expect(after.recordingUrl).toBeNull();
    // Even a fresh delivery carrying the original words is not kept once the row is purged
    // (the dedupe key is the event type, so the purged `call_ended` row makes way for it).
    await adminDb.webhookEvent.deleteMany({ where: { provider: 'retell', externalId: id, eventType: 'call_ended' } });
    const fresh = await adminDb.webhookEvent.create({
      data: { provider: 'retell', externalId: id, eventType: 'call_ended', payloadJson: { event: 'call_ended', call: { call_id: id, call_type: 'phone_call', transcript: TRANSCRIPT, recording_url: RECORDING, start_timestamp: Date.now() - 60_000, end_timestamp: Date.now(), disconnection_reason: 'user_hangup', metadata: { tenant_id: ws.workspaceId } } } },
    });
    await app.get(WebhookProcessingService).replay(fresh.id);
    const again = await row(id);
    expect(again.transcriptText).toBeNull();
    expect(again.recordingUrl).toBeNull();
  });
});
