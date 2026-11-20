import { describe, expect, it } from 'vitest';
import { LEDGER_CSV_COLUMNS, ledgerCsvHeader, ledgerCsvRow } from './ledger-csv';

describe('credit history CSV (QA-080)', () => {
  it('has one header cell per column, CRLF-terminated', () => {
    expect(ledgerCsvHeader()).toBe(`${LEDGER_CSV_COLUMNS.join(',')}\r\n`);
  });

  it('writes a debit with its call id in column order', () => {
    const row = ledgerCsvRow({
      id: '11111111-1111-4111-8111-111111111111',
      created_at: '2026-10-28T10:00:00.000Z',
      reason: 'call',
      delta: -2.5,
      balance_after: 147.5,
      ref_type: 'call',
      ref_id: 'call_abc',
    });
    // Amounts stay numbers — a negative debit is summable, not a quoted formula.
    expect(row).toBe('11111111-1111-4111-8111-111111111111,2026-10-28T10:00:00.000Z,call,-2.5,147.5,call,call_abc\r\n');
  });

  it('still guards the text cells', () => {
    const row = ledgerCsvRow({ id: 'x', created_at: 't', reason: 'adjustment', delta: 1, balance_after: 1, ref_type: '=cmd', ref_id: '@sum' });
    expect(row).toBe('x,t,adjustment,1,1,"\t=cmd","\t@sum"\r\n');
  });

  it('leaves empty references empty', () => {
    const row = ledgerCsvRow({ id: 'x', created_at: 't', reason: 'trial', delta: 20, balance_after: 20, ref_type: null, ref_id: null });
    expect(row).toBe('x,t,trial,20,20,,\r\n');
  });
});
