import { roundCredits } from '../wallet/fifo';

/**
 * §14.2 metering, as a pure function of the `call_ended` payload and the rate captured
 * at `call_started`. No I/O, so the money rule is tested against the D2 fixtures byte
 * for byte (metering.test.ts) and cannot drift from the code that bills.
 */

/**
 * `disconnection_reason` values that mean the callee never answered: dial failed, busy,
 * no answer, and the telephony-side refusals. The customer does not pay for a ringing
 * phone. Anything after connection — hangups, transfers, errors mid-call, max duration —
 * is billable for the seconds it lasted. Values from retell-sdk 6.0.1 `disconnection_reason`.
 */
export const NOT_CONNECTED_REASONS: ReadonlySet<string> = new Set([
  'dial_busy',
  'dial_failed',
  'dial_no_answer',
  'invalid_destination',
  'telephony_provider_permission_denied',
  'telephony_provider_unavailable',
  'sip_routing_error',
  'marked_as_spam',
  'user_declined',
  'no_valid_payment',
  'scam_detected',
  'concurrency_limit_reached',
  'no_concurrency_fallback',
  'registered_call_timeout',
  'error_user_not_joined',
]);

/** The subset of a Retell `call` object metering needs. Everything optional: payloads vary. */
export interface CallEndedFacts {
  call_status?: string | null;
  start_timestamp?: number | null;
  end_timestamp?: number | null;
  /** Retell's own span. Used only when a timestamp is missing; the timestamps win otherwise. */
  duration_ms?: number | null;
  disconnection_reason?: string | null;
}

export type ZeroChargeReason = 'not_connected' | 'zero_duration' | 'missing_timestamps';

export interface Charge {
  /** False means the ledger is not touched and `calls.credits_charged` is 0. */
  billable: boolean;
  /** (end − start)/1000, fractional — metered per second, not rounded up like Retell's `total_duration_seconds`. */
  duration_s: number;
  /** duration_s/60 × rate, 2 dp. */
  credits: number;
  zero_reason?: ZeroChargeReason;
}

/**
 * credits = duration_s/60 × rate(tier), rounded to 0.01; 0 when the call never connected.
 *
 * `rate` is `calls.rate`, captured at `call_started` from the config current at that moment
 * (§14.2). It is a parameter here precisely so that nothing in this file reads config.
 */
export function computeCharge(call: CallEndedFacts, rate: number): Charge {
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`rate must be a non-negative number, got ${rate}`);

  const zero = (zero_reason: ZeroChargeReason, duration_s = 0): Charge => ({ billable: false, duration_s, credits: 0, zero_reason });

  if (call.call_status === 'not_connected') return zero('not_connected');
  if (call.disconnection_reason && NOT_CONNECTED_REASONS.has(call.disconnection_reason)) return zero('not_connected');

  const { start_timestamp: start, end_timestamp: end } = call;
  let span_ms: number;
  if (typeof start === 'number' && typeof end === 'number') {
    span_ms = end - start;
  } else if (typeof call.duration_ms === 'number' && Number.isFinite(call.duration_ms)) {
    // A payload with one timestamp dropped still carries duration_ms; bill the seconds
    // Retell itself measured rather than giving the minutes away.
    span_ms = call.duration_ms;
  } else {
    return zero('missing_timestamps');
  }

  const duration_s = Math.max(0, span_ms / 1000);
  if (duration_s <= 0) return zero('zero_duration', 0);

  const credits = roundCredits((duration_s / 60) * rate);
  return { billable: credits > 0, duration_s, credits, ...(credits > 0 ? {} : { zero_reason: 'zero_duration' as const }) };
}
