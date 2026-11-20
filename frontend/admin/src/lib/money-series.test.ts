import { describe, expect, it } from 'vitest';
import { currenciesIn, shownCurrency } from './money-series';

describe('per-currency chart series', () => {
  const days = [
    { day: '2026-11-01', by_currency: [{ currency: 'USD', sales_cents: 4900 }] },
    { day: '2026-11-02', by_currency: [{ currency: 'USD', sales_cents: 4900 }, { currency: 'CAD', sales_cents: 6500 }] },
    { day: '2026-11-03', by_currency: [] },
  ];

  it('lists each currency once, in a stable order', () => {
    expect(currenciesIn(days, (d) => d.by_currency)).toEqual(['CAD', 'USD']);
    expect(currenciesIn([], () => [])).toEqual([]);
  });

  it('keeps the picked currency only while it has data', () => {
    expect(shownCurrency('USD', ['CAD', 'USD'])).toBe('USD');
    expect(shownCurrency('EUR', ['CAD', 'USD'])).toBe('CAD');
    expect(shownCurrency(null, [])).toBe('USD');
  });
});
