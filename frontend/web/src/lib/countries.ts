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

/**
 * The zones each listed country runs on, its main one first (A4, BUG-008 #4). Hours, the
 * daily digest and the D1/D2 day windows all run on `tenants.timezone`, so a Canadian
 * workspace left on the browser's `Asia/Calcutta` works on the wrong day. An entry ending
 * in `/` is a prefix (`Australia/`). There is no zone → country table in `Intl`, hence
 * the list; a zone missing from it only shows the mismatch hint, it never blocks.
 */
export const COUNTRY_ZONES: Record<string, readonly string[]> = {
  CA: ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Regina', 'America/Halifax', 'America/St_Johns', 'America/Moncton', 'America/Montreal', 'America/Whitehorse', 'America/Yellowknife', 'America/Iqaluit', 'America/Glace_Bay', 'America/Goose_Bay', 'America/Dawson_Creek', 'America/Creston', 'America/Fort_Nelson', 'America/Swift_Current', 'America/Rankin_Inlet', 'America/Resolute', 'America/Cambridge_Bay', 'America/Inuvik', 'America/Dawson', 'America/Atikokan', 'America/Blanc-Sablon', 'America/Nipigon', 'America/Thunder_Bay', 'America/Rainy_River', 'America/Pangnirtung'],
  US: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'America/Detroit', 'America/Boise', 'America/Indiana/', 'America/Kentucky/', 'America/North_Dakota/', 'America/Juneau', 'America/Sitka', 'America/Nome', 'America/Yakutat', 'America/Metlakatla', 'America/Adak', 'America/Menominee'],
  GB: ['Europe/London'],
  AU: ['Australia/Sydney', 'Australia/'],
  IN: ['Asia/Kolkata', 'Asia/Calcutta'],
  IE: ['Europe/Dublin'],
  NZ: ['Pacific/Auckland', 'Pacific/Chatham'],
  FR: ['Europe/Paris'],
  DE: ['Europe/Berlin', 'Europe/Busingen'],
  ES: ['Europe/Madrid', 'Atlantic/Canary', 'Africa/Ceuta'],
  IT: ['Europe/Rome'],
  NL: ['Europe/Amsterdam'],
  BE: ['Europe/Brussels'],
  CH: ['Europe/Zurich'],
  SE: ['Europe/Stockholm'],
  NO: ['Europe/Oslo'],
  DK: ['Europe/Copenhagen'],
  FI: ['Europe/Helsinki'],
  PT: ['Europe/Lisbon', 'Atlantic/Azores', 'Atlantic/Madeira'],
  MX: ['America/Mexico_City', 'America/Cancun', 'America/Merida', 'America/Monterrey', 'America/Matamoros', 'America/Chihuahua', 'America/Ciudad_Juarez', 'America/Ojinaga', 'America/Mazatlan', 'America/Bahia_Banderas', 'America/Hermosillo', 'America/Tijuana'],
  BR: ['America/Sao_Paulo', 'America/Manaus', 'America/Recife', 'America/Fortaleza', 'America/Belem', 'America/Bahia', 'America/Maceio', 'America/Araguaina', 'America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Rio_Branco', 'America/Eirunepe', 'America/Santarem', 'America/Noronha'],
  SG: ['Asia/Singapore'],
  AE: ['Asia/Dubai'],
  ZA: ['Africa/Johannesburg'],
  JP: ['Asia/Tokyo'],
};

/** True when `zone` is one `country` runs on; true for a country the table does not know. */
export function zoneInCountry(zone: string, country: string): boolean {
  const zones = COUNTRY_ZONES[country];
  if (!zones) return true;
  return zones.some((z) => (z.endsWith('/') ? zone.startsWith(z) : zone === z));
}

/** The listed country whose zones include `zone`, or null. */
export function countryOfZone(zone: string): string | null {
  for (const { code } of COUNTRIES) if (COUNTRY_ZONES[code] && zoneInCountry(zone, code)) return code;
  return null;
}

/** The zone a workspace in `country` starts on: the browser's when it is one of that country's, else the main one. */
export function defaultZoneFor(country: string, browserZone: string): string {
  return zoneInCountry(browserZone, country) ? browserZone : (COUNTRY_ZONES[country]?.[0] ?? browserZone);
}
