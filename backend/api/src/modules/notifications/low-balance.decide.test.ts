import { describe, expect, it } from 'vitest';
import { decideLowBalance, lowBalanceKey, pctOfLowBalanceKey } from './low-balance.decide';

const thresholds = [20, 5, 0];

describe('decideLowBalance (§5.4)', () => {
  it('opens nothing while the balance is above every threshold', () => {
    expect(decideLowBalance({ balance: 400, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set() })).toEqual({ open: [], resolve: [] });
  });

  it('opens the thresholds crossed, largest first, at or below the line', () => {
    expect(decideLowBalance({ balance: 100, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set() })).toEqual({ open: [{ pct: 20, credits: 100 }], resolve: [] });
    expect(decideLowBalance({ balance: 12, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set() })).toEqual({
      open: [
        { pct: 20, credits: 100 },
        { pct: 5, credits: 25 },
      ],
      resolve: [],
    });
    expect(decideLowBalance({ balance: 0, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set() }).open.map((o) => o.pct)).toEqual([20, 5, 0]);
    expect(decideLowBalance({ balance: -3, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set() }).open.map((o) => o.pct)).toEqual([20, 5, 0]);
  });

  it('does not re-open a threshold that is already open — the schedule can run every 15 minutes', () => {
    expect(decideLowBalance({ balance: 80, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set([20]) })).toEqual({ open: [], resolve: [] });
    expect(decideLowBalance({ balance: 3, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set([20, 5]) })).toEqual({ open: [], resolve: [] });
  });

  it('resolves an open threshold once the balance is back above it, so the next drop alerts again', () => {
    const recovered = decideLowBalance({ balance: 300, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set([20, 5]) });
    expect(recovered).toEqual({ open: [], resolve: [20, 5] });
    // Partial recovery: back above 5% but still under 20%.
    expect(decideLowBalance({ balance: 60, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set([20, 5]) })).toEqual({ open: [], resolve: [5] });
    // And dropping again after a full recovery opens afresh.
    expect(decideLowBalance({ balance: 90, baseCredits: 500, thresholdsPct: thresholds, openPct: new Set() }).open).toEqual([{ pct: 20, credits: 100 }]);
  });

  it('treats "no base" as nothing to alert on and clears anything left open', () => {
    expect(decideLowBalance({ balance: 0, baseCredits: 0, thresholdsPct: thresholds, openPct: new Set([20]) })).toEqual({ open: [], resolve: [20] });
  });

  it('resolves an open threshold the policy no longer lists', () => {
    expect(decideLowBalance({ balance: 1, baseCredits: 500, thresholdsPct: [20], openPct: new Set([20, 5]) })).toEqual({ open: [], resolve: [5] });
  });

  it('round-trips the alert key', () => {
    expect(lowBalanceKey(20)).toBe('low_balance:20');
    expect(pctOfLowBalanceKey('low_balance:5')).toBe(5);
    expect(pctOfLowBalanceKey('concurrency')).toBeNull();
  });
});
