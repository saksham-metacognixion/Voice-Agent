import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { DeclineReason, WorkspaceCaps } from '@portal/schemas';
import { OpsAlertService } from '../alerts';
import type { CurrentPricing } from '../config';
import { JobQueues, type InboundDecisionJob } from '../jobs';
import { REDIS, type RedisLike, redisKeys } from '../redis';
import { type InboundResponse, RetellGateway, type RetellInboundEvent } from '../retell';
import { isNumberRecord, type NumberRecord } from '../runtime-cache';
import { forwardingTestMatch, parseForwardingTestMarker } from './forwarding-test';
import { ACTIVE_SLACK_MS, type Decision, RETELL_MAX_CALL_MS, decide, encodeActive, parseActiveHash } from './inbound.decide';
import { RESERVE_SCRIPT, type ReserveResult, isReserveResult } from './reserve.script';

/** The whole Redis side of one authorisation shares this budget (ADR 0003 §12). */
export const INBOUND_REDIS_BUDGET_MS = 150;

/**
 * Decision warnings that mean this workspace's Redis projection is missing something the
 * answer needed. Each one triggers a write-behind `warm-workspace` job, so the next call
 * on this workspace decides on complete data.
 */
const STALE_PROJECTION_WARNINGS = ['balance_unknown', 'caps_unknown', 'rate_unknown'] as const;

/** What to answer when Redis cannot be consulted. `open` = 200 `{}` (bound agent answers); `closed` = busy tone. */
export type RedisDownPolicy = 'open' | 'closed';

export function redisDownPolicy(env: NodeJS.ProcessEnv = process.env): RedisDownPolicy {
  return env.INBOUND_REDIS_DOWN_POLICY?.trim().toLowerCase() === 'closed' ? 'closed' : 'open';
}

export type InboundVerdict =
  | { kind: 'allow' | 'decline' | 'open' }
  /** Redis timed out or errored inside the budget. */
  | { kind: 'redis_down' };

export interface InboundOutcome {
  body: InboundResponse | Record<string, never>;
  decision: Decision | { kind: 'redis_down'; reason: string } | { kind: 'forwarding_test'; testId: string; callerId: 'ours' | 'original' };
  /** What Retell will do with `body`. */
  answered: 'allow' | 'decline' | 'fail_open';
  latencyMs: number;
  warnings: string[];
}

/** Counters for the health page and the k6 run; a metrics exporter lands with observability. */
export interface InboundMetrics {
  requests: number;
  allowed: number;
  declined: Record<DeclineReason, number>;
  failOpen: number;
  redisDown: number;
  overBudget: number;
  /** D17: forwarding tests recognised and turned away. */
  forwardingTests: number;
}

class Deadline {
  private readonly at: number;
  constructor(budgetMs: number) {
    this.at = Date.now() + budgetMs;
  }
  remaining(): number {
    return this.at - Date.now();
  }
  /** Rejects with `RedisBudgetExceeded` when `run` outlives what is left of the budget. */
  async bound<T>(run: () => Promise<T>): Promise<T> {
    const left = this.remaining();
    if (left <= 0) throw new RedisBudgetExceeded();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RedisBudgetExceeded()), left);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class RedisBudgetExceeded extends Error {
  constructor() {
    super(`redis did not answer within the ${INBOUND_REDIS_BUDGET_MS} ms inbound budget`);
  }
}

/**
 * POST /webhooks/retell/inbound/:number_token — the §13.9 hot path, p95 < 300 ms.
 *
 * Redis only. Two round trips: the global keys plus the number, then the workspace keys
 * the number names. The decision itself is `decide()` (pure). Postgres is touched by
 * nobody here; both outcomes become a `calls` row through the `calls` queue, and every
 * cache gap the decision reports is repaired by a queued warm-up rather than inline.
 *
 * Redis down (timeout or error anywhere inside the budget) answers at once with the
 * policy from ADR 0003 §12: `200 {}` so the number's `latest_published` agent takes the
 * call bounded by its own max duration — or `reject` under INBOUND_REDIS_DOWN_POLICY=closed.
 * Never a 4xx/5xx: Retell would retry three times and then answer anyway (ADR 0003 §1).
 */
@Injectable()
export class InboundAuthorizationService {
  private readonly log = new Logger(InboundAuthorizationService.name);
  readonly policy: RedisDownPolicy = redisDownPolicy();
  readonly metrics: InboundMetrics = {
    requests: 0,
    allowed: 0,
    declined: { balance: 0, cap: 0, blocked: 0, hours: 0, paused: 0 },
    failOpen: 0,
    redisDown: 0,
    overBudget: 0,
    forwardingTests: 0,
  };
  private lastFailOpenLog = 0;
  private lastRedisDownAlert = 0;

  constructor(
    @Inject(REDIS) private readonly redis: RedisLike,
    private readonly queues: JobQueues,
    @Optional() private readonly alerts?: OpsAlertService,
  ) {}

  async authorize(token: string, event: RetellInboundEvent, now = new Date()): Promise<InboundOutcome> {
    const startedAt = process.hrtime.bigint();
    this.metrics.requests += 1;
    const inbound = event.call_inbound;
    const callId = inbound.call_id ?? null;
    const to = inbound.to_number ?? null;
    const from = inbound.from_number ?? null;
    const eventTimestamp = typeof event.event_timestamp === 'number' ? event.event_timestamp : now.getTime();

    const deadline = new Deadline(INBOUND_REDIS_BUDGET_MS);
    let decision: Decision;
    let staleActive: string[] = [];
    let activeExpiryFloor = 0;
    try {
      let number: NumberRecord | null = null;
      let pricing: CurrentPricing | null = null;
      let rejectInbound = false;
      if (to) {
        // The kill switch comes from its own long-lived key, not from `flags:global`:
        // that key carries the 60 s config TTL against a five-minute refresh, so it is
        // absent for most of every cycle and the veto would quietly never fire
        // (redisKeys.rejectInbound). Missing still reads as off — a cache gap must not
        // start rejecting calls.
        // D17: a "Test forwarding" ringing for this number rides the same round trip.
        const [numRaw, pricingRaw, rejectRaw, testRaw] = await deadline.bound(() =>
          this.redis.mget(redisKeys.number(to), redisKeys.pricingCurrent, redisKeys.rejectInbound, redisKeys.forwardingTest(to)),
        );
        number = parseNumber(numRaw);
        pricing = parsePricing(pricingRaw);
        rejectInbound = rejectRaw === '1';

        // The test coming back through the carrier's forwarding. Turned away before every
        // other check — a busy tone, no call object, nothing billed, no `calls` row — so it
        // never becomes the agent talking to itself, and the outbound leg ends unconnected.
        const marker = number && number.inbound_token === token ? parseForwardingTestMarker(testRaw) : null;
        const callerId = number && marker ? forwardingTestMatch(marker, { numberId: number.number_id, from, to }) : null;
        if (marker && callerId) {
          this.metrics.forwardingTests += 1;
          void this.queues.enqueueForwardingTestLanded({ testId: marker.test_id, numberId: marker.number_id, workspaceId: marker.workspace_id, callerId });
          return {
            body: RetellGateway.inboundDecline(),
            decision: { kind: 'forwarding_test', testId: marker.test_id, callerId },
            answered: 'decline',
            latencyMs: elapsedMs(startedAt),
            warnings: [],
          };
        }
      }

      let caps: WorkspaceCaps | null = null;
      let balance: number | null = null;
      let active: ReturnType<typeof parseActiveHash>['live'] = [];
      if (number && number.inbound_token === token) {
        const ws = number.workspace_id;
        const [[capsRaw, balRaw], activeHash] = await deadline.bound(() =>
          Promise.all([this.redis.mget(redisKeys.caps(ws), redisKeys.balance(ws)), this.redis.hgetall(redisKeys.activeCalls(ws))]),
        );
        caps = parseJson<WorkspaceCaps>(capsRaw);
        const bal = balRaw === null || balRaw === undefined ? NaN : Number(balRaw);
        balance = Number.isFinite(bal) ? bal : null;
        const parsed = parseActiveHash(activeHash, now.getTime());
        active = parsed.live;
        staleActive = parsed.stale;
        activeExpiryFloor = Math.max(0, ...active.map((a) => a.expiresAt));
      }

      decision = decide({ token, callId, from, to, now, number, caps, balance, active, pricing, rejectInbound });
    } catch (error) {
      return this.redisDown(error, startedAt);
    }

    const warnings: string[] = decision.kind === 'open' ? [decision.reason] : [...decision.warnings];

    // Take the slot before answering, atomically: the next call for this workspace may
    // arrive before Retell has even connected this one, and the two must not both be let
    // through on the same free slot or the same credits (ADR 0011 §1). The script
    // re-checks the cap and the balance ceiling as it writes, so a lost race comes back as
    // the decline it would have been a millisecond later.
    if (decision.kind === 'allow' && callId) {
      const reserved = await this.reserve(decision, callId, now, activeExpiryFloor, deadline);
      if (reserved === 'cap' || reserved === 'balance') {
        this.log.warn(`inbound ${callId}: lost the race for a slot, declining on ${reserved}`);
        decision = { kind: 'decline', reason: reserved, workspaceId: decision.workspaceId, numberId: decision.numberId, agentId: decision.agentId, tier: decision.tier, warnings: decision.warnings };
        warnings.push('reservation_raced');
      } else if (reserved === 'skipped') {
        // The call is still allowed — `call_started` reserves again, and the cap is
        // repaired then — but say so: this is the one write the path depends on.
        warnings.push('reservation_not_written');
      }
    }

    let body: InboundOutcome['body'];
    let answered: InboundOutcome['answered'];

    if (decision.kind === 'allow') {
      answered = 'allow';
      body = RetellGateway.inboundAllow({
        agentId: decision.retellAgentId,
        dynamicVariables: decision.dynamicVariables,
        metadata: { ...decision.metadata, call_id: callId ?? undefined },
        maxCallDurationMs: decision.maxCallDurationMs ?? undefined,
      });
      this.metrics.allowed += 1;
      // Anything the decision had to guess at means this workspace's projection is stale.
      // `rate_unknown` belongs here as much as the other two: without a rate the answer
      // reserves no credits and sizes the call from `plan_max_ms` alone, so concurrent
      // calls stop seeing each other's spend (ADR 0011 §1).
      if (STALE_PROJECTION_WARNINGS.some((w) => decision.warnings.includes(w))) {
        void this.queues.enqueueWarmWorkspace(decision.workspaceId);
      }
    } else if (decision.kind === 'decline') {
      answered = 'decline';
      body = RetellGateway.inboundDecline();
      this.metrics.declined[decision.reason] += 1;
    } else {
      // Unknown number. Nothing to authorise against and nothing to write a row for; the
      // policy decides between the bound agent answering and a busy tone (ADR 0011 §2).
      answered = 'fail_open';
      body = this.policy === 'closed' ? RetellGateway.inboundDecline() : {};
      this.metrics.failOpen += 1;
      this.logFailOpen(`inbound token=${token} to=${to ?? '?'}: ${decision.reason}; answering ${this.policy === 'closed' ? 'reject' : '{}'}`);
      if (to && decision.reason !== 'missing_to_number') void this.queues.enqueueRefreshNumber(to);
    }

    // Write-behind (architecture §9): the `calls` row, allowed or declined, never inline.
    //
    // An allow with no `call_id` is the one case that writes nothing. A decline has no
    // Retell call to be named after, so a synthetic `dec_<uuid>` is that row's real and
    // permanent id; an allowed call is about to arrive as `call_started` under Retell's own
    // id, and a synthetic row for it would be a phantom `registered` call that nothing ever
    // finishes, next to the real row `call_started` creates — the same path web calls take.
    if (decision.kind !== 'open' && (decision.kind === 'decline' || callId)) {
      const job: InboundDecisionJob = {
        callId: callId ?? JobQueues.syntheticCallId(),
        workspaceId: decision.workspaceId,
        numberId: decision.numberId,
        agentId: decision.agentId,
        tier: decision.tier,
        fromNumber: from,
        toNumber: to,
        eventTimestamp,
        decision: decision.kind,
        declineReason: decision.kind === 'decline' ? decision.reason : null,
        rate: decision.kind === 'allow' ? decision.rate : null,
        configVersion: decision.kind === 'allow' ? decision.configVersion : null,
        maxCallDurationMs: decision.kind === 'allow' ? decision.maxCallDurationMs : null,
        reservedCredits: decision.kind === 'allow' ? decision.reservedCredits : 0,
      };
      // Not awaited: the answer to Retell does not wait on the queue. JobQueues bounds and logs.
      void this.queues.enqueueInboundDecision(job);
    }
    if (decision.kind !== 'open' && staleActive.length) {
      void this.redis.hdel(redisKeys.activeCalls(decision.workspaceId), ...staleActive).catch(() => undefined);
    }

    const latencyMs = elapsedMs(startedAt);
    if (latencyMs > 300) this.metrics.overBudget += 1;
    if (warnings.length) this.log.warn(`inbound ${callId ?? '?'} ${answered}: ${warnings.join(', ')}`);
    return { body, decision, answered, latencyMs, warnings };
  }

  /**
   * Writes this call's reservation into `active:{ws}`, re-checking the cap and the balance
   * ceiling inside the same atomic script. Returns `skipped` when the write could not be
   * made at all (no Lua, or Redis gave up inside the budget) — the call is still allowed in
   * that case, because refusing a call over a cache write would be the wrong trade on a
   * path whose whole job is that the phone gets answered.
   */
  private async reserve(
    decision: Extract<Decision, { kind: 'allow' }>,
    callId: string,
    now: Date,
    activeExpiryFloor: number,
    deadline: Deadline,
  ): Promise<ReserveResult> {
    const key = redisKeys.activeCalls(decision.workspaceId);
    const expiresAt = now.getTime() + (decision.maxCallDurationMs ?? RETELL_MAX_CALL_MS) + ACTIVE_SLACK_MS;
    const ttlSeconds = Math.ceil((Math.max(expiresAt, activeExpiryFloor) - now.getTime()) / 1000) + 60;
    const credits = encodeActive(decision.reservedCredits, expiresAt).split('|')[0]!;
    // Empty means "the balance was not known", so the script skips that predicate — the
    // same thing `decide()` did with a `balance_unknown` warning.
    const ceiling = decision.balanceCeiling === null ? '' : String(decision.balanceCeiling);

    try {
      return await deadline.bound(async () => {
        if (typeof this.redis.eval !== 'function') {
          await this.redis.hset(key, callId, encodeActive(decision.reservedCredits, expiresAt));
          await this.redis.expire(key, ttlSeconds);
          return 'ok' as const;
        }
        const result = await this.redis.eval(
          RESERVE_SCRIPT,
          1,
          key,
          callId,
          credits,
          String(Math.round(expiresAt)),
          String(now.getTime()),
          String(decision.concurrencyCap ?? -1),
          ceiling,
          String(ttlSeconds),
        );
        return isReserveResult(result) ? result : 'ok';
      });
    } catch (error) {
      this.log.warn(`inbound ${callId}: reservation not written (${error instanceof Error ? error.message : String(error)})`);
      return 'skipped';
    }
  }

  private redisDown(error: unknown, startedAt: bigint): InboundOutcome {
    this.metrics.redisDown += 1;
    this.metrics.failOpen += 1;
    const reason = error instanceof Error ? error.message : String(error);
    this.logFailOpen(`inbound: redis unavailable (${reason}); policy=${this.policy}`);
    this.alertRedisDown(reason);
    return {
      body: this.policy === 'closed' ? RetellGateway.inboundDecline() : {},
      decision: { kind: 'redis_down', reason },
      answered: 'fail_open',
      latencyMs: elapsedMs(startedAt),
      warnings: ['redis_down'],
    };
  }

  /** One line per outage, not one per call — the hot path can see hundreds a minute. */
  private logFailOpen(message: string): void {
    const now = Date.now();
    if (now - this.lastFailOpenLog > 60_000) {
      this.lastFailOpenLog = now;
      this.log.error(`${message} — ALERT: inbound fail-open (ADR 0003 §12)`);
    }
  }

  /**
   * One ops alert per outage minute, on its own clock so an unknown-number log line cannot
   * swallow it. Not awaited: `send()` never rejects and posts over HTTP, not Redis, so it
   * still reaches a human while Redis is the thing that is down.
   */
  private alertRedisDown(reason: string): void {
    const now = Date.now();
    if (now - this.lastRedisDownAlert <= 60_000) return;
    this.lastRedisDownAlert = now;
    void this.alerts?.send({
      kind: 'redis_down',
      severity: 'critical',
      title: this.policy === 'closed' ? 'Redis unavailable — inbound calls are being declined' : 'Redis unavailable — inbound calls are answered without checks',
      fields: { policy: this.policy, reason, env: process.env.APP_ENV },
    });
  }
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseNumber(raw: string | null | undefined): NumberRecord | null {
  const value = parseJson<unknown>(raw);
  return isNumberRecord(value) ? value : null;
}

/** Enough of `pricing:current` to read a rate and the grace; the full zod parse is not worth its milliseconds here. */
function parsePricing(raw: string | null | undefined): CurrentPricing | null {
  const value = parseJson<CurrentPricing>(raw);
  if (!value || typeof value !== 'object') return null;
  const rates = value.config?.rates;
  if (!rates || typeof rates.standard_per_min !== 'number' || typeof rates.premium_per_min !== 'number') return null;
  return value;
}
