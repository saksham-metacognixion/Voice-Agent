import { describe, expect, it } from 'vitest';
import { ANSWER_MODES, buyNumberRequest, hoursMode, hoursModeUsesSchedule, phoneNumberResponse, phonePlanRequest, phonePlanResponse, sipCredentials } from './numbers.js';

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
