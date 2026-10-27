import { describe, expect, it } from 'vitest';
import { webCaller } from './caller';

describe('webCaller', () => {
  it('tells a browser test from a website visitor, and leaves phone calls to their number', () => {
    expect(webCaller({ channel: 'web', is_test: true })).toBe('browserTest');
    expect(webCaller({ channel: 'web', is_test: false })).toBe('websiteVisitor');
    expect(webCaller({ channel: 'phone', is_test: true })).toBeNull();
  });
});
