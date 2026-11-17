import { describe, expect, it } from 'vitest';
import type { SafeParseReturnType } from 'zod';
import { ANSWER_MODES, AREA_CODE_NOT_IN_COUNTRY, buyNumberRequest, hoursMode, hoursModeUsesSchedule, importNumberRequest, updateNumberRequest, phoneNumberResponse, phonePlanRequest, phonePlanResponse, sipCredentials } from './numbers.js';

/* §8 W6 fields (ADR 0040): the answer modes, Option B's forward mode and Option C's provider and transport. */

type Parsed = SafeParseReturnType<unknown, unknown>;

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
    ['W6 Option C (sip.number)', (n) => phonePlanRequest.safeParse({ option: 'sip', carrier_consent: true, sip: { ...SIP, number: n } }).success],
    ['D4 Keep your number (forward_from)', (n) => buyNumberRequest.safeParse({ agent_id: AGENT, country: 'CA', forward_from: n }).success],
    ['D4 Bring your own line (sip.number)', (n) => importNumberRequest.safeParse({ agent_id: AGENT, carrier_consent: true, sip: { ...SIP, number: n } }).success],
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
    const sip = importNumberRequest.safeParse({ agent_id: AGENT, carrier_consent: true, sip: { ...SIP, number: '+5145550123' } });
    expect(new Set(sip.success ? [] : sip.error.issues.map((i) => i.path.join('.')))).toEqual(new Set(['sip.number']));
  });
});

/*
 * QA bug list, 17 Nov: "Number step accepts an area code that does not exist; the purchase
 * then uses another code". The same rule on W6 (new and forward) and D4 "Add number".
 */
describe('the area code is one of the chosen country', () => {
  const AGENT = '00000000-0000-4000-8000-000000000001';
  const entryPoints: Array<[string, (country: string, code: string | undefined, tollFree?: boolean) => Parsed]> = [
    ['W6 Get a new number', (country, code, tollFree) => phonePlanRequest.safeParse({ option: 'new', country, area_code: code, toll_free: tollFree })],
    ['W6 Keep your number', (country, code) => phonePlanRequest.safeParse({ option: 'forward', country, area_code: code, existing_number: '+15145550123' })],
    ['D4 Add number', (country, code, tollFree) => buyNumberRequest.safeParse({ agent_id: AGENT, country, area_code: code, toll_free: tollFree })],
  ];

  for (const [name, parse] of entryPoints) {
    it(`${name}: refuses a code that exists nowhere, a toll-free code and the other country's code, on area_code`, () => {
      for (const [country, code] of [['CA', '999'], ['US', '999'], ['CA', '555'], ['CA', '800'], ['CA', '212'], ['US', '416'], ['US', '787']] as const) {
        const result = parse(country, code);
        expect(result.success, `${country} ${code}`).toBe(false);
        if (!result.success) expect(result.error.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['area_code', AREA_CODE_NOT_IN_COUNTRY]]);
      }
    });

    it(`${name}: accepts a code of the country, and no code at all`, () => {
      for (const [country, code] of [['CA', '416'], ['CA', '647'], ['CA', '514'], ['CA', '236'], ['US', '212'], ['US', '415'], ['US', '907']] as const) {
        expect(parse(country, code).success, `${country} ${code}`).toBe(true);
      }
      expect(parse('CA', undefined).success).toBe(true);
    });
  }

  it('a malformed code keeps its one shape issue', () => {
    for (const code of ['12', '4165', '041', 'abc']) {
      const result = phonePlanRequest.safeParse({ option: 'new', country: 'CA', area_code: code });
      expect(result.success ? [] : result.error.issues.map((i) => i.message), code).toEqual(['Three-digit area code']);
    }
  });

  it('a toll-free number has no area code to check', () => {
    expect(phonePlanRequest.safeParse({ option: 'new', country: 'CA', area_code: '999', toll_free: true }).success).toBe(true);
    expect(buyNumberRequest.safeParse({ agent_id: AGENT, country: 'CA', toll_free: true }).success).toBe(true);
  });
});

/*
 * QA bug list, 17 Nov: "Own-line consent is enforced on the screen only". §8 W6 Option C:
 * the request itself carries the consent, on the plan and on D4's import.
 */
describe('bring your own line needs the carrier consent in the request', () => {
  const AGENT = '00000000-0000-4000-8000-000000000001';
  const sip = { number: '+14505550123', host: 'sip.example.com' };
  const entryPoints: Array<[string, (consent: unknown) => Parsed]> = [
    ['W6 Option C', (consent) => phonePlanRequest.safeParse({ option: 'sip', sip, ...(consent === undefined ? {} : { carrier_consent: consent }) })],
    ['D4 Bring your own line', (consent) => importNumberRequest.safeParse({ agent_id: AGENT, sip, ...(consent === undefined ? {} : { carrier_consent: consent }) })],
  ];

  for (const [name, parse] of entryPoints) {
    it(`${name}: refused without it, with false, or with anything that is not true`, () => {
      for (const consent of [undefined, false, null, 'true', 1, 'yes']) {
        const result = parse(consent);
        expect(result.success, String(consent)).toBe(false);
        if (!result.success) expect(result.error.issues.map((i) => i.path.join('.'))).toEqual(['carrier_consent']);
      }
    });

    it(`${name}: accepted with true`, () => {
      expect(parse(true).success).toBe(true);
    });
  }

  it('the other options never ask for it', () => {
    expect(phonePlanRequest.safeParse({ option: 'new', country: 'CA', area_code: '514' }).success).toBe(true);
    expect(buyNumberRequest.safeParse({ agent_id: AGENT, country: 'CA' }).success).toBe(true);
  });
});

/*
 * QA bug list, 17 Nov: "Number step and Add number accept phone numbers that cannot exist"
 * (filed on 13694f6; fixed by QA-106 / QA-107 in 7f8b859). The report's own number.
 */
describe('a number that cannot exist is refused at every W6 and D4 entry point', () => {
  const AGENT = '00000000-0000-4000-8000-000000000001';
  const impossible = '+4505550123'; // +45 is Denmark, and Danish numbers do not start with 0
  const cases: Array<[string, () => Parsed, string]> = [
    ['W6 Keep your number', () => phonePlanRequest.safeParse({ option: 'forward', country: 'CA', existing_number: impossible }), 'existing_number'],
    ['W6 transfer person', () => phonePlanRequest.safeParse({ option: 'new', country: 'CA', transfer_targets: [{ label: 'Sam', number: impossible }] }), 'transfer_targets.0.number'],
    ['W6 own line', () => phonePlanRequest.safeParse({ option: 'sip', carrier_consent: true, sip: { number: impossible, host: 'sip.example.com' } }), 'sip.number'],
    ['D4 Add number, keep your number', () => buyNumberRequest.safeParse({ agent_id: AGENT, country: 'CA', forward_from: impossible }), 'forward_from'],
    ['D4 Add number, own line', () => importNumberRequest.safeParse({ agent_id: AGENT, carrier_consent: true, sip: { number: impossible, host: 'sip.example.com' } }), 'sip.number'],
    ['D4 Hand-off', () => updateNumberRequest.safeParse({ transfer_targets: [{ label: 'Sam', number: impossible }] }), 'transfer_targets.0.number'],
  ];
  for (const [name, parse, field] of cases) {
    it(`${name}: refused on ${field}`, () => {
      const result = parse();
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((i) => i.path.join('.'))).toEqual([field]);
    });
  }
});
