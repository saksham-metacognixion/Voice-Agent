import { describe, expect, it } from 'vitest';
import { RECORDING_URL_TTL_S, RecordingSigner } from './recording';

const SECRET = 'a-recording-secret-long-enough-to-be-used';

function signer(secret = SECRET) {
  return new RecordingSigner({ RECORDING_SIGNING_SECRET: secret } as NodeJS.ProcessEnv);
}

describe('RecordingSigner', () => {
  const claims = { callId: 'call_abc', workspaceId: '11111111-1111-4111-8111-111111111111' };

  it('round-trips the claims it signed', () => {
    const s = signer();
    const { token, expiresAt } = s.sign(claims);
    expect(s.verify(token)).toMatchObject(claims);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan((RECORDING_URL_TTL_S - 5) * 1000);
  });

  it('refuses a token past its expiry', () => {
    const s = signer();
    const { token } = s.sign(claims, new Date(Date.now() - 2 * RECORDING_URL_TTL_S * 1000));
    expect(s.verify(token)).toBeNull();
  });

  it('refuses a tampered payload, a tampered signature, and junk', () => {
    const s = signer();
    const { token } = s.sign(claims);
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify([1, claims.workspaceId, 'call_other', Math.floor(Date.now() / 1000) + 600]), 'utf8').toString('base64url');
    expect(s.verify(`${forged}.${signature}`)).toBeNull();
    expect(s.verify(`${payload}.${'A'.repeat(signature!.length)}`)).toBeNull();
    expect(s.verify('not-a-token')).toBeNull();
    expect(s.verify('')).toBeNull();
    expect(s.verify(undefined)).toBeNull();
  });

  it('refuses a token whose signature is multi-byte, rather than throwing at the comparison', () => {
    const s = signer();
    const { token } = s.sign(claims);
    const payload = token.slice(0, token.lastIndexOf('.'));
    // `verify` is reached from the @Public() stream route, where a throw is a 500 rather
    // than a 401 — and a string whose characters are not one byte each is what does it.
    expect(() => s.verify(`${payload}.café`)).not.toThrow();
    expect(s.verify(`${payload}.café`)).toBeNull();
    expect(s.verify(`${payload}.${'é'.repeat(43)}`)).toBeNull();
  });

  it('will not verify a token minted with another secret — one process cannot forge for another', () => {
    const { token } = signer().sign(claims);
    expect(signer('a-different-secret-also-long-enough-x').verify(token)).toBeNull();
  });

  it('falls back to a per-process secret when the configured one is missing or too short', () => {
    const weak = new RecordingSigner({ RECORDING_SIGNING_SECRET: 'short' } as NodeJS.ProcessEnv);
    const { token } = weak.sign(claims);
    expect(weak.verify(token)).toMatchObject(claims);
    // A second process would have a different random secret, so the token does not travel.
    expect(new RecordingSigner({} as NodeJS.ProcessEnv).verify(token)).toBeNull();
  });
});
