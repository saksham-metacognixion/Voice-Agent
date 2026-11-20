/**
 * FIFO lot consumption (§5.4): the credits closest to expiring burn first.
 *
 * Pure. The service loads the open lots for a workspace ordered by `expires_at`, hands
 * them here, and writes back what this returns. Keeping the arithmetic out of the
 * transaction makes it testable to the cent without a database.
 */

export interface OpenLot {
  id: string;
  remaining: number;
}

export interface LotDraw {
  id: string;
  /** Credits taken from this lot, > 0. */
  take: number;
}

export interface FifoAllocation {
  draws: LotDraw[];
  /** Part of `amount` no lot could cover — the overdraft the grace allowance absorbs. */
  uncovered: number;
}

/** Ledger deltas are 2 dp (§14.2). Half-up, and immune to 1.005-style float drift. */
export function roundCredits(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function allocateFifo(lots: readonly OpenLot[], amount: number): FifoAllocation {
  let left = roundCredits(amount);
  const draws: LotDraw[] = [];
  for (const lot of lots) {
    if (left <= 0) break;
    if (lot.remaining <= 0) continue;
    const take = roundCredits(Math.min(lot.remaining, left));
    draws.push({ id: lot.id, take });
    left = roundCredits(left - take);
  }
  return { draws, uncovered: Math.max(0, left) };
}

/**
 * How a new lot settles an overdraft first (§5.4 "next top-up settles it first"): a
 * balance of −6 and a 150-credit lot leaves the lot with 144 remaining. The ledger row
 * still records the full +150; only the lot is short.
 */
export function lotRemainingAfterSettling(credits: number, balanceBefore: number): number {
  if (balanceBefore >= 0) return roundCredits(credits);
  return roundCredits(Math.max(0, credits + balanceBefore));
}
