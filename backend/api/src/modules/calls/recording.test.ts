import { describe, expect, it } from 'vitest';
import { recordingDisposition } from './calls.controller';
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

  it('keeps a playback link and a download link apart (QA-077)', () => {
    const s = signer();
    const play = s.sign(claims).token;
    const download = s.sign(claims, new Date(), undefined, 'download').token;
    expect(s.verify(download, new Date(), 'download')).toMatchObject(claims);
    // An editor's playback token cannot be served as a download, and a download token
    // is not a playback (or live-transcript) credential either.
    expect(s.verify(play, new Date(), 'download')).toBeNull();
    expect(s.verify(download)).toBeNull();
    expect(s.verify(download, new Date(), 'live')).toBeNull();
  });
});

describe('recordingDisposition', () => {
  it('is inline for the player and an attachment for the D2 download (QA-077)', () => {
    expect(recordingDisposition('call_abc123', 'mp3', false)).toBe('inline; filename="call-call_abc123.mp3"');
    expect(recordingDisposition('call_abc123', 'wav', true)).toBe('attachment; filename="call-call_abc123.wav"');
  });

  it('cannot be broken out of by the id', () => {
    expect(recordingDisposition('call_"; x=1\r\n', 'mp3', true)).toBe('attachment; filename="call-call_x1.mp3"');
  });
});
