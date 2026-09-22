import { describe, expect, it } from 'vitest';
import type { ProviderCallFacts } from '../retell';
import { providerCallFacts } from '../retell';
import { type InternalCallFacts, driftThresholdPct, previousUtcDay, reconcile } from './reconcile';

function theirs(id: string, seconds = 60, cents = 12): ProviderCallFacts {
  return { call_id: id, call_type: 'phone_call', call_status: 'ended', start_timestamp: 1, end_timestamp: 1 + seconds * 1000, duration_s: seconds, disconnection_reason: 'user_hangup', cost_cents: cents, workspace_id: 'ws' };
}
function ours(id: string, seconds = 60, cents = 12): InternalCallFacts {
  return { id, duration_s: seconds, retell_cost_cents: cents, workspace_id: 'ws', billable: true };
}

describe('reconcile (§14.2)', () => {
  it('reports zero drift when both sides agree', () => {
    const m = reconcile([theirs('a'), theirs('b')], [ours('a'), ours('b')]);
    expect(m).toMatchObject({ provider_calls: 2, internal_calls: 2, matched: 2, missing: [], extra: [], drift_pct: 0, provider_seconds: 120, internal_seconds: 120, provider_cost_cents: 24, internal_cost_cents: 24 });
  });

  it('counts a provider call we never stored as missing — a call that was never billed', () => {
    const m = reconcile([theirs('a'), theirs('b'), theirs('c'), theirs('d')], [ours('a'), ours('b'), ours('c')]);
    expect(m.missing).toEqual(['d']);
    expect(m.extra).toEqual([]);
    expect(m.id_drift_pct).toBe(25);
    expect(m.drift_pct).toBe(25);
  });

  it('counts a row the provider does not list as extra, and keeps ids sorted for a stable record', () => {
    const m = reconcile([theirs('a')], [ours('a'), ours('z'), ours('m')]);
    expect(m.extra).toEqual(['m', 'z']);
    expect(m.id_drift_pct).toBeCloseTo(66.667, 3);
  });

  it('measures seconds drift over matched calls only, so a missing call is not counted twice', () => {
    const m = reconcile([theirs('a', 100), theirs('b', 100)], [ours('a', 90), ours('b', 100)]);
    expect(m.id_drift_pct).toBe(0);
    expect(m.seconds_drift_pct).toBe(5);
    expect(m.drift_pct).toBe(5);
  });

  it('is deterministic: the same inputs in any order give the same numbers', () => {
    const p = [theirs('a', 30), theirs('b', 45), theirs('c', 10)];
    const i = [ours('c', 10), ours('a', 30)];
    expect(reconcile(p, i)).toEqual(reconcile([...p].reverse(), [...i].reverse()));
  });

  it('handles an empty window and a provider with nothing while we have rows', () => {
    expect(reconcile([], []).drift_pct).toBe(0);
    const m = reconcile([], [ours('a')]);
    expect(m.extra).toEqual(['a']);
    expect(m.drift_pct).toBe(100);
  });

  it('reads the threshold from the environment with a 5% default', () => {
    expect(driftThresholdPct({})).toBe(5);
    expect(driftThresholdPct({ RECONCILE_DRIFT_THRESHOLD_PCT: '2.5' })).toBe(2.5);
    expect(driftThresholdPct({ RECONCILE_DRIFT_THRESHOLD_PCT: 'lots' })).toBe(5);
  });

  it('reconciles the previous whole UTC day', () => {
    expect(previousUtcDay(new Date('2026-09-22T02:30:00Z'))).toEqual({ start: new Date('2026-09-21T00:00:00Z'), end: new Date('2026-09-22T00:00:00Z') });
  });
});

describe('providerCallFacts', () => {
  it('reduces a list-calls row to the facts compared, rounding combined_cost to cents', () => {
    expect(
      providerCallFacts({ call_id: 'call_1', call_type: 'phone_call', call_status: 'ended', start_timestamp: 1000, end_timestamp: 75_500, disconnection_reason: 'user_hangup', call_cost: { combined_cost: 12.49 }, metadata: { tenant_id: 'ws-1' } }),
    ).toEqual({ call_id: 'call_1', call_type: 'phone_call', call_status: 'ended', start_timestamp: 1000, end_timestamp: 75_500, duration_s: 74.5, disconnection_reason: 'user_hangup', cost_cents: 12, workspace_id: 'ws-1' });
  });

  it('tolerates a row with nothing but an id, and rejects one without', () => {
    expect(providerCallFacts({ call_id: 'x' })).toMatchObject({ call_id: 'x', duration_s: null, cost_cents: null, workspace_id: null, call_type: 'unknown' });
    expect(providerCallFacts({ start_timestamp: 1 })).toBeNull();
    expect(providerCallFacts(null)).toBeNull();
  });
});
