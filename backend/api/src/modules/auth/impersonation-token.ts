import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

/** How long a view-as session lasts (admin §7.4 gives act-as 30 min; view-as gets an hour). */
export const IMPERSONATION_TTL_S = 3_600;

/** Every impersonation bearer starts with this, which is how AuthGuard tells it from a JWT. */
export const IMPERSONATION_PREFIX = 'imp_';

export interface ImpersonationClaims {
  sessionId: string;
  tenantId: string;
  staffId: string;
  /** Unix seconds. */
  exp: number;
}

/**
 * The credential a staff member's browser presents to the *customer* API while viewing a
 * workspace read-only (admin §7.4, D12).
 *
 * It is not an Auth0 token: the staff tenant's JWT must never verify on a customer route
 * (that is the whole `namespaceForPath` rule), and the customer tenant has no user to mint
 * one for. So the API mints its own — an HMAC over (session, tenant, staff, expiry) that
 * only the API can produce, bound to one `impersonation_sessions` row. AuthGuard accepts
 * it on the customer namespace only, loads the row on every request (an ended session is
 * refused at once, not at expiry), and WorkspaceGuard refuses every non-GET under it.
 *
 * `IMPERSONATION_SIGNING_SECRET` (falling back to `RECORDING_SIGNING_SECRET`) must be
 * set wherever more than one API process runs, for the same reason as the recording
 * signer: a per-process secret dies with the process.
 */
@Injectable()
export class ImpersonationTokenService {
  private readonly log = new Logger(ImpersonationTokenService.name);
  private readonly secret: Buffer;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const configured = (env.IMPERSONATION_SIGNING_SECRET ?? env.RECORDING_SIGNING_SECRET)?.trim();
    if (configured && configured.length >= 32) {
      this.secret = Buffer.from(configured, 'utf8');
    } else {
      this.secret = randomBytes(32);
      this.log.warn(
        'IMPERSONATION_SIGNING_SECRET is unset; view-as links are signed with a per-process secret and die with this process',
      );
    }
  }

  sign(claims: Omit<ImpersonationClaims, 'exp'>, expiresAt: Date): string {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const payload = Buffer.from(
      JSON.stringify([claims.sessionId, claims.tenantId, claims.staffId, exp]),
      'utf8',
    ).toString('base64url');
    return `${IMPERSONATION_PREFIX}${payload}.${this.digest(payload)}`;
  }

  /** The claims when the token is intact and unexpired; null otherwise. Never throws. */
  verify(token: string | undefined, now = new Date()): ImpersonationClaims | null {
    if (!token?.startsWith(IMPERSONATION_PREFIX)) return null;
    const body = token.slice(IMPERSONATION_PREFIX.length);
    const dot = body.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = body.slice(0, dot);
    const given = Buffer.from(body.slice(dot + 1), 'utf8');
    const expected = Buffer.from(this.digest(payload), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [sessionId, tenantId, staffId, exp] = parsed as [unknown, unknown, unknown, unknown];
    if (
      typeof sessionId !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof staffId !== 'string' ||
      typeof exp !== 'number'
    )
      return null;
    if (exp * 1000 <= now.getTime()) return null;
    return { sessionId, tenantId, staffId, exp };
  }

  private digest(payload: string): string {
    return createHmac('sha256', this.secret).update(`impersonation:${payload}`).digest('base64url');
  }
}
