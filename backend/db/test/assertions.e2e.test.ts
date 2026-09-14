import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { assertIssuersDiffer, assertRlsEnforced, disconnect } from '../src/index.js';

/**
 * The boot guards. RLS only guards if the runtime actually connects as something RLS
 * applies to, and the failure mode of getting that wrong is silent cross-tenant reads —
 * so the check runs on every boot and is tested against a connection that really does
 * bypass RLS.
 */

const realDatabaseUrl = process.env.DATABASE_URL;

/** appDb memoises on globalThis, so a URL swap needs the cache cleared. */
function repointAppDb(url: string | undefined) {
  globalThis.__portalAppDb = undefined;
  if (url) process.env.DATABASE_URL = url;
  else delete process.env.DATABASE_URL;
}

afterEach(() => repointAppDb(realDatabaseUrl));
afterAll(async () => {
  repointAppDb(realDatabaseUrl);
  await disconnect();
});

describe('assertRlsEnforced', () => {
  it('passes for the configured runtime connection', async () => {
    await expect(assertRlsEnforced()).resolves.toBeUndefined();
  });

  it('refuses to boot when DATABASE_URL points at the schema owner', async () => {
    repointAppDb(process.env.DIRECT_DATABASE_URL);
    await expect(assertRlsEnforced()).rejects.toThrow(
      /owns the tables|not a member of portal_app/i,
    );
  });

  it('names the offending role so the fix is obvious', async () => {
    repointAppDb(process.env.DIRECT_DATABASE_URL);
    await expect(assertRlsEnforced()).rejects.toThrow(/pnpm db:roles/);
  });
});

describe('assertIssuersDiffer', () => {
  it('accepts two genuinely separate tenants', () => {
    expect(() =>
      assertIssuersDiffer('https://customers.us.auth0.com/', 'https://staff.us.auth0.com/'),
    ).not.toThrow();
  });

  it.each([
    ['identical', 'https://one.us.auth0.com/', 'https://one.us.auth0.com/'],
    ['differing by a trailing slash', 'https://one.us.auth0.com', 'https://one.us.auth0.com/'],
    ['differing by case', 'https://One.us.auth0.com/', 'https://one.us.auth0.com/'],
    ['differing by scheme', 'http://one.us.auth0.com/', 'https://one.us.auth0.com/'],
  ])('rejects issuers %s', (_label, a, b) => {
    expect(() => assertIssuersDiffer(a, b)).toThrow(/two separate tenants/i);
  });

  it('rejects a missing issuer rather than treating it as different', () => {
    expect(() => assertIssuersDiffer('', 'https://staff.us.auth0.com/')).toThrow(/must be set/i);
  });
});
