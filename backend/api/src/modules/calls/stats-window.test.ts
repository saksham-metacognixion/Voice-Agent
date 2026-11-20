import { describe, expect, it } from 'vitest';
import { resolveWindow, startOfLocalDay } from './stats-window';

/*
 * `GET /stats` windows (D1) are whole local days in the workspace's zone. Each midnight
 * takes the offset of its own date: the bug (QA-027) applied today's offset to every
 * past midnight, so a window that crossed a DST change started an hour off.
 */
describe('stats windows across a DST change', () => {
  const toronto = 'America/Toronto';
  // 3 Nov 2026, 10:00 EST — two days after the clocks went back (1 Nov, 02:00 EDT → 01:00 EST).
  const afterFallBack = new Date('2026-11-03T15:00:00Z');

  it('starts today at local midnight on standard time', () => {
    expect(startOfLocalDay(afterFallBack, toronto, 0).toISOString()).toBe('2026-11-03T05:00:00.000Z');
    expect(resolveWindow({ range: 'today' } as never, toronto, afterFallBack).from.toISOString()).toBe('2026-11-03T05:00:00.000Z');
  });

  it('starts a 7-day window on a summer-time midnight with the summer offset', () => {
    // 28 Oct is still EDT (−4): midnight is 04:00 UTC, not 05:00.
    expect(resolveWindow({ range: '7d' } as never, toronto, afterFallBack).from.toISOString()).toBe('2026-10-28T04:00:00.000Z');
    expect(resolveWindow({ range: '30d' } as never, toronto, afterFallBack).from.toISOString()).toBe('2026-10-05T04:00:00.000Z');
  });

  it('handles the 25-hour day itself', () => {
    expect(startOfLocalDay(afterFallBack, toronto, 2).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(startOfLocalDay(afterFallBack, toronto, 1).toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('handles the spring change the other way', () => {
    // 10 Mar 2026, 11:00 EDT; the clocks went forward on 8 Mar. 4 Mar is EST (−5).
    const afterSpring = new Date('2026-03-10T15:00:00Z');
    expect(startOfLocalDay(afterSpring, toronto, 0).toISOString()).toBe('2026-03-10T04:00:00.000Z');
    expect(startOfLocalDay(afterSpring, toronto, 6).toISOString()).toBe('2026-03-04T05:00:00.000Z');
  });

  it('agrees with the portal (D2) on the same days', () => {
    // frontend/web `startOfLocalDay(shiftDate(localDate(now), -6))` gives the same instant.
    expect(startOfLocalDay(afterFallBack, toronto, 6).toISOString()).toBe('2026-10-28T04:00:00.000Z');
  });

  it('uses today’s date in the zone, not UTC’s', () => {
    // 02:00 UTC on 4 Nov is still 3 Nov in Toronto.
    expect(startOfLocalDay(new Date('2026-11-04T02:00:00Z'), toronto, 0).toISOString()).toBe('2026-11-03T05:00:00.000Z');
    // A zone without DST and a half-hour offset.
    expect(startOfLocalDay(afterFallBack, 'Asia/Kolkata', 0).toISOString()).toBe('2026-11-02T18:30:00.000Z');
  });

  it('falls back to UTC midnights for a zone Intl does not know', () => {
    expect(startOfLocalDay(afterFallBack, 'Not/AZone', 1).toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('passes a custom range through', () => {
    const w = resolveWindow({ range: 'custom', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' } as never, toronto, afterFallBack);
    expect(w.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });
});
