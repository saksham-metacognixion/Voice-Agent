import { describe, expect, it } from 'vitest';
import { AuthConfig } from './auth.config';

const base = {
  AUTH0_CUSTOMER_AUDIENCE: 'https://api.example.com',
  AUTH0_STAFF_AUDIENCE: 'https://admin-api.example.com',
};

describe('plaintext issuers', () => {
  it('are accepted in dev, so the auth tests can run against a local tenant', () => {
    const config = new AuthConfig({
      ...base,
      NODE_ENV: 'test',
      AUTH0_CUSTOMER_DOMAIN: 'http://127.0.0.1:9001',
      AUTH0_STAFF_DOMAIN: 'http://127.0.0.1:9002',
    });
    expect(config.customer.issuer).toBe('http://127.0.0.1:9001/');
    expect(config.customer.jwksUri).toBe('http://127.0.0.1:9001/.well-known/jwks.json');
  });

  it.each([
    ['NODE_ENV=production', { NODE_ENV: 'production' }],
    ['APP_ENV=prod', { APP_ENV: 'prod' }],
  ])('are refused when %s', (_label, over) => {
    expect(
      () =>
        new AuthConfig({
          ...base,
          ...over,
          AUTH0_CUSTOMER_DOMAIN: 'http://127.0.0.1:9001',
          AUTH0_STAFF_DOMAIN: 'staff.us.auth0.com',
        }),
    ).toThrow(/plaintext issuer/i);
  });

  it('still defaults a bare domain to https in dev', () => {
    const config = new AuthConfig({
      ...base,
      NODE_ENV: 'test',
      AUTH0_CUSTOMER_DOMAIN: 'customers.us.auth0.com',
      AUTH0_STAFF_DOMAIN: 'staff.us.auth0.com',
    });
    expect(config.customer.issuer).toBe('https://customers.us.auth0.com/');
  });
});
