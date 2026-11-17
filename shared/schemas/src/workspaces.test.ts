import { describe, expect, it } from 'vitest';
import { LAUNCH_COUNTRIES, createWorkspaceRequest, isLaunchCountry } from './workspaces.js';

/* QA bug list, 17 Nov: "Workspace can be created with any country through the API" (§6.3 A3). */
describe('createWorkspaceRequest.country', () => {
  const body = (country: unknown) => ({ name: 'Maple Dental', country, timezone: 'America/Toronto' });

  it('launch countries are the United States and Canada', () => {
    expect([...LAUNCH_COUNTRIES].sort()).toEqual(['CA', 'US']);
  });

  it('accepts a launch country in either case and stores it upper case', () => {
    for (const country of ['US', 'CA', 'us', 'ca', 'Ca']) {
      const parsed = createWorkspaceRequest.safeParse(body(country));
      expect(parsed.success && parsed.data.country, country).toBe(country.toUpperCase());
    }
  });

  it('refuses every other country, a made-up code and a malformed one, on the country field', () => {
    for (const country of ['DE', 'XX', 'GB', 'IN', 'SA', 'AE', 'CAN', 'C', '', 12, null, undefined]) {
      const parsed = createWorkspaceRequest.safeParse(body(country));
      expect(parsed.success, String(country)).toBe(false);
      if (!parsed.success) expect(new Set(parsed.error.issues.map((i) => i.path.join('.')))).toEqual(new Set(['country']));
    }
  });

  it('isLaunchCountry reads any case and nothing as no', () => {
    expect(isLaunchCountry('ca')).toBe(true);
    expect(isLaunchCountry('US')).toBe(true);
    expect(isLaunchCountry('DE')).toBe(false);
    expect(isLaunchCountry(null)).toBe(false);
    expect(isLaunchCountry(undefined)).toBe(false);
  });
});
