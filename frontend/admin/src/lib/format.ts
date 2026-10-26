/** Numbers, dates and money as the console shows them. Staff read UTC-ish browser-local times. */

export function formatDateTime(iso: string | null | undefined, opts: { seconds?: boolean } = {}): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  try {
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(opts.seconds ? { second: '2-digit' } : {}) }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  try {
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** "3 min ago", "in 2 h", "yesterday" — for last-activity columns. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '–';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '–';
  const diff = t - now;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 86_400_000],
    ['month', 30 * 86_400_000],
    ['week', 7 * 86_400_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, ms] of units) {
      if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
    }
    return 'just now';
  } catch {
    return formatDateTime(iso);
  }
}

/** `YYYY-MM-DD` → "24 Sep". */
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

/** Credits to two decimals (§5.1). */
export function formatCredits(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
}

/** Signed credits: "+12.5" / "−3". */
export function formatDelta(value: number): string {
  const abs = formatCredits(Math.abs(value));
  return value < 0 ? `−${abs}` : `+${abs}`;
}

/** Cents + ISO currency → "$49.00". */
export function formatCents(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '–';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return `${value.toFixed(digits)}%`;
}

/** `+14165550100` → `+1 416 555 0100` for a NANP number; other numbers are left alone. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '–';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** The first 8 characters of a uuid or call id, for a table cell. */
export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return '–';
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

/** `snake_case` → "Snake case". */
export function humanize(value: string | null | undefined): string {
  if (!value) return '–';
  const s = value.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A datetime-local input value → ISO with offset, or undefined when empty/invalid. */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** "3 / 20" against an allowance, "3 live" when none is set — never "3 / 0" (QA-051). */
export function concurrencyText(c: { live: number | null; allowance: number | null }): string {
  const live = c.live ?? '?';
  return c.allowance ? `${live} / ${c.allowance}` : `${live} live`;
}
