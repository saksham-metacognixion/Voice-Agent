/**
 * Per-day money for charts. An amount belongs to one currency, so a chart draws one
 * currency at a time: US$49 and CA$65 on the same day are two bars on two charts, never
 * one bar of 114.
 */

/** The currencies that appear anywhere in the days, in a stable order. */
export function currenciesIn<T>(days: readonly T[], entries: (day: T) => ReadonlyArray<{ currency: string }>): string[] {
  return [...new Set(days.flatMap((d) => entries(d).map((e) => e.currency)))].sort();
}

/** The currency a chart shows: the one picked while it still has data, else the first present, else the fallback. */
export function shownCurrency(picked: string | null, present: readonly string[], fallback = 'USD'): string {
  if (picked && present.includes(picked)) return picked;
  return present[0] ?? fallback;
}
