import { describe, expect, it } from 'vitest';
import { INDUSTRIES, INDUSTRY_GROUPS, industryGroupOf, isIndustryId } from './industries';

/*
 * §8 W1 "Industry … searchable select (≈ 40 options)". The spec gives the count and the
 * businesses (§3), not the list (ADR 0039 §3). The slugs are what templates are tagged
 * with, so a template tag must stay in the catalogue.
 */

describe('INDUSTRY_GROUPS', () => {
  it('offers about forty industries', () => {
    expect(INDUSTRIES.length).toBeGreaterThanOrEqual(40);
    expect(INDUSTRIES.length).toBeLessThanOrEqual(60);
  });

  it('lists every slug once, in snake_case', () => {
    expect(new Set(INDUSTRIES).size).toBe(INDUSTRIES.length);
    for (const slug of INDUSTRIES) expect(slug).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('keeps every industry the shipped templates are tagged with', () => {
    for (const tag of ['dental', 'plumbing', 'auto', 'legal', 'salon', 'real_estate', 'restaurant']) expect(INDUSTRIES).toContain(tag);
  });

  it('covers the businesses §3 names', () => {
    for (const slug of ['dental', 'medical', 'salon', 'legal', 'real_estate', 'auto', 'restaurant', 'plumbing', 'electrical', 'hvac']) expect(INDUSTRIES).toContain(slug);
  });

  it('has no empty group and unique group keys', () => {
    expect(new Set(INDUSTRY_GROUPS.map((g) => g.key)).size).toBe(INDUSTRY_GROUPS.length);
    for (const group of INDUSTRY_GROUPS) expect(group.industries.length).toBeGreaterThan(0);
  });
});

describe('isIndustryId / industryGroupOf', () => {
  it('knows a catalogue slug and its group', () => {
    expect(isIndustryId('dental')).toBe(true);
    expect(industryGroupOf('dental')).toBe('health');
    expect(industryGroupOf('restaurant')).toBe('hospitality');
  });

  it('refuses free text, an empty value and the template-only "generic"', () => {
    expect(isIndustryId('Dental')).toBe(false);
    expect(isIndustryId('generic')).toBe(false);
    expect(isIndustryId('')).toBe(false);
    expect(isIndustryId(null)).toBe(false);
    expect(industryGroupOf('bakery')).toBeNull();
  });
});
