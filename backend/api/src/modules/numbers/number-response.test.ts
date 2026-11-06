import { describe, expect, it } from 'vitest';
import { FORWARDING_TEST_RING_MS } from '../calls/forwarding-test';
import { SIP_VERIFY_LEASE_MS, forwardingTestOf, parseForwardMode, parseTargets, toNumberResponse, verificationOf } from './number-response';

/* D4 / D11 / D16 / D17: what a phone number row looks like on the wire. */

const NOW = Date.parse('2026-11-04T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function numberRow(over: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    agentId: 'a-1',
    e164: '+14165550123',
    nickname: 'num-abc',
    type: 'retell_twilio',
    country: 'CA',
    areaCode: '416',
    tollFree: false,
    status: 'active',
    pausedAt: null,
    hoursMode: 'always',
    hoursOverrideJson: null,
    transferTargetsJson: [{ label: 'Front desk', number: '+14165550199' }],
    allowedCountries: [],
    blocklist: [],
    forwardingFrom: null,
    forwardingStatus: null,
    carrier: null,
    rentalCredits: 15,
    nextRentalAt: new Date('2026-12-04T00:00:00Z'),
    error: 'should not leak',
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-02T00:00:00Z'),
    ...over,
  } as never;
}

describe('toNumberResponse', () => {
  it('a bought number names no vendor and carries no SIP block', () => {
    const wire = toNumberResponse(numberRow(), 7);
    expect(wire).toMatchObject({ kind: 'bought', sip: null, calls_7d: 7, paused: false, error: null, requested_area_code: null, forwarding: null });
    expect(JSON.stringify(wire)).not.toMatch(/twilio|telnyx/i);
    expect(wire).not.toHaveProperty('type');
  });

  it('the error is shown only on a failed number', () => {
    expect(toNumberResponse(numberRow({ status: 'failed' })).error).toBe('should not leak');
  });

  it('paused is true from either the column or the status', () => {
    expect(toNumberResponse(numberRow({ pausedAt: new Date() })).paused).toBe(true);
    expect(toNumberResponse(numberRow({ status: 'paused' })).paused).toBe(true);
  });

  it('a forward target defaults to waiting_for_customer', () => {
    expect(toNumberResponse(numberRow({ forwardingFrom: '+14165550100' })).forwarding).toEqual({
      from: '+14165550100',
      status: 'waiting_for_customer',
      carrier: null,
      mode: null,
      test: null,
    });
  });

  it('carries the forward mode the plan recorded, and reads an unknown value as not said (ADR 0040)', () => {
    expect(toNumberResponse(numberRow({ forwardingFrom: '+14165550100', forwardMode: 'busy_no_answer' })).forwarding?.mode).toBe('busy_no_answer');
    expect(toNumberResponse(numberRow({ forwardingFrom: '+14165550100', forwardMode: 'sometimes' })).forwarding?.mode).toBeNull();
    expect(parseForwardMode('outside_hours')).toBe('outside_hours');
    expect(parseForwardMode(undefined)).toBeNull();
  });

  it('a SIP number shows host, username and has_password — never the sealed password', () => {
    const sealed = { v: 1, kid: 'local:abc', edk: 'EDK-SECRET', iv: 'IV', tag: 'TAG', ct: 'CIPHERTEXT-SECRET' };
    const wire = toNumberResponse(
      numberRow({ type: 'custom_sip', plan: { sipJson: { number: '+14165550123', host: 'sip.example.com', username: 'trunk', password: sealed } } }),
    );
    expect(wire.kind).toBe('sip');
    expect(wire.sip).toEqual({ host: 'sip.example.com', username: 'trunk', has_password: true, provider: 'other', transport: 'TCP', origination_uri: null, verification: null });
    expect(JSON.stringify(wire)).not.toMatch(/EDK-SECRET|CIPHERTEXT-SECRET/);
  });

  it('a SIP number carries its provider, transport and the environment origination address (ADR 0040)', () => {
    const sipJson = { number: '+14165550123', host: 'h', username: null, password: null, provider: 'twilio', transport: 'TLS' };
    const wire = toNumberResponse(numberRow({ type: 'custom_sip', plan: { sipJson }, originationUri: 'sip:env.example.net' }));
    expect(wire.sip).toMatchObject({ provider: 'twilio', transport: 'TLS', origination_uri: 'sip:env.example.net' });
    const before = process.env.SIP_ORIGINATION_URI;
    process.env.SIP_ORIGINATION_URI = 'sip:from-env.example.net';
    try {
      expect(toNumberResponse(numberRow({ type: 'custom_sip', plan: { sipJson } })).sip?.origination_uri).toBe('sip:from-env.example.net');
    } finally {
      if (before === undefined) delete process.env.SIP_ORIGINATION_URI;
      else process.env.SIP_ORIGINATION_URI = before;
    }
  });

  it('a SIP number without a password says so; unreadable credentials show no SIP block', () => {
    const plan = (sipJson: unknown) => numberRow({ type: 'custom_sip', plan: { sipJson } });
    expect(toNumberResponse(plan({ number: '+14165550123', host: 'h', username: null, password: null })).sip).toMatchObject({ has_password: false });
    expect(toNumberResponse(plan({ host: 'h' })).sip).toBeNull();
  });

  it('unreadable hours read as none', () => {
    expect(toNumberResponse(numberRow({ hoursOverrideJson: 'closed' })).hours_override).toBeNull();
    expect(toNumberResponse(numberRow({ hoursOverrideJson: { days: 'weekdays' } })).hours_override).toBeNull();
  });
});

describe('parseTargets', () => {
  it('keeps valid targets and drops the rest', () => {
    expect(
      parseTargets([
        { label: 'Front desk', number: '+14165550199' },
        { label: '', number: '+14165550199' },
        { label: 'Bad', number: '416-555-0199' },
        null,
        'x',
      ]),
    ).toEqual([{ label: 'Front desk', number: '+14165550199' }]);
  });

  it.each([null, undefined, {}, 'x', 5])('%j is no targets', (value) => {
    expect(parseTargets(value)).toEqual([]);
  });
});

describe('verificationOf (D16 SIP re-verify)', () => {
  const last = { status: 'verified', checked_at: iso(NOW - 3_600_000), reason: null, checks: { trunk: 'auth_accepted', platform: 'synced' }, credentials_updated: false };

  it('reads the stored result when no lease is held', () => {
    expect(verificationOf({ sipVerificationJson: last, sipVerifyStartedAt: null }, NOW)).toEqual(last);
  });

  it('reads pending while the lease is live, keeping the last check time', () => {
    expect(verificationOf({ sipVerificationJson: last, sipVerifyStartedAt: new Date(NOW - SIP_VERIFY_LEASE_MS + 1) }, NOW)).toEqual({
      status: 'pending',
      checked_at: last.checked_at,
      reason: null,
      checks: null,
      credentials_updated: false,
    });
  });

  it('an expired lease no longer reads as pending', () => {
    expect(verificationOf({ sipVerificationJson: last, sipVerifyStartedAt: new Date(NOW - SIP_VERIFY_LEASE_MS) }, NOW)).toEqual(last);
  });

  it('unreadable JSON reads as never checked', () => {
    expect(verificationOf({ sipVerificationJson: { status: 'bogus' } }, NOW)).toBeNull();
  });
});

describe('forwardingTestOf (D17)', () => {
  const calling = (startedMsAgo: number) => ({ status: 'calling', started_at: iso(NOW - startedMsAgo), finished_at: null, caller_id: null });

  it('a test still inside its ring window and grace stays calling', () => {
    expect(forwardingTestOf({ forwardingTestJson: calling(FORWARDING_TEST_RING_MS + 60_000) }, NOW)?.status).toBe('calling');
  });

  it('a calling test past ring window + grace reads as not_landed, finished at the window’s end', () => {
    const started = NOW - FORWARDING_TEST_RING_MS - 60_001;
    expect(forwardingTestOf({ forwardingTestJson: calling(FORWARDING_TEST_RING_MS + 60_001) }, NOW)).toEqual({
      status: 'not_landed',
      started_at: iso(started),
      finished_at: iso(started + FORWARDING_TEST_RING_MS),
      caller_id: null,
    });
  });

  it('a finished test is returned as stored, however old', () => {
    const landed = { status: 'landed', started_at: iso(NOW - 86_400_000), finished_at: iso(NOW - 86_390_000), caller_id: 'ours' };
    expect(forwardingTestOf({ forwardingTestJson: landed }, NOW)).toEqual(landed);
  });

  it('no or unreadable JSON is no test', () => {
    expect(forwardingTestOf({}, NOW)).toBeNull();
    expect(forwardingTestOf({ forwardingTestJson: { status: 'calling' } }, NOW)).toBeNull();
  });
});
