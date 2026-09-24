import { describe, expect, it } from 'vitest';
import { activitySeries, seriesTotal } from './activity-series';

describe('activitySeries', () => {
  const stats = {
    timezone: 'America/Toronto',
    from: '2026-08-26T04:00:00.000Z',
    to: '2026-09-24T13:00:01.000Z',
    by_day: [
      { date: '2026-09-24', calls: 3, missed: 1, minutes: 4.5, credits: 4.5 },
      { date: '2026-09-01', calls: 1, missed: 0, minutes: 2, credits: 2 },
    ],
  };

  it('fills every local day of the window, oldest first, with zeros where the API had no row', () => {
    const series = activitySeries(stats);
    expect(series).toHaveLength(30);
    expect(series[0]!.date).toBe('2026-08-26');
    expect(series.at(-1)).toEqual({ date: '2026-09-24', calls: 3, missed: 1, minutes: 4.5, credits: 4.5 });
    expect(series.find((p) => p.date === '2026-09-01')?.calls).toBe(1);
    expect(series.filter((p) => p.calls === 0)).toHaveLength(28);
  });

  it('uses the workspace day, not UTC, for the last column', () => {
    // 03:00 UTC on the 25th is still the 24th in Toronto.
    const series = activitySeries({ ...stats, to: '2026-09-25T03:00:01.000Z' });
    expect(series.at(-1)!.date).toBe('2026-09-24');
  });

  it('sums a metric', () => {
    expect(seriesTotal(activitySeries(stats), 'calls')).toBe(4);
    expect(seriesTotal(activitySeries(stats), 'minutes')).toBe(6.5);
  });
});
