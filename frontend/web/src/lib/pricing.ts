/**
 * How long a `GET /pricing` answer may be served from the query cache. Admin §5.2 promises
 * the portal shows a published price within 60 s (the API's own config TTL), so the
 * browser must not hold it longer than that either (QA-036). One constant for every caller.
 */
export const PRICING_STALE_MS = 60_000;

/** The published figures a sentence quotes. Each is null until `GET /pricing` has answered, and a sentence then goes without its number. */
export interface PricingFigures {
  /** Credits a minute on a Standard agent. */
  standardRate: number | null;
  /** Credits a minute on a Premium agent. */
  premiumRate: number | null;
  /** Free credits a new workspace starts with; null when the trial grants none. */
  trialCredits: number | null;
}

/**
 * The rates and the trial size as copy quotes them, read from the published pricing and
 * nowhere else: "1.5× credits" and "20 free credits" used to be typed into the catalogue,
 * so a publish changed what a call cost and not what the screen said.
 */
export function pricingFigures(pricing: { rates: { standard_per_min: number; premium_per_min: number }; wallet_policy: { trial_credits: number } } | null | undefined): PricingFigures {
  const positive = (value: number | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
  return {
    standardRate: positive(pricing?.rates.standard_per_min),
    premiumRate: positive(pricing?.rates.premium_per_min),
    trialCredits: positive(pricing?.wallet_policy.trial_credits),
  };
}
