import { describe, expect, it } from 'vitest';
import { AuthConfig } from './auth.config';
import { namespaceForPath } from './auth.guard';

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  AUTH0_CUSTOMER_DOMAIN: 'portal-customers.us.auth0.com',
  AUTH0_CUSTOMER_AUDIENCE: 'https://api.example.com',
  AUTH0_STAFF_DOMAIN: 'portal-staff.us.auth0.com',
  AUTH0_STAFF_AUDIENCE: 'https://admin-api.example.com',
  ...over,
});

describe('AuthConfig', () => {
  it('builds an issuer and a JWKS url per tenant', () => {
    const config = new AuthConfig(env());
    expect(config.customer.issuer).toBe('https://portal-customers.us.auth0.com/');
    expect(config.customer.jwksUri).toBe(
      'https://portal-customers.us.auth0.com/.well-known/jwks.json',
    );
    expect(config.staff.issuer).toBe('https://portal-staff.us.auth0.com/');
  });

  it('keeps the trailing slash Auth0 puts in `iss`', () => {
    expect(new AuthConfig(env()).customer.issuer.endsWith('/')).toBe(true);
  });

  it('tolerates a domain written as a full URL', () => {
    const config = new AuthConfig(
      env({ AUTH0_CUSTOMER_DOMAIN: 'https://portal-customers.us.auth0.com/' }),
    );
    expect(config.customer.issuer).toBe('https://portal-customers.us.auth0.com/');
  });

  it('refuses to boot when both tenants are the same — ADR 0002', () => {
    expect(
      () => new AuthConfig(env({ AUTH0_STAFF_DOMAIN: 'portal-customers.us.auth0.com' })),
    ).toThrow(/two separate tenants/i);
  });

  it('catches the same collapse when the domains differ only by formatting', () => {
    expect(
      () => new AuthConfig(env({ AUTH0_STAFF_DOMAIN: 'https://Portal-Customers.us.auth0.com/' })),
    ).toThrow(/two separate tenants/i);
  });

  it('refuses to boot with a missing audience', () => {
    expect(() => new AuthConfig(env({ AUTH0_STAFF_AUDIENCE: '' }))).toThrow(/AUTH0_STAFF_AUDIENCE/);
  });

  it('hands back the config for the namespace asked for', () => {
    const config = new AuthConfig(env());
    expect(config.for('staff')).toBe(config.staff);
    expect(config.for('customer')).toBe(config.customer);
  });
});

describe('namespaceForPath', () => {
  it.each(['/admin', '/admin/', '/admin/customers', '/admin/pricing?draft=1'])(
    'routes %s to the staff tenant',
    (path) => {
      expect(namespaceForPath(path)).toBe('staff');
    },
  );

  it.each(['/agents', '/wallet', '/health', '/webhooks/retell'])(
    'routes %s to the customer tenant',
    (path) => {
      expect(namespaceForPath(path)).toBe('customer');
    },
  );

  it('is not fooled by a path that merely starts with the letters', () => {
    expect(namespaceForPath('/administrators')).toBe('customer');
    expect(namespaceForPath('/admin-tools')).toBe('customer');
  });
});
