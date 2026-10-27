import { describe, expect, it } from 'vitest';
import { anyProvisioning, isNumberEditable, maskSecretish, numberType, parseBlocklist, sortNumbers } from './numbers-view';

const base = { id: 'n', agent_id: null, e164: '+15145550100', nickname: null, kind: 'bought' as const, country: 'CA', area_code: '514', toll_free: false, status: 'active' as const, paused: false, hours_mode: 'always' as const, hours_override: null, transfer_targets: [], allowed_countries: [], blocklist: [], forwarding: null, sip: null, calls_7d: 0, rental_credits: 15, next_rental_at: null, error: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };

describe('numberType (D4 list)', () => {
  it('names New, Forward target and SIP', () => {
    expect(numberType(base)).toBe('new');
    expect(numberType({ ...base, forwarding: { from: '+15145550000', status: 'ready', carrier: 'bell', test: null } })).toBe('forward');
    expect(numberType({ ...base, kind: 'sip' })).toBe('sip');
  });
});

describe('isNumberEditable', () => {
  it('freezes released and releasing numbers', () => {
    expect(isNumberEditable(base)).toBe(true);
    expect(isNumberEditable({ status: 'paused' })).toBe(true);
    expect(isNumberEditable({ status: 'released' })).toBe(false);
    expect(isNumberEditable({ status: 'releasing' })).toBe(false);
  });
});

describe('sortNumbers', () => {
  it('puts answering numbers first and released ones last', () => {
    const list = [{ ...base, id: 'r', status: 'released' as const }, { ...base, id: 'p', status: 'provisioning' as const }, { ...base, id: 'a', status: 'active' as const }];
    expect(sortNumbers(list).map((n) => n.id)).toEqual(['a', 'p', 'r']);
  });
});

describe('parseBlocklist', () => {
  it('normalises formatted numbers to E.164 and separates what the API refuses', () => {
    expect(parseBlocklist(['+1 (514) 555-0666', '15145550666', '12', 'abc', ''])).toEqual({ valid: ['+15145550666'], invalid: ['12', 'abc'] });
  });
});

describe('maskSecretish', () => {
  it('keeps two characters at each end', () => {
    expect(maskSecretish('trunk-user')).toBe('tr••••er');
    expect(maskSecretish('abc')).toBe('••••');
    expect(maskSecretish(null)).toBe('–');
  });
});

describe('anyProvisioning', () => {
  it('is true while a number is still being set up or released', () => {
    expect(anyProvisioning([base])).toBe(false);
    expect(anyProvisioning([{ ...base, status: 'provisioning' }])).toBe(true);
    expect(anyProvisioning(undefined)).toBe(false);
  });
});
