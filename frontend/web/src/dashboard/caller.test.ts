import { describe, expect, it } from 'vitest';
import { callerLabel, otherPartyNumber, webCaller } from './caller';

describe('webCaller', () => {
  it('tells a browser test from a website visitor, and leaves phone calls to their number', () => {
    expect(webCaller({ channel: 'web', is_test: true })).toBe('browserTest');
    expect(webCaller({ channel: 'web', is_test: false })).toBe('websiteVisitor');
    expect(webCaller({ channel: 'phone', is_test: true })).toBeNull();
  });
});

describe('callerLabel', () => {
  const t = (key: string) => `[${key}]`;

  it('names a web call by who made it, a phone call by its number, and a call without one as unknown', () => {
    expect(callerLabel({ channel: 'web', is_test: false, from_number: null }, t)).toBe('[websiteVisitor]');
    expect(callerLabel({ channel: 'web', is_test: true, from_number: null }, t)).toBe('[browserTest]');
    expect(callerLabel({ channel: 'phone', is_test: false, from_number: '+14165550123' }, t)).toContain('+1 416 555 0123');
    expect(callerLabel({ channel: 'phone', is_test: false, from_number: null }, t)).toBe('[unknownCaller]');
  });

  it('names an outbound call by the number it rang', () => {
    expect(callerLabel({ channel: 'phone', is_test: false, direction: 'outbound', from_number: '+14165550100', to_number: '+14165550123' }, t)).toContain('+1 416 555 0123');
    expect(callerLabel({ channel: 'phone', is_test: false, direction: 'outbound', from_number: '+14165550100', to_number: null }, t)).toBe('[unknownCaller]');
    expect(callerLabel({ channel: 'phone', is_test: false, direction: 'inbound', from_number: '+14165550123', to_number: '+14165550100' }, t)).toContain('+1 416 555 0123');
  });
});

describe('otherPartyNumber (QA-077)', () => {
  it('is the caller on an inbound call and the number we rang on an outbound one', () => {
    expect(otherPartyNumber({ channel: 'phone', is_test: false, direction: 'inbound', from_number: '+14165550123', to_number: '+14505550100' })).toBe('+14165550123');
    expect(otherPartyNumber({ channel: 'phone', is_test: true, direction: 'outbound', from_number: '+14505550100', to_number: '+14165550123' })).toBe('+14165550123');
  });

  it('is null for a web call and for a phone call without a number', () => {
    expect(otherPartyNumber({ channel: 'web', is_test: false, from_number: '+14165550123' })).toBeNull();
    expect(otherPartyNumber({ channel: 'web', is_test: true, from_number: null })).toBeNull();
    expect(otherPartyNumber({ channel: 'phone', is_test: false, from_number: null })).toBeNull();
    expect(otherPartyNumber({ channel: 'phone', is_test: false, from_number: '  ' })).toBeNull();
  });
});
