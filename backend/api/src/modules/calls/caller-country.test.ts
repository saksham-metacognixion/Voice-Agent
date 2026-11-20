import { describe, expect, it } from 'vitest';
import { callerCountry } from './caller-country';

describe('callerCountry (§13.9 allowed caller countries, ADR 0035)', () => {
  it('reads the country from an E.164 caller id', () => {
    expect(callerCountry('+14165550123')).toBe('CA');
    expect(callerCountry('+12125550123')).toBe('US');
    expect(callerCountry('+966501234567')).toBe('SA');
    expect(callerCountry('+442071234567')).toBe('GB');
    expect(callerCountry(' +14165550123 ')).toBe('CA');
  });

  it('answers null for a withheld, malformed or national number — never a guess', () => {
    expect(callerCountry(null)).toBeNull();
    expect(callerCountry(undefined)).toBeNull();
    expect(callerCountry('')).toBeNull();
    expect(callerCountry('anonymous')).toBeNull();
    expect(callerCountry('Restricted')).toBeNull();
    // A national number has nothing to say which country it is from.
    expect(callerCountry('4165550123')).toBeNull();
    expect(callerCountry('(416) 555-0123')).toBeNull();
    // Too short, or an exchange no plan assigns.
    expect(callerCountry('+1416')).toBeNull();
    expect(callerCountry('+11234567890')).toBeNull();
    // The carriers' anonymous-caller placeholder.
    expect(callerCountry('+266696687')).toBeNull();
  });
});
