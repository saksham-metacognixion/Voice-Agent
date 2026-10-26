import { isPhoneFieldName } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { localeRegion, phoneRegions } from '../../common/phone-regions';
import { callerUtterances, checkCapturedPhones, spokenDigitRuns } from './captured-phones';

/** The 26 Oct staging call (en-IN, Standard, Hailey): nine digits said twice, ten captured. */
const OCT26_CALLER = [
  'Table for four this Friday at 7 PM.',
  'eight. Seven six five. Four, three, two one zero',
  'And the name is Priya.',
  "Yeah. I have already sent to you. It's online. Eight seven, six, five, four. Three. Two. One. Zero.",
];

const check = (value: unknown, callerTurns: string[], extra: { callerId?: string | null; regions?: string[] } = {}) =>
  checkCapturedPhones({
    captured: { callback_number: value, caller_name: 'Priya', party_size: 4 },
    callerTurns,
    callerId: extra.callerId ?? null,
    regions: extra.regions ?? ['CA', 'IN'],
  });

describe('spokenDigitRuns', () => {
  it('keeps exactly the digits said, punctuation and pauses included — no trailing zero', () => {
    expect(spokenDigitRuns(OCT26_CALLER[1]!)).toEqual(['876543210']);
    expect(spokenDigitRuns(OCT26_CALLER[3]!)).toEqual(['876543210']);
  });

  it('reads numerals, double/triple, oh, teens, tens and hundreds as people dictate', () => {
    expect(spokenDigitRuns('98765 43210')).toEqual(['9876543210']);
    expect(spokenDigitRuns('nine eight double seven six triple five four two')).toEqual(['987765554' + '2']);
    expect(spokenDigitRuns('four one six, five five five, oh one two three')).toEqual(['4165550123']);
    expect(spokenDigitRuns('six four seven five five five twenty-one hundred')).toEqual(['6475552100']);
    expect(spokenDigitRuns('eighteen hundred, ninety one')).toEqual(['180091']);
  });

  it('ends a run at an ordinary word, not at a filler', () => {
    expect(spokenDigitRuns('Friday at 7 PM for 4')).toEqual(['7', '4']);
    expect(spokenDigitRuns('nine eight uh seven six')).toEqual(['9876']);
  });

  it('does not turn an opening "oh" into a digit', () => {
    expect(spokenDigitRuns('Oh, it is Priya')).toEqual([]);
  });
});

describe('checkCapturedPhones', () => {
  it('flags the 26 Oct number: ten digits captured, nine said, and says what was said', () => {
    expect(check('8765432100', OCT26_CALLER)).toEqual([
      { field: 'callback_number', value: '8765432100', status: 'mismatch', digits: 10, heard: ['876543210'] },
    ]);
    // The same number formatted the way the summary wrote it.
    expect(check('876-543-2100', OCT26_CALLER)[0]!.status).toBe('mismatch');
  });

  it('flags the caller’s nine digits copied faithfully as incomplete, never padded', () => {
    expect(check('876543210', OCT26_CALLER)).toEqual([
      { field: 'callback_number', value: '876543210', status: 'invalid', digits: 9, heard: ['876543210'] },
    ]);
  });

  it('accepts a complete number the caller said, formatted or not', () => {
    const turns = ['My number is nine eight seven six five, four three two one zero.'];
    expect(check('9876543210', turns)[0]!.status).toBe('ok');
    expect(check('+91 98765 43210', turns)[0]!.status).toBe('ok');
    expect(check('098765 43210', turns)[0]!.status).toBe('ok');
  });

  it('asks again → corrected: the number from the retry is the one that passes', () => {
    const turns = [...OCT26_CALLER, 'Sorry, it is eight seven six five four three two one zero nine.'];
    expect(check('8765432109', turns)[0]!.status).toBe('ok');
    expect(check('8765432100', turns)[0]!.status).toBe('mismatch');
  });

  it('accepts a number split across two turns', () => {
    expect(check('4165550123', ['four one six five five five', 'zero one two three'], { regions: ['CA'] })[0]!.status).toBe('ok');
  });

  it('accepts North American and international numbers in their regions', () => {
    expect(check('(416) 555-0123', ['four one six, five five five, zero one two three'], { regions: ['CA'] })[0]!.status).toBe('ok');
    expect(check('+44 20 7946 0958', ['plus four four, two zero, seven nine four six, zero nine five eight'], { regions: ['CA'] })[0]!.status).toBe('ok');
  });

  it('marks a number valid only somewhere else as invalid for this workspace', () => {
    // Nine digits is not a Canadian or Indian number even when the caller said all nine.
    expect(check('987654321', ['nine eight seven six five four three two one'])[0]!.status).toBe('invalid');
  });

  it('accepts the caller id when the caller asked to be called back on it', () => {
    expect(check('+1 416 555 0123', ['Just call me back on this number.'], { callerId: '+14165550123', regions: ['CA'] })[0]!.status).toBe('ok');
  });

  it('flags a digit the caller did not say clearly rather than vouching for a guess', () => {
    // "nine eight seven six five four three two one … uh" — the last digit never came.
    expect(check('9876543210', ['nine eight seven six five four three two one uh'])[0]!.status).toBe('mismatch');
  });

  it('without a transcript, checks the format only', () => {
    expect(check('9876543210', [])[0]!.status).toBe('ok');
    expect(check('876543210', [])[0]).toMatchObject({ status: 'invalid', heard: [] });
  });

  it('checks phone fields only, and skips empty ones', () => {
    const out = checkCapturedPhones({
      captured: { party_size: 4, phone: '', contact_number: 8765432100, reference_number: '123' },
      callerTurns: OCT26_CALLER,
      regions: ['IN'],
    });
    expect(out).toEqual([{ field: 'contact_number', value: '8765432100', status: 'mismatch', digits: 10, heard: ['876543210'] }]);
    expect(checkCapturedPhones({ captured: null, callerTurns: [], regions: [] })).toEqual([]);
  });
});

describe('callerUtterances', () => {
  it('reads the caller’s turns from transcript_object, never the agent’s read-back', () => {
    const json = [
      { role: 'agent', content: 'I have your phone number as 876-543-2100.' },
      { role: 'user', content: OCT26_CALLER[3] },
      { role: 'tool_call_invocation', content: 'x' },
    ];
    expect(callerUtterances(json, null)).toEqual([OCT26_CALLER[3]]);
  });

  it('falls back to the plain transcript', () => {
    expect(callerUtterances(null, 'Agent: Your number?\nUser: nine eight seven\nsix five\nAgent: Thanks')).toEqual(['nine eight seven six five']);
  });
});

describe('isPhoneFieldName / localeRegion', () => {
  it('recognises phone fields by their words', () => {
    for (const n of ['phone', 'callback_number', 'caller_phone', 'mobileNumber', 'contact_number', 'call_back_number', 'whatsapp'])
      expect(isPhoneFieldName(n)).toBe(true);
    for (const n of ['party_size', 'excellence_score', 'hotel_name', 'reference_number', 'caller_name']) expect(isPhoneFieldName(n)).toBe(false);
  });

  it('reads the region off a locale', () => {
    expect(localeRegion('en-IN')).toBe('IN');
    expect(localeRegion('fr-CA')).toBe('CA');
    expect(localeRegion('multi')).toBeNull();
  });

  it('validates in the workspace country then the locale regions, deduped and real', () => {
    expect(phoneRegions('ca', ['en-IN', 'en-CA', 'fr-CA', 'xx-ZZ', null])).toEqual(['CA', 'IN']);
    expect(phoneRegions(undefined, ['en-US'])).toEqual(['US']);
  });
});
