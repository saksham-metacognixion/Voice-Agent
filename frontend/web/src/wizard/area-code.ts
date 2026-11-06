import type { PurchasableCountry } from '@portal/schemas';

/**
 * §8 W6 Option A "Suggest": fills the area code from where the workspace is. The spec
 * suggests from the address or city; the workspace records neither, so the time zone
 * (A3, required) is the location we have. One well-known local code per zone and
 * country; a zone the table does not know falls back to the country's largest city.
 * Only ever a preference: provisioning widens to a neighbouring code when the one asked
 * for has no stock (ADR 0013, QA-076), and the copy says so.
 */
const BY_ZONE: Record<PurchasableCountry, Record<string, string>> = {
  CA: {
    'America/Toronto': '416',
    'America/Montreal': '514',
    'America/Vancouver': '604',
    'America/Edmonton': '403',
    'America/Winnipeg': '204',
    'America/Regina': '306',
    'America/Halifax': '902',
    'America/Moncton': '506',
    'America/St_Johns': '709',
    'America/Whitehorse': '867',
    'America/Yellowknife': '867',
    'America/Iqaluit': '867',
  },
  US: {
    'America/New_York': '212',
    'America/Detroit': '313',
    'America/Chicago': '312',
    'America/Indiana/Indianapolis': '317',
    'America/Kentucky/Louisville': '502',
    'America/Denver': '303',
    'America/Boise': '208',
    'America/Phoenix': '602',
    'America/Los_Angeles': '213',
    'America/Anchorage': '907',
    'Pacific/Honolulu': '808',
  },
};

const COUNTRY_DEFAULT: Record<PurchasableCountry, string> = { CA: '416', US: '212' };

export interface AreaCodeSuggestion {
  code: string;
  /** `timezone` when the zone was recognised, `country` when only the country was. */
  basis: 'timezone' | 'country';
}

export function suggestAreaCode(country: PurchasableCountry, timezone: string | null | undefined): AreaCodeSuggestion {
  const byZone = timezone ? BY_ZONE[country][timezone] : undefined;
  return byZone ? { code: byZone, basis: 'timezone' } : { code: COUNTRY_DEFAULT[country], basis: 'country' };
}
