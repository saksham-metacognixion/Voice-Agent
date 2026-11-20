import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import { PURGED, redactWebhookPayload } from '../../common/webhook-payload';
import { OpsAlertService } from '../alerts';
import { RetellGateway, isRetellNotFound } from '../retell';

/** A purge the platform keeps refusing pages ops once it has failed this many times. */
export const PURGE_ALERT_AFTER_ATTEMPTS = 3;

export type PurgeOutcome =
  | { outcome: 'purged'; callId: string; workspaceId: string; providerDeleted: boolean; events: number }
  | { outcome: 'provider_failed'; callId: string; workspaceId: string; attempts: number; error: string };

export interface PurgeTick {
  candidates: number;
  purged: number;
  failed: number;
}

interface Candidate {
  id: string;
  tenant_id: string;
  status: string;
  purge_attempts: number;
}

/**
 * §17 data retention, the `data-retention` schedule (ADR 0035, audit 29 Oct §6.1 #2).
 *
 * Every hour: each workspace's calls older than its own `tenants.retention_days`
 * (30/90/365 on D6, 7–365 on the wire) lose their transcript (`transcript_text`,
 * `transcript_json`), their recording link, and the copies of both inside every stored
 * `webhook_events` body for the call — the same fields SA12 blanks for a role without
 * `can_listen_recordings`, written over with `PURGED` so a replay of the row carries
 * nothing to restore. The call's billing facts, duration, outcome and analysis stay: they
 * are the customer's ledger history, and the spec's retention names transcripts and
 * recordings.
 *
 * Age is `ended_at`, else `created_at` (a row that never ended still ages). The window is
 * the workspace's at the moment of the tick, so a shortened retention catches up on the
 * next hour and a lengthened one simply stops purging until the new age.
 *
 * Provider first, row after. `delete-call` removes the platform's copy (recording,
 * transcript, logs); a 404 is "already gone" and counts as deleted. Any other answer
 * leaves `purged_at` null, bumps `purge_attempts`, keeps the error on the row and pages
 * ops at `PURGE_ALERT_AFTER_ATTEMPTS` — never a call quietly marked purged while the
 * platform still holds it. A declined (missed) call never existed on the platform, so
 * nothing is asked of it. Safe to re-run: a purged row is out of the scan, a crash
 * between the provider's answer and the row write meets a 404 next hour, and the row
 * write is one transaction.
 *
 * Nothing restores purged data: the lifecycle handlers skip transcript and recording facts
 * for a row with `purged_at` (CallsService), `call-recovery` only asks about rows younger
 * than a day, and the recording route answers 404 for a row without a link.
 */
@Injectable()
export class CallRetentionService {
  private readonly log = new Logger(CallRetentionService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly ops: OpsAlertService,
  ) {}

  /** One tick: the oldest `limit` expired rows across every workspace. */
  async purgeExpired(now = new Date(), limit = 500): Promise<PurgeTick> {
    const candidates = await this.candidates(now, limit);
    const tick: PurgeTick = { candidates: candidates.length, purged: 0, failed: 0 };
    for (const row of candidates) {
      const outcome = await this.purgeOne(row, now);
      if (outcome.outcome === 'purged') tick.purged += 1;
      else tick.failed += 1;
    }
    if (tick.candidates) this.log.log(`data-retention: ${tick.candidates} expired, ${tick.purged} purged, ${tick.failed} waiting on the platform`);
    return tick;
  }

  /** Rows past their workspace's retention and not yet purged, oldest first. Ids and status only — never the content. */
  async candidates(now: Date, limit: number): Promise<Candidate[]> {
    return adminDb.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT c.id, c.tenant_id, c.status::text AS status, c.purge_attempts
      FROM calls c
      JOIN tenants t ON t.id = c.tenant_id
      WHERE c.purged_at IS NULL
        AND COALESCE(c.ended_at, c.created_at) < ${now} - make_interval(days => t.retention_days)
      ORDER BY COALESCE(c.ended_at, c.created_at) ASC
      LIMIT ${limit}
    `);
  }

  async purgeOne(row: Candidate, now = new Date()): Promise<PurgeOutcome> {
    // 1. The platform's copy. A declined call has no platform object; our synthetic ids never do.
    let providerDeleted = false;
    if (row.status !== 'declined' && !row.id.startsWith('dec_')) {
      try {
        await this.retell.deleteCall(row.id);
        providerDeleted = true;
      } catch (error) {
        if (!isRetellNotFound(error)) return this.providerFailed(row, error, now);
        this.log.log(`data-retention ${row.id}: the platform no longer has it`);
      }
    }

    // 2. Ours, in one transaction: the row's content, and every stored body for the call.
    const events = await adminDb.$transaction(async (tx) => {
      const stored = await tx.webhookEvent.findMany({ where: { provider: 'retell', externalId: row.id }, select: { id: true, payloadJson: true } });
      for (const event of stored) {
        const { payload, redacted } = redactWebhookPayload(event.payloadJson, PURGED);
        if (redacted.length) await tx.webhookEvent.update({ where: { id: event.id }, data: { payloadJson: payload as Prisma.InputJsonValue } });
      }
      await tx.call.update({
        where: { id: row.id },
        data: { transcriptText: null, transcriptJson: Prisma.DbNull, recordingUrl: null, purgedAt: now, purgeError: null },
      });
      return stored.length;
    });
    this.log.log(`data-retention ${row.id} (${row.tenant_id}): purged (platform ${providerDeleted ? 'deleted' : 'had nothing'}, ${events} stored bodies cleared)`);
    return { outcome: 'purged', callId: row.id, workspaceId: row.tenant_id, providerDeleted, events };
  }

  private async providerFailed(row: Candidate, error: unknown, now: Date): Promise<PurgeOutcome> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    const attempts = row.purge_attempts + 1;
    await adminDb.call.update({ where: { id: row.id }, data: { purgeAttempts: attempts, purgeError: message } });
    this.log.warn(`data-retention ${row.id} (${row.tenant_id}): delete-call failed (attempt ${attempts}): ${message}`);
    if (attempts === PURGE_ALERT_AFTER_ATTEMPTS) {
      await this.ops.send({
        kind: 'retention_purge_failed',
        severity: 'warning',
        title: 'A call past its retention could not be deleted on the voice platform',
        fields: { workspace_id: row.tenant_id, call_id: row.id, attempts, error: message, at: now.toISOString() },
      });
    }
    return { outcome: 'provider_failed', callId: row.id, workspaceId: row.tenant_id, attempts, error: message };
  }
}
