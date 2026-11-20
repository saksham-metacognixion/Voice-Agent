import { describe, expect, it } from 'vitest';
import { phoneNumberResponse, phonePlanRequest, transferTarget, updateNumberRequest } from './numbers.js';
import { areaCodeCountry, blockedCallerFromCallerId, dialableE164, isDialableE164, nationalReading, normaliseCallerId, toBlockedCaller, toDialableE164 } from './phone.js';

/* QA-106: hand-off targets take a real number with its country code; blocked callers `+` and digits. */

describe('toDialableE164', () => {
  it('refuses a number typed without its country code instead of reading the digits as one', () => {
    // With a "+" put in front these were +41 (Switzerland) and +51 (Peru).
    expect(toDialableE164('4165550101')).toBeNull();
    expect(toDialableE164('5145550123')).toBeNull();
    expect(toDialableE164('15145550123')).toBeNull();
    expect(toDialableE164('14165550101')).toBeNull();
    expect(toDialableE164('(416) 555-0101')).toBeNull();
  });

  it('accepts Canadian and US numbers with +1', () => {
    expect(toDialableE164('+14165550101')).toBe('+14165550101');
    expect(toDialableE164('+15145550123')).toBe('+15145550123');
    expect(toDialableE164('+12125550100')).toBe('+12125550100');
  });

  it('normalises spaces, brackets, dots and hyphens', () => {
    expect(toDialableE164('+1 (416) 555-0101')).toBe('+14165550101');
    expect(toDialableE164('+1 416 555 0101')).toBe('+14165550101');
    expect(toDialableE164(' +1 (514) 555-0123 ')).toBe('+15145550123');
    expect(toDialableE164('+1.416.555.0101')).toBe('+14165550101');
    expect(toDialableE164('+44 20 7183 8750')).toBe('+442071838750');
  });

  it('reads 00 as the international prefix', () => {
    expect(toDialableE164('0044 20 7183 8750')).toBe('+442071838750');
    expect(toDialableE164('00 1 514 555 0123')).toBe('+15145550123');
  });

  it('accepts valid numbers elsewhere', () => {
    expect(toDialableE164('+41446681800')).toBe('+41446681800');
    expect(toDialableE164('+966501234567')).toBe('+966501234567');
    expect(toDialableE164('+919876543210')).toBe('+919876543210');
  });

  it('refuses what the min metadata would let through (the Peruvian reading of 514…)', () => {
    expect(toDialableE164('+5145550123')).toBeNull();
    expect(toDialableE164('+4165550101')).toBeNull();
  });

  it('refuses incomplete, too long, unknown country codes and letters', () => {
    expect(toDialableE164('+1416555')).toBeNull();
    expect(toDialableE164('+141655501011234')).toBeNull();
    expect(toDialableE164('+999123456789')).toBeNull();
    expect(toDialableE164('+1 416 CALL NOW')).toBeNull();
    expect(toDialableE164('+')).toBeNull();
    expect(toDialableE164('')).toBeNull();
  });

  it('refuses an unassigned North American area code', () => {
    expect(toDialableE164('+15555550123')).toBeNull();
  });
});

describe('isDialableE164', () => {
  it('is canonical E.164 only', () => {
    expect(isDialableE164('+15145550123')).toBe(true);
    expect(isDialableE164('+1 514 555 0123')).toBe(false);
    expect(isDialableE164('5145550123')).toBe(false);
    expect(isDialableE164('+4402071838750')).toBe(false);
  });

  it('carries the portal’s message on the schema', () => {
    const r = dialableE164.safeParse('+4165550101');
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/international format/);
  });
});

describe('requests that store a number someone is put through to or refused from', () => {
  it('PATCH /numbers/:id refuses a mis-read hand-off target and accepts the real one', () => {
    expect(updateNumberRequest.safeParse({ transfer_targets: [{ label: 'Front desk', number: '+4165550101' }] }).success).toBe(false);
    expect(updateNumberRequest.safeParse({ transfer_targets: [{ label: 'Front desk', number: '4165550101' }] }).success).toBe(false);
    expect(updateNumberRequest.parse({ transfer_targets: [{ label: 'Front desk', number: '+14165550101' }] }).transfer_targets).toEqual([{ label: 'Front desk', number: '+14165550101' }]);
  });

  it('PATCH /numbers/:id takes any blocked caller in international format and names a refused entry', () => {
    expect(updateNumberRequest.parse({ blocklist: ['+15145550123', '+5145550123', '+0123'] }).blocklist).toEqual(['+15145550123', '+5145550123', '+0123']);
    const bad = updateNumberRequest.safeParse({ blocklist: ['+15145550123', '5145550123'] });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['blocklist', 1]);
    // The request carries what the form normalised; formatting is the form's to remove.
    expect(updateNumberRequest.safeParse({ blocklist: ['+1 514 555 0123'] }).success).toBe(false);
    expect(updateNumberRequest.safeParse({ blocklist: ['+1234567890123456'] }).success).toBe(false);
  });

  it('W6 refuses the same targets', () => {
    expect(phonePlanRequest.safeParse({ option: 'new', country: 'CA', transfer_targets: [{ label: 'Owner', number: '+4165550101' }] }).success).toBe(false);
    expect(phonePlanRequest.safeParse({ option: 'new', country: 'CA', transfer_targets: [{ label: 'Owner', number: '+14165550101' }] }).success).toBe(true);
    expect(transferTarget.safeParse({ label: 'Owner', number: '+14165550101' }).success).toBe(true);
  });

  it('a number saved before the rule still reads back, so the form can mark it', () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000001', agent_id: null, e164: '+15145550100', nickname: null, kind: 'bought', country: 'CA', area_code: '514',
      toll_free: false, status: 'active', paused: false, hours_mode: 'always', hours_override: null,
      transfer_targets: [{ label: 'Front desk', number: '+4165550101' }], allowed_countries: [], blocklist: ['+5145550123'],
      forwarding: null, sip: null, calls_7d: 0, rental_credits: 15, next_rental_at: null, error: null,
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    };
    const parsed = phoneNumberResponse.parse(row);
    expect(parsed.transfer_targets).toEqual([{ label: 'Front desk', number: '+4165550101' }]);
    expect(parsed.blocklist).toEqual(['+5145550123']);
  });
});

describe('toBlockedCaller', () => {
  it('takes + or 00 and digits, real number or not, and removes the formatting', () => {
    expect(toBlockedCaller('+1 (514) 555-0123')).toBe('+15145550123');
    expect(toBlockedCaller('0044 20 7183 8750')).toBe('+442071838750');
    // Not real numbers, but caller IDs a carrier can show: listed as typed.
    expect(toBlockedCaller('+5145550123')).toBe('+5145550123');
    expect(toBlockedCaller('+15555550123')).toBe('+15555550123');
    expect(toBlockedCaller('+0123')).toBe('+0123');
  });

  it('still refuses a number without its country code', () => {
    expect(toBlockedCaller('5145550123')).toBeNull();
    expect(toBlockedCaller('14165550101')).toBeNull();
    expect(toBlockedCaller('(514) 555-0123')).toBeNull();
  });

  it('refuses letters, an empty entry and more than 15 digits', () => {
    expect(toBlockedCaller('+1 514 CALL NOW')).toBeNull();
    expect(toBlockedCaller('+')).toBeNull();
    expect(toBlockedCaller('')).toBeNull();
    expect(toBlockedCaller('+1234567890123456')).toBeNull();
  });
});

describe('caller IDs', () => {
  it('normalise the way the inbound check compares them', () => {
    expect(normaliseCallerId('+15145550123')).toBe('+15145550123');
    expect(normaliseCallerId('15145550123')).toBe('+15145550123');
    expect(normaliseCallerId('+1 (514) 555-0123')).toBe('+15145550123');
    expect(normaliseCallerId('anonymous')).toBe('');
  });

  it('can be blocked whatever the carrier sent, as long as there are digits', () => {
    expect(blockedCallerFromCallerId('+15145550123')).toBe('+15145550123');
    expect(blockedCallerFromCallerId('+5145550123')).toBe('+5145550123');
    expect(blockedCallerFromCallerId('15145550123')).toBe('+15145550123');
    expect(blockedCallerFromCallerId('anonymous')).toBeNull();
    expect(blockedCallerFromCallerId('')).toBeNull();
  });
});

describe('nationalReading', () => {
  it('finds the number an entry saved before QA-106 was meant to be', () => {
    expect(nationalReading('+4165550101', 'CA')).toBe('+14165550101');
    expect(nationalReading('+5145550123', 'US')).toBe('+15145550123');
    expect(nationalReading('+2071838750', 'GB')).toBe('+442071838750');
  });

  it('says nothing about a real number, an unreadable one or without a country', () => {
    expect(nationalReading('+14165550101', 'CA')).toBeNull();
    expect(nationalReading('+41446681800', 'CA')).toBeNull();
    expect(nationalReading('+0123', 'CA')).toBeNull();
    expect(nationalReading('+4165550101', null)).toBeNull();
    expect(nationalReading('4165550101', 'CA')).toBeNull();
  });
});

describe('areaCodeCountry', () => {
  it('names the country an area code is assigned to', () => {
    for (const code of ['416', '647', '437', '514', '450', '236', '604', '867']) expect(areaCodeCountry(code), code).toBe('CA');
    for (const code of ['212', '415', '907', '808', '305']) expect(areaCodeCountry(code), code).toBe('US');
    expect(areaCodeCountry('787')).toBe('PR');
  });

  it('knows no country for a code nobody is assigned, a toll-free code or anything that is not three digits', () => {
    for (const code of ['999', '555', '911', '200', '800', '888', '900', '12', '4165', '041', '1', '', 'abc']) expect(areaCodeCountry(code), code).toBeNull();
  });
});
