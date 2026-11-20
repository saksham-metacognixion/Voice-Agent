import { describe, expect, it } from 'vitest';
import { concurrencyAlertPct, concurrencyThreshold, decideConcurrency, platformConcurrencyLimit } from './concurrency-monitor';

describe('decideConcurrency (§14.3)', () => {
  it('reaches the threshold at ceil(cap × pct / 100)', () => {
    expect(concurrencyThreshold(10, 80)).toBe(8);
    expect(concurrencyThreshold(3, 80)).toBe(3);
    expect(concurrencyThreshold(2, 80)).toBe(2);
    expect(concurrencyThreshold(1, 80)).toBe(1);
    expect(concurrencyThreshold(0, 80)).toBe(Number.POSITIVE_INFINITY);
  });

  it('is silent below the threshold, opens at exactly the threshold, and stays open above it', () => {
    expect(decideConcurrency({ live: 7, cap: 10, pct: 80, open: false })).toEqual({ action: 'none', threshold: 8 });
    expect(decideConcurrency({ live: 8, cap: 10, pct: 80, open: false })).toEqual({ action: 'open', threshold: 8 });
    expect(decideConcurrency({ live: 11, cap: 10, pct: 80, open: false })).toEqual({ action: 'open', threshold: 8 });
    // Repeated ticks while still above: nothing new.
    expect(decideConcurrency({ live: 11, cap: 10, pct: 80, open: true })).toEqual({ action: 'none', threshold: 8 });
  });

  it('resolves once the count falls below the threshold, and can open again on the next crossing', () => {
    expect(decideConcurrency({ live: 7, cap: 10, pct: 80, open: true })).toEqual({ action: 'resolve', threshold: 8 });
    expect(decideConcurrency({ live: 0, cap: 10, pct: 80, open: true })).toEqual({ action: 'resolve', threshold: 8 });
    expect(decideConcurrency({ live: 9, cap: 10, pct: 80, open: false })).toEqual({ action: 'open', threshold: 8 });
  });

  it('never alerts a workspace with no cap, and resolves a stale alert for one', () => {
    expect(decideConcurrency({ live: 5, cap: 0, pct: 80, open: false }).action).toBe('none');
    expect(decideConcurrency({ live: 5, cap: 0, pct: 80, open: true }).action).toBe('resolve');
  });

  it('reads its knobs from the environment with safe defaults', () => {
    expect(concurrencyAlertPct({})).toBe(80);
    expect(concurrencyAlertPct({ CONCURRENCY_ALERT_PCT: '100' })).toBe(100);
    expect(concurrencyAlertPct({ CONCURRENCY_ALERT_PCT: '0' })).toBe(80);
    expect(platformConcurrencyLimit({})).toBeNull();
    expect(platformConcurrencyLimit({ CONCURRENCY_PLATFORM_LIMIT: '20' })).toBe(20);
  });
});
