import { describe, expect, it } from 'vitest';
import { addNumberBlock, anyProvisioning, applyMisreadFixes, areaCodeSubstitute, isBlocklistEntryInvalid, isNumberEditable, maskSecretish, misreadBlocklist, needingFixSignature, numberType, numbersNeedingFix, parseBlocklist, rejectedNumberList, sortNumbers } from './numbers-view';

const base = { id: 'n', agent_id: null, e164: '+15145550100', nickname: null, kind: 'bought' as const, country: 'CA', area_code: '514', requested_area_code: null, toll_free: false, status: 'active' as const, paused: false, staff_paused: false, staff_pause_ticket_id: null, hours_mode: 'always' as const, hours_override: null, transfer_targets: [], transfer_fail_message: null, allowed_countries: [], blocklist: [], forwarding: null, sip: null, calls_7d: 0, rental_credits: 15, next_rental_at: null, error: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };

describe('numberType (D4 list)', () => {
  it('names New, Forward target and SIP', () => {
    expect(numberType(base)).toBe('new');
    expect(numberType({ ...base, forwarding: { from: '+15145550000', status: 'ready', carrier: 'bell', mode: null, test: null } })).toBe('forward');
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
    expect(parseBlocklist(['+1 (514) 555-0666', '12', 'abc', ''])).toEqual({ valid: ['+15145550666'], invalid: ['12', 'abc'] });
  });

  it('ORL-NUM-646: refuses a number typed without its country code rather than reading 51 as Peru (QA-106)', () => {
    expect(parseBlocklist(['5145550123'])).toEqual({ valid: [], invalid: ['5145550123'] });
    expect(parseBlocklist(['15145550666'])).toEqual({ valid: [], invalid: ['15145550666'] });
    expect(parseBlocklist(['+15145550123'])).toEqual({ valid: ['+15145550123'], invalid: [] });
  });

  it('takes a caller ID that is not a real number, since a spoofed one is worth blocking', () => {
    expect(parseBlocklist(['+5145550123', '+0123'])).toEqual({ valid: ['+5145550123', '+0123'], invalid: [] });
  });

  it('drops a duplicate typed two ways and keeps international numbers', () => {
    expect(parseBlocklist(['+1 514 555 0123', '+15145550123', '0044 20 7183 8750'])).toEqual({ valid: ['+15145550123', '+442071838750'], invalid: [] });
  });

  it('marks the chip as soon as it is added', () => {
    expect(isBlocklistEntryInvalid('5145550123')).toBe(true);
    expect(isBlocklistEntryInvalid('+1 514 CALL')).toBe(true);
    expect(isBlocklistEntryInvalid('+15145550123')).toBe(false);
    expect(isBlocklistEntryInvalid('+5145550123')).toBe(false);
    expect(isBlocklistEntryInvalid('  ')).toBe(false);
  });
});

describe('entries saved without their country code before QA-106', () => {
  it('finds a blocked caller written as + and a national number, with the number it was meant to be', () => {
    expect(misreadBlocklist(['+15145550123', '+5145550123', '+0123'], 'CA')).toEqual([{ entry: '+5145550123', suggestion: '+15145550123' }]);
    expect(misreadBlocklist(['+5145550123'], null)).toEqual([]);
  });

  it('applies the suggestions without duplicating a number already listed', () => {
    expect(applyMisreadFixes(['+15145550123', '+5145550123', '+4165550101'], [
      { entry: '+5145550123', suggestion: '+15145550123' },
      { entry: '+4165550101', suggestion: '+14165550101' },
    ])).toEqual(['+15145550123', '+14165550101']);
  });

  it('names the numbers with a hand-off target that is not real or a misread blocked caller', () => {
    const fine = { ...base, id: 'fine', transfer_targets: [{ label: 'Desk', number: '+14165550101' }], blocklist: ['+15145550123', '+0123'] };
    const handoff = { ...base, id: 'handoff', transfer_targets: [{ label: 'Desk', number: '+4165550101' }, { label: 'Owner', number: '+14165550101' }] };
    const blocked = { ...base, id: 'blocked', country: null, blocklist: ['+5145550123'] };
    const released = { ...base, id: 'gone', status: 'released' as const, transfer_targets: [{ label: 'Desk', number: '+4165550101' }] };
    const found = numbersNeedingFix([fine, handoff, blocked, released], 'CA');
    expect(found.map((n) => [n.number.id, n.handoff, n.blocked])).toEqual([['handoff', 1, 0], ['blocked', 0, 1]]);
    expect(numbersNeedingFix([blocked], null)).toEqual([]);
    expect(numbersNeedingFix(undefined, 'CA')).toEqual([]);
  });

  it('remembers a dismissal by what was wrong, so a new entry shows the notice again', () => {
    const a = { number: { ...base, id: 'a' }, handoff: 1, blocked: 0 };
    const b = { number: { ...base, id: 'b' }, handoff: 0, blocked: 2 };
    expect(needingFixSignature([a, b])).toBe(needingFixSignature([b, a]));
    expect(needingFixSignature([a, b])).not.toBe(needingFixSignature([a, { ...b, blocked: 3 }]));
  });
});

describe('rejectedNumberList', () => {
  it('names the list a 422 points at', () => {
    expect(rejectedNumberList([{ field: 'blocklist.1' }])).toBe('blocklist');
    expect(rejectedNumberList([{ field: 'transfer_targets.0.number' }])).toBe('transfer_targets');
    expect(rejectedNumberList([{ field: 'nickname' }])).toBeNull();
    expect(rejectedNumberList(undefined)).toBeNull();
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

describe('areaCodeSubstitute (QA-076)', () => {
  const bought = { kind: 'bought' as const, toll_free: false, e164: '+12365550100', area_code: '236', requested_area_code: '647' };

  it('names both codes when the requested one had no stock', () => {
    expect(areaCodeSubstitute(bought)).toEqual({ requested: '647', bought: '236' });
  });

  it('says nothing when there is nothing to explain', () => {
    expect(areaCodeSubstitute({ ...bought, requested_area_code: '236' })).toBeNull();
    expect(areaCodeSubstitute({ ...bought, requested_area_code: null })).toBeNull();
    expect(areaCodeSubstitute({ ...bought, e164: null })).toBeNull();
    expect(areaCodeSubstitute({ ...bought, toll_free: true })).toBeNull();
    expect(areaCodeSubstitute({ ...bought, kind: 'sip' })).toBeNull();
  });
});

/*
 * QA-108: D4 "Add number" says why it cannot go ahead, in the API's order.
 * ORL-NUM-629 trial workspace (20 credits, no pack); ORL-NUM-630 Starter with its one number held.
 */
describe('addNumberBlock', () => {
  const held = (...statuses: Array<'active' | 'provisioning' | 'paused' | 'failed' | 'released' | 'releasing'>) => statuses.map((status) => ({ status }));

  it('ORL-NUM-629: no pack bought yet asks for a pack, whatever the trial balance or the cap says', () => {
    expect(addNumberBlock({ lastPackCredits: null, maxNumbers: 0, numbers: [] })).toEqual({ kind: 'purchase' });
    expect(addNumberBlock({ lastPackCredits: null, maxNumbers: undefined, numbers: undefined })).toEqual({ kind: 'purchase' });
  });

  it('ORL-NUM-630: Starter with its one number held names the cap', () => {
    expect(addNumberBlock({ lastPackCredits: 150, maxNumbers: 1, numbers: held('active') })).toEqual({ kind: 'limit', max: 1 });
  });

  it('counts provisioning and paused numbers like the API, never failed or released ones', () => {
    expect(addNumberBlock({ lastPackCredits: 500, maxNumbers: 2, numbers: held('provisioning', 'paused') })).toEqual({ kind: 'limit', max: 2 });
    expect(addNumberBlock({ lastPackCredits: 150, maxNumbers: 1, numbers: held('failed', 'released', 'releasing') })).toBeNull();
  });

  it('lets a paid workspace under its cap through', () => {
    expect(addNumberBlock({ lastPackCredits: 150, maxNumbers: 1, numbers: [] })).toBeNull();
    expect(addNumberBlock({ lastPackCredits: 1500, maxNumbers: 5, numbers: held('active', 'active') })).toBeNull();
  });

  it('decides nothing while the wallet, the flags or the list are loading, or for a plan with no numbers (the API says so)', () => {
    expect(addNumberBlock({ lastPackCredits: undefined, maxNumbers: 1, numbers: held('active') })).toBeNull();
    expect(addNumberBlock({ lastPackCredits: 150, maxNumbers: undefined, numbers: held('active') })).toBeNull();
    expect(addNumberBlock({ lastPackCredits: 150, maxNumbers: 1, numbers: undefined })).toBeNull();
    expect(addNumberBlock({ lastPackCredits: 150, maxNumbers: 0, numbers: [] })).toBeNull();
  });
});
