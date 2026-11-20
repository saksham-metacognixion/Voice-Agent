import { describe, expect, it, vi } from 'vitest';

vi.mock('@portal/db', () => {
  class Decimal {
    constructor(private readonly text: string) {}
    toFixed(): string {
      return this.text;
    }
  }
  return { Prisma: { Decimal }, adminDb: {}, withWorkspace: vi.fn(), isUniqueViolation: () => false };
});

import type { PriceQuote } from '../config';
import { amountMismatch, assertPriceShown, firstPurchaseOverLimit, purchaseMoney } from './billing.service';
import type { CheckoutSessionFacts } from './stripe.gateway';

/*
 * ADR 0049: the three pure rules between a price on a screen and credits in a wallet —
 * what the customer confirmed is what is charged (PRICE_CHANGED), what is charged is fixed
 * on the purchase row when checkout begins (purchaseMoney), and what Stripe collected is
 * what the row says before anything is granted (amountMismatch).
 */

const FX = { id: '7b0a7f6e-1f0b-4c57-9c60-3a3d0f1c2b11', rate: '1.4291', observedOn: '2026-11-17', source: 'bank_of_canada', series: 'FXUSDCAD', fetchedAt: '2026-11-17T21:30:00.000Z', confirmedAt: '2026-11-18T21:30:00.000Z' };
const USD: PriceQuote = { amountCents: 4_900, currency: 'USD', baseAmountCents: 4_900, baseCurrency: 'USD', fx: null };
const CAD: PriceQuote = { amountCents: 7_000, currency: 'CAD', baseAmountCents: 4_900, baseCurrency: 'USD', fx: FX };

const changed = (shown: Parameters<typeof assertPriceShown>[0], quote: PriceQuote) => {
  try {
    assertPriceShown(shown, quote);
    return null;
  } catch (error) {
    return error as { code: string; fields?: Array<{ field: string; message: string }>; getStatus(): number };
  }
};

describe('assertPriceShown', () => {
  it('passes when the price shown is the price in force', () => {
    expect(changed({ expected_amount_cents: 4_900, expected_currency: 'USD' }, USD)).toBeNull();
    expect(changed({ expected_amount_cents: 7_000, expected_currency: 'CAD' }, CAD)).toBeNull();
    expect(changed({ expected_amount_cents: 7_000 }, CAD)).toBeNull();
  });

  it('a USD checkout that states no price still goes through (clients from before ADR 0049)', () => {
    expect(changed({}, USD)).toBeNull();
  });

  it('a converted price must be stated: saying nothing is PRICE_CHANGED, never a blind charge', () => {
    expect(changed({}, CAD)?.code).toBe('PRICE_CHANGED');
    expect(changed({ expected_currency: 'CAD' }, CAD)?.code).toBe('PRICE_CHANGED');
  });

  it('answers 409 PRICE_CHANGED with the latest price when the rate moved the amount', () => {
    const error = changed({ expected_amount_cents: 6_900, expected_currency: 'CAD' }, CAD);
    expect(error?.code).toBe('PRICE_CHANGED');
    expect(error?.getStatus()).toBe(409);
    expect(error?.fields).toEqual([
      { field: 'expected_amount_cents', message: '7000' },
      { field: 'expected_currency', message: 'CAD' },
    ]);
  });

  it('a pricing publish between the page and the click is a changed price in USD too', () => {
    expect(changed({ expected_amount_cents: 4_900, expected_currency: 'USD' }, { ...USD, amountCents: 5_900, baseAmountCents: 5_900 })?.code).toBe('PRICE_CHANGED');
  });

  it('the right number in the wrong currency is a changed price', () => {
    expect(changed({ expected_amount_cents: 7_000, expected_currency: 'USD' }, CAD)?.code).toBe('PRICE_CHANGED');
    expect(changed({ expected_amount_cents: 4_900, expected_currency: 'CAD' }, USD)?.code).toBe('PRICE_CHANGED');
  });

  it('one cent off is a changed price', () => {
    expect(changed({ expected_amount_cents: 7_001, expected_currency: 'CAD' }, CAD)?.code).toBe('PRICE_CHANGED');
    expect(changed({ expected_amount_cents: 6_999, expected_currency: 'CAD' }, CAD)?.code).toBe('PRICE_CHANGED');
  });
});

describe('purchaseMoney', () => {
  it('a USD purchase stores its amount as its base and no rate', () => {
    expect(purchaseMoney(USD)).toEqual({ amountCents: 4_900, currency: 'USD', baseAmountCents: 4_900, baseCurrency: 'USD', fxRate: null, fxRateDate: null, fxRateId: null });
  });

  it('a CAD purchase stores the CAD amount, the USD price it came from, and the rate row that converted it', () => {
    const money = purchaseMoney(CAD);
    expect(money).toMatchObject({ amountCents: 7_000, currency: 'CAD', baseAmountCents: 4_900, baseCurrency: 'USD', fxRateId: FX.id });
    expect(money.fxRate?.toFixed()).toBe('1.4291');
    expect(money.fxRateDate?.toISOString()).toBe('2026-11-17T00:00:00.000Z');
  });
});

describe('amountMismatch (what Stripe collected against the purchase row)', () => {
  const session = (amount_total: number | null, currency: string | null): CheckoutSessionFacts => ({
    id: 'cs_test_1',
    payment_status: 'paid',
    status: 'complete',
    client_reference_id: null,
    metadata: {},
    customer: null,
    payment_intent: 'pi_1',
    invoice: null,
    amount_total,
    currency,
  });

  it('matches a USD charge to a USD purchase and a CAD charge to a CAD purchase', () => {
    expect(amountMismatch(session(4_900, 'usd'), { amountCents: 4_900, currency: 'USD' })).toBeNull();
    expect(amountMismatch(session(7_000, 'cad'), { amountCents: 7_000, currency: 'CAD' })).toBeNull();
    expect(amountMismatch(session(7_000, 'cad'), { amountCents: 7_000, currency: 'CAD' /* CHAR(3) */ })).toBeNull();
  });

  it('refuses the right amount in the wrong currency: 7000 USD is not 7000 CAD', () => {
    expect(amountMismatch(session(7_000, 'usd'), { amountCents: 7_000, currency: 'CAD' })).toMatch(/USD.*CAD/);
    expect(amountMismatch(session(4_900, 'cad'), { amountCents: 4_900, currency: 'USD' })).toMatch(/CAD.*USD/);
  });

  it('refuses a different amount in the right currency, by a cent', () => {
    expect(amountMismatch(session(7_001, 'cad'), { amountCents: 7_000, currency: 'CAD' })).toMatch(/7001.*7000/);
    expect(amountMismatch(session(4_900, 'cad'), { amountCents: 7_000, currency: 'CAD' })).not.toBeNull();
  });
});

/*
 * The §17 first-purchase rule is asked by checkout (of the quote) and by fulfil (of the row
 * the quote became). Both call this one function with the same facts, so a purchase
 * checkout lets through unreviewed can never be one fulfil refuses to credit.
 */
describe('firstPurchaseOverLimit', () => {
  const LIMIT = 100_000;
  const first = (amountCents: number, currency: string, fxRate: string | null) => firstPurchaseOverLimit({ hasPaidBefore: false, amountCents, currency, fxRate, baseLimitCents: LIMIT });

  it('USD: strictly over the limit, and only for a first purchase', () => {
    expect(first(100_000, 'USD', null)).toBe(false);
    expect(first(100_001, 'USD', null)).toBe(true);
    expect(firstPurchaseOverLimit({ hasPaidBefore: true, amountCents: 999_999, currency: 'USD', fxRate: null, baseLimitCents: LIMIT })).toBe(false);
  });

  it('CAD: the limit converted with the purchase’s own rate, as the column stores it', () => {
    expect(first(142_910, 'CAD', '1.4291')).toBe(false);
    expect(first(142_911, 'CAD', '1.4291')).toBe(true);
    // Checkout passes the quote's text, fulfil the Decimal(14, 8) column's: the same answer.
    expect(first(142_910, 'CAD ', '1.42910000')).toBe(false);
    expect(first(142_911, 'cad', '1.42910000')).toBe(true);
  });

  it('a CAD purchase with no rate of its own cannot be judged, and is reviewed whatever its amount', () => {
    expect(first(7_000, 'CAD', null)).toBe(true);
    expect(first(7_000, 'EUR', '1.1')).toBe(true);
    expect(firstPurchaseOverLimit({ hasPaidBefore: true, amountCents: 7_000, currency: 'CAD', fxRate: null, baseLimitCents: LIMIT })).toBe(false);
  });
});
