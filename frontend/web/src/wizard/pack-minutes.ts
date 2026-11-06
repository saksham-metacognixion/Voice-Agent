/**
 * §8 W7 "≈150 min": whole minutes a pack buys at a tier's rate (credits per minute,
 * from `GET /pricing`). Floor, never rounded up: the card must not promise a minute
 * the wallet cannot pay for.
 */
export function packMinutes(credits: number, ratePerMin: number): number | null {
  if (!Number.isFinite(credits) || !Number.isFinite(ratePerMin) || ratePerMin <= 0 || credits < 0) return null;
  return Math.floor(credits / ratePerMin);
}

/** §5.4 "Auto top-up … 10%/20% of pack": the choices W7 offers, in percent of the pack. */
export const TOPUP_PERCENTS = [10, 20] as const;
export type TopupPercent = (typeof TOPUP_PERCENTS)[number];

/** The API refuses a threshold under 10 credits; the percentage is rounded to a whole credit. */
export const TOPUP_THRESHOLD_MIN = 10;

export function topupThreshold(packCredits: number, pct: number): number {
  return Math.max(TOPUP_THRESHOLD_MIN, Math.round((packCredits * pct) / 100));
}

/** Which of the offered choices the published policy suggests (§5.4 "default … at 10 % of last pack"); 10 when the policy names neither. */
export function defaultTopupPercent(policyPct: number | null | undefined): TopupPercent {
  return (TOPUP_PERCENTS as readonly number[]).includes(policyPct ?? NaN) ? (policyPct as TopupPercent) : 10;
}
