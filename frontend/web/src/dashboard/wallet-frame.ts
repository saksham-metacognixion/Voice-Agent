import type { SseEvent } from '@portal/schemas';

export interface WalletFrame {
  balanceAfter: number;
  delta: number;
  reason: string | null;
}

/**
 * A `wallet` / `ledger` frame (`WalletModule` publishes `{delta, balance_after, reason,
 * ref_id}` on every ledger write) → the numbers the pill needs, or null for anything
 * else: another type, a missing or non-finite balance, a string where a number belongs.
 * The SSE envelope is validated by `sseEvent`; its `data` is `unknown`, so this is the
 * gate between a frame and the wallet cache.
 */
export function walletFrame(event: Pick<SseEvent, 'topic' | 'type' | 'data'>): WalletFrame | null {
  if (event.topic !== 'wallet' || event.type !== 'ledger') return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const balanceAfter = record.balance_after;
  const delta = record.delta;
  if (typeof balanceAfter !== 'number' || !Number.isFinite(balanceAfter)) return null;
  return {
    balanceAfter: Math.round(balanceAfter * 100) / 100,
    delta: typeof delta === 'number' && Number.isFinite(delta) ? delta : 0,
    reason: typeof record.reason === 'string' ? record.reason : null,
  };
}
