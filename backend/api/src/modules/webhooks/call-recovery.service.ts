import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import { RECOVER_ANALYSIS_MAX_CHECKS, RECOVER_ANALYSIS_WINDOW_MS, RECOVER_RECHECK_MS, RECOVER_WINDOW_MS, unsettledCallKind } from '../calls';
import { JobQueues } from '../jobs';
import { RetellGateway, type RetellCallFacts, type RetellLifecycleEventType } from '../retell';
import { WebhookEventsService } from './webhook-events.service';

/** A row younger than this is not asked about: its call is live or its webhook is in flight. */
export const RECOVER_UNFINISHED_AFTER_MS = 3 * 60_000;
/** A call the platform ended less than this long ago may still have its `call_ended` on the wire. */
export const RECOVER_ENDED_AFTER_MS = 2 * 60_000;
/**
 * The same grace for `recoverOne()`. Someone is watching that call, and the platform
 * delivers `call_ended` in the same second as `call_analyzed` — seconds after hang-up —
 * so a call ended this long ago with nothing stored has lost its webhook. A real delivery
 * racing the recovery is harmless: same dedupe key, so one of them is a duplicate.
 */
export const RECOVER_ONE_ENDED_AFTER_MS = 15_000;
/** An `ended` row whose analysis is this late is asked about by the schedule. */
export const RECOVER_ANALYSIS_AFTER_MS = 10 * 60_000;
/**
 * `recoverOne()` asks about a missing analysis this long after the call ended, and again
 * no sooner than this after the last ask. The platform's analysis lands within a minute of
 * the call; asking every 20 s from the first poll would spend the `RECOVER_ANALYSIS_MAX_CHECKS`
 * before it could have arrived.
 */
export const RECOVER_ONE_ANALYSIS_AFTER_MS = 60_000;
/**
 * An `in_progress` row the platform cannot find is settled after this many "not found"
 * answers, not the first: `call_started` proved the call existed, so one 404 may be the
 * platform lagging. A `registered` row is settled on the first — no `call_started` ever
 * came, and the platform never created the call.
 */
export const RECOVER_NOT_FOUND_CHECKS_IN_PROGRESS = 2;
/**
 * get-call reads per tick, per query. Rows never asked about come first, then the ones
 * asked longest ago, newest first within that — so a row the platform cannot answer for
 * (a genuinely long call, one it never analysed) is re-asked on `RECOVER_RECHECK_MS` and
 * never sits at the head of the queue in front of a call whose webhook was actually lost.
 * A backlog beyond this drains over the next ticks.
 */
export const RECOVER_BATCH = 100;

/** `call_status` values after which the platform sends no further lifecycle event but `call_analyzed`. */
const TERMINAL_STATUSES = new Set(['ended', 'error', 'not_connected']);

export interface CallRecoveryOutcome {
  checked: number;
  /** Events stored from `get-call` and handed to the queue. */
  recovered: { call_ended: number; call_analyzed: number };
  /** Still ongoing on the platform, or ended too recently to call the webhook lost. */
  live: number;
  /** The platform has no such call. A `registered` row is settled as not connected; see `RECOVER_NOT_FOUND_CHECKS_IN_PROGRESS`. */
  not_found: number;
  failed: number;
}

interface RecoveryRow {
  id: string;
  status: string;
  recoveryChecks: number;
}

/**
 * §13.11 `call-recovery` (ADR 0011 §7): settles calls whose `call_ended` or
 * `call_analyzed` the platform never delivered.
 *
 * Without it a dropped `call_ended` is a call that is never billed and shows as in
 * progress forever — the reservation in `active:{ws}` expires on its own, nothing else
 * does, and the SA12 replay cannot help because nothing was stored. Seen on 24 Sep 2026:
 * a web test call with `call_started` delivered and the other two events never sent.
 *
 * It does not bill anything itself. It asks `get-call` for rows still `registered` /
 * `in_progress`, or `ended` without analysis, and stores the platform's answer as the
 * missing webhook — same `(provider, external_id, event_type)` key, same queue, same
 * handler. So every money rule holds unchanged: `call_ended` is still the only event
 * that moves credits, the debit is still idempotent on `call_id`, and a real webhook that
 * arrives after the recovery is a duplicate of a processed event (204), not a second
 * charge. A row whose event is already stored is skipped — that one is the
 * `webhook-sweeper`'s and BullMQ's.
 *
 * Every ask is remembered on the row (`recovery_checked_at`, `recovery_checks`): a row
 * is re-asked on `RECOVER_RECHECK_MS`, rows never asked come first, and a row with no
 * analysis is given up after `RECOVER_ANALYSIS_MAX_CHECKS`. A call the platform cannot
 * find is settled as a `call_ended` it never sent — `not_connected` for a `registered`
 * row, `error` for an `in_progress` one — which the ordinary handler bills as zero, so a
 * caller who hung up before the platform created the call does not ring in D2 for a day.
 */
@Injectable()
export class CallRecoveryService {
  private readonly log = new Logger(CallRecoveryService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly events: WebhookEventsService,
    private readonly queues: JobQueues,
  ) {}

  async recover(now = new Date()): Promise<CallRecoveryOutcome> {
    const outcome = emptyOutcome();
    const at = now.getTime();
    const notRecently: Prisma.CallWhereInput = {
      OR: [{ recoveryCheckedAt: null }, { recoveryCheckedAt: { lt: new Date(at - RECOVER_RECHECK_MS) } }],
    };
    const leastRecentlyAskedFirst = (column: 'createdAt' | 'endedAt'): Prisma.CallOrderByWithRelationInput[] => [
      { recoveryCheckedAt: { sort: 'asc', nulls: 'first' } },
      { [column]: 'desc' },
    ];

    const unfinished = await adminDb.call.findMany({
      where: {
        status: { in: ['registered', 'in_progress'] },
        endedAt: null,
        createdAt: { gte: new Date(at - RECOVER_WINDOW_MS), lt: new Date(at - RECOVER_UNFINISHED_AFTER_MS) },
        ...notRecently,
      },
      orderBy: leastRecentlyAskedFirst('createdAt'),
      take: RECOVER_BATCH,
      select: { id: true, status: true, recoveryChecks: true },
    });
    const unanalysed = await adminDb.call.findMany({
      where: {
        status: 'ended',
        analysisJson: { equals: Prisma.DbNull },
        endedAt: { gte: new Date(at - RECOVER_ANALYSIS_WINDOW_MS), lt: new Date(at - RECOVER_ANALYSIS_AFTER_MS) },
        recoveryChecks: { lt: RECOVER_ANALYSIS_MAX_CHECKS },
        ...notRecently,
      },
      orderBy: leastRecentlyAskedFirst('endedAt'),
      take: RECOVER_BATCH,
      select: { id: true, status: true, recoveryChecks: true },
    });
    if (unfinished.length === 0 && unanalysed.length === 0) return outcome;

    const stored = await this.storedEvents([...unfinished, ...unanalysed].map((c) => c.id));
    const has = (id: string, type: RetellLifecycleEventType) => stored.has(`${id}|${type}`);
    const work: Array<{ row: RecoveryRow; want: RetellLifecycleEventType[] }> = [
      // An unfinished row whose call_ended is already stored is not lost, only queued.
      ...unfinished.filter((c) => !has(c.id, 'call_ended')).map((row) => ({ row, want: has(row.id, 'call_analyzed') ? ['call_ended' as const] : ['call_ended' as const, 'call_analyzed' as const] })),
      ...unanalysed.filter((c) => !has(c.id, 'call_analyzed')).map((row) => ({ row, want: ['call_analyzed' as const] })),
    ];

    for (const { row, want } of work) await this.settle(row, want, at, RECOVER_ENDED_AFTER_MS, outcome);

    if (outcome.recovered.call_ended || outcome.recovered.call_analyzed) {
      this.log.warn(
        `call-recovery: the platform never delivered ${outcome.recovered.call_ended} call_ended and ${outcome.recovered.call_analyzed} call_analyzed; stored from get-call and queued`,
      );
    }
    return outcome;
  }

  /**
   * The same repair for one call, now: `GET /calls/:id` served an unsettled row and queued
   * `recover-call` (`JobQueues.enqueueRecoverCall`), so someone — typically the W5
   * after-call card — is waiting on it. Without this a dropped webhook keeps that card on
   * "Calculating…" for up to eight minutes (the 3-minute age floor plus a 5-minute tick).
   * Same store → queue → handler path as the schedule, so it bills nothing itself.
   */
  async recoverOne(callId: string, now = new Date()): Promise<CallRecoveryOutcome> {
    const outcome = emptyOutcome();
    const at = now.getTime();
    const row = await adminDb.call.findUnique({
      where: { id: callId },
      select: { status: true, endedAt: true, analysisJson: true, createdAt: true, recoveryCheckedAt: true, recoveryChecks: true },
    });
    if (!row) return outcome;
    const kind = unsettledCallKind(row, at);
    if (!kind) return outcome;
    if (kind === 'unanalysed') {
      // The analysis normally lands within a minute of the call; asked sooner, or again
      // sooner than that, a "no analysis yet" would only spend one of the few checks.
      const endedAt = (row.endedAt ?? row.createdAt).getTime();
      if (endedAt > at - RECOVER_ONE_ANALYSIS_AFTER_MS) return outcome;
      if (row.recoveryCheckedAt && row.recoveryCheckedAt.getTime() > at - RECOVER_ONE_ANALYSIS_AFTER_MS) return outcome;
    }

    const stored = await this.storedEvents([callId]);
    const want: RetellLifecycleEventType[] = [];
    if (kind === 'unfinished' && !stored.has(`${callId}|call_ended`)) want.push('call_ended');
    if (!stored.has(`${callId}|call_analyzed`)) want.push('call_analyzed');
    // An unfinished row whose call_ended is stored is queued, not lost; the sweeper has it.
    if (kind === 'unfinished' && !want.includes('call_ended')) return outcome;
    // Everything this row is missing is already stored and on its way: nothing to ask.
    if (want.length === 0) return outcome;

    await this.settle({ id: callId, status: row.status, recoveryChecks: row.recoveryChecks }, want, at, RECOVER_ONE_ENDED_AFTER_MS, outcome);
    if (outcome.recovered.call_ended || outcome.recovered.call_analyzed) {
      this.log.warn(`recover-call ${callId}: stored ${want.join(' + ')} from get-call; the platform never delivered it`);
    }
    return outcome;
  }

  /** Asks `get-call` about one call, remembers the ask on the row, and stores whichever of `want` the platform can answer. */
  private async settle(row: RecoveryRow, want: RetellLifecycleEventType[], at: number, endedAfterMs: number, outcome: CallRecoveryOutcome): Promise<void> {
    outcome.checked += 1;
    let call: RetellCallFacts | null;
    try {
      call = await this.retell.retrieveCallFacts(row.id);
    } catch (error) {
      // Not counted as an ask: the platform did not answer, so nothing was learned.
      outcome.failed += 1;
      this.log.warn(`call-recovery ${row.id}: get-call failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.remember(row.id, at);
    const checks = row.recoveryChecks + 1;

    if (!call) {
      outcome.not_found += 1;
      if (want.includes('call_ended')) await this.settleMissing(row, checks, at, outcome);
      return;
    }

    if (want.includes('call_ended')) {
      const endedLongEnough = (call.end_timestamp ?? 0) <= at - endedAfterMs;
      if (!TERMINAL_STATUSES.has(call.call_status ?? '') || !endedLongEnough) {
        outcome.live += 1;
        return;
      }
      if (await this.store(call, 'call_ended', at)) outcome.recovered.call_ended += 1;
    }
    if (want.includes('call_analyzed') && call.call_analysis) {
      if (await this.store(call, 'call_analyzed', at)) outcome.recovered.call_analyzed += 1;
    }
  }

  /**
   * The platform has no such call. Nothing more will ever arrive for the row, so it gets
   * the `call_ended` the platform never sent: `not_connected` for a `registered` row (no
   * `call_started` came — the caller hung up before the platform created the call), and
   * `error` for an `in_progress` one once the platform has said so twice. Neither carries
   * timestamps, so the handler charges zero, frees the `active:{ws}` slot and shows the
   * row as ended rather than ringing for a day.
   */
  private async settleMissing(row: RecoveryRow, checks: number, at: number, outcome: CallRecoveryOutcome): Promise<void> {
    if (row.status === 'in_progress' && checks < RECOVER_NOT_FOUND_CHECKS_IN_PROGRESS) return;
    const call: RetellCallFacts = {
      call_id: row.id,
      call_status: row.status === 'registered' ? 'not_connected' : 'error',
      disconnection_reason: 'call_not_found',
      end_timestamp: at,
    };
    if (await this.store(call, 'call_ended', at, 'not_found')) {
      outcome.recovered.call_ended += 1;
      this.log.warn(`call-recovery ${row.id}: the platform has no such call after ${checks} ask(s); settled as ${call.call_status}`);
    }
  }

  private async remember(callId: string, at: number): Promise<void> {
    await adminDb.call
      .update({ where: { id: callId }, data: { recoveryCheckedAt: new Date(at), recoveryChecks: { increment: 1 } } })
      .catch((error: unknown) => this.log.warn(`call-recovery ${callId}: could not record the check: ${String(error)}`));
  }

  /** `<call_id>|<event_type>` for every lifecycle event already stored for these calls. */
  private async storedEvents(callIds: string[]): Promise<Set<string>> {
    const rows = await adminDb.webhookEvent.findMany({
      where: { provider: 'retell', externalId: { in: callIds }, eventType: { in: ['call_ended', 'call_analyzed'] } },
      select: { externalId: true, eventType: true },
    });
    return new Set(rows.map((r) => `${r.externalId}|${r.eventType}`));
  }

  /**
   * Stores the event exactly as a delivery would have, then queues it. `recovered_by`
   * marks the row for SA12 (`recovery_reason` says why when the platform had no call);
   * the lifecycle parser ignores both. False when the event turned out to be stored and
   * processed already (the real webhook won the race).
   */
  private async store(call: RetellCallFacts, event: RetellLifecycleEventType, at: number, reason?: 'not_found'): Promise<boolean> {
    const payload = {
      event,
      call,
      event_timestamp: event === 'call_ended' ? (call.end_timestamp ?? at) : at,
      recovered_by: 'call-recovery',
      ...(reason ? { recovery_reason: reason } : {}),
    };
    const stored = await this.events.store({ provider: 'retell', externalId: call.call_id, eventType: event, payload });
    if (stored.kind === 'duplicate') return false;
    const queued = await this.queues.enqueueWebhook(stored.id, 'retell');
    if (queued === 'failed') this.log.error(`call-recovery ${call.call_id} ${event}: stored but not queued; the webhook sweeper will retry`);
    return true;
  }
}

function emptyOutcome(): CallRecoveryOutcome {
  return { checked: 0, recovered: { call_ended: 0, call_analyzed: 0 }, live: 0, not_found: 0, failed: 0 };
}
