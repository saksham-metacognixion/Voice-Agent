import { describe, expect, it } from 'vitest';
import { NUMBER_RECORD_VERSION, isNumberRecord, normalisePhone } from './number-record';

/* §13.9: the `num:{e164}` projection the inbound path trusts, and the blocklist comparison. */

const valid = {
  v: NUMBER_RECORD_VERSION,
  number_id: 'n-1',
  e164: '+14165550123',
  inbound_token: 'tok',
  workspace_id: 'ws-1',
  tier: 'standard',
  blocklist: [],
};

describe('isNumberRecord', () => {
  it('accepts a record of the current version with its required fields', () => {
    expect(isNumberRecord(valid)).toBe(true);
  });

  it('refuses a record written by an older version (so it is rebuilt, not misread)', () => {
    expect(isNumberRecord({ ...valid, v: NUMBER_RECORD_VERSION - 1 })).toBe(false);
    expect(isNumberRecord({ ...valid, v: String(NUMBER_RECORD_VERSION) })).toBe(false);
  });

  it.each(['number_id', 'e164', 'inbound_token', 'workspace_id', 'tier'])('refuses a record without a string %s', (field) => {
    expect(isNumberRecord({ ...valid, [field]: undefined })).toBe(false);
    expect(isNumberRecord({ ...valid, [field]: 42 })).toBe(false);
  });

  it('refuses a blocklist that is not an array', () => {
    expect(isNumberRecord({ ...valid, blocklist: '+1555' })).toBe(false);
  });

  it.each([null, undefined, 'string', 42, []])('refuses %j', (value) => {
    expect(isNumberRecord(value)).toBe(false);
  });
});

describe('normalisePhone', () => {
  it.each([
    ['+1 (416) 555-0123', '+14165550123'],
    ['14165550123', '+14165550123'],
    ['+1-416-555-0123 ext', '+14165550123'],
    ['+1+416+555', '+1416555'],
    ['', ''],
    ['anonymous', ''],
  ])('%j → %j', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  it('two spellings of one number compare equal', () => {
    expect(normalisePhone('+1 416 555 0123')).toBe(normalisePhone('1-416-555-0123'));
  });
});
