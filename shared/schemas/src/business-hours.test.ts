import { describe, expect, it } from 'vitest';
import { type BusinessHours, businessHours, businessHoursInput, intervalsOn, isOpen, isTimeZone, nextOpeningAt, shiftDate } from './business-hours.js';

const TORONTO = 'America/Toronto';
const h = (partial: Partial<BusinessHours> = {}): BusinessHours => ({ days: {}, closed_dates: [], ...partial });
/** Toronto local time → the instant, in EDT (UTC−4) for these September dates. */
const at = (date: string, time: string) => new Date(`${date}T${time}:00-04:00`);

describe('businessHoursInput (what a write must satisfy)', () => {
  it('accepts a normal week with a split day, an overnight close, overrides and holidays', () => {
    const ok = businessHoursInput.safeParse({
      timezone: 'America/Vancouver',
      days: { mon: [{ open: '09:00', close: '12:00' }, { open: '13:00', close: '17:00' }], fri: [{ open: '18:00', close: '02:00' }] },
      closed_dates: ['2026-12-25'],
      date_overrides: [{ date: '2026-12-24', intervals: [{ open: '09:00', close: '13:00' }] }, { date: '2026-12-31', intervals: [] }],
    });
    expect(ok.success).toBe(true);
  });

  it('refuses an unknown zone, overlapping openings, impossible and repeated dates', () => {
    const issues = (value: unknown) => (businessHoursInput.safeParse(value).error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(issues({ timezone: 'Mars/Olympus', days: {} })).toEqual(['timezone: Not a time zone we recognise']);
    expect(issues({ days: { tue: [{ open: '09:00', close: '13:00' }, { open: '12:00', close: '17:00' }] } })).toEqual(['days.tue: These opening times overlap']);
    // An overnight interval occupies the rest of its own day.
    expect(issues({ days: { sat: [{ open: '20:00', close: '02:00' }, { open: '21:00', close: '23:00' }] } })).toEqual(['days.sat: These opening times overlap']);
    expect(issues({ closed_dates: ['2026-02-30', '2026-12-25', '2026-12-25'] })).toEqual(['closed_dates.0: Not a real date', 'closed_dates.2: This date is listed twice']);
    expect(issues({ closed_dates: ['2026-12-25'], date_overrides: [{ date: '2026-12-25', intervals: [] }] })).toEqual(['date_overrides.0.date: This date is already closed']);
    expect(issues({ days: { mon: Array.from({ length: 5 }, (_, i) => ({ open: `0${i}:00`, close: `0${i}:30` })) } })).toEqual(['days.mon: At most 4 openings a day']);
  });

  it('stays lenient on read: a schedule stored before these rules still parses', () => {
    expect(businessHours.safeParse({ timezone: 'Mars/Olympus', days: { mon: [{ open: '09:00', close: '13:00' }, { open: '12:00', close: '17:00' }] } }).success).toBe(true);
    expect(businessHours.parse({ days: {} })).toEqual({ days: {}, closed_dates: [] });
  });

  it('knows a zone when Intl does', () => {
    expect(isTimeZone('America/Toronto')).toBe(true);
    expect(isTimeZone('Asia/Riyadh')).toBe(true);
    expect(isTimeZone('EST5EDT')).toBe(true);
    expect(isTimeZone('Toronto')).toBe(false);
  });
});

describe('isOpen with date overrides (D16)', () => {
  // 2026-09-16 is a Wednesday.
  const week = h({ days: { wed: [{ open: '09:00', close: '17:00' }], thu: [{ open: '09:00', close: '17:00' }], tue: [{ open: '20:00', close: '02:00' }] } });

  it('uses the override instead of the weekday', () => {
    const short = { ...week, date_overrides: [{ date: '2026-09-16', intervals: [{ open: '09:00', close: '12:00' }] }] };
    expect(isOpen(short, at('2026-09-16', '11:59'), TORONTO).open).toBe(true);
    expect(isOpen(short, at('2026-09-16', '12:00'), TORONTO).open).toBe(false);
    expect(isOpen(short, at('2026-09-17', '15:00'), TORONTO).open).toBe(true); // the next day is ordinary
  });

  it('opens on a day the week has closed when an override says so', () => {
    const sunday = { ...week, date_overrides: [{ date: '2026-09-20', intervals: [{ open: '10:00', close: '14:00' }] }] };
    expect(isOpen(sunday, at('2026-09-20', '11:00'), TORONTO).open).toBe(true);
    expect(isOpen(week, at('2026-09-20', '11:00'), TORONTO).open).toBe(false);
  });

  it('an override with no hours closes the whole date', () => {
    const off = { ...week, date_overrides: [{ date: '2026-09-16', intervals: [] }] };
    expect(isOpen(off, at('2026-09-16', '10:00'), TORONTO).open).toBe(false);
  });

  it('a closed date also shuts the early hours the evening before would run into', () => {
    // Tuesday 20:00–02:00 normally covers Wednesday 01:00.
    expect(isOpen(week, at('2026-09-16', '01:00'), TORONTO).open).toBe(true);
    expect(isOpen({ ...week, closed_dates: ['2026-09-16'] }, at('2026-09-16', '01:00'), TORONTO).open).toBe(false);
    expect(isOpen({ ...week, date_overrides: [{ date: '2026-09-16', intervals: [] }] }, at('2026-09-16', '01:00'), TORONTO).open).toBe(false);
  });

  it('an override can run past midnight, and a closed eve does not', () => {
    const late = { ...week, date_overrides: [{ date: '2026-09-17', intervals: [{ open: '18:00', close: '03:00' }] }] };
    expect(isOpen(late, at('2026-09-18', '02:30'), TORONTO).open).toBe(true);
    expect(isOpen({ ...week, closed_dates: ['2026-09-15'] }, at('2026-09-16', '01:00'), TORONTO).open).toBe(false);
  });

  it('reads the boundaries exactly: open at the opening minute, closed at the closing one', () => {
    expect(isOpen(week, at('2026-09-16', '09:00'), TORONTO).open).toBe(true);
    expect(isOpen(week, at('2026-09-16', '08:59'), TORONTO).open).toBe(false);
    expect(isOpen(week, at('2026-09-16', '17:00'), TORONTO).open).toBe(false);
  });

  it('decides in the schedule zone, not the server one', () => {
    const riyadh = h({ timezone: 'Asia/Riyadh', days: { wed: [{ open: '09:00', close: '17:00' }] } });
    // 06:30 UTC is 09:30 in Riyadh (UTC+3) and 02:30 in Toronto.
    expect(isOpen(riyadh, new Date('2026-09-16T06:30:00Z'), TORONTO).open).toBe(true);
    expect(isOpen(riyadh, new Date('2026-09-16T05:30:00Z'), TORONTO).open).toBe(false);
  });

  it('finds the next opening through overrides and closed dates', () => {
    const holiday = { ...week, closed_dates: ['2026-09-17'], date_overrides: [{ date: '2026-09-18', intervals: [{ open: '11:00', close: '15:00' }] }] };
    expect(nextOpeningAt(holiday, at('2026-09-16', '18:00'), TORONTO)).toEqual({ offset: 2, weekday: 'fri', date: '2026-09-18', time: '11:00' });
  });
});

describe('date helpers', () => {
  it('shifts across month, year and DST boundaries by calendar day', () => {
    expect(shiftDate('2026-03-01', -1)).toEqual({ date: '2026-02-28', weekday: 'sat' });
    expect(shiftDate('2026-12-31', 1)).toEqual({ date: '2027-01-01', weekday: 'fri' });
    expect(shiftDate('2026-11-01', 1)).toEqual({ date: '2026-11-02', weekday: 'mon' });
  });

  it('applies precedence closed date → override → weekday', () => {
    const hours = h({ days: { mon: [{ open: '09:00', close: '17:00' }] }, closed_dates: ['2026-09-21'], date_overrides: [{ date: '2026-09-28', intervals: [{ open: '10:00', close: '11:00' }] }] });
    expect(intervalsOn(hours, '2026-09-21', 'mon')).toEqual([]);
    expect(intervalsOn(hours, '2026-09-28', 'mon')).toEqual([{ open: '10:00', close: '11:00' }]);
    expect(intervalsOn(hours, '2026-10-05', 'mon')).toEqual([{ open: '09:00', close: '17:00' }]);
  });
});
