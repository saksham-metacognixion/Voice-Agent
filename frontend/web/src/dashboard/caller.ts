import type { CallSummary } from '@portal/schemas';

/**
 * Who a web call came from, for D2's caller column (D17). A browser call is either the
 * customer testing their agent (W5, D3) or a visitor on their website (§11.5) — the
 * widget is the only web call that is not a test. A phone call is named by its number.
 */
export function webCaller(call: Pick<CallSummary, 'channel' | 'is_test'>): 'browserTest' | 'websiteVisitor' | null {
  if (call.channel !== 'web') return null;
  return call.is_test ? 'browserTest' : 'websiteVisitor';
}
