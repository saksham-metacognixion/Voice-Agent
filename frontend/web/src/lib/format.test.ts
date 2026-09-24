import { describe, expect, it } from 'vitest';
import { formatDuration, formatPhone, localDate, shiftDate, startOfLocalDay } from './format';

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('–');
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
});
