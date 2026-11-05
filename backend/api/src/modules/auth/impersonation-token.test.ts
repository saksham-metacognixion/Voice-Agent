import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IMPERSONATION_PREFIX, ImpersonationTokenService } from './impersonation-token';

/* Admin §7.4 view-as: the API-minted `imp_` credential (D12, ADR 0021). */

const SECRET = 'x'.repeat(32);
const NOW = new Date('2026-11-04T12:00:00Z');
const IN_AN_HOUR = new Date(NOW.getTime() + 3_600_000);
const claims = { sessionId: 'sess-1', tenantId: 'ws-1', staffId: 'staff-1' };

function service(secret: string | undefined = SECRET) {
  return new ImpersonationTokenService({ IMPERSONATION_SIGNING_SECRET: secret } as NodeJS.ProcessEnv);
}

describe('ImpersonationTokenService', () => {
  it('signs a token with the imp_ prefix that verifies back to the same claims', () => {
    const tokens = service();
    const token = tokens.sign(claims, IN_AN_HOUR);
    expect(token.startsWith(IMPERSONATION_PREFIX)).toBe(true);
    expect(tokens.verify(token, NOW)).toEqual({ ...claims, exp: Math.floor(IN_AN_HOUR.getTime() / 1000) });
  });

  it('refuses a token at or after its expiry', () => {
    const tokens = service();
    const token = tokens.sign(claims, IN_AN_HOUR);
    expect(tokens.verify(token, new Date(IN_AN_HOUR.getTime() - 1000))).not.toBeNull();
    expect(tokens.verify(token, IN_AN_HOUR)).toBeNull();
    expect(tokens.verify(token, new Date(IN_AN_HOUR.getTime() + 1000))).toBeNull();
  });

  it('refuses a token whose payload was edited to name another workspace', () => {
    const tokens = service();
    const token = tokens.sign(claims, IN_AN_HOUR);
    const [, signature] = token.slice(IMPERSONATION_PREFIX.length).split('.');
    const forged = Buffer.from(JSON.stringify(['sess-1', 'ws-OTHER', 'staff-1', Math.floor(IN_AN_HOUR.getTime() / 1000)])).toString('base64url');
    expect(tokens.verify(`${IMPERSONATION_PREFIX}${forged}.${signature}`, NOW)).toBeNull();
  });

  it('refuses a token signed with another secret (another environment)', () => {
    const token = service('y'.repeat(32)).sign(claims, IN_AN_HOUR);
    expect(service().verify(token, NOW)).toBeNull();
  });

  it('two processes with the same configured secret accept each other’s tokens', () => {
    expect(service().verify(service().sign(claims, IN_AN_HOUR), NOW)).not.toBeNull();
  });

  it('falls back to RECORDING_SIGNING_SECRET when its own secret is unset', () => {
    const env = { RECORDING_SIGNING_SECRET: SECRET } as NodeJS.ProcessEnv;
    const token = new ImpersonationTokenService(env).sign(claims, IN_AN_HOUR);
    expect(service().verify(token, NOW)).not.toBeNull();
  });

  it('a secret shorter than 32 characters is not used: each process gets its own', () => {
    const short = 'short-secret';
    const token = service(short).sign(claims, IN_AN_HOUR);
    expect(service(short).verify(token, NOW)).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['a JWT', 'eyJhbGciOiJSUzI1NiJ9.e30.sig'],
    ['the prefix only', 'imp_'],
    ['no signature', 'imp_abc'],
    ['a dot first', 'imp_.sig'],
    ['a wrong-length signature', 'imp_abc.short'],
  ])('returns null, never throws, for %s', (_label, token) => {
    expect(service().verify(token, NOW)).toBeNull();
  });

  // A signature that verifies is not enough: only the (string, string, string, number) tuple passes.
  it.each([
    ['not JSON', 'not json at all'],
    ['an object', JSON.stringify({ sessionId: 's', tenantId: 't', staffId: 'u', exp: 9e9 })],
    ['three items', JSON.stringify(['s', 't', 'u'])],
    ['a numeric session id', JSON.stringify([1, 't', 'u', 9e9])],
    ['a string expiry', JSON.stringify(['s', 't', 'u', '9999999999'])],
  ])('refuses a correctly signed payload that is %s', (_label, body) => {
    const payload = Buffer.from(body, 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(`impersonation:${payload}`).digest('base64url');
    expect(service().verify(`${IMPERSONATION_PREFIX}${payload}.${signature}`, NOW)).toBeNull();
  });
});
