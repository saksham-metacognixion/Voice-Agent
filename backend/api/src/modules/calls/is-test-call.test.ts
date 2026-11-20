import { describe, expect, it } from 'vitest';
import { isTestCall } from './calls.service';

/* D17 / ADR 0029: `is_test` is what we minted — `metadata.test` when boolean, else channel = web. */

const call = (over: Record<string, unknown>) => ({ call_id: 'c-1', call_type: 'phone_call', ...over }) as never;

describe('isTestCall', () => {
  it('a W5 browser test (test: true on web) is a test', () => {
    expect(isTestCall(call({ call_type: 'web_call', metadata: { test: true } }))).toBe(true);
  });

  it('"Call my phone" (test: true on a phone call) is a test', () => {
    expect(isTestCall(call({ call_type: 'phone_call', metadata: { test: true } }))).toBe(true);
  });

  it('the website widget (test: false on web) is a real caller', () => {
    expect(isTestCall(call({ call_type: 'web_call', metadata: { test: false } }))).toBe(false);
  });

  it('an inbound phone call with no metadata is real', () => {
    expect(isTestCall(call({ call_type: 'phone_call' }))).toBe(false);
  });

  it('a web call without a boolean flag falls back to the channel (test)', () => {
    expect(isTestCall(call({ call_type: 'web_call' }))).toBe(true);
    expect(isTestCall(call({ call_type: 'web_call', metadata: { test: 'false' } }))).toBe(true);
  });

  it('a string "true" on a phone call is not a test flag', () => {
    expect(isTestCall(call({ call_type: 'phone_call', metadata: { test: 'true' } }))).toBe(false);
  });
});
