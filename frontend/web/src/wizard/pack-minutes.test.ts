import { describe, expect, it } from 'vitest';
import { defaultTopupPercent, packMinutes, topupThreshold } from './pack-minutes';

describe('packMinutes', () => {
  it('is whole minutes at the tier rate, floored', () => {
    expect(packMinutes(150, 1)).toBe(150);
    expect(packMinutes(150, 1.5)).toBe(100);
    expect(packMinutes(500, 1.5)).toBe(333);
  });

  it('says nothing without a usable rate', () => {
    expect(packMinutes(150, 0)).toBeNull();
    expect(packMinutes(150, Number.NaN)).toBeNull();
    expect(packMinutes(-1, 1)).toBeNull();
  });
});

describe('top-up thresholds', () => {
  it('is 10 % or 20 % of the pack, never under the API’s floor', () => {
    expect(topupThreshold(500, 10)).toBe(50);
    expect(topupThreshold(500, 20)).toBe(100);
    expect(topupThreshold(150, 10)).toBe(15);
    expect(topupThreshold(50, 10)).toBe(10);
  });

  it('starts on the policy’s percentage when it is one of the two, else 10', () => {
    expect(defaultTopupPercent(20)).toBe(20);
    expect(defaultTopupPercent(10)).toBe(10);
    expect(defaultTopupPercent(15)).toBe(10);
    expect(defaultTopupPercent(null)).toBe(10);
  });
});
