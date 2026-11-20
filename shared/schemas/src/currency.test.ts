import { describe, expect, it } from 'vitest';
import {
  BASE_CURRENCY,
  LIMIT_ROUNDING,
  convertCents,
  currencyRounding,
  defaultCurrencyForCountry,
  fxRateText,
  isCurrencyCode,
  storedCurrency,
  workspaceCurrency,
  limitInCurrency,
  parseFxRate,
  priceInCurrency,
} from './currency.js';
import { checkoutRequest } from './wallet.js';
import { pricingQuery, pricingResponse } from './pricing.js';

/* ADR 0049: USD is the base, CAD is derived. Every figure below is integer arithmetic. */

const DOLLAR = { step_cents: 100, mode: 'nearest' } as const;
const PACKS = [
  { id: 'starter', price_cents: 4_900, credits: 150 },
  { id: 'growth', price_cents: 14_900, credits: 500 },
  { id: 'scale', price_cents: 39_900, credits: 1_500 },
  { id: 'pro', price_cents: 99_900, credits: 4_500 },
] as const;

describe('parseFxRate', () => {
  it('reads a published decimal as an integer scaled by 10^8', () => {
    expect(parseFxRate('1.4291')).toBe(142_910_000n);
    expect(parseFxRate('1')).toBe(100_000_000n);
    expect(parseFxRate('0.00000001')).toBe(1n);
  });

  it.each(['', '0', '0.0000', '-1.4291', '1.4291e0', '1,4291', ' 1.4291', '1.123456789', 'NaN', 'Infinity', '.5', '1.'])('refuses %j', (text) => {
    expect(parseFxRate(text)).toBeNull();
    expect(fxRateText.safeParse(text).success).toBe(false);
  });

  it.each([undefined, null, 1.4291, {}, []])('refuses a non-string (%j)', (value) => {
    expect(parseFxRate(value)).toBeNull();
  });
});

describe('convertCents', () => {
  it('prices the four packs at 1.4291 to the nearest whole dollar', () => {
    // 49 × 1.4291 = 70.0259, 149 × = 212.9359, 399 × = 570.2109, 999 × = 1427.6709
    expect(PACKS.map((p) => convertCents(p.price_cents, '1.4291', DOLLAR))).toEqual([7_000, 21_300, 57_000, 142_800]);
  });

  it('rounds an exact half up, and anything under it down', () => {
    expect(convertCents(10_000, '1.005', DOLLAR)).toBe(10_100); // 100.50 → 101
    expect(convertCents(10_000, '1.00499999', DOLLAR)).toBe(10_000); // 100.499999 → 100
    expect(convertCents(10_000, '1.00500001', DOLLAR)).toBe(10_100);
    expect(convertCents(100, '1.5', DOLLAR)).toBe(200); // 1.50 → 2
    expect(convertCents(100, '1.49', DOLLAR)).toBe(100);
  });

  it('follows the configured step and mode rather than a rule of its own', () => {
    expect(convertCents(4_900, '1.4291', { step_cents: 1, mode: 'nearest' })).toBe(7_003); // 70.0259
    expect(convertCents(4_900, '1.4291', { step_cents: 100, mode: 'up' })).toBe(7_100);
    expect(convertCents(14_900, '1.4291', { step_cents: 100, mode: 'down' })).toBe(21_200);
    expect(convertCents(14_900, '1.4291', { step_cents: 500, mode: 'nearest' })).toBe(21_500);
    expect(convertCents(7_000, '1', { step_cents: 100, mode: 'up' })).toBe(7_000); // already on a step: no move
  });

  it('has none of the float error the same sum has in doubles', () => {
    // In doubles 1.005 * 1000 is 1004.9999999999999, which rounds down to 1004.
    expect(1.005 * 1000).not.toBe(1005);
    expect(convertCents(1_000, '1.005', { step_cents: 1, mode: 'nearest' })).toBe(1_005);
    // 0.1 + 0.2 territory: 30 cents at 1.1 is exactly 33.
    expect(convertCents(30, '1.1', { step_cents: 1, mode: 'nearest' })).toBe(33);
    // A large amount keeps every digit.
    expect(convertCents(9_007_199_254_740, '1.00000001', { step_cents: 1, mode: 'down' })).toBe(9_007_199_344_811);
  });

  it('is the identity at a rate of exactly 1', () => {
    for (const p of PACKS) expect(convertCents(p.price_cents, '1', DOLLAR)).toBe(p.price_cents);
  });

  it.each(['0', '-1.4', '', 'abc', '1.4291e0'])('throws on rate %j rather than produce an amount', (rate) => {
    expect(() => convertCents(4_900, rate, DOLLAR)).toThrow(RangeError);
  });

  it.each([-1, 49.5, Number.NaN, Number.POSITIVE_INFINITY])('throws on %j cents', (cents) => {
    expect(() => convertCents(cents, '1.4291', DOLLAR)).toThrow(RangeError);
  });

  it('refuses a rounding step that is not a positive whole number of cents', () => {
    expect(currencyRounding.safeParse({ step_cents: 0, mode: 'nearest' }).success).toBe(false);
    expect(currencyRounding.safeParse({ step_cents: 1.5, mode: 'nearest' }).success).toBe(false);
    expect(currencyRounding.safeParse({ step_cents: 100, mode: 'bankers' }).success).toBe(false);
    expect(() => convertCents(4_900, '1.4291', { step_cents: 0, mode: 'nearest' })).toThrow();
  });
});

describe('priceInCurrency', () => {
  const usd = (price_cents: number) => ({ price_cents, currency: 'USD' as const });

  it('keeps the published USD price for a USD workspace, with or without a rate', () => {
    for (const p of PACKS) {
      expect(priceInCurrency(usd(p.price_cents), 'USD', null, DOLLAR)).toBe(p.price_cents);
      expect(priceInCurrency(usd(p.price_cents), 'USD', { rate: '1.4291' }, DOLLAR)).toBe(p.price_cents);
    }
  });

  it('derives the CAD price from the USD price and the rate', () => {
    expect(priceInCurrency(usd(4_900), 'CAD', { rate: '1.4291' }, DOLLAR)).toBe(7_000);
    expect(priceInCurrency(usd(4_900), 'CAD', { rate: '1.3500' }, DOLLAR)).toBe(6_600); // 66.15
  });

  it('answers null, never the USD figure, when CAD cannot be priced', () => {
    expect(priceInCurrency(usd(4_900), 'CAD', null, DOLLAR)).toBeNull();
    expect(priceInCurrency(usd(4_900), 'CAD', { rate: '0' }, DOLLAR)).toBeNull();
    expect(priceInCurrency(usd(4_900), 'CAD', { rate: '-1.4' }, DOLLAR)).toBeNull();
    expect(priceInCurrency(usd(4_900), 'CAD', { rate: 'stale' }, DOLLAR)).toBeNull();
  });

  it('does not convert backwards from a pack published in CAD', () => {
    expect(priceInCurrency({ price_cents: 7_000, currency: 'CAD' }, 'USD', { rate: '1.4291' }, DOLLAR)).toBeNull();
    expect(priceInCurrency({ price_cents: 7_000, currency: 'CAD' }, 'CAD', null, DOLLAR)).toBe(7_000);
  });

  it('a conversion the rounding takes to nothing is "do not sell", never a price of 0', () => {
    // 49.00 USD is about 70 CAD: under one 100-dollar step, rounded down.
    expect(priceInCurrency(usd(4_900), 'CAD', { rate: '1.4291' }, { step_cents: 10_000, mode: 'down' })).toBeNull();
    expect(priceInCurrency(usd(4_900), 'CAD', { rate: '1.4291' }, { step_cents: 10_000, mode: 'up' })).toBe(10_000);
    expect(priceInCurrency(usd(14_900), 'CAD', { rate: '1.4291' }, { step_cents: 10_000, mode: 'down' })).toBe(20_000);
  });
});

describe('limitInCurrency', () => {
  it('leaves a USD limit alone for a USD amount', () => {
    expect(limitInCurrency(100_000, 'USD', null)).toBe(100_000);
    expect(limitInCurrency(100_000, 'USD', '1.4291')).toBe(100_000);
  });

  it('converts to the cent, rounded down, for a CAD amount', () => {
    expect(limitInCurrency(100_000, 'CAD', '1.4291')).toBe(142_910);
    expect(limitInCurrency(30_000, 'CAD', '1.42915')).toBe(42_874); // 428.745 → 428.74, never up
    expect(LIMIT_ROUNDING).toEqual({ step_cents: 1, mode: 'down' });
  });

  it('answers null when a CAD limit has no usable rate', () => {
    expect(limitInCurrency(100_000, 'CAD', null)).toBeNull();
    expect(limitInCurrency(100_000, 'CAD', '0')).toBeNull();
  });

  it('keeps 0 ("cannot") at 0 in either currency', () => {
    expect(limitInCurrency(0, 'CAD', '1.4291')).toBe(0);
  });
});

describe('workspace currency', () => {
  it('defaults to CAD for a Canadian business and to USD for every other', () => {
    expect(defaultCurrencyForCountry('CA')).toBe('CAD');
    expect(defaultCurrencyForCountry('ca')).toBe('CAD');
    expect(defaultCurrencyForCountry(' CA ')).toBe('CAD');
    for (const country of ['US', 'GB', 'IN', 'SA', 'AE', 'FR', '', null, undefined]) expect(defaultCurrencyForCountry(country)).toBe('USD');
    expect(BASE_CURRENCY).toBe('USD');
  });

  it('knows two currencies and no others', () => {
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('CAD')).toBe(true);
    for (const value of ['usd', 'EUR', 'INR', '', null, undefined, 1]) expect(isCurrencyCode(value)).toBe(false);
  });

  it('reads a stored currency one way: padding and case ignored, anything else is not a currency', () => {
    for (const value of ['CAD', 'cad', ' cad', 'CAD ', 'Cad']) expect(storedCurrency(value)).toBe('CAD');
    for (const value of ['EUR', '', '   ', 'US', null, undefined, 1]) expect(storedCurrency(value)).toBeNull();
    expect(workspaceCurrency('cad ')).toBe('CAD');
    for (const value of ['EUR', '', null, undefined]) expect(workspaceCurrency(value)).toBe('USD');
  });
});

describe('wire shapes', () => {
  it('GET /pricing takes ?currency= in either case and refuses a currency we do not sell in', () => {
    expect(pricingQuery.parse({ currency: 'cad' }).currency).toBe('CAD');
    expect(pricingQuery.parse({}).currency).toBeUndefined();
    expect(pricingQuery.safeParse({ currency: 'EUR' }).success).toBe(false);
  });

  it('an answer written before currencies existed still parses, as USD with no rate', () => {
    const parsed = pricingResponse.parse({
      version: 1,
      effective_at: '2026-09-14T00:00:00.000Z',
      currency: 'USD',
      packs: [],
      rates: { standard_per_min: 1, premium_per_min: 1.5 },
      recurring: { number_rental_credits: 15, extra_kb_credits: 30, release_after_days_at_zero_balance: 30, rental_warning_days: [7] },
      wallet_policy: { trial_credits: 20, trial_validity_days: 30, credit_expiry_months: 12, grace_overdraft_credits: 10, low_balance_thresholds_pct: [20, 5, 0], auto_topup_default_on: true, auto_topup_threshold_pct: 10 },
    });
    expect(parsed).toMatchObject({ base_currency: 'USD', fx: null, currency_unavailable: false });
  });

  it('checkout carries the price that was shown, as whole cents in a known currency', () => {
    expect(checkoutRequest.parse({ pack_id: 'starter', expected_amount_cents: 7_000, expected_currency: 'CAD' })).toMatchObject({ expected_amount_cents: 7_000, expected_currency: 'CAD' });
    expect(checkoutRequest.safeParse({ pack_id: 'starter', expected_amount_cents: 70.5 }).success).toBe(false);
    expect(checkoutRequest.safeParse({ pack_id: 'starter', expected_amount_cents: 0 }).success).toBe(false);
    expect(checkoutRequest.safeParse({ pack_id: 'starter', expected_amount_cents: -7_000 }).success).toBe(false);
    expect(checkoutRequest.safeParse({ pack_id: 'starter', expected_currency: 'EUR' }).success).toBe(false);
  });
});
