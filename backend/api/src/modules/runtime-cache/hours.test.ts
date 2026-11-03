import { describe, expect, it } from 'vitest';
import type { BusinessHours } from '@portal/schemas';
import { businessVariables, isOpen, localClock, nextOpening, parseBusinessHours } from './hours';

/*
 * The §13.9 hours check. Every case here is one a real customer hits: a business in a
 * timezone that is not the server's, a bar that closes at 2am, a statutory holiday, and a
 * misconfigured timezone that must never stop the phone ringing.
 */

const TORONTO = 'America/Toronto';

function hours(partial: Partial<BusinessHours> = {}): BusinessHours {
  return { days: {}, closed_dates: [], ...partial };
}

/** 2026-09-16 is a Wednesday. 14:00 UTC is 10:00 in Toronto (EDT, UTC−4). */
const WED_1400_UTC = new Date('2026-09-16T14:00:00Z');

describe('localClock', () => {
  it('reads the local weekday and wall clock for a zone', () => {
    expect(localClock(WED_1400_UTC, TORONTO)).toEqual({ weekday: 'wed', minutes: 600, date: '2026-09-16', time: '10:00' });
  });

  it('crosses the date line correctly', () => {
    // 2026-09-16T23:30Z is already Thursday morning in Tokyo.
    const tokyo = localClock(new Date('2026-09-16T23:30:00Z'), 'Asia/Tokyo');
    expect(tokyo).toMatchObject({ weekday: 'thu', date: '2026-09-17', time: '08:30' });
  });

  it('renders local midnight as 00:00, not 24:00', () => {
    expect(localClock(new Date('2026-09-17T04:00:00Z'), TORONTO)).toMatchObject({ time: '00:00', minutes: 0 });
  });

  it('returns null for a zone Intl does not know', () => {
    expect(localClock(WED_1400_UTC, 'Mars/Olympus')).toBeNull();
  });
});

describe('isOpen', () => {
  const nineToFive = hours({ days: { wed: [{ open: '09:00', close: '17:00' }] } });

  it('is open inside the interval and closed outside it', () => {
    expect(isOpen(nineToFive, WED_1400_UTC, TORONTO).open).toBe(true);
    // 02:00 Toronto, same Wednesday.
    expect(isOpen(nineToFive, new Date('2026-09-16T06:00:00Z'), TORONTO).open).toBe(false);
    // 17:00 exactly is closed: the interval is [open, close).
    expect(isOpen(nineToFive, new Date('2026-09-16T21:00:00Z'), TORONTO).open).toBe(false);
    // 09:00 exactly is open.
    expect(isOpen(nineToFive, new Date('2026-09-16T13:00:00Z'), TORONTO).open).toBe(true);
  });

  it('reads the schedule in the business timezone, not the server one', () => {
    // 14:00 UTC is 10:00 in Toronto (open) and 23:00 in Kolkata (closed).
    expect(isOpen(nineToFive, WED_1400_UTC, TORONTO).open).toBe(true);
    expect(isOpen({ ...nineToFive, timezone: 'Asia/Kolkata' }, WED_1400_UTC, TORONTO).open).toBe(false);
  });

  it('handles an interval that runs past midnight, from both sides', () => {
    const bar = hours({ days: { wed: [{ open: '18:00', close: '02:00' }] } });
    // 23:00 Wednesday Toronto.
    expect(isOpen(bar, new Date('2026-09-17T03:00:00Z'), TORONTO).open).toBe(true);
    // 01:00 Thursday Toronto — covered by Wednesday's overnight interval.
    expect(isOpen(bar, new Date('2026-09-17T05:00:00Z'), TORONTO).open).toBe(true);
    // 03:00 Thursday Toronto — past the close.
    expect(isOpen(bar, new Date('2026-09-17T07:00:00Z'), TORONTO).open).toBe(false);
  });

  it('honours split shifts and closes over the lunch gap', () => {
    const split = hours({ days: { wed: [{ open: '09:00', close: '12:00' }, { open: '13:00', close: '17:00' }] } });
    expect(isOpen(split, new Date('2026-09-16T16:30:00Z'), TORONTO).open).toBe(false); // 12:30
    expect(isOpen(split, new Date('2026-09-16T17:30:00Z'), TORONTO).open).toBe(true); // 13:30
  });

  it('closes on a listed closed date even inside opening hours', () => {
    const holiday = hours({ days: { wed: [{ open: '09:00', close: '17:00' }] }, closed_dates: ['2026-09-16'] });
    expect(isOpen(holiday, WED_1400_UTC, TORONTO).open).toBe(false);
  });

  it('treats a day with no intervals as closed', () => {
    expect(isOpen(hours({ days: { thu: [{ open: '09:00', close: '17:00' }] } }), WED_1400_UTC, TORONTO).open).toBe(false);
  });

  it('fails open with a note when there is no schedule or the zone is unusable', () => {
    expect(isOpen(null, WED_1400_UTC, TORONTO)).toMatchObject({ open: true, note: 'no_schedule' });
    expect(isOpen(nineToFive, WED_1400_UTC, 'Nowhere/Nothing')).toMatchObject({ open: true, note: 'invalid_timezone' });
  });
});

describe('nextOpening', () => {
  it('names later today, tomorrow, or the weekday', () => {
    const schedule = hours({ days: { wed: [{ open: '09:00', close: '11:00' }, { open: '14:00', close: '17:00' }], thu: [{ open: '09:00', close: '17:00' }] } });
    // 10:00 Toronto Wednesday: the next opening is this afternoon.
    expect(nextOpening(schedule, WED_1400_UTC, TORONTO)).toBe('today at 14:00');
    // 18:00 Toronto Wednesday: tomorrow.
    expect(nextOpening(schedule, new Date('2026-09-16T22:00:00Z'), TORONTO)).toBe('tomorrow at 09:00');
  });

  it('is null when nothing is scheduled at all', () => {
    expect(nextOpening(hours(), WED_1400_UTC, TORONTO)).toBeNull();
    expect(nextOpening(null, WED_1400_UTC, TORONTO)).toBeNull();
  });
});

describe('businessVariables (§9.7, ADR 0035)', () => {
  const nineToFive = hours({ days: { mon: [{ open: '09:00', close: '17:00' }], wed: [{ open: '09:00', close: '17:00' }] } });

  it('open: true, no next opening, the local clock', () => {
    expect(businessVariables(nineToFive, WED_1400_UTC, TORONTO)).toEqual({ business_open: 'true', next_open_time: '', current_time: '10:00' });
  });

  it('closed: false and when it next opens', () => {
    // Wednesday 18:00 Toronto → Monday.
    expect(businessVariables(nineToFive, new Date('2026-09-16T22:00:00Z'), TORONTO)).toEqual({ business_open: 'false', next_open_time: 'Monday at 09:00', current_time: '18:00' });
    // Wednesday 07:00 Toronto → later today.
    expect(businessVariables(nineToFive, new Date('2026-09-16T11:00:00Z'), TORONTO)).toEqual({ business_open: 'false', next_open_time: 'today at 09:00', current_time: '07:00' });
  });

  it('no hours = open; an unreadable zone = open with the instant as the time', () => {
    expect(businessVariables(null, WED_1400_UTC, TORONTO)).toEqual({ business_open: 'true', next_open_time: '', current_time: '10:00' });
    expect(businessVariables(nineToFive, WED_1400_UTC, 'Not/AZone')).toEqual({ business_open: 'true', next_open_time: '', current_time: WED_1400_UTC.toISOString() });
  });

  it('is decided in the business zone across a DST change, not the server clock', () => {
    // Toronto leaves DST on 1 Nov 2026 at 02:00. 13:30 UTC is 09:30 EDT on Sat 31 Oct and 08:30 EST on Mon 2 Nov.
    const sat = hours({ days: { sat: [{ open: '09:00', close: '12:00' }], mon: [{ open: '09:00', close: '12:00' }] } });
    expect(businessVariables(sat, new Date('2026-10-31T13:30:00Z'), TORONTO)).toMatchObject({ business_open: 'true', current_time: '09:30' });
    expect(businessVariables(sat, new Date('2026-11-02T13:30:00Z'), TORONTO)).toMatchObject({ business_open: 'false', current_time: '08:30', next_open_time: 'today at 09:00' });
  });

  it('parseBusinessHours reads a stored schedule and refuses a broken one', () => {
    expect(parseBusinessHours(nineToFive)).toEqual(nineToFive);
    expect(parseBusinessHours(null)).toBeNull();
    expect(parseBusinessHours({ days: 'nope' })).toBeNull();
  });
});
