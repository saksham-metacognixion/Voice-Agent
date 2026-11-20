import type { LedgerEntryResponse } from '@portal/schemas';
import { csvCell } from '../calls/csv';

/**
 * The D5 credit-history export (`POST /wallet/ledger/export`, QA-080): one row per ledger
 * movement, the columns of the list — what the customer already sees on the screen, in
 * the ledger's own words. `ref_id` is the call id for a call or transfer row, so a
 * spreadsheet can join it against the call export. Same RFC 4180 + formula-safe cells
 * as the call export (`csvCell`).
 */
export const LEDGER_CSV_COLUMNS = ['entry_id', 'created_at', 'reason', 'delta', 'balance_after', 'ref_type', 'ref_id'] as const;

export function ledgerCsvHeader(): string {
  return `${LEDGER_CSV_COLUMNS.join(',')}\r\n`;
}

export function ledgerCsvRow(entry: LedgerEntryResponse): string {
  // Amounts are written as numbers, not through `csvCell`: a debit is negative, and the
  // formula guard would turn "-2.5" into text a spreadsheet cannot sum. A number JS
  // formatted cannot carry a formula, so the guard has nothing to protect here.
  const cells = [csvCell(entry.id), csvCell(entry.created_at), csvCell(entry.reason), amount(entry.delta), amount(entry.balance_after), csvCell(entry.ref_type), csvCell(entry.ref_id)];
  return `${cells.join(',')}\r\n`;
}

function amount(value: number): string {
  return Number.isFinite(value) ? String(value) : '';
}
