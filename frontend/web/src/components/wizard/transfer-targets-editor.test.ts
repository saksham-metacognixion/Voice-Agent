import { describe, expect, it } from 'vitest';
import { normaliseE164, toDrafts, toTargets, validateTargets } from './transfer-targets-editor';
import { transferTarget } from '@portal/schemas';

/* QA-106 / ORL-NUM-639: the D4 Hand-off and W6 editor judge a number by the API's rule. */

const messages = { label: 'Give this person a name.', number: 'Enter the number with its country code, e.g. +14505550123.' };

describe('validateTargets', () => {
  it('marks a number typed without its country code instead of saving it as +41…', () => {
    const rows = toDrafts([{ label: 'Front desk', number: '4165550101' }]);
    expect(validateTargets(rows, messages)).toEqual({ [rows[0]!.key]: { number: messages.number } });
  });

  it('marks an explicit number that is not real', () => {
    const rows = toDrafts([{ label: 'Front desk', number: '+4165550101' }, { label: 'Owner', number: '+1416555' }]);
    expect(Object.keys(validateTargets(rows, messages))).toHaveLength(2);
  });

  it('accepts +1 numbers in any common formatting and saves E.164', () => {
    const rows = toDrafts([{ label: ' Front desk ', number: '+1 (416) 555-0101' }, { label: 'Owner', number: '0044 20 7183 8750' }]);
    expect(validateTargets(rows, messages)).toEqual({});
    expect(toTargets(rows)).toEqual([{ label: 'Front desk', number: '+14165550101' }, { label: 'Owner', number: '+442071838750' }]);
  });

  it('marks only the bad row of several', () => {
    const rows = toDrafts([{ label: 'A', number: '+14165550101' }, { label: 'B', number: '5145550123' }, { label: '', number: '+15145550123' }]);
    expect(validateTargets(rows, messages)).toEqual({ [rows[1]!.key]: { number: messages.number }, [rows[2]!.key]: { label: messages.label } });
  });
});

describe('normaliseE164', () => {
  it('keeps the typed country code and never invents one', () => {
    expect(normaliseE164('+1 (450) 555-0123')).toBe('+14505550123');
    expect(normaliseE164('0044 20 7183 8750')).toBe('+442071838750');
    expect(normaliseE164(' 4165550101 ')).toBe('4165550101');
    expect(normaliseE164('')).toBe('');
  });

  // QA-107 / ORL-NUM-628: W6 Option B/C and D4 "Keep your number" / "Bring your own line"
  // send what this returns, and `dialableE164` refuses anything that is not a real number.
  it('passes a number without its country code through as typed, for the schema to refuse', () => {
    for (const typed of ['5145550123', '4165550101', '+5145550123', '+4165550101', '+9995551234', '+1 514 555']) {
      expect(normaliseE164(typed)).toBe(typed);
      expect(transferTarget.safeParse({ label: 'x', number: normaliseE164(typed) }).success).toBe(false);
    }
  });

  it('turns a real number typed with its country code into canonical E.164', () => {
    expect(normaliseE164('+1 (514) 555-0123')).toBe('+15145550123');
    expect(normaliseE164('+1 416 555 0101')).toBe('+14165550101');
    expect(normaliseE164('+33 1 42 68 53 00')).toBe('+33142685300');
  });
});
