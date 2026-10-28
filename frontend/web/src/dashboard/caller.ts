import type { CallSummary } from '@portal/schemas';
import { formatPhone } from '../lib/format';

/**
 * Who a web call came from, for D2's caller column (D17). A browser call is either the
 * customer testing their agent (W5, D3) or a visitor on their website (§11.5) — the
 * widget is the only web call that is not a test. A phone call is named by its number.
 */
export function webCaller(call: Pick<CallSummary, 'channel' | 'is_test'>): 'browserTest' | 'websiteVisitor' | null {
  if (call.channel !== 'web') return null;
  return call.is_test ? 'browserTest' : 'websiteVisitor';
}

/**
 * The other party as every list and drawer names it, from a translator scoped to
 * `dashboard.calls`. On an outbound call (a D18 callback, "Call my phone") that is the
 * number we rang, not our own number it was placed from.
 */
/**
 * The other party's number as dialled — what D2's "Copy caller number" and "Call from
 * your phone" (`tel:`) use (QA-077). Null for a web call, which has no number, and for a
 * phone call whose number the platform did not pass on. Outbound, it is the number we
 * rang, as in `callerLabel`.
 */
export function otherPartyNumber(
  call: Pick<CallSummary, 'channel' | 'is_test' | 'from_number'> & Partial<Pick<CallSummary, 'direction' | 'to_number'>>,
): string | null {
  if (webCaller(call)) return null;
  const other = call.direction === 'outbound' ? call.to_number : call.from_number;
  return other?.trim() ? other.trim() : null;
}

export function callerLabel(
  call: Pick<CallSummary, 'channel' | 'is_test' | 'from_number'> & Partial<Pick<CallSummary, 'direction' | 'to_number'>>,
  t: (key: 'browserTest' | 'websiteVisitor' | 'unknownCaller') => string,
): string {
  const web = webCaller(call);
  if (web) return t(web);
  const other = call.direction === 'outbound' ? call.to_number : call.from_number;
  return other ? formatPhone(other) : t('unknownCaller');
}
