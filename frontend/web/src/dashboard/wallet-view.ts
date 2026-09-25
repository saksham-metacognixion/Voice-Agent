import type { AutoTopupRequest, CreditLotResponse, LedgerEntryResponse, LedgerReason } from '@portal/schemas';
import { callPath } from '../routes';
import type { ActivityPoint } from './activity-series';

export type BalanceTone = 'ok' | 'warning' | 'danger';

/**
 * §7.2: the pill "turns amber < 20 % of last pack, red at ≤ 0". Before the first
 * purchase there is no pack to be a percentage of; the trial falls back to a flat
 * 20 credits, which is what the pill showed before D11.
 */
export function balanceTone(balance: number, lastPackCredits: number | null | undefined): BalanceTone {
  if (balance <= 0) return 'danger';
  const threshold = lastPackCredits && lastPackCredits > 0 ? lastPackCredits * 0.2 : 20;
  return balance < threshold ? 'warning' : 'ok';
}

/** D5 "Expiring soon": open lots whose expiry falls within `days` (spec p. 38: 60), soonest first. */
export function expiringSoon(lots: CreditLotResponse[], now: Date, days = 60): CreditLotResponse[] {
  const horizon = now.getTime() + days * 24 * 60 * 60 * 1000;
  return lots
    .filter((lot) => {
      const at = new Date(lot.expires_at).getTime();
      return lot.credits_remaining > 0 && Number.isFinite(at) && at >= now.getTime() && at <= horizon;
    })
    .sort((a, b) => new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime());
}

/** The figure line over the D5 chart: "412 cr used · 13.7/day". */
export function usageSummary(points: ActivityPoint[]): { total: number; perDay: number } {
  const total = points.reduce((sum, p) => sum + p.credits, 0);
  return { total: Math.round(total * 100) / 100, perDay: points.length ? Math.round((total / points.length) * 10) / 10 : 0 };
}

/** Ledger reasons in the order the D5 filter lists them. */
export const LEDGER_REASONS: LedgerReason[] = ['call', 'purchase', 'topup', 'rental', 'kb', 'trial', 'adjustment', 'refund', 'expiry'];

/** A call row links to its D2 detail (spec p. 38); nothing else has a customer page. */
export function ledgerLink(entry: Pick<LedgerEntryResponse, 'reason' | 'ref_id'>): string | null {
  return entry.reason === 'call' && entry.ref_id ? callPath(entry.ref_id) : null;
}

export interface AutoTopupDraft {
  enabled: boolean;
  packId: string | null;
  threshold: string;
}

/**
 * D5 auto top-up form → `PUT /wallet/auto-topup`, or the field that is wrong. Enabling
 * needs a pack and a threshold of at least 10 credits (spec p. 38, `autoTopupRequest`);
 * turning it off needs neither.
 */
export function autoTopupBody(draft: AutoTopupDraft): { ok: true; body: AutoTopupRequest } | { ok: false; field: 'pack' | 'threshold' } {
  if (!draft.enabled) return { ok: true, body: { enabled: false } };
  if (!draft.packId) return { ok: false, field: 'pack' };
  const threshold = Number(draft.threshold.trim());
  if (!draft.threshold.trim() || !Number.isFinite(threshold) || threshold < 10) return { ok: false, field: 'threshold' };
  return { ok: true, body: { enabled: true, pack_id: draft.packId, threshold } };
}
