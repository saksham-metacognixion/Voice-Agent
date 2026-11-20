import { hoursProblems, type BusinessHours } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { dateRows, withDateRows } from './hours-view';

const week: BusinessHours = { days: { mon: [{ open: '09:00', close: '17:00' }] }, closed_dates: ['2026-12-25'], date_overrides: [{ date: '2026-12-24', intervals: [{ open: '09:00', close: '13:00' }] }] };

describe('the special-dates list', () => {
  it('shows closed dates and special hours as one list, by date', () => {
    expect(dateRows(week)).toEqual([
      { date: '2026-12-24', closed: false, intervals: [{ open: '09:00', close: '13:00' }] },
      { date: '2026-12-25', closed: true, intervals: [] },
    ]);
  });

  it('round-trips to the stored shape without touching the week or the zone', () => {
    expect(withDateRows({ ...week, timezone: 'Asia/Riyadh' }, dateRows(week))).toEqual({ ...week, timezone: 'Asia/Riyadh' });
  });

  it('stores a day switched to closed as a closed date, and drops an empty override list', () => {
    const rows = dateRows(week).map((r) => ({ ...r, closed: true, intervals: [] }));
    const next = withDateRows(week, rows);
    expect(next).toEqual({ days: week.days, closed_dates: ['2026-12-24', '2026-12-25'] });
    expect(hoursProblems(next)).toEqual([]);
  });

  it('keeps an override with no hours readable as closed (the inbound check treats it so)', () => {
    expect(dateRows({ days: {}, closed_dates: [], date_overrides: [{ date: '2026-12-31', intervals: [] }] })).toEqual([{ date: '2026-12-31', closed: true, intervals: [] }]);
  });
});
