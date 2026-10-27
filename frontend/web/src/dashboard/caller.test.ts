import { describe, expect, it } from 'vitest';
import { callerLabel, webCaller } from './caller';

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
});
