import type { AgentTier, DeclineReason, WorkspaceCaps } from '@portal/schemas';
import { rateForTier } from '@portal/schemas';
import type { CurrentPricing } from '../config';
import { clampDuration } from '../retell';
import { isOpen, nextOpening, type NumberRecord, normalisePhone } from '../runtime-cache';
import { roundCredits } from '../wallet/fifo';

/*
 * The six §13.9 checks as a pure function of what Redis holds. No I/O, no clock reads,
 * no config lookups — every input is a parameter, so the ordering, the decline reasons,
 * the max-duration arithmetic and every "the cache was missing X" branch are unit-tested
 * exhaustively without Redis (inbound.decide.test.ts). The service around it only fetches
 * and answers.
 */

/** One live call in the `active:{ws}` hash: field call_id → "credits|expiresAtMs". */
export interface ActiveCall {
  callId: string;
  /** Credits reserved for this call at authorisation (ADR 0011). */
  credits: number;
  expiresAt: number;
}

/** How long past a call's maximum its reservation is kept (CLAUDE.md: max duration + 5 min). */
export const ACTIVE_SLACK_MS = 5 * 60_000;
/** Retell's own ceiling — the widest a reservation can ever need to live when the max is unknown. */
export const RETELL_MAX_CALL_MS = 7_200_000;

export function encodeActive(credits: number, expiresAtMs: number): string {
  return `${roundCredits(credits).toFixed(2)}|${Math.round(expiresAtMs)}`;
}

/** Live entries only; expired and unreadable fields are dropped (and reported so the caller can HDEL them). */
export function parseActiveHash(hash: Record<string, string>, nowMs: number): { live: ActiveCall[]; stale: string[] } {
  const live: ActiveCall[] = [];
  const stale: string[] = [];
  for (const [callId, raw] of Object.entries(hash)) {
    const [c, e] = raw.split('|');
    const credits = Number(c);
    const expiresAt = Number(e);
    if (!Number.isFinite(credits) || !Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      stale.push(callId);
      continue;
    }
    live.push({ callId, credits: Math.max(0, credits), expiresAt });
  }
  return { live, stale };
}

export interface DecisionInput {
  /** `:number_token` from the path. */
  token: string;
  callId: string | null;
  from: string | null;
  to: string | null;
  now: Date;
  /** `num:{to}` — null on a miss. */
  number: NumberRecord | null;
  /** `caps:{ws}` — null on a miss. */
  caps: WorkspaceCaps | null;
  /** `bal:{ws}` — null on a miss. */
  balance: number | null;
  /** Live entries of `active:{ws}` — including this call's own, when it is a retry. */
  active: ActiveCall[];
  /** `pricing:current` — null on a miss. */
  pricing: CurrentPricing | null;
  /** SA12 `reject_inbound` kill switch. */
  rejectInbound: boolean;
}

export type OpenReason = 'missing_to_number' | 'unknown_number' | 'token_mismatch';

/** Cache gaps the decision worked around. Each one is a warning in the log and a metric, never an error. */
export type DecisionWarning =
  | 'balance_unknown'
  | 'grace_unknown'
  | 'caps_unknown'
  | 'rate_unknown'
  | 'plan_max_unknown'
  | 'hours_no_schedule'
  | 'hours_invalid_timezone'
  | 'no_call_id';

interface Identified {
  workspaceId: string;
  numberId: string;
  agentId: string | null;
  tier: AgentTier;
}

export type Decision =
  | (Identified & {
      kind: 'allow';
      retellAgentId: string;
      /** Credits/min from the pricing snapshot, or null when it was not cached. */
      rate: number | null;
      configVersion: number | null;
      /** Already clamped to Retell's window; null when neither planMax nor a rate was known. */
      maxCallDurationMs: number | null;
      /** What this call adds to `active:{ws}`: its worst case at `rate`. */
      reservedCredits: number;
      /** balance − reservations of the other live calls, or null when the balance was unknown. */
      available: number | null;
      /**
       * What the other live calls' reservations must stay below: balance + grace. Null when
       * either was unknown. Re-checked inside the atomic reservation, which is how two
       * calls racing for the last of a wallet lose on the same rule (ADR 0011 §1).
       */
      balanceCeiling: number | null;
      /** The cap the same reservation re-checks. Null when `caps:{ws}` was missing. */
      concurrencyCap: number | null;
      dynamicVariables: Record<string, string>;
      metadata: Record<string, unknown>;
      warnings: DecisionWarning[];
    })
  | (Identified & { kind: 'decline'; reason: DeclineReason; warnings: DecisionWarning[] })
  /**
   * We could not identify the number, so there is nothing to authorise against. The
   * policy for this case (fail open, or reject under INBOUND_REDIS_DOWN_POLICY=closed)
   * belongs to the service (ADR 0011 §2).
   */
  | { kind: 'open'; reason: OpenReason };

export function decide(input: DecisionInput): Decision {
  const { number, now } = input;
  if (!input.to) return { kind: 'open', reason: 'missing_to_number' };
  if (!number) return { kind: 'open', reason: 'unknown_number' };
  if (number.inbound_token !== input.token) return { kind: 'open', reason: 'token_mismatch' };

  const id: Identified = { workspaceId: number.workspace_id, numberId: number.number_id, agentId: number.agent_id, tier: number.tier };
  const warnings: DecisionWarning[] = [];
  const decline = (reason: DeclineReason): Decision => ({ kind: 'decline', reason, ...id, warnings });

  // 0. The operator's veto (admin SA12). Before everything: it exists for incidents.
  if (input.rejectInbound) return decline('paused');
  // 1. Workspace paused (staff pause, §D1 banner).
  if (number.workspace_paused) return decline('paused');
  // 2. Number paused, or not (yet / any more) active.
  if (number.number_paused || !number.number_active) return decline('paused');
  // 2b. No live agent to answer: unbound, still a draft, paused, or never provisioned on Retell.
  if (!number.retell_agent_id || !number.agent_live) return decline('paused');
  // 3. Caller on the number's or the platform's blocklist.
  if (input.from && number.blocklist.includes(normalisePhone(input.from))) return decline('blocked');

  // A retry of this same call is already in `active:{ws}` — Retell resends `call_inbound`
  // with an identical `call_id` up to three times when it does not get an answer it likes
  // (the decline_timeout fixtures), and the first attempt may well have reserved before
  // timing out. Counting that reservation against its own retry declines the caller on
  // `cap`, or collapses their duration to the 60 s floor on credits they already hold.
  // `reserve.script.ts` excludes `field ~= callId` for exactly this reason; the two must
  // agree, or a race the script would allow is refused here before it ever runs.
  const others = input.callId === null ? input.active : input.active.filter((a) => a.callId !== input.callId);

  // 4. Balance, net of what the other live calls may still spend, must stay above −grace.
  const reserved = roundCredits(others.reduce((sum, a) => sum + a.credits, 0));
  const grace = input.caps?.grace_overdraft_credits ?? input.pricing?.config.wallet_policy.grace_overdraft_credits ?? null;
  let available: number | null = null;
  let balanceCeiling: number | null = null;
  if (input.balance === null || !Number.isFinite(input.balance)) {
    warnings.push('balance_unknown');
  } else {
    available = roundCredits(input.balance - reserved);
    if (grace === null) warnings.push('grace_unknown');
    else {
      balanceCeiling = roundCredits(input.balance + grace);
      if (!(available > -grace)) return decline('balance');
    }
  }

  // 5. Concurrency: live calls (authorised or started) below the plan cap.
  if (!input.caps) warnings.push('caps_unknown');
  else if (others.length >= input.caps.concurrency_cap) return decline('cap');

  // 6. Hours. `always` skips the arithmetic entirely.
  let currentTime = now.toISOString();
  if (number.hours_mode !== 'always') {
    const verdict = isOpen(number.hours, now, number.timezone);
    if (!verdict.open) return decline('hours');
    if (verdict.note) warnings.push(`hours_${verdict.note}`);
    if (verdict.clock) currentTime = verdict.clock.time;
  }

  // max_call_duration_ms = min(planMax, remainingCredits/rate × 60000), clamped to Retell's window.
  // The rate comes from the number record first: it is written by the same refresh that
  // wrote `plan_max_ms`, so both halves of the formula live and expire together. Falling
  // back to `pricing:current` covers a record written before the rate was carried there.
  const rawRate = number.rate_per_min ?? (input.pricing ? rateForTier(input.pricing.config.rates, number.tier) : NaN);
  const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : null;
  if (rate === null) warnings.push('rate_unknown');
  const candidates: number[] = [];
  if (number.plan_max_ms && number.plan_max_ms > 0) candidates.push(number.plan_max_ms);
  else warnings.push('plan_max_unknown');
  if (rate !== null && available !== null) candidates.push(Math.floor((Math.max(available, 0) / rate) * 60_000));
  const maxCallDurationMs = candidates.length ? clampDuration(Math.min(...candidates)) : null;
  const reservedCredits = rate !== null && maxCallDurationMs !== null ? roundCredits((maxCallDurationMs / 60_000) * rate) : 0;
  if (!input.callId) warnings.push('no_call_id');

  const dynamicVariables: Record<string, string> = {
    business_name: number.business_name,
    agent_name: number.agent_name ?? '',
    business_open: 'true',
    next_open_time: nextOpening(number.hours, now, number.timezone) ?? '',
    current_time: currentTime,
  };
  number.transfer_numbers.forEach((n, i) => {
    dynamicVariables[`transfer_number_${i + 1}`] = n;
  });

  return {
    kind: 'allow',
    ...id,
    retellAgentId: number.retell_agent_id,
    rate,
    configVersion: number.config_version ?? input.pricing?.version ?? null,
    maxCallDurationMs,
    reservedCredits,
    available,
    balanceCeiling,
    concurrencyCap: input.caps?.concurrency_cap ?? null,
    dynamicVariables,
    metadata: { tenant_id: number.workspace_id, number_id: number.number_id, agent_id: number.agent_id, tier: number.tier },
    warnings,
  };
}
