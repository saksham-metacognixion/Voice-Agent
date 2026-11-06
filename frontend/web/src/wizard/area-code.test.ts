import { describe, expect, it } from 'vitest';
import { suggestAreaCode } from './area-code';

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
