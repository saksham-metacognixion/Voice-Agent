import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import { CLAIM_EMAIL, CLAIM_EMAIL_VERIFIED, CLAIM_MFA, CLAIM_MFA_AT, CLAIM_MFA_ENROLLED, CLAIM_NAME } from '@portal/schemas';

/*
 * §6.2 / ADR 0036 §1: the bearer check. The JWKS fetch is the only thing replaced — by a
 * local key set built from a key pair generated here — so signature, issuer, audience,
 * expiry and the 15-minute token age are verified by jose exactly as in production.
 */

const keys = vi.hoisted(() => ({ jwks: null as unknown }));
vi.mock('jose', async (importOriginal) => {
  const jose = await importOriginal<typeof import('jose')>();
  return { ...jose, createRemoteJWKSet: () => keys.jwks };
});

import { JwtVerifier } from './jwt-verifier.service';

const ISSUER = 'https://customer.example.test/';
const AUDIENCE = 'https://api.example.test';
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let privateKey: PrivateKey;
let otherKey: PrivateKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  keys.jwks = createLocalJWKSet({ keys: [jwk] });
});

function verifier(maxTokenAgeS: number | null = 900) {
  const config = { for: () => ({ issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://unused/jwks.json', maxTokenAgeS: maxTokenAgeS ?? undefined }) };
  return new JwtVerifier(config as never);
}

async function token(claims: JWTPayload = {}, opts: { iat?: number; exp?: string | number; iss?: string; aud?: string; sub?: string | null; key?: PrivateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 900);
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? 'auth0|user-1');
  return jwt.sign(opts.key ?? privateKey);
}

describe('JwtVerifier.verify', () => {
  it('maps our namespaced claims, lower-casing and trimming the email', async () => {
    const verified = await verifier().verify(
      await token({
        [CLAIM_EMAIL]: '  Owner@Example.COM ',
        [CLAIM_NAME]: ' Ada ',
        [CLAIM_EMAIL_VERIFIED]: true,
        [CLAIM_MFA]: true,
        [CLAIM_MFA_ENROLLED]: false,
        [CLAIM_MFA_AT]: 1_700_000_000,
      }),
      'customer',
    );
    expect(verified).toMatchObject({
      subject: 'auth0|user-1',
      email: 'owner@example.com',
      name: 'Ada',
      emailVerified: true,
      mfa: true,
      mfaEnrolled: false,
      mfaAt: 1_700_000_000,
    });
  });

  it('never trusts a bare `email` claim, and reads absent claims as false / null', async () => {
    const verified = await verifier().verify(await token({ email: 'bare@example.com', email_verified: true }), 'customer');
    expect(verified).toMatchObject({ email: '', name: null, emailVerified: false, mfa: false, mfaEnrolled: null, mfaAt: null });
  });

  it('only `true` counts for the boolean claims (a string "true" does not)', async () => {
    const verified = await verifier().verify(await token({ [CLAIM_MFA]: 'true', [CLAIM_EMAIL_VERIFIED]: 1, [CLAIM_NAME]: '   ' }), 'customer');
    expect(verified).toMatchObject({ mfa: false, emailVerified: false, name: null });
  });

  it.each([
    ['another issuer', { iss: 'https://staff.example.test/' }],
    ['another audience', { aud: 'https://elsewhere.test' }],
    ['an expired token', { iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 }],
    ['no subject', { sub: null }],
  ])('refuses %s with INVALID_TOKEN', async (_label, opts) => {
    await expect(verifier().verify(await token({}, opts), 'customer')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('refuses a token signed by a key outside the JWKS', async () => {
    await expect(verifier().verify(await token({}, { key: otherKey }), 'customer')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('refuses garbage and an unsigned token', async () => {
    await expect(verifier().verify('not-a-jwt', 'customer')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'x', iss: ISSUER, aud: AUDIENCE })).toString('base64url')}.`;
    await expect(verifier().verify(none, 'customer')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  describe('token age (ADR 0036 §1)', () => {
    const now = () => Math.floor(Date.now() / 1000);

    it('accepts a token up to the maximum age plus the 5 s skew', async () => {
      await expect(verifier(900).verify(await token({}, { iat: now() - 900, exp: now() + 600 }), 'customer')).resolves.toBeTruthy();
      await expect(verifier(900).verify(await token({}, { iat: now() - 904, exp: now() + 600 }), 'customer')).resolves.toBeTruthy();
    });

    it('refuses an older token with TOKEN_EXPIRED even though `exp` has not passed', async () => {
      await expect(verifier(900).verify(await token({}, { iat: now() - 910, exp: now() + 3_600 }), 'customer')).rejects.toMatchObject({
        code: 'TOKEN_EXPIRED',
      });
    });

    it('does not check age when no maximum is configured (staff, or AUTH_CUSTOMER_MAX_TOKEN_AGE_S=0)', async () => {
      await expect(verifier(null).verify(await token({}, { iat: now() - 86_400, exp: now() + 600 }), 'staff')).resolves.toBeTruthy();
    });
  });
});
