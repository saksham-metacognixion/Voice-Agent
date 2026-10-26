import { describe, expect, it } from 'vitest';
import { formatDate, formatDuration, formatPhone, localDate, shiftDate, startOfLocalDay } from './format';

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('–');
  });
  it('keeps the year on a date that can be months away', () => {
    // 04:57 UTC on 25 Sep 2027 is still the 25th in Toronto; the year is what D1 lost.
    expect(formatDate('2027-09-25T04:57:02Z', 'America/Toronto')).toMatch(/2027/);
    expect(formatDate('2027-09-25T02:00:00Z', 'America/Toronto')).toMatch(/24/);
    expect(formatDate(null)).toBe('–');
  });
  it('spaces NANP numbers and leaves others alone', () => {
    expect(formatPhone('+14165550100')).toBe('+1 416 555 0100');
    expect(formatPhone('+442071838750')).toBe('+442071838750');
  });
  it('finds the local date and the local midnight across a DST change', () => {
    expect(localDate(new Date('2026-09-25T03:00:00Z'), 'America/Toronto')).toBe('2026-09-24');
    expect(startOfLocalDay('2026-09-24', 'America/Toronto').toISOString()).toBe('2026-09-24T04:00:00.000Z');
    // The clocks go back on 1 Nov 2026 in Toronto: the 2nd starts at 05:00 UTC.
    expect(startOfLocalDay('2026-11-02', 'America/Toronto').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('resolves each day with that day’s own offset, the same instants GET /stats uses (QA-027)', () => {
    // Seven days back from 3 Nov 2026 (EST) is 28 Oct, still EDT: 04:00 UTC, not 05:00.
    expect(startOfLocalDay(shiftDate(localDate(new Date('2026-11-03T15:00:00Z'), 'America/Toronto'), -6), 'America/Toronto').toISOString()).toBe('2026-10-28T04:00:00.000Z');
    // The 25-hour day starts on summer time; the spring change goes the other way.
    expect(startOfLocalDay('2026-11-01', 'America/Toronto').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(startOfLocalDay('2026-03-08', 'America/Toronto').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(startOfLocalDay('2026-03-09', 'America/Toronto').toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });
});
