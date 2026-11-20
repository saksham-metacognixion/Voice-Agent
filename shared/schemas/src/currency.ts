import { z } from 'zod';

/**
 * Money in two currencies (ADR 0049). USD is the base: every published pack price, review
 * limit and refund cap is a USD figure, and a CAD figure is derived from it with a stored
 * exchange rate. Everything here is integer arithmetic on minor units (cents) and on the
 * rate's decimal text, so the API, the portal and the console cannot round differently.
 * No `number` ever holds a rate or a product of one.
 */

export const currencyCode = z.enum(['USD', 'CAD']);
export type CurrencyCode = z.infer<typeof currencyCode>;

/** The currency prices are published in. A derived currency is priced from it. */
export const BASE_CURRENCY: CurrencyCode = 'USD';

/** Digits kept after the decimal point of a rate. The Bank of Canada publishes four. */
export const FX_RATE_SCALE = 8;
const SCALE = 10n ** BigInt(FX_RATE_SCALE);

/** A rate as decimal text, e.g. "1.4291": units of the quote currency per one base unit. */
export const fxRateText = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,8})?$/, 'A decimal rate such as 1.4291')
  .refine((text) => parseFxRate(text) !== null, 'The rate must be greater than zero');

/**
 * The rate as an integer scaled by 10^8, or null for anything that is not a positive
 * decimal: empty, negative, zero, exponent notation, more than eight decimals, NaN.
 */
export function parseFxRate(text: unknown): bigint | null {
  if (typeof text !== 'string' || !/^\d{1,6}(\.\d{1,8})?$/.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(FX_RATE_SCALE, '0'));
  return scaled > 0n ? scaled : null;
}

/** Where a rate comes from. The Bank of Canada's Valet API, series FXUSDCAD, is the only source today. */
export const fxSource = z.enum(['bank_of_canada']);
export type FxSource = z.infer<typeof fxSource>;

export const roundingMode = z.enum(['nearest', 'up', 'down']);
export type RoundingMode = z.infer<typeof roundingMode>;

/** How a converted amount is rounded: to a multiple of `step_cents`, in `mode`. Half rounds up under `nearest`. */
export const currencyRounding = z.object({
  step_cents: z.number().int().min(1).max(10_000),
  mode: roundingMode,
});
export type CurrencyRounding = z.infer<typeof currencyRounding>;

/** Exact to the cent, rounded down: how a limit is converted, so a converted cap never allows more than the base cap. */
export const LIMIT_ROUNDING: CurrencyRounding = { step_cents: 1, mode: 'down' };

/**
 * `baseCents × rate`, rounded to the step. Throws on a rate that does not parse and on
 * cents that are not a non-negative integer: a caller must never get an amount out of a
 * rate nobody published.
 */
export function convertCents(baseCents: number, rate: string, rounding: CurrencyRounding): number {
  const scaled = parseFxRate(rate);
  if (scaled === null) throw new RangeError(`not an exchange rate: ${String(rate)}`);
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) throw new RangeError(`not an amount in cents: ${String(baseCents)}`);
  const { step_cents: step, mode } = currencyRounding.parse(rounding);
  const numerator = BigInt(baseCents) * scaled;
  const denominator = SCALE * BigInt(step);
  const floor = numerator / denominator;
  const remainder = numerator % denominator;
  const steps = mode === 'down' || remainder === 0n ? floor : mode === 'up' ? floor + 1n : remainder * 2n >= denominator ? floor + 1n : floor;
  const cents = steps * BigInt(step);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('converted amount is out of range');
  return Number(cents);
}

/** The rate a price or a limit was converted with, as stored and as shown. */
export const fxQuote = z.object({
  rate: fxRateText,
  /** The business day the source published the rate for (YYYY-MM-DD). */
  observed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string(),
});
export type FxQuote = z.infer<typeof fxQuote>;

/** The currency a new workspace starts in: CAD for a Canadian business, the base currency for every other. */
export function defaultCurrencyForCountry(country: string | null | undefined): CurrencyCode {
  return country?.trim().toUpperCase() === 'CA' ? 'CAD' : BASE_CURRENCY;
}

/**
 * What a published price costs in `target`: the price itself in its own currency, the
 * converted and rounded figure for a base-currency price in a derived currency, and null
 * when it cannot be priced (no rate stored yet, a price published in a currency other
 * than the base, or a conversion the rounding rule takes to nothing — a large step rounded
 * down). Null is "do not sell", never "sell at the base price" and never "sell for 0".
 */
export function priceInCurrency(
  price: { price_cents: number; currency: CurrencyCode },
  target: CurrencyCode,
  fx: Pick<FxQuote, 'rate'> | null,
  rounding: CurrencyRounding,
): number | null {
  if (price.currency === target) return price.price_cents;
  if (price.currency !== BASE_CURRENCY || !fx) return null;
  if (parseFxRate(fx.rate) === null) return null;
  const cents = convertCents(price.price_cents, fx.rate, rounding);
  return cents > 0 ? cents : null;
}

/**
 * A base-currency limit (the first-purchase review limit, a role's refund cap) for an
 * amount in `currency`: unchanged in the base currency, converted with the transaction's
 * rate otherwise. Null when a derived currency has no rate, which a caller treats as
 * "cannot decide" and refuses.
 */
export function limitInCurrency(limitCents: number, currency: CurrencyCode, rate: string | null): number | null {
  if (currency === BASE_CURRENCY) return limitCents;
  if (rate === null || parseFxRate(rate) === null) return null;
  return convertCents(limitCents, rate, LIMIT_ROUNDING);
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return value === 'USD' || value === 'CAD';
}

/**
 * A currency as a database column or a provider holds it — `char(3)` padding, either case
 * — as a code we sell in, or null for anything else. The one reading of a stored currency:
 * checkout, auto top-up, refunds and the responses must not each normalise it their own way.
 */
export function storedCurrency(value: unknown): CurrencyCode | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return isCurrencyCode(code) ? code : null;
}

/** A workspace's currency from its row. A value we do not sell in reads as the base currency. */
export function workspaceCurrency(value: unknown): CurrencyCode {
  return storedCurrency(value) ?? BASE_CURRENCY;
}
