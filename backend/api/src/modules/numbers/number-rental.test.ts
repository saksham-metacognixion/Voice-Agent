import { describe, expect, it } from 'vitest';
import { daysBetween, decideRental } from './number-rental.service';

describe('decideRental (§5.3)', () => {
  it('charges while the balance after the rental stays within the grace overdraft', () => {
    expect(decideRental({ balance: 100, rental: 15, grace: 10 })).toBe('charge');
    expect(decideRental({ balance: 15, rental: 15, grace: 10 })).toBe('charge');
    expect(decideRental({ balance: 5, rental: 15, grace: 10 })).toBe('charge'); // → −10, exactly the grace
  });

  it('goes overdue instead of debiting past the grace', () => {
    expect(decideRental({ balance: 4.99, rental: 15, grace: 10 })).toBe('overdue');
    expect(decideRental({ balance: 0, rental: 15, grace: 10 })).toBe('overdue');
    expect(decideRental({ balance: -9, rental: 15, grace: 10 })).toBe('overdue');
  });

  it('a zero rental (SIP, or a free plan) is always a charge of nothing', () => {
    expect(decideRental({ balance: -50, rental: 0, grace: 10 })).toBe('charge');
  });
});

describe('daysBetween', () => {
  it('floors to whole days and never goes negative', () => {
    const since = new Date('2026-09-01T10:00:00Z');
    expect(daysBetween(since, new Date('2026-09-01T12:00:00Z'))).toBe(0);
    expect(daysBetween(since, new Date('2026-09-08T09:59:00Z'))).toBe(6);
    expect(daysBetween(since, new Date('2026-09-08T10:00:00Z'))).toBe(7);
    expect(daysBetween(since, new Date('2026-08-01T10:00:00Z'))).toBe(0);
  });
});
