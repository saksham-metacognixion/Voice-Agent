import { describe, expect, it } from 'vitest';
import { COUNTRIES, COUNTRY_ZONES, countryOfZone, defaultZoneFor, zoneInCountry } from './countries';

describe('country ↔ time zone (BUG-008 #4)', () => {
  it('defaults a Canadian workspace to a Canadian zone, not the browser’s Indian one', () => {
    expect(defaultZoneFor('CA', 'Asia/Calcutta')).toBe('America/Toronto');
    expect(defaultZoneFor('CA', 'America/Vancouver')).toBe('America/Vancouver');
    expect(defaultZoneFor('IN', 'America/Toronto')).toBe('Asia/Kolkata');
  });

  it('knows multi-zone countries, including prefixes', () => {
    expect(zoneInCountry('America/Indiana/Indianapolis', 'US')).toBe(true);
    expect(zoneInCountry('Australia/Perth', 'AU')).toBe(true);
    expect(zoneInCountry('Asia/Kolkata', 'CA')).toBe(false);
    expect(zoneInCountry('Anything/Else', 'ZZ')).toBe(true);
  });

  it('finds the country of the browser’s zone', () => {
    expect(countryOfZone('Asia/Kolkata')).toBe('IN');
    expect(countryOfZone('America/Edmonton')).toBe('CA');
    expect(countryOfZone('Europe/London')).toBe('GB');
    expect(countryOfZone('Antarctica/Troll')).toBeNull();
  });

  it('lists a zone for every country the picker offers, and the main zone is a real one', () => {
    for (const { code } of COUNTRIES) {
      const main = COUNTRY_ZONES[code]?.[0];
      expect(main, code).toBeTruthy();
      expect(() => new Intl.DateTimeFormat('en', { timeZone: main })).not.toThrow();
    }
  });
});
