import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, type DeclineReason } from '@portal/db';
import type { AgentTier } from '@portal/schemas';
import { EventsService } from '../events';
import { type InboundDecisionJob, JobQueues } from '../jobs';
import { PlatformConfigService } from '../config';
import { REDIS, type RedisLike, redisKeys } from '../redis';
import { RETELL_TRANSFER_EVENTS, channelOf, clampDuration, directionOf, type RetellCallFacts, type RetellLifecycleEvent, type RetellTransferEvent } from '../retell';
import { DuplicateCallDebit, DuplicateTransferDebit, WalletService } from '../wallet';
import { roundCredits } from '../wallet/fifo';
import { ACTIVE_SLACK_MS, RETELL_MAX_CALL_MS, encodeActive, parseActiveHash } from './inbound.decide';
import { usedKnowledge } from './call-knowledge.service';
import { type Charge, computeCharge } from './metering';
import { type TransferEventFact, type TransferFacts, computeTransferCharge, foldTransfer } from './transfer';

export type LifecycleOutcome =
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'registered'; callId: string }
  | { outcome: 'started'; callId: string; rate: number; configVersion: number | null }
  | { outcome: 'already_started'; callId: string }
  | { outcome: 'ended'; callId: string; credits: number; billable: boolean; duplicate: boolean }
  | { outcome: 'already_ended'; callId: string; credits: number }
  | { outcome: 'analyzed'; callId: string; retellCostCents: number | null };

export type TransferOutcome =
  /** No row for the call yet: the stored event is folded in when the call is recorded. */
  | { outcome: 'transfer_deferred'; callId: string }
  | { outcome: 'transfer_recorded'; callId: string; status: TransferFacts['status'] }
  | { outcome: 'transfer_billed'; callId: string; credits: number; duplicate: boolean; billable: boolean };

/**
 * §14 metering and the `calls` lifecycle. Everything here runs from a BullMQ job, never
 * from a request, so every method must be safe to run twice: a retried job, a replayed
 * webhook and a Retell re-delivery all land in the same place.
 *
 * The four rules this file exists to keep (§14.2):
 *   1. `call_ended` is the **only** event that moves credits.
 *   2. `calls.rate` and `calls.config_version` are captured once, at the first event that
 *      creates the row, and are never overwritten — a mid-call price change cannot
 *      re-price a call that is already running.
 *   3. The debit is idempotent on `call_id`; the guarantee is the partial unique index on
 *      `credit_ledger (ref_id) WHERE reason = 'call'`, not the `if` in front of it.
 *   4. `call_analyzed` stores analysis and `retell_cost_cents` for COGS and never bills.
 *   5. (D16) The transferred leg is the one other thing that moves credits, on its own
 *      `transfer` ledger row, once it has both a bridge and an end — never from
 *      `call_ended`'s duration, which is the agent leg only.
 *
 * Connection: `adminDb`. The workspace is only known after the payload is parsed, which
 * is exactly the ADR 0006 case for the admin connection.
 */
@Injectable()
export class CallsService {
  private readonly log = new Logger(CallsService.name);

  constructor(
    @Inject(REDIS) private readonly redis: RedisLike,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly events: EventsService,
    private readonly queues: JobQueues,
  ) {}

  // ---------------------------------------------------------------- write-behind (§13.9)

  /**
   * The `calls` row for an inbound authorisation, allowed or declined — the job the hot
   * path enqueues instead of writing inline (architecture §9).
   *
   * `createMany({skipDuplicates})` rather than `create` in a try/catch: two jobs for one
   * Retell retry (all three carry the same `call_id`, ADR 0003 §1) must not race into a
   * unique violation, and Prisma logs every query error before we could catch it. If the
   * row exists because `call_started` overtook this job, nothing here touches it — that
   * row already has the truth.
   */
  async recordInboundDecision(job: InboundDecisionJob): Promise<{ created: boolean; callId: string }> {
    const declined = job.decision === 'decline';
    const startedAt = new Date(job.eventTimestamp);
    const { count } = await adminDb.call.createMany({
      data: [
        {
          id: job.callId,
          tenantId: job.workspaceId,
          agentId: job.agentId,
          numberId: job.numberId,
          channel: 'phone',
          direction: 'inbound',
          fromNumber: job.fromNumber,
          toNumber: job.toNumber,
          tier: job.tier,
          // A declined call never reaches Retell, so it has a start and an end and no
          // duration: it is "Missed" in D2, not a call that ran for zero seconds.
          startedAt,
          endedAt: declined ? startedAt : null,
          durationS: declined ? 0 : null,
          creditsCharged: declined ? new Prisma.Decimal(0) : null,
          ...(job.rate === null ? {} : { rate: new Prisma.Decimal(job.rate) }),
          configVersion: job.configVersion,
          status: declined ? 'declined' : 'registered',
          declineReason: job.declineReason,
        },
      ],
      skipDuplicates: true,
    });

    if (count === 1) {
      // The D1/D2 pages subscribe to every `call:` topic and act on the first frame of a
      // call, so it carries what a toast needs: who called, on which agent, and that it
      // was a phone call — a browser test call (`call_started`, `is_test`) is not news.
      await this.publishCall(job.workspaceId, job.callId, declined ? 'missed' : 'registered', {
        decline_reason: job.declineReason,
        from_number: job.fromNumber,
        agent_id: job.agentId,
        channel: 'phone',
        direction: 'inbound',
        is_test: false,
      });
    }
    return { created: count === 1, callId: job.callId };
  }

  // ---------------------------------------------------------------- lifecycle (§13.10)

  async handleLifecycle(event: RetellLifecycleEvent): Promise<LifecycleOutcome> {
    const outcome = await (async () => {
      switch (event.event) {
        case 'call_started':
          return this.handleStarted(event.call);
        case 'call_ended':
          return this.handleEnded(event.call);
        case 'call_analyzed':
          return this.handleAnalyzed(event.call);
      }
    })();
    // A transfer event that arrived before the row existed was stored and deferred; the
    // row exists now, so its leg is settled here. A no-op for the (nearly all) calls that
    // were never transferred: one indexed read of this call's stored events.
    if (outcome.outcome !== 'ignored') await this.settleTransfer(event.call.call_id);
    // D16: what the agent looked up. Its own job — a slow CDN must not hold this webhook.
    if (outcome.outcome !== 'ignored' && event.event !== 'call_started' && usedKnowledge(event.call)) {
      await this.queues.enqueueCallKnowledge(event.call.call_id);
    }
    return outcome;
  }

  // ---------------------------------------------------------------- transfer leg (D16)

  /**
   * `transfer_started` / `_bridged` / `_cancelled` / `_ended`. The event itself is already
   * in `webhook_events`; this re-derives the leg from every stored event for the call and
   * bills it once it is complete. With no row yet (the platform dropped `call_started`,
   * or the call is not ours) the event is settled as deferred rather than retried — it is
   * folded in by `handleLifecycle` when the call is recorded, and a call that never is
   * was never ours to bill.
   */
  async handleTransfer(event: RetellTransferEvent): Promise<TransferOutcome> {
    const callId = event.call.call_id;
    const existing = await adminDb.call.findUnique({ where: { id: callId }, select: { id: true } });
    if (!existing) {
      this.log.warn(`${event.event} ${callId}: no call row yet; folded in when the call is recorded`);
      return { outcome: 'transfer_deferred', callId };
    }
    return this.settleTransfer(callId);
  }

  /**
   * Folds the call's stored events into the transfer columns and, once the leg has a
   * bridge and an end, debits it. Safe to run any number of times in any order: the
   * columns are a deterministic function of the stored events, the rate is captured once,
   * and the debit is idempotent on the call id (`credit_ledger_transfer_debit_once_idx`).
   */
  async settleTransfer(callId: string): Promise<TransferOutcome> {
    const row = await adminDb.call.findUnique({
      where: { id: callId },
      select: { id: true, tenantId: true, status: true, configVersion: true, transferRate: true, transferStatus: true },
    });
    if (!row) return { outcome: 'transfer_deferred', callId };

    const facts = foldTransfer(await this.storedTransferFacts(callId));
    if (facts.status === null) return { outcome: 'transfer_recorded', callId, status: null };
    if (row.status === 'declined') {
      // A declined call never reached the platform, so it cannot have transferred.
      this.log.warn(`transfer events for ${callId}, a declined (missed) call; not billed`);
      return { outcome: 'transfer_recorded', callId, status: facts.status };
    }

    // Captured once, like `calls.rate`: the version the call was rated under prices the leg.
    let rate = row.transferRate?.toNumber() ?? null;
    if (rate === null && facts.bridgedAt !== null) {
      rate = (await this.config.transferRate(row.configVersion)).rate;
      await adminDb.call.updateMany({ where: { id: callId, transferRate: null }, data: { transferRate: new Prisma.Decimal(rate) } });
      // Another settlement may have captured it first; the stored value is the one that bills.
      rate = (await adminDb.call.findUnique({ where: { id: callId }, select: { transferRate: true } }))?.transferRate?.toNumber() ?? rate;
    }

    const charge = computeTransferCharge(facts, rate ?? 0);
    await adminDb.call.update({
      where: { id: callId },
      data: {
        transferStatus: facts.status,
        transferStartedAt: date(facts.startedAt),
        transferBridgedAt: date(facts.bridgedAt),
        transferEndedAt: date(facts.endedAt),
        transferDurationS: charge.settled ? Math.round(charge.duration_s) : null,
      },
    });
    if (!charge.settled) {
      if (row.transferStatus !== facts.status) await this.publishCall(row.tenantId, callId, 'transfer', { transfer_status: facts.status });
      return { outcome: 'transfer_recorded', callId, status: facts.status };
    }

    let credits = 0;
    let duplicate = false;
    if (charge.billable) {
      try {
        const write = await this.wallet.debitTransfer(row.tenantId, callId, charge.credits);
        credits = Math.abs(write.delta);
        duplicate = write.duplicate;
      } catch (error) {
        if (!(error instanceof DuplicateTransferDebit)) throw error;
        credits = await this.chargedCredits(row.tenantId, callId, 'transfer');
        duplicate = true;
      }
    }
    // A projection of the ledger row, written after it — a crash in between is repaired
    // by the next settlement reading the same row.
    await adminDb.call.update({ where: { id: callId }, data: { transferCreditsCharged: new Prisma.Decimal(credits) } });

    if (!duplicate) {
      await this.publishCall(row.tenantId, callId, 'transfer', {
        transfer_status: facts.status,
        transfer_duration_s: charge.duration_s,
        transfer_credits_charged: credits,
      });
      this.log.log(
        `transfer leg ${callId}: ${charge.duration_s.toFixed(3)}s × ${rate ?? 0}/min → ${credits} credits${charge.billable ? '' : ` (${charge.zero_reason})`}`,
      );
    }
    return { outcome: 'transfer_billed', callId, credits, duplicate, billable: charge.billable };
  }

  /** Every stored Retell event for the call, reduced to what `foldTransfer` reads. */
  private async storedTransferFacts(callId: string): Promise<TransferEventFact[]> {
    const rows = await adminDb.webhookEvent.findMany({
      where: { provider: 'retell', externalId: callId, eventType: { in: [...RETELL_TRANSFER_EVENTS, 'call_ended', 'call_analyzed'] } },
      select: { eventType: true, payloadJson: true, receivedAt: true },
    });
    return rows.map((r) => {
      const payload = (r.payloadJson ?? {}) as Record<string, unknown>;
      const call = (typeof payload.call === 'object' && payload.call !== null ? payload.call : {}) as Record<string, unknown>;
      const eventTs = numberOrNull(payload.event_timestamp as number | null | undefined);
      return {
        type: r.eventType,
        at: eventTs ?? r.receivedAt.getTime(),
        transferEndTimestamp: numberOrNull(call.transfer_end_timestamp as number | null | undefined),
        disconnectionReason: typeof call.disconnection_reason === 'string' ? call.disconnection_reason : null,
        endTimestamp: numberOrNull(call.end_timestamp as number | null | undefined),
      };
    });
  }

  /**
   * `call_started`: the row exists (inbound) or is created (web and outbound calls, which
   * have no inbound webhook), the rate and config version are captured **now**, and the
   * call takes a slot in `active:{ws}`.
   *
   * Reserving here as well as at authorisation is deliberate: a web test call never went
   * through the inbound path, and an inbound reservation may have been lost to a Redis
   * blip. `HSET` is last-write-wins on one field, so doing it twice reserves once.
   */
  private async handleStarted(call: RetellCallFacts): Promise<LifecycleOutcome> {
    const existing = await this.load(call.call_id);
    const origin = existing ? null : await this.origin(call);
    const workspaceId = existing?.tenantId ?? origin?.workspaceId ?? null;
    if (!workspaceId) return { outcome: 'ignored', reason: `call_started ${call.call_id}: ${UNIDENTIFIED}` };

    if (existing && (existing.status === 'ended' || existing.status === 'analyzed')) {
      // Out of order: call_ended was processed first. Nothing to start; re-reserving a
      // finished call would leave a slot held until its TTL.
      return { outcome: 'already_started', callId: call.call_id };
    }

    const { rate, configVersion, tier } = await this.rateFor(existing, call, origin);
    const startedAt = timestamp(call.start_timestamp) ?? new Date();

    if (existing) {
      // Conditional in Postgres, not on the read above: a call_ended landing in between
      // must not be reopened.
      const { count } = await adminDb.call.updateMany({
        where: { id: call.call_id, status: { notIn: ['ended', 'analyzed', 'declined'] } },
        data: {
          status: 'in_progress',
          startedAt,
          agentVersion: await this.versionOf(call, existing.agentId),
          fromNumber: existing.fromNumber ?? call.from_number ?? null,
          toNumber: existing.toNumber ?? call.to_number ?? null,
          // rate / configVersion are NOT touched: captured when the row was created (§14.2).
        },
      });
      if (count === 0) {
        // The race the condition guards against happened: another worker finalised the
        // row between the read and this write. Reserving now would hold an `active:{ws}`
        // slot for a finished call until its TTL, and the frame would show it live again.
        return { outcome: 'already_started', callId: call.call_id };
      }
    } else {
      await adminDb.call.createMany({
        data: [
          {
            id: call.call_id,
            tenantId: workspaceId,
            agentId: origin?.agentId ?? null,
            numberId: origin?.numberId ?? null,
            agentVersion: await this.versionOf(call, origin?.agentId ?? null),
            channel: channelOf(call.call_type),
            direction: directionOf(call.direction),
            isTest: isTestCall(call),
            fromNumber: call.from_number ?? null,
            toNumber: call.to_number ?? null,
            startedAt,
            tier,
            rate: new Prisma.Decimal(rate),
            configVersion,
            status: 'in_progress',
          },
        ],
        skipDuplicates: true,
      });
    }

    await this.reserve(workspaceId, call.call_id, rate, existing?.agentId ?? origin?.agentId ?? null);
    await this.publishCall(workspaceId, call.call_id, 'in_progress', {
      started_at: startedAt.toISOString(),
      rate,
      from_number: call.from_number ?? null,
      agent_id: existing?.agentId ?? origin?.agentId ?? null,
      channel: channelOf(call.call_type),
      direction: directionOf(call.direction),
      is_test: isTestCall(call),
    });
    return { outcome: 'started', callId: call.call_id, rate, configVersion };
  }

  /**
   * `call_ended` — the only event that moves credits (§14.2).
   *
   * Order matters: the row is finalised first (duration, reason, status), then the ledger
   * debit runs against the rate on that row, then `credits_charged` is written. A retry
   * after a crash anywhere in that sequence re-runs it: the debit is idempotent on
   * `call_id`, so the second pass finds the existing ledger row and only repairs the
   * `credits_charged` column.
   */
  private async handleEnded(call: RetellCallFacts): Promise<LifecycleOutcome> {
    const existing = await this.load(call.call_id);
    const origin = existing ? null : await this.origin(call);
    const workspaceId = existing?.tenantId ?? origin?.workspaceId ?? null;
    if (!workspaceId) return { outcome: 'ignored', reason: `call_ended ${call.call_id}: ${UNIDENTIFIED}` };

    if (existing?.status === 'declined') {
      // A declined call never reached Retell, so this cannot be the same call; if it is,
      // the decline row is the one that is wrong. Never bill against it.
      return { outcome: 'ignored', reason: `call_ended ${call.call_id}: the row is a declined (missed) call` };
    }

    const { rate, configVersion, tier } = await this.rateFor(existing, call, origin);
    const charge = computeCharge(call, rate);
    const endedAt = timestamp(call.end_timestamp) ?? new Date();
    const startedAt = timestamp(call.start_timestamp) ?? existing?.startedAt ?? endedAt;

    // 1. Finalise the row. `updateMany`/`createMany` so an out-of-order or already-final
    //    row is not a crash; the debit below is what must not run twice, not this.
    const facts = {
      endedAt,
      durationS: Math.round(charge.duration_s),
      disconnectionReason: call.disconnection_reason ?? null,
      transcriptText: call.transcript ?? undefined,
      transcriptJson: (call.transcript_object ?? undefined) as Prisma.InputJsonValue | undefined,
      recordingUrl: call.recording_url ?? undefined,
    };
    // An analyzed row stays analyzed: call_analyzed is the later state (§13.10). The two
    // events can land in the same millisecond, so `existing.status` may already be stale;
    // the condition is evaluated by Postgres, not from the read above.
    const finalise = async (fallbackStartedAt: Date) => {
      await adminDb.call.update({ where: { id: call.call_id }, data: facts });
      await adminDb.call.updateMany({ where: { id: call.call_id, startedAt: null }, data: { startedAt: fallbackStartedAt } });
      await adminDb.call.updateMany({ where: { id: call.call_id, status: { not: 'analyzed' } }, data: { status: 'ended' } });
    };
    if (existing) {
      await finalise(startedAt);
    } else {
      const created = await adminDb.call.createMany({
        data: [
          {
            id: call.call_id,
            tenantId: workspaceId,
            agentId: origin?.agentId ?? null,
            numberId: origin?.numberId ?? null,
            agentVersion: await this.versionOf(call, origin?.agentId ?? null),
            channel: channelOf(call.call_type),
            direction: directionOf(call.direction),
            isTest: isTestCall(call),
            fromNumber: call.from_number ?? null,
            toNumber: call.to_number ?? null,
            startedAt,
            tier,
            rate: new Prisma.Decimal(rate),
            configVersion,
            ...facts,
            status: 'ended',
          },
        ],
        skipDuplicates: true,
      });
      // Another event created the row since the read (call_analyzed first): finalise it.
      if (created.count === 0) await finalise(startedAt);
    }

    // 2. Release the concurrency slot. Before the debit, not after: a debit that fails and
    //    is retried must not hold a slot for the whole backoff.
    await this.release(workspaceId, call.call_id);

    // 3. Bill, exactly once.
    let credits = 0;
    let duplicate = false;
    if (charge.billable && charge.credits > 0) {
      try {
        const write = await this.wallet.debitCall(workspaceId, call.call_id, charge.credits);
        credits = Math.abs(write.delta);
        duplicate = write.duplicate;
      } catch (error) {
        if (error instanceof DuplicateCallDebit) {
          // Lost the race with a concurrent finalisation; it charged. Read what it wrote.
          credits = await this.chargedCredits(workspaceId, call.call_id);
          duplicate = true;
        } else {
          throw error;
        }
      }
    }

    // 4. `credits_charged` is a projection of the ledger, written after it. A crash
    //    between 3 and 4 leaves it null and the retry fills it from the same ledger row.
    await adminDb.call.update({ where: { id: call.call_id }, data: { creditsCharged: new Prisma.Decimal(credits) } });

    await this.publishCall(workspaceId, call.call_id, 'ended', {
      duration_s: charge.duration_s,
      credits_charged: credits,
      disconnection_reason: call.disconnection_reason ?? null,
      billable: charge.billable,
      zero_reason: charge.zero_reason ?? null,
    });

    this.log.log(
      `call_ended ${call.call_id}: ${charge.duration_s.toFixed(3)}s × ${rate}/min → ${credits} credits${duplicate ? ' (already debited)' : ''}${
        charge.billable ? '' : ` (${charge.zero_reason})`
      }`,
    );
    return duplicate
      ? { outcome: 'already_ended', callId: call.call_id, credits }
      : { outcome: 'ended', callId: call.call_id, credits, billable: charge.billable, duplicate: false };
  }

  /**
   * `call_analyzed`: analysis, transcript and `retell_cost_cents` (COGS). **Never bills.**
   * Nothing in this method may touch the wallet, `credits_charged` or `active:{ws}` — two
   * events that both move money is how double-billing happens under retry (§14.2).
   */
  private async handleAnalyzed(call: RetellCallFacts): Promise<LifecycleOutcome> {
    const existing = await this.load(call.call_id);
    const origin = existing ? null : await this.origin(call);
    const workspaceId = existing?.tenantId ?? origin?.workspaceId ?? null;
    if (!workspaceId) return { outcome: 'ignored', reason: `call_analyzed ${call.call_id}: ${UNIDENTIFIED}` };

    const retellCostCents = costCents(call);
    const analysis = call.call_analysis ?? null;
    const data: Prisma.CallUpdateInput = {
      analysisJson: (analysis ?? undefined) as Prisma.InputJsonValue | undefined,
      retellCostCents,
      transcriptText: call.transcript ?? undefined,
      transcriptJson: (call.transcript_object ?? undefined) as Prisma.InputJsonValue | undefined,
      recordingUrl: call.recording_url ?? undefined,
      outcome: outcomeOf(analysis),
      status: 'analyzed',
    };

    if (existing) {
      await adminDb.call.update({ where: { id: call.call_id }, data });
    } else {
      // Analysis before (or without) call_ended. The row is created unbilled and stays
      // that way: only call_ended bills, and if it never arrives the reconcile-calls job
      // (§13.11) is what settles it — not this event.
      const created = await adminDb.call.createMany({
        data: [
          {
            id: call.call_id,
            tenantId: workspaceId,
            agentId: origin?.agentId ?? null,
            numberId: origin?.numberId ?? null,
            agentVersion: await this.versionOf(call, origin?.agentId ?? null),
            channel: channelOf(call.call_type),
            direction: directionOf(call.direction),
            isTest: isTestCall(call),
            fromNumber: call.from_number ?? null,
            toNumber: call.to_number ?? null,
            startedAt: timestamp(call.start_timestamp),
            endedAt: timestamp(call.end_timestamp),
            tier: origin?.tier ?? 'standard',
            analysisJson: (analysis ?? undefined) as Prisma.InputJsonValue | undefined,
            retellCostCents,
            transcriptText: call.transcript ?? null,
            transcriptJson: (call.transcript_object ?? undefined) as Prisma.InputJsonValue | undefined,
            recordingUrl: call.recording_url ?? null,
            outcome: outcomeOf(analysis),
            status: 'analyzed',
          },
        ],
        skipDuplicates: true,
      });
      if (created.count === 0) {
        // call_ended (or call_started) created the row since the read: annotate that one.
        await adminDb.call.update({ where: { id: call.call_id }, data });
      } else {
        this.log.warn(`call_analyzed ${call.call_id}: no row and no call_ended yet; stored unbilled`);
      }
    }

    await this.publishCall(workspaceId, call.call_id, 'analyzed', { outcome: outcomeOf(analysis) });
    return { outcome: 'analyzed', callId: call.call_id, retellCostCents };
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Whose call this is, for a payload with no row yet.
   *
   * `metadata.tenant_id` answers it for every call we authorised, because that is what we
   * put in the allow. The fail-open answers do **not** carry it: `200 {}` (Redis down, or
   * a number we could not identify, ADR 0011 §2) lets Retell answer with the bound agent
   * and no metadata at all, and the invariant for that case is that `call_ended` bills as
   * usual — which it cannot do from a payload alone. So we identify the call from what
   * Retell always sends: the agent it used, then the number it was dialled on. Postgres is
   * fine here; this runs in a job, never on the §13.9 path.
   */
  private async origin(call: RetellCallFacts): Promise<CallOrigin | null> {
    const metadata = metadataOf(call);
    const fromMetadata = workspaceFromMetadata(call);
    if (fromMetadata) {
      const agentId = stringOrNull(metadata.agent_id);
      const tier = tierFromMetadata(call);
      // Our own metadata, but only part of it — an older allow, or a call created with just
      // the workspace. The agent is what sizes the rate and the reservation, so fill it in.
      const agent = agentId && tier ? null : await this.agentOf(call, fromMetadata);
      return {
        workspaceId: fromMetadata,
        agentId: agentId ?? agent?.id ?? null,
        numberId: stringOrNull(metadata.number_id),
        tier: tier ?? agent?.tier ?? null,
      };
    }

    const agent = await this.agentOf(call);
    if (agent) {
      const number = await this.numberOf(call, agent.tenantId);
      this.log.warn(`${call.call_id}: no metadata; identified by retell agent ${call.agent_id} → workspace ${agent.tenantId}`);
      return { workspaceId: agent.tenantId, agentId: agent.id, numberId: number?.id ?? null, tier: agent.tier };
    }

    const number = await this.numberOf(call);
    if (number) {
      this.log.warn(`${call.call_id}: no metadata; identified by number ${number.e164} → workspace ${number.tenantId}`);
      return { workspaceId: number.tenantId, agentId: number.agentId, numberId: number.id, tier: number.agent?.tier ?? null };
    }
    return null;
  }

  /**
   * `calls.agent_version` is **our** `agent_versions.version_no`, never the platform's
   * version counter — that one is `retell_agent_version`, which stays off every wire
   * schema (a draft test call reads 0 there). A test call names its version in
   * `metadata.version_no`; a phone call runs `latest_published`, so the platform's number
   * is translated through the published row that recorded it. Unknown → null.
   */
  private async versionOf(call: RetellCallFacts, agentId: string | null): Promise<number | null> {
    const fromMetadata = metadataOf(call).version_no;
    if (typeof fromMetadata === 'number' && Number.isInteger(fromMetadata) && fromMetadata > 0) return fromMetadata;
    const platformVersion = numberOrNull(call.agent_version);
    if (!agentId || platformVersion === null) return null;
    const row = await adminDb.agentVersion
      .findFirst({
        where: { agentId, retellAgentVersion: platformVersion, publishedAt: { not: null } },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      })
      .catch(() => null);
    return row?.versionNo ?? null;
  }

  /** The agent Retell says took the call, by its `retell_agent_id`. */
  private async agentOf(call: RetellCallFacts, workspaceId?: string) {
    if (!call.agent_id) return null;
    return adminDb.agent.findFirst({
      where: { retellAgentId: call.agent_id, ...(workspaceId ? { tenantId: workspaceId } : {}) },
      select: { id: true, tenantId: true, tier: true },
    });
  }

  /** Our phone number in this call: `to_number` inbound, `from_number` outbound. `e164` is unique, so a hit is ours. */
  private async numberOf(call: RetellCallFacts, workspaceId?: string) {
    const e164 = ourEnd(call);
    if (!e164) return null;
    const row = await adminDb.phoneNumber.findUnique({
      where: { e164 },
      select: { id: true, e164: true, tenantId: true, agentId: true, agent: { select: { tier: true } } },
    });
    return row && (workspaceId === undefined || row.tenantId === workspaceId) ? row : null;
  }

  private load(callId: string) {
    return adminDb.call.findUnique({
      where: { id: callId },
      select: { id: true, tenantId: true, agentId: true, status: true, rate: true, configVersion: true, tier: true, startedAt: true, fromNumber: true, toNumber: true, creditsCharged: true },
    });
  }

  /**
   * The rate this call bills at. Captured on the row wins, always — that is rule 2, and
   * it is why a pricing publish mid-call cannot re-price it. Only a call whose row does
   * not exist yet reads the config, and it reads it as of now.
   */
  private async rateFor(
    existing: { rate: Prisma.Decimal; configVersion: number | null; tier: AgentTier } | null,
    call: RetellCallFacts,
    origin: CallOrigin | null,
  ): Promise<{ rate: number; configVersion: number | null; tier: AgentTier }> {
    if (existing) {
      const rate = existing.rate.toNumber();
      // A row written before the pricing snapshot was cached can carry the column default.
      if (Number.isFinite(rate) && rate > 0 && existing.configVersion !== null) {
        return { rate, configVersion: existing.configVersion, tier: existing.tier };
      }
      const fresh = await this.config.rateFor(existing.tier).catch(() => null);
      if (!fresh) return { rate: Number.isFinite(rate) && rate > 0 ? rate : 0, configVersion: existing.configVersion, tier: existing.tier };
      await adminDb.call.update({ where: { id: call.call_id }, data: { rate: new Prisma.Decimal(fresh.rate), configVersion: fresh.configVersion } });
      return { rate: fresh.rate, configVersion: fresh.configVersion, tier: existing.tier };
    }
    const tier = origin?.tier ?? 'standard';
    const { rate, configVersion } = await this.config.rateFor(tier);
    return { rate, configVersion, tier };
  }

  private async chargedCredits(workspaceId: string, callId: string, reason: 'call' | 'transfer' = 'call'): Promise<number> {
    const row = await adminDb.creditLedger.findFirst({ where: { tenantId: workspaceId, reason, refId: callId }, select: { delta: true } });
    return row ? Math.abs(row.delta.toNumber()) : 0;
  }

  /**
   * Takes a concurrency slot in `active:{ws}` (§14.3), sized to what this call can
   * actually spend.
   *
   * The size is not bookkeeping: `active:{ws}` is what the §13.9 balance check subtracts
   * from the wallet before it lets the next caller through (ADR 0011 §1), so a
   * reservation larger than the call's real exposure declines other callers on `balance`
   * while the credits are still there — a browser test call reserving Retell's two-hour
   * ceiling is 120 credits at the standard rate, more than most wallets hold.
   *
   * So it is sized the way the inbound path sizes it — min(the agent's own max duration,
   * what is left of the wallet after the other live calls) — for the calls that never
   * went through that path: browser tests, outbound calls, and an inbound call whose
   * reservation was lost to a Redis blip.
   *
   * Idempotent: an existing field is never overwritten, so the inbound reservation (which
   * the authorisation sized against the balance at the time) stays as it is.
   */
  private async reserve(workspaceId: string, callId: string, rate: number, agentId: string | null): Promise<void> {
    const key = redisKeys.activeCalls(workspaceId);
    const now = Date.now();
    try {
      const hash = await this.redis.hgetall(key);
      if (hash[callId]) return; // already reserved at authorisation
      const { live } = parseActiveHash(hash, now);
      const reserved = live.reduce((sum, a) => sum + a.credits, 0);

      const maxMs = clampDuration(await this.maxCallMs(agentId));
      const headroom = await this.headroom(workspaceId, reserved);
      const worstCase = roundCredits((maxMs / 60_000) * (rate > 0 ? rate : 0));
      const credits = headroom === null ? worstCase : Math.min(worstCase, headroom);
      // The field lives as long as the call may run — that is the concurrency slot, and it
      // is not shortened by the call holding fewer credits than its full duration costs.
      const expiresAt = now + maxMs + ACTIVE_SLACK_MS;

      const written = await this.redis.hsetnx(key, callId, encodeActive(credits, expiresAt));
      if (written === 1) {
        // Never shorten the key below what an already-live call still needs.
        const floor = Math.max(expiresAt, ...live.map((a) => a.expiresAt));
        await this.redis.expire(key, Math.ceil((floor - now) / 1000) + 60);
      }
    } catch (error) {
      this.log.warn(`active:{${workspaceId}} reserve ${callId} failed: ${String(error)}`);
    }
  }

  /** `min(agents.max_call_duration_s, Retell's ceiling)` in ms — the same planMax the hot path uses. */
  private async maxCallMs(agentId: string | null): Promise<number> {
    if (!agentId) return RETELL_MAX_CALL_MS;
    const agent = await adminDb.agent.findUnique({ where: { id: agentId }, select: { maxCallDurationS: true } }).catch(() => null);
    const ms = (agent?.maxCallDurationS ?? 0) * 1_000;
    return ms > 0 ? Math.min(ms, RETELL_MAX_CALL_MS) : RETELL_MAX_CALL_MS;
  }

  /** Credits this call may still spend: balance + grace − the other live reservations. Null when the balance is unknown. */
  private async headroom(workspaceId: string, reservedByOthers: number): Promise<number | null> {
    const balance = await this.wallet.balance(workspaceId).catch(() => null);
    if (balance === null || !Number.isFinite(balance)) return null;
    const grace = await this.config
      .capsFor(workspaceId)
      .then((caps) => caps.grace_overdraft_credits)
      .catch(() => 0);
    return Math.max(0, roundCredits(balance + grace - reservedByOthers));
  }

  /** Frees the slot. Safe to call for a call that never held one. */
  private async release(workspaceId: string, callId: string): Promise<void> {
    try {
      await this.redis.hdel(redisKeys.activeCalls(workspaceId), callId);
    } catch (error) {
      this.log.warn(`active:{${workspaceId}} release ${callId} failed: ${String(error)}`);
    }
  }

  /** SSE `call:{id}` (§16). Never throws: a lost frame is a display problem, not a billing one. */
  private async publishCall(workspaceId: string, callId: string, type: string, data: Record<string, unknown>): Promise<void> {
    await this.events.publish(workspaceId, `call:${callId}`, type, { call_id: callId, ...data }).catch(() => null);
  }
}

/** Where a call is identified from when the payload carries no `metadata.tenant_id`. */
interface CallOrigin {
  workspaceId: string;
  agentId: string | null;
  numberId: string | null;
  tier: AgentTier | null;
}

const UNIDENTIFIED = 'no workspace on the row, in the metadata, on the agent or on the number';

/**
 * The end of the call that would be ours: inbound we are `to`, outbound we are `from`.
 * Only that end. The other end of an outbound call is whoever it dialled, and when that is
 * a customer's number the leg is still the caller's: a platform number ringing one of ours
 * posts its own outbound leg here without our metadata, and matching it on `to` billed the
 * caller's minutes to the workspace that was called.
 */
function ourEnd(call: RetellCallFacts): string | null {
  const e164 = (directionOf(call.direction) === 'outbound' ? call.from_number : call.to_number)?.trim();
  return e164 ? e164 : null;
}

function metadataOf(call: RetellCallFacts): Record<string, unknown> {
  return (call.metadata ?? {}) as Record<string, unknown>;
}

/**
 * A test call is one we minted as such: the W5/D3 browser test and "Call my phone" put
 * `test: true` in the metadata. A browser call is a test unless it says otherwise — the
 * website widget (D17 §11.5) is the one that does, with `test: false`, and is a real
 * caller on the `web` channel.
 */
function isTestCall(call: RetellCallFacts): boolean {
  const test = metadataOf(call).test;
  if (typeof test === 'boolean') return test;
  return channelOf(call.call_type) === 'web';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `metadata.tenant_id` (§14.2 tenant isolation). Anyone who can reach Retell could put a
 * string there, so it is only believed when it is a uuid; the row's own `tenant_id` wins
 * wherever the row exists, which is every call that went through our API.
 */
function workspaceFromMetadata(call: RetellCallFacts): string | null {
  const value = metadataOf(call).tenant_id;
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

function tierFromMetadata(call: RetellCallFacts): AgentTier | null {
  const value = metadataOf(call).tier;
  return value === 'premium' || value === 'standard' ? value : null;
}

function timestamp(value: number | null | undefined): Date | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value) : null;
}

function date(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

/** ADR 0003 §3: `combined_cost` is US cents, floating point. `retell_cost_cents` is an int column. */
function costCents(call: RetellCallFacts): number | null {
  const combined = call.call_cost?.combined_cost;
  return typeof combined === 'number' && Number.isFinite(combined) ? Math.round(combined) : null;
}

/** A one-word outcome for the D2 list, from Retell's analysis. Absent values come back as zero values (ADR 0003 §11). */
function outcomeOf(analysis: Record<string, unknown> | null): string | undefined {
  if (!analysis) return undefined;
  if (analysis.in_voicemail === true) return 'voicemail';
  const custom = analysis.custom_analysis_data;
  if (typeof custom === 'object' && custom !== null) {
    const reason = (custom as Record<string, unknown>).call_reason;
    if (typeof reason === 'string' && reason) return reason;
  }
  if (typeof analysis.call_successful === 'boolean') return analysis.call_successful ? 'completed' : 'unresolved';
  return undefined;
}

export type { Charge, DeclineReason };
