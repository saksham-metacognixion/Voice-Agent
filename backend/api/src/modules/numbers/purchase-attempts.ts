/**
 * The order a bought number is asked for in (§11 option A/B, W6 "we choose the closest
 * available number"). The area code on W6 is a preference, not a condition: the platform
 * answers `404 No phone numbers of this area code.` when its carrier has no stock there
 * (647 and 236 on staging, 30 Sep), and a go-live must not stop on that.
 *
 *   1. the requested area code, from each carrier — the platform buys from Twilio by
 *      default, and Telnyx holds a separate inventory
 *   2. the other codes of the same region (a Canadian overlay), from each carrier
 *   3. any local number in the country, from each carrier
 *
 * A toll-free request is never widened into a local number: carriers only. Pure and
 * exported for the unit test.
 */
export type NumberCarrier = 'twilio' | 'telnyx';

export interface PurchaseAttempt {
  provider: NumberCarrier;
  areaCode?: number;
}

const CARRIERS: readonly NumberCarrier[] = ['twilio', 'telnyx'];

/**
 * Canadian overlay groups: every code in a group rings the same region, so a caller in
 * Toronto reads a 437 exactly as a 647. The US is left to step 3 — its overlays are too
 * many to keep by hand, and any local number is still a working agent.
 */
const CA_OVERLAYS: readonly (readonly number[])[] = [
  [416, 647, 437, 942], // Toronto
  [905, 289, 365, 742], // Greater Toronto / Golden Horseshoe
  [519, 226, 548, 382], // Southwestern Ontario
  [613, 343, 753], // Ottawa / Eastern Ontario
  [705, 249, 683], // Central and Northern Ontario
  [604, 778, 236, 672], // British Columbia
  [403, 587, 825, 368], // Southern Alberta (Calgary)
  [780, 587, 825, 368], // Northern Alberta (Edmonton)
  [514, 438, 263], // Montréal
  [450, 579, 354], // Montréal suburbs
  [418, 581, 367], // Eastern Québec
  [819, 873, 468], // Western Québec
  [204, 431, 584], // Manitoba
  [306, 639, 474], // Saskatchewan
  [902, 782], // Nova Scotia / PEI
  [506, 428], // New Brunswick
  [709, 879], // Newfoundland and Labrador
];

/** The other codes of the requested code's region, in the table's order, without duplicates. */
export function overlayCodes(country: 'US' | 'CA', areaCode: number): number[] {
  if (country !== 'CA') return [];
  const out: number[] = [];
  for (const group of CA_OVERLAYS) {
    if (!group.includes(areaCode)) continue;
    for (const code of group) if (code !== areaCode && !out.includes(code)) out.push(code);
  }
  return out;
}

export function purchaseAttempts(input: {
  country: 'US' | 'CA';
  areaCode: number | null;
  tollFree: boolean;
}): PurchaseAttempt[] {
  const any = CARRIERS.map((provider) => ({ provider }));
  if (input.tollFree || input.areaCode === null) return any;
  const codes = [input.areaCode, ...overlayCodes(input.country, input.areaCode)];
  return [
    ...codes.flatMap((areaCode) => CARRIERS.map((provider) => ({ provider, areaCode }))),
    ...any,
  ];
}
