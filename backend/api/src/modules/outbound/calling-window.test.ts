import { DEFAULT_OUTBOUND_COUNTRIES, type OutboundCountryRule } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { callingWindowVerdict, insideCallingWindow } from './calling-window';

const US = DEFAULT_OUTBOUND_COUNTRIES.US!;
const CA = DEFAULT_OUTBOUND_COUNTRIES.CA!;
const at = (iso: string) => new Date(iso);

/*
 * The window is the intersection over every zone of the country, each on its own clock.
 * 2026: the US and Canada leave daylight time on Sunday 1 November at 02:00 local.
 */
describe('US — 8 am to 9 pm, every zone from New York to Honolulu (47 CFR 64.1200(c)(1))', () => {
  it('opens when Honolulu reaches 8 am and closes when New York reaches 9 pm', () => {
    // Wed 28 Oct, daylight time: Honolulu 08:00 = 18:00Z, New York 21:00 EDT = 01:00Z.
    expect(insideCallingWindow(US, at('2026-10-28T17:59:00Z'))).toBe(false);
    expect(insideCallingWindow(US, at('2026-10-28T18:00:00Z'))).toBe(true);
    expect(insideCallingWindow(US, at('2026-10-29T00:59:00Z'))).toBe(true);
    expect(insideCallingWindow(US, at('2026-10-29T01:00:00Z'))).toBe(false);
  });

  it('names the next opening to the minute — 8 am in Honolulu — when New York is already awake but Hawaii is not', () => {
    const v = callingWindowVerdict(US, at('2026-10-28T12:00:00Z')); // 08:00 in New York, 02:00 in Honolulu
    expect(v).toEqual({ open: false, nextAt: at('2026-10-28T18:00:00Z') });
  });

  it('follows the end of daylight time: 9 pm in New York is an hour later in UTC after 1 November', () => {
    // 01:30Z is 21:30 EDT on 28 Oct (closed) but 20:30 EST on 2 Nov (open).
    expect(insideCallingWindow(US, at('2026-10-29T01:30:00Z'))).toBe(false);
    expect(insideCallingWindow(US, at('2026-11-03T01:30:00Z'))).toBe(true);
    expect(insideCallingWindow(US, at('2026-11-03T02:00:00Z'))).toBe(false);
  });

  it('keeps a configured holiday closed in every zone, and opens again the next local morning', () => {
    const thanksgiving: OutboundCountryRule = { ...US, closed_dates: ['2026-11-26'] };
    expect(insideCallingWindow(thanksgiving, at('2026-11-26T20:00:00Z'))).toBe(false);
    expect(callingWindowVerdict(thanksgiving, at('2026-11-26T20:00:00Z')).nextAt).toEqual(at('2026-11-27T18:00:00Z'));
  });
});

describe('Canada — weekdays 9 am to 9:30 pm, weekends 10 am to 6 pm (CRTC UTR Part III)', () => {
  it('uses the weekend window on Saturday: 10 am in Vancouver to 6 pm in St. John’s', () => {
    // Sat 31 Oct, daylight time: Vancouver 10:00 PDT = 17:00Z, St. John's 18:00 NDT = 20:30Z.
    expect(insideCallingWindow(CA, at('2026-10-31T16:59:00Z'))).toBe(false);
    expect(insideCallingWindow(CA, at('2026-10-31T17:00:00Z'))).toBe(true);
    expect(insideCallingWindow(CA, at('2026-10-31T20:29:00Z'))).toBe(true);
    expect(insideCallingWindow(CA, at('2026-10-31T20:30:00Z'))).toBe(false);
  });

  it('carries a closed Saturday evening over to Sunday morning, whatever the zones’ clocks did overnight', () => {
    // Which zones left daylight time on 1 Nov depends on the tz data (2026c keeps British
    // Columbia and Alberta on it for good), so this asserts the property, not an hour: the
    // answer is Sunday, every zone is inside Sunday's window then, and a minute earlier one is not.
    const { nextAt } = callingWindowVerdict(CA, at('2026-10-31T20:30:00Z'));
    expect(nextAt).not.toBeNull();
    expect(nextAt!.getTime()).toBeGreaterThan(at('2026-11-01T12:00:00Z').getTime());
    expect(nextAt!.getTime()).toBeLessThan(at('2026-11-01T22:00:00Z').getTime());
    expect(insideCallingWindow(CA, nextAt!)).toBe(true);
    expect(insideCallingWindow(CA, new Date(nextAt!.getTime() - 60_000))).toBe(false);
    for (const zone of CA.zones) {
      const local = nextAt!.toLocaleString('en-CA', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
      expect(local, zone).toMatch(/^Sun/);
    }
  });

  it('holds each zone to its own day: Friday night in Vancouver is Saturday morning in St. John’s', () => {
    // Fri 30 Oct 23:00 PDT = Sat 31 Oct 03:30 NDT: Newfoundland is outside Saturday's window.
    expect(insideCallingWindow(CA, at('2026-10-31T06:00:00Z'))).toBe(false);
  });

  it('uses the weekday window on Monday: 9 am in Vancouver to 9:30 pm in St. John’s', () => {
    // Mon 2 Nov, standard time: Vancouver 09:00 PST = 17:00Z, St. John's 21:30 NST = 01:00Z.
    expect(insideCallingWindow(CA, at('2026-11-02T17:00:00Z'))).toBe(true);
    expect(insideCallingWindow(CA, at('2026-11-03T00:59:00Z'))).toBe(true);
    expect(insideCallingWindow(CA, at('2026-11-03T01:00:00Z'))).toBe(false);
  });
});

describe('a rule that cannot be met', () => {
  const closed = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };

  it('names no next window past the horizon rather than guess one', () => {
    expect(callingWindowVerdict({ zones: ['America/Toronto'], days: closed, closed_dates: [] }, at('2026-10-28T15:00:00Z'))).toEqual({ open: false, nextAt: null });
  });

  it('treats a zone Intl does not know as closed', () => {
    const rule = { zones: ['Mars/Olympus_Mons'], days: { ...closed, wed: { start: '00:00', end: '23:59' } }, closed_dates: [] };
    expect(insideCallingWindow(rule, at('2026-10-28T15:00:00Z'))).toBe(false);
  });
});
