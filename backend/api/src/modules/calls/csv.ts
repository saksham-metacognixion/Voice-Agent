import type { CallSummary } from '@portal/schemas';

/**
 * The D2 export (`POST /calls/export`): one row per call, the columns of the list plus
 * the note, nothing the customer cannot already see on the screen. No platform ids beyond
 * the call id, no COGS (`retell_cost_cents` is staff-only).
 */
export const CALL_CSV_COLUMNS = [
  'call_id',
  'started_at',
  'ended_at',
  'status',
  'direction',
  'channel',
  'is_test',
  'from_number',
  'to_number',
  'agent_id',
  'agent_version',
  'duration_s',
  'credits_charged',
  'rate_per_min',
  'tier',
  'sentiment',
  'outcome',
  'decline_reason',
  'disconnection_reason',
  'handled_at',
  'note',
] as const;

export function csvHeader(): string {
  return `${CALL_CSV_COLUMNS.join(',')}\r\n`;
}

export function csvRow(call: CallSummary): string {
  const cells: Array<string | number | boolean | null> = [
    call.id,
    call.started_at,
    call.ended_at,
    call.status,
    call.direction,
    call.channel,
    call.is_test,
    call.from_number,
    call.to_number,
    call.agent_id,
    call.agent_version,
    call.duration_s,
    call.credits_charged,
    call.rate,
    call.tier,
    call.sentiment,
    call.outcome,
    call.decline_reason,
    call.disconnection_reason,
    call.handled_at,
    call.note,
  ];
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/**
 * RFC 4180 quoting, plus one defence spreadsheets need: a cell that starts with `=`, `+`,
 * `-` or `@` is a formula to Excel and Sheets, and a caller's transcript note or a
 * phone number in E.164 (`+1…`) must open as text, not run. Such cells are prefixed with
 * a tab, which the RFC allows and every spreadsheet shows as nothing.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `\t${text}`;
  if (/[",\r\n]/.test(text) || text.startsWith('\t')) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}
