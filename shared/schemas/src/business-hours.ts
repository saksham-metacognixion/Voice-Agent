import { z } from 'zod';

/**
 * `tenants.business_hours_json` and `phone_numbers.hours_override_json` (§11, §13.9).
 *
 * Local wall-clock intervals per weekday in the workspace timezone (IANA name). A day
 * that is absent or empty is closed. An interval whose `close` is at or before `open`
 * runs past midnight (22:00–02:00). `closed_dates` are whole days off, YYYY-MM-DD.
 *
 * Used by the inbound hours check, which is on the 300 ms path — so this is deliberately
 * small: no holidays calendar, no per-date overrides beyond closed days.
 */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');

export const hoursInterval = z.object({ open: timeOfDay, close: timeOfDay });
export type HoursInterval = z.infer<typeof hoursInterval>;

export const weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type Weekday = z.infer<typeof weekday>;

export const businessHours = z.object({
  /** Overrides the workspace timezone when set. */
  timezone: z.string().min(1).optional(),
  days: z.record(weekday, z.array(hoursInterval)).default({}),
  closed_dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
});
export type BusinessHours = z.infer<typeof businessHours>;
