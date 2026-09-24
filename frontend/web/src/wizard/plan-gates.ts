import type { PricingResponse } from '@portal/schemas';

type Pack = PricingResponse['packs'][number];
type Gate = Pack['feature_gates'][number];

/** The cheapest pack on sale that includes `gate` — W4 and W6 name it instead of hard-coding a plan. */
export function cheapestPackWith(pricing: PricingResponse | undefined, gate: Gate): Pack | null {
  const packs = (pricing?.packs ?? []).filter((p) => p.feature_gates.includes(gate));
  return packs.sort((a, b) => a.price_cents - b.price_cents)[0] ?? null;
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

export function formatCredits(credits: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(credits);
}
