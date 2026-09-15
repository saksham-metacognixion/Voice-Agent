import { describe, expect, it } from 'vitest';
import { allocateFifo, lotRemainingAfterSettling, roundCredits } from './fifo';

describe('roundCredits', () => {
  it('rounds half up to two decimals without float drift', () => {
    expect(roundCredits(1.005)).toBe(1.01);
    expect(roundCredits(1.25915)).toBe(1.26);
    expect(roundCredits(0.004)).toBe(0);
    expect(roundCredits(2.675)).toBe(2.68);
    expect(roundCredits(0.1 + 0.2)).toBe(0.3);
  });
});

describe('allocateFifo', () => {
  const lots = [
    { id: 'a', remaining: 4 }, // expires first
    { id: 'b', remaining: 10 },
    { id: 'c', remaining: 100 },
  ];

  it('draws from the earliest-expiring lot first and spills into the next', () => {
    expect(allocateFifo(lots, 5.5)).toEqual({ draws: [{ id: 'a', take: 4 }, { id: 'b', take: 1.5 }], uncovered: 0 });
  });

  it('skips empty lots', () => {
    expect(allocateFifo([{ id: 'z', remaining: 0 }, ...lots], 1)).toEqual({ draws: [{ id: 'a', take: 1 }], uncovered: 0 });
  });

  it('reports what no lot could cover so the grace overdraft can absorb it', () => {
    expect(allocateFifo(lots, 120)).toEqual({
      draws: [{ id: 'a', take: 4 }, { id: 'b', take: 10 }, { id: 'c', take: 100 }],
      uncovered: 6,
    });
    expect(allocateFifo([], 1.26)).toEqual({ draws: [], uncovered: 1.26 });
  });

  it('is exact to the cent across many small draws', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), remaining: 0.1 }));
    const out = allocateFifo(many, 2.95);
    expect(out.uncovered).toBe(0);
    expect(roundCredits(out.draws.reduce((s, d) => s + d.take, 0))).toBe(2.95);
    expect(out.draws.length).toBe(30);
    expect(out.draws.at(-1)?.take).toBeCloseTo(0.05, 10);
  });

  it('draws nothing for a zero amount', () => {
    expect(allocateFifo(lots, 0)).toEqual({ draws: [], uncovered: 0 });
  });
});

describe('lotRemainingAfterSettling', () => {
  it('settles an overdraft out of the new lot and never goes negative', () => {
    expect(lotRemainingAfterSettling(150, 0)).toBe(150);
    expect(lotRemainingAfterSettling(150, 12.5)).toBe(150);
    expect(lotRemainingAfterSettling(150, -6)).toBe(144);
    expect(lotRemainingAfterSettling(5, -9.99)).toBe(0);
  });
});
