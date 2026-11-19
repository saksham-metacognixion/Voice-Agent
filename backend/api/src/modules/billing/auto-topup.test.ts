import { describe, expect, it } from 'vitest';
import { TOPUP_FAILURE_COOLDOWN_MS, TOPUP_IN_FLIGHT_MS, TOPUP_MAX_RETRIES, TOPUP_MIN_INTERVAL_MS, decideTopup, topupCurrency } from './auto-topup.service';

/* §5.4 — when does a low balance turn into a charge, and when must it not. */

const NOW = new Date('2026-09-21T12:00:00Z');
const settings = { enabled: true, pack_id: 'starter', threshold: 15, payment_method_id: 'pm_123', card_last4: '4242', currency: null as 'USD' | 'CAD' | null };
const base = { settings, balance: 4, pendingSince: null, lastPaidAt: null, failures: 0, lastFailureAt: null, workspacePaused: false, now: NOW };
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60_000;

describe('decideTopup', () => {
  it('charges when enabled, below the threshold, with a card and no attempt in flight', () => {
    expect(decideTopup(base)).toEqual({ action: 'charge', reason: 'below_threshold' });
  });

  it('never charges when disabled, without a card or pack, or at/above the threshold', () => {
    expect(decideTopup({ ...base, settings: null }).action).toBe('skip');
    expect(decideTopup({ ...base, settings: { ...settings, enabled: false } })).toMatchObject({ reason: 'disabled' });
    expect(decideTopup({ ...base, settings: { ...settings, payment_method_id: null } })).toMatchObject({ reason: 'no_card' });
    expect(decideTopup({ ...base, settings: { ...settings, pack_id: null } })).toMatchObject({ reason: 'no_pack' });
    expect(decideTopup({ ...base, settings: { ...settings, threshold: null } })).toMatchObject({ reason: 'no_pack' });
    expect(decideTopup({ ...base, balance: 15 })).toMatchObject({ reason: 'above_threshold' });
    expect(decideTopup({ ...base, balance: 100 })).toMatchObject({ reason: 'above_threshold' });
  });

  it('a paused workspace is never charged', () => {
    expect(decideTopup({ ...base, workspacePaused: true })).toMatchObject({ reason: 'paused' });
  });

  it('one threshold event, one charge: a pending top-up in flight blocks a second one', () => {
    expect(decideTopup({ ...base, pendingSince: new Date(NOW.getTime() - 60_000) })).toMatchObject({ reason: 'in_flight' });
    // …until it has clearly been abandoned by everything, including the reconcile sweep.
    expect(decideTopup({ ...base, pendingSince: new Date(NOW.getTime() - TOPUP_IN_FLIGHT_MS - 1) }).action).toBe('charge');
  });

  it('a paid top-up holds the next one back for ten minutes, however far below the threshold the balance still is', () => {
    // The bug list's case: Starter (150) at threshold 500, balance 189 two minutes after a paid top-up.
    const low = { ...base, settings: { ...settings, threshold: 500 }, balance: 189 };
    expect(decideTopup({ ...low, lastPaidAt: ago(2 * 60_000) })).toEqual({ action: 'skip', reason: 'recent' });
    expect(decideTopup({ ...low, lastPaidAt: ago(TOPUP_MIN_INTERVAL_MS - 1) })).toMatchObject({ reason: 'recent' });
    expect(decideTopup({ ...low, lastPaidAt: ago(TOPUP_MIN_INTERVAL_MS) }).action).toBe('charge');
    expect(TOPUP_MIN_INTERVAL_MS).toBe(10 * 60_000);
  });

  it('a declined card is retried once a day', () => {
    for (const hours of [1, 6, 12, 18, 23.9]) {
      expect(decideTopup({ ...base, failures: 1, lastFailureAt: ago(hours * HOUR) })).toMatchObject({ reason: 'cooldown' });
    }
    expect(decideTopup({ ...base, failures: 1, lastFailureAt: ago(TOPUP_FAILURE_COOLDOWN_MS) }).action).toBe('charge');
    expect(TOPUP_FAILURE_COOLDOWN_MS).toBe(24 * HOUR);
  });

  it('retries three times, then stops for good', () => {
    expect(TOPUP_MAX_RETRIES).toBe(3);
    const dayLater = ago(TOPUP_FAILURE_COOLDOWN_MS);
    // The first decline and two failed retries: one retry is left.
    for (const failures of [1, 2, 3]) expect(decideTopup({ ...base, failures, lastFailureAt: dayLater }).action).toBe('charge');
    // The third retry failed too: nothing more, at 24, 48, 72 or 96 hours.
    for (const hours of [24, 48, 72, 96, 24 * 30]) {
      expect(decideTopup({ ...base, failures: 4, lastFailureAt: ago(hours * HOUR) })).toEqual({ action: 'skip', reason: 'retries_exhausted' });
    }
  });

  it('a reset streak charges again (a paid purchase, or auto top-up saved on again)', () => {
    expect(decideTopup({ ...base, failures: 0, lastFailureAt: null }).action).toBe('charge');
  });

  it('a balance in the grace overdraft still charges', () => {
    expect(decideTopup({ ...base, balance: -3 }).action).toBe('charge');
  });
});

/* ADR 0049 — a saved switch is charged only in the currency it was saved on in. */
describe('decideTopup and the workspace currency', () => {
  const cad = { ...settings, currency: 'CAD' as const };
  const usd = { ...settings, currency: 'USD' as const };

  it('charges a USD switch in a USD workspace and a CAD switch in a CAD workspace', () => {
    expect(decideTopup({ ...base, settings: usd, workspaceCurrency: 'USD' })).toEqual({ action: 'charge', reason: 'below_threshold' });
    expect(decideTopup({ ...base, settings: cad, workspaceCurrency: 'CAD' })).toEqual({ action: 'charge', reason: 'below_threshold' });
  });

  it('never charges when the workspace currency is not the one the switch was saved in', () => {
    expect(decideTopup({ ...base, settings: usd, workspaceCurrency: 'CAD' })).toEqual({ action: 'skip', reason: 'currency_mismatch' });
    expect(decideTopup({ ...base, settings: cad, workspaceCurrency: 'USD' })).toEqual({ action: 'skip', reason: 'currency_mismatch' });
  });

  it('reads settings saved before currencies existed as USD', () => {
    expect(topupCurrency(settings)).toBe('USD');
    expect(decideTopup({ ...base, workspaceCurrency: 'USD' })).toEqual({ action: 'charge', reason: 'below_threshold' });
    expect(decideTopup({ ...base, workspaceCurrency: 'CAD' })).toEqual({ action: 'skip', reason: 'currency_mismatch' });
  });

  it('stays opt-in: a currency match never charges a switch that is off or has no card', () => {
    expect(decideTopup({ ...base, settings: { ...cad, enabled: false }, workspaceCurrency: 'CAD' })).toEqual({ action: 'skip', reason: 'disabled' });
    expect(decideTopup({ ...base, settings: null, workspaceCurrency: 'CAD' })).toEqual({ action: 'skip', reason: 'disabled' });
    expect(decideTopup({ ...base, settings: { ...cad, payment_method_id: null }, workspaceCurrency: 'CAD' })).toEqual({ action: 'skip', reason: 'no_card' });
  });

  it('a mismatch is decided before the balance, so it is reported even above the threshold', () => {
    expect(decideTopup({ ...base, balance: 500, settings: usd, workspaceCurrency: 'CAD' })).toEqual({ action: 'skip', reason: 'currency_mismatch' });
  });
});
