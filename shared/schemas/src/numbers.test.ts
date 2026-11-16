import { describe, expect, it } from 'vitest';
import { ANSWER_MODES, buyNumberRequest, hoursMode, hoursModeUsesSchedule, importNumberRequest, updateNumberRequest, phoneNumberResponse, phonePlanRequest, phonePlanResponse, sipCredentials } from './numbers.js';

/* §8 W6 fields (ADR 0040): the answer modes, Option B's forward mode and Option C's provider and transport. */

describe('hours modes', () => {
  it('offers the spec’s three answer modes on W6 and keeps D4’s two', () => {
    expect([...ANSWER_MODES]).toEqual(['always', 'outside_hours', 'unanswered']);
    expect(hoursMode.options).toEqual(['always', 'business', 'custom', 'outside_hours', 'unanswered']);
  });

  it('reads a clock only for the scheduled modes', () => {
    expect(hoursMode.options.filter(hoursModeUsesSchedule)).toEqual(['business', 'custom', 'outside_hours']);
  });
});

describe('phonePlanRequest', () => {
  it('Option B carries a forward mode, always by default', () => {
    const parsed = phonePlanRequest.parse({ option: 'forward', country: 'CA', existing_number: '+14505550123' });
    expect(parsed.option === 'forward' && parsed.forward_mode).toBe('always');
    const busy = phonePlanRequest.parse({ option: 'forward', country: 'CA', existing_number: '+14505550123', forward_mode: 'busy_no_answer', hours_mode: 'unanswered' });
    expect(busy).toMatchObject({ forward_mode: 'busy_no_answer', hours_mode: 'unanswered' });
    expect(phonePlanRequest.safeParse({ option: 'forward', country: 'CA', existing_number: '+14505550123', forward_mode: 'sometimes' }).success).toBe(false);
  });

  it('Option C takes a provider and a transport, with the platform defaults', () => {
    expect(sipCredentials.parse({ number: '+14505550123', host: 'sip.example.com' })).toMatchObject({ provider: 'other', transport: 'TCP' });
    expect(sipCredentials.parse({ number: '+14505550123', host: 'sip.example.com', provider: 'twilio', transport: 'TLS' })).toMatchObject({ provider: 'twilio', transport: 'TLS' });
    expect(sipCredentials.safeParse({ number: '+14505550123', host: 'sip.example.com', transport: 'SCTP' }).success).toBe(false);
    expect(sipCredentials.safeParse({ number: '+14505550123', host: 'sip.example.com', provider: 'asterisk' }).success).toBe(false);
  });

  it('a bought number may record the forward mode too (D4 "Add number")', () => {
    expect(buyNumberRequest.parse({ agent_id: '00000000-0000-4000-8000-000000000001', country: 'US', forward_from: '+14505550123', forward_mode: 'outside_hours' }).forward_mode).toBe('outside_hours');
  });
});

describe('responses written before the fields existed', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000001',
    agent_id: '00000000-0000-4000-8000-000000000002',
    option: 'sip',
    country: null,
    area_code: null,
    toll_free: false,
    existing_number: null,
    carrier: null,
    sip: { number: '+14505550123', host: 'h', username: null, has_password: false },
    hours_mode: 'always',
    transfer_targets: [],
    allowed_countries: [],
    status: 'pending',
    number_id: null,
    created_at: '2026-11-06T00:00:00.000Z',
    updated_at: '2026-11-06T00:00:00.000Z',
  };

  it('a plan without forward_mode, provider or transport still parses with the defaults', () => {
    const parsed = phonePlanResponse.parse(base);
    expect(parsed.forward_mode).toBeNull();
    expect(parsed.sip).toMatchObject({ provider: 'other', transport: 'TCP' });
  });

  it('a number without the new SIP and forwarding fields still parses', () => {
    const parsed = phoneNumberResponse.parse({
      ...base,
      nickname: null,
      kind: 'sip',
      e164: '+14505550123',
      requested_area_code: null,
      status: 'active',
      paused: false,
      hours_override: null,
      transfer_fail_message: null,
      blocklist: [],
      forwarding: { from: '+14505550199', status: 'ready', carrier: null },
      sip: { host: 'h', username: null, has_password: false },
      calls_7d: 0,
      rental_credits: 0,
      next_rental_at: null,
      error: null,
    });
    expect(parsed.forwarding?.mode).toBeNull();
    expect(parsed.sip).toMatchObject({ provider: 'other', transport: 'TCP', origination_uri: null, verification: null });
  });
});

/*
 * QA-107 / ORL-NUM-628: the line a customer keeps (Option B) and the line they bring
 * (Option C) carry their country code. `5145550123` read with an implied `+` is Peru and
 * `4165550101` Switzerland; both used to be stored, bought against and rung by
 * "Test forwarding". The same rule on W6 (phone plan), D4 "Add number" (buy and import).
 */
describe('QA-107: the forwarded and the own line need their country code', () => {
  const AGENT = '00000000-0000-4000-8000-000000000001';
  const SIP = { host: 'sip.example.com' };
  const refused = ['5145550123', '4165550101', '+5145550123', '+4165550101', '+9995551234', '', '+', 'abc', '+1 514 555', '+1 (514) 555-0123'];
  const accepted = ['+15145550123', '+14165550101', '+442071838750', '+33142685300', '+919876543210'];

  const entryPoints: Array<[string, (n: string) => boolean]> = [
    ['W6 Option B (existing_number)', (n) => phonePlanRequest.safeParse({ option: 'forward', country: 'CA', existing_number: n }).success],
    ['W6 Option C (sip.number)', (n) => phonePlanRequest.safeParse({ option: 'sip', sip: { ...SIP, number: n } }).success],
    ['D4 Keep your number (forward_from)', (n) => buyNumberRequest.safeParse({ agent_id: AGENT, country: 'CA', forward_from: n }).success],
    ['D4 Bring your own line (sip.number)', (n) => importNumberRequest.safeParse({ agent_id: AGENT, sip: { ...SIP, number: n } }).success],
    ['D4 Forwarding, correcting the line (forwarding_from)', (n) => updateNumberRequest.safeParse({ forwarding_from: n }).success],
  ];

  for (const [name, accepts] of entryPoints) {
    it(`${name}: refuses a number without its country code, an invalid one or a malformed one`, () => {
      for (const n of refused) expect(accepts(n), n).toBe(false);
    });
    it(`${name}: accepts real numbers in E.164, North American and international`, () => {
      for (const n of accepted) expect(accepts(n), n).toBe(true);
    });
  }

  it('names the field a 422 points at', () => {
    const forward = buyNumberRequest.safeParse({ agent_id: AGENT, country: 'CA', forward_from: '5145550123' });
    expect(new Set(forward.success ? [] : forward.error.issues.map((i) => i.path.join('.')))).toEqual(new Set(['forward_from']));
    const sip = importNumberRequest.safeParse({ agent_id: AGENT, sip: { ...SIP, number: '+5145550123' } });
    expect(new Set(sip.success ? [] : sip.error.issues.map((i) => i.path.join('.')))).toEqual(new Set(['sip.number']));
  });
});
