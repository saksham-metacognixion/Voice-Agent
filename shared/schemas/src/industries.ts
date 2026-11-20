/**
 * W1 "Industry (optional, improves defaults) — searchable select (≈ 40 options)" (§8).
 *
 * The spec names the count and the businesses it was written for (§3: clinics, dental,
 * home services, salons, legal intake, real estate, auto shops, restaurants) but not the
 * list, so the list is a decision (ADR 0039). The slugs are the keys everything else is
 * filed under — `agents.industry`, a template's `industry_tags` and its `example_texts` —
 * so a template written for `dental` matches a workspace that picked `dental`. The
 * portal shows each in the reader's language (`wizard.w1.catalog.industries.<slug>`).
 *
 * Groups are for the picker's headings only; nothing is gated on them.
 */
export const INDUSTRY_GROUPS = [
  { key: 'health', industries: ['dental', 'medical', 'physio', 'chiropractic', 'optometry', 'veterinary', 'pharmacy', 'mental_health'] },
  { key: 'home', industries: ['plumbing', 'electrical', 'hvac', 'roofing', 'landscaping', 'cleaning', 'pest_control', 'moving', 'locksmith', 'renovation', 'appliance_repair'] },
  { key: 'personal', industries: ['salon', 'barber', 'spa', 'fitness', 'tattoo', 'pet_grooming', 'photography'] },
  { key: 'professional', industries: ['legal', 'accounting', 'insurance', 'financial_advice', 'marketing_agency', 'it_services', 'consulting', 'recruiting'] },
  { key: 'property', industries: ['real_estate', 'property_management', 'home_inspection'] },
  { key: 'automotive', industries: ['auto', 'auto_detailing', 'towing', 'car_dealership'] },
  { key: 'hospitality', industries: ['restaurant', 'catering', 'hotel', 'event_venue'] },
  { key: 'education', industries: ['tutoring', 'childcare', 'driving_school'] },
] as const;

export type IndustryGroupKey = (typeof INDUSTRY_GROUPS)[number]['key'];
export type IndustryId = (typeof INDUSTRY_GROUPS)[number]['industries'][number];

/** Every industry, in the picker's order. */
export const INDUSTRIES: readonly IndustryId[] = INDUSTRY_GROUPS.flatMap((group) => group.industries);

export function isIndustryId(value: string | null | undefined): value is IndustryId {
  return Boolean(value) && (INDUSTRIES as readonly string[]).includes(value!);
}

export function industryGroupOf(industry: string): IndustryGroupKey | null {
  return INDUSTRY_GROUPS.find((group) => (group.industries as readonly string[]).includes(industry))?.key ?? null;
}
