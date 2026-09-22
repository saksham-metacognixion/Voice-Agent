import { describe, expect, it } from 'vitest';
import { assertPortalUrl, portalUrl } from './portal-url';

describe('portalUrl', () => {
  it('normalises the configured origin', () => {
    expect(portalUrl({ PORTAL_URL: 'https://app.example.com/' })).toBe('https://app.example.com');
  });

  it('falls back to localhost only outside staging and prod', () => {
    expect(portalUrl({ APP_ENV: 'dev' })).toBe('http://localhost:3000');
    expect(portalUrl({ APP_ENV: 'prod' })).toBe('http://localhost:3000'); // logged, never thrown mid-email
  });

  it('refuses to boot staging or prod without a public origin', () => {
    expect(() => assertPortalUrl({ APP_ENV: 'prod' })).toThrow(/PORTAL_URL/);
    expect(() => assertPortalUrl({ APP_ENV: 'staging', PORTAL_URL: 'http://localhost:3000' })).toThrow(/PORTAL_URL/);
    expect(() => assertPortalUrl({ APP_ENV: 'prod', PORTAL_URL: 'https://app.example.com' })).not.toThrow();
    expect(() => assertPortalUrl({ APP_ENV: 'dev' })).not.toThrow();
  });
});
