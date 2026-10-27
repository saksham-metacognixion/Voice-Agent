import { describe, expect, it } from 'vitest';
import { checkTestDestination } from './call-my-phone';

describe('checkTestDestination', () => {
  it('accepts a real number in an allowed country, normalised to E.164', () => {
    expect(checkTestDestination('+1 416 555 0123', ['CA'])).toMatchObject({ ok: true, country: 'CA' });
    expect(checkTestDestination('+12125551234', ['US', 'CA'])).toEqual({ ok: true, e164: '+12125551234', country: 'US' });
  });

  it('refuses a number that is not real for its country', () => {
    expect(checkTestDestination('+11234567890', ['US', 'CA'])).toEqual({ ok: false, reason: 'invalid' });
    expect(checkTestDestination('not a number', ['US'])).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a country the call may not go to', () => {
    expect(checkTestDestination('+966501234567', ['US', 'CA'])).toEqual({ ok: false, reason: 'country' });
    expect(checkTestDestination('+966501234567', ['SA'])).toMatchObject({ ok: true, country: 'SA' });
  });

  it('refuses a premium-rate number', () => {
    expect(checkTestDestination('+19005551234', ['US'])).toEqual({ ok: false, reason: 'type' });
  });
});
