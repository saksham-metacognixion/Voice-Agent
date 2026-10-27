import { describe, expect, it } from 'vitest';
import { forwardingTestMatch, parseForwardingTestMarker } from './forwarding-test';

const marker = { test_id: 't1', number_id: 'n1', workspace_id: 'w1', original: '+14165550100' };

describe('parseForwardingTestMarker', () => {
  it('reads a marker', () => {
    expect(parseForwardingTestMarker(JSON.stringify(marker))).toEqual(marker);
  });

  it('reads nothing from an absent, unreadable or partial value', () => {
    expect(parseForwardingTestMarker(null)).toBeNull();
    expect(parseForwardingTestMarker('{')).toBeNull();
    expect(parseForwardingTestMarker(JSON.stringify({ test_id: 't1' }))).toBeNull();
  });
});

describe('forwardingTestMatch', () => {
  const to = '+14505550123';

  it('recognises the forwarded leg showing our own number as the caller', () => {
    expect(forwardingTestMatch(marker, { numberId: 'n1', from: to, to })).toBe('ours');
  });

  it('recognises a carrier that passes the forwarding line instead', () => {
    expect(forwardingTestMatch(marker, { numberId: 'n1', from: '+1 (416) 555-0100', to })).toBe('original');
  });

  it('leaves a real caller alone while a test is ringing', () => {
    expect(forwardingTestMatch(marker, { numberId: 'n1', from: '+12125550199', to })).toBeNull();
  });

  it('never matches without a marker, a caller, or on another number', () => {
    expect(forwardingTestMatch(null, { numberId: 'n1', from: to, to })).toBeNull();
    expect(forwardingTestMatch(marker, { numberId: 'n1', from: null, to })).toBeNull();
    expect(forwardingTestMatch(marker, { numberId: 'n2', from: to, to })).toBeNull();
  });
});
