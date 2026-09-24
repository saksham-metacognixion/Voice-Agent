import { storage } from '@/src/lib/storage';

/**
 * What W7 remembers across the Stripe redirect: which purchase was started, for which
 * agent, and when. It is a hint for the return screen — "wait for an activation newer
 * than this" — never proof of payment; the backend decides whether anything was paid.
 */
export interface CheckoutMarker {
  purchaseId: string;
  agentId: string;
  packId: string;
  startedAt: number;
}

const KEY = 'portal:w7-checkout';
/** Checkout sessions expire server-side; a marker older than a day is stale. */
const MAX_AGE_MS = 24 * 60 * 60_000;

export const checkoutMarker = {
  get(agentId: string): CheckoutMarker | null {
    try {
      const raw = storage.get(KEY);
      if (!raw) return null;
      const m = JSON.parse(raw) as CheckoutMarker;
      if (m.agentId !== agentId || Date.now() - m.startedAt > MAX_AGE_MS) return null;
      return m;
    } catch {
      return null;
    }
  },
  set(marker: CheckoutMarker): void {
    storage.set(KEY, JSON.stringify(marker));
  },
  clear(): void {
    storage.remove(KEY);
  },
};
