import { describe, expect, it } from 'vitest';
import { COUNTRIES, LAUNCH_COUNTRIES, isLaunchCountry } from './countries';

describe('launch countries (§6.3 A3, ADR 0036 §10)', () => {
  it('are the United States and Canada, in any case', () => {
    expect([...LAUNCH_COUNTRIES].sort()).toEqual(['CA', 'US']);
    expect(isLaunchCountry('us')).toBe(true);
    expect(isLaunchCountry('CA')).toBe(true);
  });
  it('lists the rest as coming soon, never selectable, and handles nothing', () => {
    expect(COUNTRIES.filter((c) => !isLaunchCountry(c.code)).length).toBeGreaterThan(0);
    expect(isLaunchCountry('GB')).toBe(false);
    expect(isLaunchCountry('')).toBe(false);
    expect(isLaunchCountry(null)).toBe(false);
  });
});
