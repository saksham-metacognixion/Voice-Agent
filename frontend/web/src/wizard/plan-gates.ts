import { activeIntlLocale, activeLocale, localeDirection } from '../i18n';
import type { PricingResponse } from '@portal/schemas';

type Pack = PricingResponse['packs'][number];
type Gate = Pack['feature_gates'][number];

/** The cheapest pack on sale that includes `gate` — W4 and W6 name it instead of hard-coding a plan. */
export function cheapestPackWith(pricing: PricingResponse | undefined, gate: Gate): Pack | null {
  const packs = (pricing?.packs ?? []).filter((p) => p.feature_gates.includes(gate));
  return packs.sort((a, b) => a.price_cents - b.price_cents)[0] ?? null;
}

export function formatMoney(cents: number, currency: string): string {
  const text = new Intl.NumberFormat(activeIntlLocale(), { style: 'currency', currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
  // Arabic gives `‏149 US$`; inside a right-to-left line the trailing `$` is pulled to the
  // other side ("$US 149"). Isolated left to right it reads `149 US$` wherever it lands.
  return localeDirection(activeLocale()) === 'rtl' ? `\u2066${text.replace(/[\u200e\u200f]/g, '')}\u2069` : text;
}

export function formatCredits(credits: number): string {
  return new Intl.NumberFormat(activeIntlLocale(), { maximumFractionDigits: 2 }).format(credits);
}
