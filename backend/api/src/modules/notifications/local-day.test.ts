import { describe, expect, it } from 'vitest';
import { localDate, localDayBounds, localHour, offsetMinutes, previousDate } from './local-day';

/*
 * The digest's notion of "yesterday" is a workspace's local day, so these pin the
 * conversions across zones, half-hour offsets and both DST transitions.
 */
describe('localDate / localHour', () => {
  it('reads the wall clock in the zone, not in UTC', () => {
    const at = new Date('2026-09-22T03:30:00Z'); // 23:30 the day before in Toronto, 09:00 in Kolkata
    expect(localDate(at, 'UTC')).toBe('2026-09-22');
    expect(localDate(at, 'America/Toronto')).toBe('2026-09-21');
    expect(localHour(at, 'America/Toronto')).toBe(23);
    expect(localDate(at, 'Asia/Kolkata')).toBe('2026-09-22');
    expect(localHour(at, 'Asia/Kolkata')).toBe(9);
    expect(localDate(at, 'Pacific/Auckland')).toBe('2026-09-22');
    expect(localHour(at, 'Pacific/Auckland')).toBe(15);
  });

  it('returns null for a zone Intl does not know', () => {
    expect(localDate(new Date(), 'Mars/Olympus_Mons')).toBeNull();
    expect(localHour(new Date(), 'Mars/Olympus_Mons')).toBeNull();
    expect(localDayBounds('2026-09-21', 'Mars/Olympus_Mons')).toBeNull();
  });
});

describe('previousDate', () => {
  it('steps back across month and year boundaries', () => {
    expect(previousDate('2026-09-22')).toBe('2026-09-21');
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
    expect(previousDate('2028-03-01')).toBe('2028-02-29');
    expect(previousDate('2026-01-01')).toBe('2025-12-31');
  });
});

describe('localDayBounds', () => {
  it('is the UTC day for UTC', () => {
    expect(localDayBounds('2026-09-21', 'UTC')).toEqual({ start: new Date('2026-09-21T00:00:00Z'), end: new Date('2026-09-22T00:00:00Z') });
  });

  it('shifts by the zone offset, including half-hour zones', () => {
    expect(localDayBounds('2026-09-21', 'America/Toronto')).toEqual({ start: new Date('2026-09-21T04:00:00Z'), end: new Date('2026-09-22T04:00:00Z') });
    expect(localDayBounds('2026-09-21', 'Asia/Kolkata')).toEqual({ start: new Date('2026-09-20T18:30:00Z'), end: new Date('2026-09-21T18:30:00Z') });
    expect(localDayBounds('2026-09-21', 'America/St_Johns')).toEqual({ start: new Date('2026-09-21T02:30:00Z'), end: new Date('2026-09-22T02:30:00Z') });
  });

  it('makes the spring-forward day 23 hours and the fall-back day 25 hours long', () => {
    // North America 2026: DST starts Sun 8 Mar, ends Sun 1 Nov.
    const spring = localDayBounds('2026-03-08', 'America/Toronto')!;
    expect(spring.start.toISOString()).toBe('2026-03-08T05:00:00.000Z'); // EST midnight
    expect(spring.end.toISOString()).toBe('2026-03-09T04:00:00.000Z'); // EDT midnight
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);

    const fall = localDayBounds('2026-11-01', 'America/Toronto')!;
    expect(fall.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(fall.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);

    // Southern hemisphere goes the other way in the same months.
    const nz = localDayBounds('2026-09-27', 'Pacific/Auckland')!; // NZ DST starts 27 Sep 2026
    expect((nz.end.getTime() - nz.start.getTime()) / 3_600_000).toBe(23);
  });

  it('every instant in the day maps back to that date, and none outside does', () => {
    for (const zone of ['America/Toronto', 'Asia/Kolkata', 'Europe/London', 'Australia/Lord_Howe']) {
      const { start, end } = localDayBounds('2026-10-04', zone)!;
      expect(localDate(start, zone)).toBe('2026-10-04');
      expect(localDate(new Date(end.getTime() - 1), zone)).toBe('2026-10-04');
      expect(localDate(new Date(start.getTime() - 1), zone)).toBe('2026-10-03');
      expect(localDate(end, zone)).toBe('2026-10-05');
    }
  });
});

describe('offsetMinutes', () => {
  it('is the signed wall-clock offset from UTC', () => {
    expect(offsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/Toronto')).toBe(-240);
    expect(offsetMinutes(new Date('2026-01-01T12:00:00Z'), 'America/Toronto')).toBe(-300);
    expect(offsetMinutes(new Date('2026-01-01T12:00:00Z'), 'Asia/Kolkata')).toBe(330);
    expect(offsetMinutes(new Date('2026-01-01T12:00:00Z'), 'UTC')).toBe(0);
  });
});
