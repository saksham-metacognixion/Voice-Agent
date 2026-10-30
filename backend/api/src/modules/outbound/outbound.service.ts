import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type WorkspaceDb, adminDb, withWorkspace } from '@portal/db';
import {
  type AgentTier,
  type CallbackCheck,
  type CallbackRequest,
  type CallbackResponse,
  DEFAULT_OUTBOUND_SETTINGS,
  type KycStatus,
  type OutboundPolicy,
  type OutboundRefusal,
  type OutboundSettings,
  type VoicemailDetection,
  localClock,
  outboundSettings,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { OpsAlertService } from '../alerts';
import type { WorkspaceContext } from '../auth';
import { CallsService, MintSlot, headroom, liveCalls } from '../calls';
import { PlatformConfigService } from '../config';
import { numberTransferVariables } from '../prompting/staff-transfer';
import { REDIS, type RedisLike } from '../redis';
import { RetellGateway, type VoicemailAction, retellErrorStatus } from '../retell';
import { normalisePhone } from '../runtime-cache';
import { WalletService } from '../wallet';
import { type CallerId, callerIdCandidates, pickCallerId } from './caller-ids';
import { callingWindowVerdict } from './calling-window';
import { maskNumber, readDestination } from './destination';
import { type OutboundFacts, REFUSAL_MESSAGES, decideOutbound } from './outbound.decide';
import { unconfirmedBefore, usedOn } from './outbound-usage';

/** The caller ID's hand-off settings, which the call carries as an inbound call to it would. */
interface CallerLine {
  transferTargetsJson: unknown;
  transferFailMessage: string | null;
}

/** The agent that places the callback: the one on the call, live and published. */
interface LiveAgent {
  id: string;
  tier: AgentTier;
  maxCallDurationS: number;
  retellAgentId: string;
  publishedVersion: number;
  retellAgentVersion: number;
  briefJson: unknown;
}

/** Everything `decideOutbound` reads, plus what placing the call needs once it says yes. */
interface Assessment {
  facts: OutboundFacts;
  policy: OutboundPolicy;
  settings: OutboundSettings;
  callerId: CallerId | null;
  callerLine: CallerLine | null;
  agent: LiveAgent | null;
  destination: { e164: string; country: string } | null;
  nextAllowedAt: Date | null;
  localDay: string | null;
}

/**
 * D18 outbound click-to-call (ADR 0031): call back the other party of a D2 call, from a
 * verified number of the workspace, by the agent on that call — only once every gate in
 * `decideOutbound` says yes, and never by any other route.
 *
 *   GET  /calls/:id/callback  the verdict, without placing anything
 *   POST /calls/:id/callback  the verdict again, then the cap under a lock, the line, the call
 *
 * A refused attempt writes an `audit_log` row (`call.outbound_blocked`, the reason, a
 * masked number, the request id) and nothing else: no `outbound_calls` row, no `calls` row,
 * no ledger row, no platform request. A placed call gets its `calls` row straight away and
 * is billed by `call_ended` like every other call, at the agent's tier rate, once.
 *
 * The platform has no idempotency keys, so an answer we never got is not a failure: the
 * attempt stays `pending` (the same key answers 409) until a lifecycle webhook carrying its
 * `outbound_id` binds it to the call (`CallsService`), or `UNCONFIRMED_ATTEMPT_MS` passes.
 */
@Injectable()
export class OutboundCallService {
  private readonly log = new Logger(OutboundCallService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly calls: CallsService,
    @Inject(REDIS) private readonly redis: RedisLike,
    private readonly ops: OpsAlertService,
  ) {}

  async check(ctx: WorkspaceContext, callId: string): Promise<CallbackCheck> {
    const a = await this.assess(ctx, callId);
    const decision = decideOutbound(a.facts);
    return {
      allowed: decision.ok,
      reason: decision.ok ? null : decision.reason,
      next_allowed_at: !decision.ok && decision.reason === 'OUTSIDE_CALLING_WINDOW' ? (a.nextAllowedAt?.toISOString() ?? null) : null,
      to_number: a.destination?.e164 ?? null,
      from_number: a.callerId?.e164 ?? null,
      number_id: a.callerId?.id ?? null,
      agent_id: a.agent?.id ?? null,
      voicemail_detection: a.settings.voicemail_detection,
      daily_cap: a.facts.dailyCap,
      used_today: a.facts.usedToday,
      prior_contact_days: a.policy.prior_contact_days,
    };
  }

  async callBack(ctx: WorkspaceContext, callId: string, body: CallbackRequest): Promise<CallbackResponse> {
    // A key already used: the same press again (a double click, a retry, a second tab).
    const replay = await this.replay(ctx, callId, body.idempotency_key);
    if (replay) return replay;

    const a = await this.assess(ctx, callId, body.number_id);
    const decision = decideOutbound(a.facts);
    if (!decision.ok) return this.refuse(ctx, callId, a, decision.reason);
    const agent = a.agent!;
    const from = a.callerId!;
    const to = a.destination!;

    // The plan's line and the wallet after the other live calls (ADR 0011 §1), sized at the
    // live tier's rate and the agent's own ceiling — what a caller on the phone gets.
    const [{ rate, configVersion }, live, caps] = await Promise.all([
      this.config.rateFor(agent.tier),
      liveCalls(this.redis, ctx.workspaceId, this.log),
      this.config.capsFor(ctx.workspaceId).catch(() => null),
    ]);
    const room = headroom({ balance: a.facts.balance, live, cap: caps?.concurrency_cap, rate, maxDurationS: agent.maxCallDurationS });
    if (!room.ok && room.reason === 'cap') return this.refuse(ctx, callId, a, 'CONCURRENCY_LIMIT');
    if (!room.ok) return this.refuse(ctx, callId, a, 'NO_CREDITS');

    // The line first, so a lost race for it is a refusal with nothing written but the audit row.
    const slot = await MintSlot.take(this.redis, this.log, { workspaceId: ctx.workspaceId, maxMs: room.maxMs, rate, cap: room.cap, balance: a.facts.balance });
    if (slot.result === 'cap') return this.refuse(ctx, callId, a, 'CONCURRENCY_LIMIT');
    if (slot.result === 'balance') return this.refuse(ctx, callId, a, 'NO_CREDITS');

    // The attempt counts toward today's cap from here, under a per-workspace lock: two
    // presses at once cannot both take the last call of the day.
    const attempt = await this.claimAttempt(ctx, callId, body.idempotency_key, a).catch(async (error: unknown) => {
      await slot.release();
      throw error;
    });
    if (attempt === 'cap' || attempt === 'in_progress' || attempt === 'ringing') await slot.release();
    if (attempt === 'cap') return this.refuse(ctx, callId, a, 'OUTBOUND_DAILY_CAP');
    // Another press — a second tab, another of their calls — reached this person first.
    if (attempt === 'ringing') return this.refuse(ctx, callId, a, 'OUTBOUND_IN_PROGRESS');
    if (attempt === 'in_progress') throw new AppError('OUTBOUND_IN_PROGRESS', 'This call is already being placed.');

    const placed = await this.retell
      .createPhoneCall({
        fromNumber: from.e164,
        toNumber: to.e164,
        agentId: agent.retellAgentId,
        agentVersion: agent.retellAgentVersion,
        metadata: {
          tenant_id: ctx.workspaceId,
          agent_id: agent.id,
          version_no: agent.publishedVersion,
          tier: agent.tier,
          test: false,
          number_id: from.id,
          outbound_id: attempt.id,
        },
        maxCallDurationMs: room.maxMs,
        voicemail: voicemailAction(a.settings),
        // The caller ID's transfer targets and fail message, as an inbound call to it carries.
        dynamicVariables: numberTransferVariables(a.callerLine!, agent.briefJson),
      })
      .catch(async (error: unknown) => {
        // `call_started` reserves the call if it did ring; the placeholder is ours to free.
        await slot.release();
        // A 4xx is the platform refusing: nothing rang, and the key may try again. Anything
        // else — a timeout, a reset, a 5xx — may have rung the person: the attempt stays
        // `pending` so the same key cannot ring them twice (see UNCONFIRMED_ATTEMPT_MS).
        const status = retellErrorStatus(error);
        const rejected = status !== undefined && status >= 400 && status < 500 && status !== 408;
        await this.settleAttempt(ctx, attempt.id, rejected ? { status: 'failed', failure: 'upstream' } : { status: 'pending', failure: 'unconfirmed' });
        // The provider's words stay in our log; the customer and the audit row get ours.
        this.log.warn(`outbound ${attempt.id} (workspace ${ctx.workspaceId}): ${rejected ? 'refused' : 'no answer'} upstream (${status ?? 'no status'}): ${String(error)}`);
        const failure = asPlacementError(status);
        await this.audit(ctx, 'call.outbound_failed', callId, {
          reason: failure.code,
          outcome: rejected ? 'rejected' : 'unconfirmed',
          upstream_status: status ?? null,
          outbound_id: attempt.id,
          ...this.target(a),
        });
        throw failure;
      });
    await slot.bind(placed.call_id);

    await this.settleAttempt(ctx, attempt.id, { status: 'placed', callId: placed.call_id });
    await this.calls
      .recordOutboundPlaced({
        callId: placed.call_id,
        workspaceId: ctx.workspaceId,
        agentId: agent.id,
        agentVersion: agent.publishedVersion,
        numberId: from.id,
        fromNumber: from.e164,
        toNumber: to.e164,
        tier: agent.tier,
        rate,
        configVersion,
      })
      // The call is ringing either way; `call_started` creates the row from the metadata.
      .catch((error: unknown) => this.log.warn(`outbound ${attempt.id}: calls row not written ahead of call_started: ${String(error)}`));
    await this.audit(ctx, 'call.outbound_placed', callId, {
      outbound_id: attempt.id,
      call_id: placed.call_id,
      voicemail_detection: a.settings.voicemail_detection,
      ...this.target(a),
    });

    return {
      call_id: placed.call_id,
      from_number: from.e164,
      to_number: to.e164,
      agent_id: agent.id,
      voicemail_detection: a.settings.voicemail_detection,
      rate,
      balance: Math.round(a.facts.balance * 100) / 100,
      max_call_duration_s: Math.floor(room.maxMs / 1_000),
      daily_cap: a.facts.dailyCap,
      used_today: a.facts.usedToday + 1,
    };
  }

  /** The instant every gate is judged at: the calling window, the local day, the prior-contact window. A seam for tests. */
  protected now(): Date {
    return new Date();
  }

  // ------------------------------------------------------------------ the facts

  /**
   * Reads every fact the gates need. Customer data in one `withWorkspace` transaction (RLS:
   * a call of another workspace is a 404 here, before anything else is read); the two
   * lookups that must cross workspaces — "is the destination one of the platform's numbers"
   * and the platform-wide `blocklists` — on `adminDb` after it, by the destination alone.
   * With the flag off the verdict is already known, and nothing past the call is read.
   */
  private async assess(ctx: WorkspaceContext, callId: string, numberId?: string): Promise<Assessment> {
    const [{ policy }, flags] = await Promise.all([this.config.outboundPolicy(), this.config.flagsFor(ctx.workspaceId)]);
    const enabled = flags.flags.outbound_calls === true;
    const now = this.now();

    const read = await withWorkspace(ctx, async (db) => {
      const source = await db.call.findFirst({
        where: { id: callId, tenantId: ctx.workspaceId },
        select: { id: true, agentId: true, numberId: true, direction: true, channel: true, fromNumber: true, toNumber: true },
      });
      if (!source) throw AppError.notFound('Call');
      if (!enabled) return null;
      const [tenant, numbers, paid] = await Promise.all([
        db.tenant.findUniqueOrThrow({
          where: { id: ctx.workspaceId },
          select: { pausedAt: true, kycStatus: true, timezone: true, planTier: true, outboundSettingsJson: true },
        }),
        callerIdCandidates(db, ctx.workspaceId, { transferTargetsJson: true, transferFailMessage: true }),
        db.purchase.count({ where: { tenantId: ctx.workspaceId, status: 'paid' } }),
      ]);
      const localDay = localClock(now, tenant.timezone)?.date ?? null;
      const agent = await liveAgent(db, ctx.workspaceId, source.agentId ?? numbers.find((n) => n.id === source.numberId)?.agentId ?? null);
      // The other party: the caller of an inbound call, the callee of an outbound one. A
      // browser call has no number at all.
      const destination = readDestination(source.channel === 'phone' ? (source.direction === 'inbound' ? source.fromNumber : source.toNumber) : null);
      const [ownDnc, priorContact, usedToday, ringing] = await Promise.all([
        destination.ok ? db.dncEntry.findUnique({ where: { tenantId_e164: { tenantId: ctx.workspaceId, e164: destination.e164 } }, select: { id: true } }) : null,
        destination.ok ? calledWithin(db, ctx.workspaceId, destination.e164, policy.prior_contact_days, now) : false,
        localDay ? usedOn(db, ctx.workspaceId, localDay) : 0,
        destination.ok ? liveAttemptTo(db, ctx.workspaceId, destination.e164) : null,
      ]);
      return { source, tenant, numbers, paid, localDay, agent, destination, ownDnc: ownDnc !== null, priorContact, usedToday, inProgress: ringing !== null };
    });

    if (!read) return disabledAssessment(policy);
    const { source, tenant, numbers, localDay, agent, destination } = read;
    const settings = outboundSettings.safeParse(tenant.outboundSettingsJson ?? DEFAULT_OUTBOUND_SETTINGS);
    const caller = pickCallerId(numbers, { requested: numberId, sourceNumberId: source.numberId, agentId: agent?.id ?? null });
    const rule = destination.ok ? policy.countries[destination.country] : undefined;
    const window = rule ? callingWindowVerdict(rule, now) : null;

    const [isAgent, platformDnc, balance] = await Promise.all([
      destination.ok ? this.isPlatformNumber(destination.e164) : false,
      destination.ok && !read.ownDnc ? this.platformDncListed(destination.e164, now) : false,
      this.wallet.balance(ctx.workspaceId),
    ]);

    const facts: OutboundFacts = {
      enabled,
      workspacePaused: tenant.pausedAt !== null,
      kyc: tenant.kycStatus as KycStatus,
      // A time zone `Intl` does not know (a legacy or mistyped `tenants.timezone`) is its own
      // refusal, fixed in Settings → Workspace — not "outbound settings need attention" (QA-087).
      timezoneValid: localDay !== null,
      configured: settings.success,
      callerId: caller.kind,
      agentLive: agent !== null,
      destinationValid: destination.ok,
      countryRuled: rule !== undefined,
      destinationIsAgent: isAgent,
      dncListed: read.ownDnc || platformDnc,
      priorContact: read.priorContact,
      windowOpen: window?.open ?? false,
      paid: read.paid > 0,
      balance,
      usedToday: read.usedToday,
      dailyCap: policy.daily_caps[tenant.planTier],
      inProgress: read.inProgress,
    };
    const line = caller.kind === 'ok' ? numbers.find((n) => n.id === caller.number.id) : undefined;
    return {
      facts,
      policy,
      settings: settings.success ? settings.data : DEFAULT_OUTBOUND_SETTINGS,
      callerId: caller.kind === 'ok' ? caller.number : null,
      callerLine: line ? { transferTargetsJson: line.transferTargetsJson, transferFailMessage: line.transferFailMessage } : null,
      agent,
      destination: destination.ok ? { e164: destination.e164, country: destination.country } : null,
      nextAllowedAt: window?.nextAt ?? null,
      localDay,
    };
  }

  /** Any number on the platform, or a line forwarded to one, answers with an agent (D17's rule, across workspaces). */
  private async isPlatformNumber(e164: string): Promise<boolean> {
    const hit = await adminDb.phoneNumber.findFirst({
      where: { OR: [{ e164 }, { forwardingFrom: e164 }], status: { not: 'released' } },
      select: { id: true },
    });
    return hit !== null;
  }

  /**
   * The platform's list (`blocklists`, type `phone`, not expired), matched the way the
   * inbound path matches it: every stored value through `normalisePhone`, since staff may
   * have typed `14165550123` or `+1 416-555-0123`. The runtime cache reads the same rows on
   * every refresh, so the whole list is small enough to read here.
   */
  private async platformDncListed(e164: string, now: Date): Promise<boolean> {
    const rows = await adminDb.blocklist.findMany({
      where: { type: 'phone', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { value: true },
    });
    return rows.some((r) => normalisePhone(r.value) === e164);
  }

  // ------------------------------------------------------------------ the attempt row

  /**
   * Records the attempt against today's cap, atomically: a transaction-scoped advisory lock
   * per workspace, then the key and the count re-read under it. Attempts left `pending`
   * past `UNCONFIRMED_ATTEMPT_MS` are written off first, so a dead one neither holds the cap
   * nor its key for good. A key seen before is the same press — `in_progress` while it is
   * being placed; a failed one is claimed again. A *different* key while an attempt to the
   * same person is still live (`liveAttemptTo`) is `ringing`: two tabs, or two of their
   * calls, must not ring them twice at once — the gate in `decideOutbound` is the read,
   * this is the write, and only this one is under the lock. No network I/O in here
   * (CLAUDE.md, tenancy): the platform is asked after the commit.
   */
  private async claimAttempt(ctx: WorkspaceContext, callId: string, key: string, a: Assessment): Promise<{ id: string } | 'cap' | 'in_progress' | 'ringing'> {
    const day = new Date(`${a.localDay!}T00:00:00Z`);
    return withWorkspace(ctx, async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'outbound:' + ctx.workspaceId}))`;
      await db.outboundCall.updateMany({
        where: { tenantId: ctx.workspaceId, status: 'pending', callId: null, updatedAt: { lt: unconfirmedBefore() } },
        data: { status: 'failed', failure: 'unconfirmed' },
      });
      const existing = await db.outboundCall.findUnique({ where: { tenantId_idempotencyKey: { tenantId: ctx.workspaceId, idempotencyKey: key } }, select: { id: true, status: true } });
      if (existing && existing.status !== 'failed') return 'in_progress' as const;
      if (await liveAttemptTo(db, ctx.workspaceId, a.destination!.e164, existing?.id)) return 'ringing' as const;
      const used = await usedOn(db, ctx.workspaceId, a.localDay!);
      if (used >= a.facts.dailyCap) return 'cap' as const;
      const data = {
        requestedBy: ctx.userId,
        sourceCallId: callId,
        agentId: a.agent!.id,
        numberId: a.callerId!.id,
        toNumber: a.destination!.e164,
        fromNumber: a.callerId!.e164,
        localDay: day,
        status: 'pending' as const,
        voicemail: a.settings.voicemail_detection,
        failure: null,
        callId: null,
      };
      if (existing) {
        await db.outboundCall.update({ where: { id: existing.id }, data });
        return { id: existing.id };
      }
      const row = await db.outboundCall.create({ data: { tenantId: ctx.workspaceId, idempotencyKey: key, ...data }, select: { id: true } });
      return row;
    });
  }

  private async settleAttempt(
    ctx: WorkspaceContext,
    id: string,
    data: { status: 'placed'; callId: string } | { status: 'failed'; failure: string } | { status: 'pending'; failure: 'unconfirmed' },
  ): Promise<void> {
    // Never over a call a lifecycle webhook already bound the attempt to.
    await withWorkspace(ctx, (db) => db.outboundCall.updateMany({ where: { id, ...(data.status === 'placed' ? {} : { callId: null }) }, data })).catch((error: unknown) =>
      // A `pending` row left behind counts toward the cap until it is bound or written off.
      this.log.warn(`outbound ${id}: attempt not marked ${data.status}: ${String(error)}`),
    );
  }

  /**
   * The answer for a key already used. Placed: the same call again, nothing new rung. Being
   * placed: 409 — until `UNCONFIRMED_ATTEMPT_MS`, after which it is treated as failed and
   * the claim writes it off. Failed: nothing to replay, the press may try again. A key used
   * for another call is a client bug, and a 409.
   */
  private async replay(ctx: WorkspaceContext, callId: string, key: string): Promise<CallbackResponse | null> {
    const found = await withWorkspace(ctx, async (db) => {
      const row = await db.outboundCall.findUnique({ where: { tenantId_idempotencyKey: { tenantId: ctx.workspaceId, idempotencyKey: key } } });
      if (!row || row.status !== 'placed' || !row.callId) return { row, placed: null };
      const [placed, tenant, used] = await Promise.all([
        db.call.findFirst({ where: { id: row.callId, tenantId: ctx.workspaceId }, select: { rate: true } }),
        db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { planTier: true } }),
        usedOn(db, ctx.workspaceId, row.localDay.toISOString().slice(0, 10)),
      ]);
      return { row, placed: { rate: placed?.rate.toNumber() ?? 0, planTier: tenant.planTier, used } };
    });
    const { row } = found;
    if (!row) return null;
    if (row.sourceCallId !== callId) throw new AppError('CONFLICT', 'That request key was used for another call.');
    if (row.status === 'failed') return null;
    if (row.status === 'pending' && row.callId === null && row.updatedAt < unconfirmedBefore()) return null;
    if (!found.placed || !row.callId) throw new AppError('OUTBOUND_IN_PROGRESS', 'This call is already being placed.');
    const [balance, { policy }] = await Promise.all([this.wallet.balance(ctx.workspaceId), this.config.outboundPolicy()]);
    return {
      call_id: row.callId,
      from_number: row.fromNumber,
      to_number: row.toNumber,
      agent_id: row.agentId!,
      voicemail_detection: row.voicemail as VoicemailDetection,
      rate: found.placed.rate,
      balance: Math.round(balance * 100) / 100,
      max_call_duration_s: 0,
      daily_cap: policy.daily_caps[found.placed.planTier],
      used_today: found.placed.used,
    };
  }

  // ------------------------------------------------------------------ refusals and the audit trail

  private async refuse(ctx: WorkspaceContext, callId: string, a: Assessment, reason: OutboundRefusal | 'CONCURRENCY_LIMIT'): Promise<never> {
    await this.audit(ctx, 'call.outbound_blocked', callId, { reason, ...this.target(a) });
    if (reason === 'CONCURRENCY_LIMIT') {
      throw new AppError('CONCURRENCY_LIMIT', 'Every line your plan allows is on a call right now. Try again when one finishes.');
    }
    const fields = reason === 'CALLER_ID_UNVERIFIED' ? [{ field: 'number_id', message: REFUSAL_MESSAGES[reason] }] : undefined;
    const message =
      reason === 'OUTSIDE_CALLING_WINDOW' && a.nextAllowedAt
        ? `${REFUSAL_MESSAGES[reason]} The next time it may be called is ${a.nextAllowedAt.toISOString()}.`
        : reason === 'NO_PRIOR_CONTACT'
          ? `You can call back people who called you in the last ${a.policy.prior_contact_days} days. This number has not.`
          : REFUSAL_MESSAGES[reason];
    throw new AppError(reason, message, fields);
  }

  /** Who and where, for an audit row: never the full number, never a provider id. */
  private target(a: Assessment): Record<string, unknown> {
    return {
      to: maskNumber(a.destination?.e164),
      to_country: a.destination?.country ?? null,
      number_id: a.callerId?.id ?? null,
      agent_id: a.agent?.id ?? null,
    };
  }

  private async audit(ctx: WorkspaceContext, action: string, callId: string, meta: Record<string, unknown>): Promise<void> {
    await withWorkspace(ctx, (db) =>
      db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action,
          targetType: 'call',
          targetId: callId,
          ip: ctx.ip ?? null,
          metaJson: { ...meta, request_id: ctx.requestId ?? null } as Prisma.InputJsonValue,
        },
      }),
    ).catch((error: unknown) => this.auditLost(ctx, action, callId, meta, error));
  }

  /**
   * An audit row that could not be written is an ops alert, not only a log line (QA-088):
   * `call.outbound_blocked` is the only record a refusal leaves, and a compliance review
   * reads it. The answer to the customer is unchanged — the refusal (or the placement)
   * stands whatever happened to its record. Ids only in the alert: the number is already
   * masked in `meta`, and the error's text is cut short in case it quotes a value.
   */
  private auditLost(ctx: WorkspaceContext, action: string, callId: string, meta: Record<string, unknown>, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.log.warn(`${action} ${callId}: audit row not written: ${detail}`);
    try {
      void this.ops
        .send({
          kind: 'outbound_audit_failed',
          severity: 'warning',
          title: 'An outbound-call audit row was not written',
          fields: {
            action,
            workspace_id: ctx.workspaceId,
            call_id: callId,
            outbound_id: typeof meta.outbound_id === 'string' ? meta.outbound_id : null,
            reason: typeof meta.reason === 'string' ? meta.reason : null,
            request_id: ctx.requestId ?? null,
            error: detail.slice(0, 200),
          },
        })
        .catch((alertError: unknown) => this.log.warn(`${action} ${callId}: ops alert not sent: ${String(alertError)}`));
    } catch (alertError) {
      this.log.warn(`${action} ${callId}: ops alert not sent: ${String(alertError)}`);
    }
  }
}

/**
 * What `POST /calls/:id/callback` answers when the platform did not place the call. A 4xx
 * is the platform refusing what we sent — it will refuse it again on every retry — so it is
 * permanent, `BAD_REQUEST`, as `asPublishError` keeps a publish 4xx (QA-084); 408, 409 and
 * 429 are not refusals of the request itself. Everything else (a timeout, a reset, a 5xx)
 * is the 503 the portal shows a "try again" for. Neither carries the platform's words.
 */
export function asPlacementError(status: number | undefined): AppError {
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) {
    return new AppError('BAD_REQUEST', 'The call could not be placed: the number or the caller ID was not accepted. Nothing was placed. Check them, or contact support.');
  }
  return new AppError('UPSTREAM_UNAVAILABLE', 'We could not place the call just now. Try again in a moment.');
}

/** The agent on the call, if it is live, published and has its platform copy. */
async function liveAgent(db: WorkspaceDb, workspaceId: string, agentId: string | null): Promise<LiveAgent | null> {
  if (!agentId) return null;
  const agent = await db.agent.findFirst({
    where: { id: agentId, tenantId: workspaceId, deletedAt: null },
    select: { id: true, status: true, tier: true, maxCallDurationS: true, retellAgentId: true, publishedVersion: true },
  });
  if (!agent || agent.status !== 'live' || agent.publishedVersion === null || !agent.retellAgentId) return null;
  const version = await db.agentVersion.findUnique({
    where: { agentId_versionNo: { agentId: agent.id, versionNo: agent.publishedVersion } },
    select: { retellAgentVersion: true, briefJson: true },
  });
  if (version?.retellAgentVersion == null) return null;
  return {
    id: agent.id,
    tier: agent.tier,
    maxCallDurationS: agent.maxCallDurationS,
    retellAgentId: agent.retellAgentId,
    publishedVersion: agent.publishedVersion,
    retellAgentVersion: version.retellAgentVersion,
    briefJson: version.briefJson,
  };
}

/**
 * Whether `e164` called this workspace within `days` — any real inbound phone call,
 * answered or missed: a missed call is the commonest reason to call back, and the
 * attempt is the inquiry. Test calls do not count; nor does a call we placed.
 */
async function calledWithin(db: WorkspaceDb, workspaceId: string, e164: string, days: number, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const hit = await db.call.findFirst({
    where: { tenantId: workspaceId, direction: 'inbound', channel: 'phone', isTest: false, fromNumber: e164, createdAt: { gte: since } },
    select: { id: true },
  });
  return hit !== null;
}

/**
 * An attempt of this workspace to this number that may still be ringing or talking, so the
 * person is not rung twice at once (two tabs, a double press with a fresh key, another of
 * their calls in D2): `pending` with no call inside the unconfirmed window — being placed,
 * or unanswered and not yet written off — or `placed` whose `calls` row is still
 * `registered` / `in_progress`. A placed attempt whose row has not appeared yet counts only
 * inside that same window: `call_started` creates the row, and one that never comes was a
 * call that never was. `except` is the row a retried key is claiming again.
 */
async function liveAttemptTo(db: WorkspaceDb, workspaceId: string, e164: string, except?: string): Promise<{ id: string } | null> {
  const attempts = await db.outboundCall.findMany({
    where: { tenantId: workspaceId, toNumber: e164, status: { in: ['pending', 'placed'] }, ...(except ? { id: { not: except } } : {}) },
    select: { id: true, status: true, callId: true, updatedAt: true },
  });
  if (attempts.length === 0) return null;
  const cutoff = unconfirmedBefore();
  const pending = attempts.find((x) => x.status === 'pending' && x.callId === null && x.updatedAt >= cutoff);
  if (pending) return { id: pending.id };
  const placed = attempts.filter((x) => x.status === 'placed' && x.callId !== null);
  if (placed.length === 0) return null;
  const calls = await db.call.findMany({ where: { tenantId: workspaceId, id: { in: placed.map((x) => x.callId!) } }, select: { id: true, status: true } });
  const statusOf = new Map(calls.map((c) => [c.id, c.status]));
  const live = placed.find((x) => {
    const status = statusOf.get(x.callId!);
    return status === undefined ? x.updatedAt >= cutoff : status === 'registered' || status === 'in_progress';
  });
  return live ? { id: live.id } : null;
}

/** The flag is off: that is the verdict, and nothing else was read. */
function disabledAssessment(policy: OutboundPolicy): Assessment {
  return {
    facts: {
      enabled: false,
      workspacePaused: false,
      kyc: 'none',
      timezoneValid: false,
      configured: false,
      callerId: 'none',
      agentLive: false,
      destinationValid: false,
      countryRuled: false,
      destinationIsAgent: false,
      dncListed: false,
      priorContact: false,
      windowOpen: false,
      paid: false,
      balance: 0,
      usedToday: 0,
      dailyCap: 0,
      inProgress: false,
    },
    policy,
    settings: DEFAULT_OUTBOUND_SETTINGS,
    callerId: null,
    callerLine: null,
    agent: null,
    destination: null,
    nextAllowedAt: null,
    localDay: null,
  };
}

/** The workspace's setting as the gateway's per-call option. */
export function voicemailAction(settings: OutboundSettings): VoicemailAction | null {
  if (settings.voicemail_detection === 'off') return null;
  if (settings.voicemail_detection === 'leave_message' && settings.voicemail_message) return { action: 'leave_message', text: settings.voicemail_message };
  return { action: 'hang_up' };
}
