import { roundCredits } from '../wallet/fifo';

/**
 * D16 transfer billing, as pure functions of what the platform told us. No I/O, so every
 * delivery order is tested (transfer.test.ts) against the same code that bills.
 *
 * A transferred call has two legs. The agent leg is the call itself — `call_ended` bills it
 * at the tier rate, from `start_timestamp` to `end_timestamp`, exactly as before. The
 * transferred leg starts when the destination answers (`transfer_bridged`) and ends when it
 * hangs up (`transfer_end_timestamp`, else `transfer_ended`); it is billed on its own
 * ledger row at `pricing.rates.transferred_leg_per_min` (admin §5, 0.25 by default).
 *
 * The facts are folded from **every stored event for the call**, not from the one being
 * handled: the platform posts transfer events with a bare `{call_id}`, they may arrive
 * before the row exists or out of order, and a replay must recompute the same answer.
 * Folding is order-independent (earliest bridge, latest end) and idempotent.
 */

export type TransferStatus = 'started' | 'bridged' | 'cancelled' | 'ended';

/** One stored Retell event for the call, reduced to what the fold reads. */
export interface TransferEventFact {
  type: string;
  /** The event's own `event_timestamp` (ms), else when we stored it. */
  at: number;
  /** `call.transfer_end_timestamp` if the payload carried one. */
  transferEndTimestamp?: number | null;
  /** `call.disconnection_reason` / `call.end_timestamp`, from call_ended / call_analyzed. */
  disconnectionReason?: string | null;
  endTimestamp?: number | null;
}

export interface TransferFacts {
  status: TransferStatus | null;
  startedAt: number | null;
  bridgedAt: number | null;
  endedAt: number | null;
}

const NONE: TransferFacts = { status: null, startedAt: null, bridgedAt: null, endedAt: null };

export function foldTransfer(events: readonly TransferEventFact[]): TransferFacts {
  if (!events.length) return NONE;
  const at = (type: string) => events.filter((e) => e.type === type && isTime(e.at)).map((e) => e.at);
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

  const startedAt = min(at('transfer_started'));
  let bridgedAt = min(at('transfer_bridged'));
  if (bridgedAt === null) {
    // A lost transfer_bridged: the agent leg itself says it ended because the transfer
    // bridged, and the agent leaves the call at that moment — its end is the bridge.
    const bridgedEnd = events.find((e) => e.disconnectionReason === 'transfer_bridged' && isTime(e.endTimestamp));
    if (bridgedEnd) bridgedAt = bridgedEnd.endTimestamp!;
  }
  const cancelled = at('transfer_cancelled').length > 0;

  // The platform's own end of the transferred leg wins over the event's arrival time.
  const platformEnd = max(events.map((e) => e.transferEndTimestamp).filter(isTime));
  const endedAt = platformEnd ?? max(at('transfer_ended'));

  const status: TransferStatus | null =
    bridgedAt !== null && endedAt !== null
      ? 'ended'
      : bridgedAt !== null
        ? 'bridged'
        : cancelled || endedAt !== null
          ? // Ended without ever bridging: the destination never answered.
            'cancelled'
          : startedAt !== null
            ? 'started'
            : null;
  return { status, startedAt, bridgedAt, endedAt: bridgedAt !== null ? endedAt : null };
}

export type TransferZeroReason = 'not_bridged' | 'zero_duration';

export type TransferCharge =
  /** The leg has not ended yet (or we have not heard): nothing to bill, nothing final. */
  | { settled: false }
  | { settled: true; billable: boolean; duration_s: number; credits: number; zero_reason?: TransferZeroReason };

/**
 * credits = (end − bridge)/60 s × rate, rounded to 0.01 — the §14.2 rule applied to the
 * second leg. A transfer that never bridged is settled at zero: the caller was never
 * connected to anyone, and the agent leg already paid for the time spent ringing.
 */
export function computeTransferCharge(facts: TransferFacts, rate: number): TransferCharge {
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`rate must be a non-negative number, got ${rate}`);
  if (facts.status === 'cancelled') return { settled: true, billable: false, duration_s: 0, credits: 0, zero_reason: 'not_bridged' };
  if (facts.bridgedAt === null || facts.endedAt === null) return { settled: false };

  const duration_s = Math.max(0, (facts.endedAt - facts.bridgedAt) / 1000);
  const credits = roundCredits((duration_s / 60) * rate);
  if (credits <= 0) return { settled: true, billable: false, duration_s, credits: 0, zero_reason: 'zero_duration' };
  return { settled: true, billable: true, duration_s, credits };
}

function isTime(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
