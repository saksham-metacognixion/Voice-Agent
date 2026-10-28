import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

/** How long a minted recording link plays (CLAUDE.md, "signed 1-hour URLs"). */
export const RECORDING_URL_TTL_S = 3_600;

export type TokenPurpose = 'recording' | 'live' | 'download';
const PURPOSE_TAG: Record<TokenPurpose, number | string> = { recording: 1, live: 'live', download: 'download' };

export interface RecordingClaims {
  callId: string;
  workspaceId: string;
  /** Unix seconds. */
  exp: number;
}

/**
 * Signed, expiring links for GET /calls/:id/recording/stream (§17). The browser plays a
 * recording through an `<audio src>` that cannot carry `Authorization`, so the link
 * itself is the credential: an HMAC over (workspace, call, expiry) that only the API can
 * mint, valid for an hour, tied to the call it was minted for. The Retell URL behind it
 * is never exposed.
 *
 * `RECORDING_SIGNING_SECRET` must be set wherever more than one API process runs; without
 * it a per-process secret is generated, which is fine for one dev box and nothing else.
 */
@Injectable()
export class RecordingSigner {
  private readonly log = new Logger(RecordingSigner.name);
  private readonly secret: Buffer;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const configured = env.RECORDING_SIGNING_SECRET?.trim();
    if (configured && configured.length >= 32) {
      this.secret = Buffer.from(configured, 'utf8');
    } else {
      this.secret = randomBytes(32);
      this.log.warn(
        configured
          ? 'RECORDING_SIGNING_SECRET is shorter than 32 characters; using a per-process secret instead'
          : 'RECORDING_SIGNING_SECRET is unset; recording links are signed with a per-process secret and die with this process',
      );
    }
  }

  /**
   * `purpose` keeps the two credentials this signer mints apart: a recording link (tag
   * `1`, the original format, unchanged) and a live-transcript token for W5's relay (tag
   * `live`). Each `verify` accepts only its own, so one can never stand in for the other.
   * A download link (tag `download`, QA-077) is the recording served as a file, minted
   * for owner/admin only: an editor's playback token cannot be turned into one.
   */
  sign(claims: Omit<RecordingClaims, 'exp'>, now = new Date(), ttlS = RECORDING_URL_TTL_S, purpose: TokenPurpose = 'recording'): { token: string; expiresAt: Date } {
    const exp = Math.floor(now.getTime() / 1000) + ttlS;
    const payload = base64url(JSON.stringify([PURPOSE_TAG[purpose], claims.workspaceId, claims.callId, exp]));
    return { token: `${payload}.${this.digest(payload)}`, expiresAt: new Date(exp * 1000) };
  }

  /** The claims when the token is intact and unexpired; null otherwise. Never throws. */
  verify(token: string | undefined, now = new Date(), purpose: TokenPurpose = 'recording'): RecordingClaims | null {
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    // Byte lengths, not string lengths: `timingSafeEqual` throws on a length mismatch, and
    // one multi-byte character in the token makes those two numbers disagree. This method
    // is called from a `@Public()` route, where a throw is a 500 instead of a 401.
    const given = Buffer.from(token.slice(dot + 1), 'utf8');
    const expected = Buffer.from(this.digest(payload), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== PURPOSE_TAG[purpose]) return null;
    const [, workspaceId, callId, exp] = parsed as [number, unknown, unknown, unknown];
    if (typeof workspaceId !== 'string' || typeof callId !== 'string' || typeof exp !== 'number') return null;
    if (exp * 1000 <= now.getTime()) return null;
    return { workspaceId, callId, exp };
  }

  private digest(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
