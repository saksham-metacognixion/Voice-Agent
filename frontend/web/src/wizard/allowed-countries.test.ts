import { describe, expect, it } from 'vitest';
import { defaultAllowedCountries } from './allowed-countries';

describe('defaultAllowedCountries', () => {
  it('is the workspace country plus US and CA, each once', () => {
    expect(defaultAllowedCountries('CA')).toEqual(['CA', 'US']);
    expect(defaultAllowedCountries('US')).toEqual(['US', 'CA']);
    expect(defaultAllowedCountries('gb')).toEqual(['GB', 'US', 'CA']);
  });

  it('falls back to the launch countries when the workspace country is unreadable', () => {
    expect(defaultAllowedCountries(null)).toEqual(['US', 'CA']);
    expect(defaultAllowedCountries('Canada')).toEqual(['US', 'CA']);
  });
});
