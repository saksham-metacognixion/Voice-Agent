import { describe, expect, it } from 'vitest';
import type { CallSummary } from '@portal/schemas';
import { CALL_CSV_COLUMNS, csvCell, csvHeader, csvRow } from './csv';

const call: CallSummary = {
  id: 'call_abc',
  agent_id: '11111111-1111-4111-8111-111111111111',
  agent_version: 3,
  number_id: null,
  channel: 'phone',
  direction: 'inbound',
  is_test: false,
  from_number: '+14165550100',
  to_number: '+16475550199',
  started_at: '2026-09-24T10:00:00.000Z',
  ended_at: '2026-09-24T10:02:30.000Z',
  duration_s: 150,
  disconnection_reason: 'user_hangup',
  tier: 'standard',
  rate: 1,
  config_version: 1,
  credits_charged: 2.5,
  status: 'analyzed',
  decline_reason: null,
  outcome: 'successful',
  handled_at: null,
  note: 'Said "call back", then\nhung up',
  has_recording: true,
  sentiment: 'Positive',
  created_at: '2026-09-24T10:00:00.000Z',
};

describe('calls CSV', () => {
  it('writes one header and one row per call, in the column order', () => {
    expect(csvHeader()).toBe(`${CALL_CSV_COLUMNS.join(',')}\r\n`);
    const row = csvRow(call);
    expect(row.endsWith('\r\n')).toBe(true);
    expect(row.split(',').length).toBeGreaterThanOrEqual(CALL_CSV_COLUMNS.length);
    expect(row.startsWith('call_abc,2026-09-24T10:00:00.000Z,')).toBe(true);
  });

  it('quotes cells with commas, quotes and newlines (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(2.5)).toBe('2.5');
    expect(csvCell(false)).toBe('false');
  });

  it('neutralises cells a spreadsheet would run as a formula, phone numbers included', () => {
    expect(csvCell('=SUM(A1)')).toBe('"\t=SUM(A1)"');
    expect(csvCell('+14165550100')).toBe('"\t+14165550100"');
    expect(csvCell('@handle')).toBe('"\t@handle"');
    expect(csvCell('-5')).toBe('"\t-5"');
  });

  it('never carries anything but the customer-visible columns', () => {
    expect(CALL_CSV_COLUMNS.join(' ')).not.toMatch(/retell|cost|config_version|recording_url/);
  });
});
