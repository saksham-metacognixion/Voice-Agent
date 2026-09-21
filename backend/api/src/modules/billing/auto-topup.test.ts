import { describe, expect, it } from 'vitest';
import { TOPUP_FAILURE_COOLDOWN_MS, TOPUP_IN_FLIGHT_MS, decideTopup } from './auto-topup.service';

/* §5.4 — when does a low balance turn into a charge, and when must it not. */

const NOW = new Date('2026-09-21T12:00:00Z');
const settings = { enabled: true, pack_id: 'starter', threshold: 15, payment_method_id: 'pm_123', card_last4: '4242' };
const base = { settings, balance: 4, pendingSince: null, lastFailureAt: null, workspacePaused: false, now: NOW };

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

  it('a declined card is not retried every fifteen minutes', () => {
    expect(decideTopup({ ...base, lastFailureAt: new Date(NOW.getTime() - 60 * 60_000) })).toMatchObject({ reason: 'cooldown' });
    expect(decideTopup({ ...base, lastFailureAt: new Date(NOW.getTime() - TOPUP_FAILURE_COOLDOWN_MS - 1) }).action).toBe('charge');
  });

  it('a balance in the grace overdraft still charges', () => {
    expect(decideTopup({ ...base, balance: -3 }).action).toBe('charge');
  });
});
