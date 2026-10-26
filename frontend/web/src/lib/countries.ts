import { activeIntlLocale, activeLocale } from '../i18n';

/** Launch countries first (§20 item 4), then the rest of the common list. `name` is the English fallback; show `countryName()`. */
export const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'CA', name: 'Canada' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' },
  { code: 'IN', name: 'India' },
  { code: 'IE', name: 'Ireland' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'MX', name: 'Mexico' },
  { code: 'BR', name: 'Brazil' },
  { code: 'SG', name: 'Singapore' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'JP', name: 'Japan' },
];

const regions = new Map<string, Intl.DisplayNames | null>();

/** The country's name in the portal's language ("Canada", "كندا"), the English name when the runtime has none. */
export function countryName(code: string): string {
  const locale = activeIntlLocale();
  if (!regions.has(locale)) {
    try {
      regions.set(locale, new Intl.DisplayNames([locale, 'en'], { type: 'region' }));
    } catch {
      regions.set(locale, null);
    }
  }
  const name = regions.get(locale)?.of(code);
  return name && name !== code ? name : (COUNTRIES.find((c) => c.code === code)?.name ?? code);
}

/** The browser's zone first, then the IANA list when the runtime has it. */
export function timezones(): string[] {
  let all: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    all = intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    all = [];
  }
  if (all.length === 0) {
    all = ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax', 'America/St_Johns', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Australia/Sydney', 'UTC'];
  }
  return all;
}

const zoneNames = new Map<string, string>();

/**
 * An IANA zone for a picker. English shows the id as it always has (`America/Toronto`);
 * another language puts the zone's own name first ("توقيت شرق أمريكا الشمالية · America/Toronto"),
 * since the ids themselves have no translation. The stored value is always the id.
 */
export function timezoneLabel(zone: string): string {
  const id = zone.replace(/_/g, ' ');
  if (activeLocale() === 'en') return id;
  const key = `${activeIntlLocale()}|${zone}`;
  if (!zoneNames.has(key)) {
    let name = '';
    try {
      name = new Intl.DateTimeFormat(activeIntlLocale(), { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
      name = '';
    }
    zoneNames.set(key, name);
  }
  const name = zoneNames.get(key);
  return name ? `${name} · ${id}` : id;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
