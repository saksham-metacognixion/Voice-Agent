import { describe, expect, it } from 'vitest';
import { addMonths } from './wallet.service';

/* §5.3 rental anniversaries and §5.4 12-month lot expiry: calendar months, clamped at month end. */

const at = (s: string) => new Date(s);

describe('addMonths', () => {
  it.each([
    ['2026-01-15T10:30:00Z', 1, '2026-02-15T10:30:00.000Z'],
    ['2026-01-31T00:00:00Z', 1, '2026-02-28T00:00:00.000Z'],
    ['2028-01-31T00:00:00Z', 1, '2028-02-29T00:00:00.000Z'],
    ['2026-03-31T23:59:59Z', 1, '2026-04-30T23:59:59.000Z'],
    ['2026-12-15T00:00:00Z', 1, '2027-01-15T00:00:00.000Z'],
    ['2026-11-04T12:00:00Z', 12, '2027-11-04T12:00:00.000Z'],
    ['2028-02-29T00:00:00Z', 12, '2029-02-28T00:00:00.000Z'],
    ['2026-03-31T00:00:00Z', -1, '2026-02-28T00:00:00.000Z'],
    ['2026-05-20T00:00:00Z', 0, '2026-05-20T00:00:00.000Z'],
  ])('%s + %i months = %s', (from, months, expected) => {
    expect(addMonths(at(from), months).toISOString()).toBe(expected);
  });

  it('does not mutate its argument', () => {
    const date = at('2026-01-31T00:00:00Z');
    addMonths(date, 1);
    expect(date.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('a clamped month does not drift back: Jan 31 → Feb 28 → Mar 28 when chained', () => {
    expect(addMonths(addMonths(at('2026-01-31T00:00:00Z'), 1), 1).toISOString()).toBe('2026-03-28T00:00:00.000Z');
    // Computed from the anniversary instead, March keeps the 31st.
    expect(addMonths(at('2026-01-31T00:00:00Z'), 2).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });
});
