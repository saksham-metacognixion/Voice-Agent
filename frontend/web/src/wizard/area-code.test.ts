import { describe, expect, it } from 'vitest';
import { buyNumberRequest, phonePlanRequest } from '@portal/schemas';
import { isAreaCodeNotInCountry, suggestAreaCode, suggestableAreaCodes } from './area-code';

describe('suggestAreaCode', () => {
  it('names a local code for a known zone in the chosen country', () => {
    expect(suggestAreaCode('CA', 'America/Toronto')).toEqual({ code: '416', basis: 'timezone' });
    expect(suggestAreaCode('CA', 'America/Vancouver')).toEqual({ code: '604', basis: 'timezone' });
    expect(suggestAreaCode('US', 'America/Los_Angeles')).toEqual({ code: '213', basis: 'timezone' });
  });

  it('falls back to the country when the zone is unknown or belongs to the other country', () => {
    expect(suggestAreaCode('US', 'America/Toronto')).toEqual({ code: '212', basis: 'country' });
    expect(suggestAreaCode('CA', 'Europe/Paris')).toEqual({ code: '416', basis: 'country' });
    expect(suggestAreaCode('CA', null)).toEqual({ code: '416', basis: 'country' });
  });

  it('only ever suggests a valid three-digit code', () => {
    for (const country of ['CA', 'US'] as const) {
      for (const zone of ['America/Toronto', 'America/Chicago', 'Pacific/Honolulu', 'Nowhere/Zone']) {
        expect(suggestAreaCode(country, zone).code).toMatch(/^[2-9]\d{2}$/);
      }
    }
  });
});

/* QA bug list, 17 Nov: the area code is checked for the country. */
describe('the area code check', () => {
  it('accepts every code Suggest can fill in, for its own country', () => {
    for (const country of ['CA', 'US'] as const) {
      for (const code of suggestableAreaCodes(country)) {
        expect(phonePlanRequest.safeParse({ option: 'new', country, area_code: code }).success, `${country} ${code}`).toBe(true);
      }
    }
  });

  it('tells "not an area code of this country" from a malformed code', () => {
    const issues = (body: unknown) => {
      const parsed = phonePlanRequest.safeParse(body);
      return parsed.success ? [] : parsed.error.issues;
    };
    expect(issues({ option: 'new', country: 'CA', area_code: '999' }).map(isAreaCodeNotInCountry)).toEqual([true]);
    expect(issues({ option: 'new', country: 'CA', area_code: '212' }).map(isAreaCodeNotInCountry)).toEqual([true]);
    expect(issues({ option: 'new', country: 'CA', area_code: '12' }).map(isAreaCodeNotInCountry)).toEqual([false]);
    expect(issues({ option: 'new', country: 'ZZ', area_code: '416' }).some(isAreaCodeNotInCountry)).toBe(false);
    const buy = buyNumberRequest.safeParse({ agent_id: '00000000-0000-4000-8000-000000000001', country: 'US', area_code: '416' });
    expect(buy.success ? [] : buy.error.issues.map(isAreaCodeNotInCountry)).toEqual([true]);
  });
});
