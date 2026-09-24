/**
 * One place for the numbers and dates the dashboard shows. Everything takes the
 * workspace timezone where a date is involved: "today" is the customer's day (§13.11,
 * `tenants.timezone`), never the browser's or UTC.
 */

export function formatDateTime(iso: string | null | undefined, timeZone?: string, opts: { seconds?: boolean } = {}): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(opts.seconds ? { second: '2-digit' } : {}),
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** `YYYY-MM-DD` (a `statsDay.date`) → a short day label such as "24 Sep". */
export function formatDayLabel(ymd: string, style: 'short' | 'weekday' = 'short'): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(Date.UTC(y, m - 1, d));
  try {
    return new Intl.DateTimeFormat(undefined, style === 'weekday' ? { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' } : { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(date);
  } catch {
    return ymd;
  }
}

/** Seconds → `m:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

export function formatNumber(value: number | null | undefined, maxFractionDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: maxFractionDigits }).format(value);
}

/** Credits to two decimals, the way the balance pill and the wallet show them (§5.1). */
export function formatCreditsValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
}

/** `+14165550100` → `+1 416 555 0100` for a NANP number; other numbers are left alone. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '–';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** The local calendar date (`YYYY-MM-DD`) of an instant in a timezone. */
export function localDate(instant: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** `YYYY-MM-DD` shifted by whole days, on the calendar (no timezone involved). */
export function shiftDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + days));
  return date.toISOString().slice(0, 10);
}

/**
 * The instant at which local day `ymd` begins in `timeZone`. Two passes of "format the
 * guess in the zone and correct by the difference" pin the offset across a DST change.
 */
export function startOfLocalDay(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  let guess = Date.UTC(y!, m! - 1, d!);
  for (let i = 0; i < 2; i += 1) {
    const parts = partsIn(new Date(guess), timeZone);
    const seen = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess -= seen - Date.UTC(y!, m! - 1, d!);
  }
  return new Date(guess);
}

function partsIn(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value])) as Record<string, string>;
    return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
  } catch {
    return { year: instant.getUTCFullYear(), month: instant.getUTCMonth() + 1, day: instant.getUTCDate(), hour: instant.getUTCHours(), minute: instant.getUTCMinutes(), second: instant.getUTCSeconds() };
  }
}
