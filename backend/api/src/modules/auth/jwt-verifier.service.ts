import { Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { CLAIM_EMAIL, CLAIM_EMAIL_VERIFIED, CLAIM_MFA, CLAIM_MFA_AT, CLAIM_MFA_ENROLLED, CLAIM_NAME } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { AuthConfig } from './auth.config';
import type { AuthNamespace } from './auth.types';

export interface VerifiedToken {
  subject: string;
  /**
   * From `https://portal/email` — the claim *our* Post-Login Action stamps — or empty.
   * Never from a bare `email` claim: an access token does not carry one by default, and
   * only our own namespace is trusted enough to create a `users` row from (AuthGuard).
   */
  email: string;
  name: string | null;
  emailVerified: boolean;
  mfa: boolean;
  /**
   * `https://portal/mfa_enrolled`: a second factor is enrolled. Null when the token does
   * not say (an older Action build, a stand-in issuer) — never read as "not enrolled".
   */
  mfaEnrolled: boolean | null;
  /** `https://portal/mfa_at`: epoch seconds the session last passed a second factor, or null. */
  mfaAt: number | null;
  payload: JWTPayload;
}

/**
 * Verifies a bearer token against the JWKS of exactly one namespace.
 *
 * The namespace is chosen by the route (see AuthGuard), never read from the token.
 * That is the whole mechanism behind "customer JWTs are rejected on /admin/*": an
 * /admin route only ever asks the staff JWKS, and a customer token carries the
 * customer tenant's `iss`, so verification fails at the issuer check.
 */
/** The same clock skew `jwtVerify` is given for `exp` and `nbf`. */
const TOKEN_AGE_TOLERANCE_S = 5;

@Injectable()
export class JwtVerifier {
  private readonly logger = new Logger(JwtVerifier.name);
  private readonly keySets = new Map<AuthNamespace, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly config: AuthConfig) {}

  async verify(token: string, namespace: AuthNamespace): Promise<VerifiedToken> {
    const { issuer, audience } = this.config.for(namespace);

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keySet(namespace), {
        issuer,
        audience,
        algorithms: ['RS256'],
        clockTolerance: 5,
      }));
    } catch (error) {
      // Deliberately vague to the caller: which check failed is not the client's business.
      this.logger.debug(`${namespace} token rejected: ${(error as Error).message}`);
      throw new AppError('INVALID_TOKEN', 'Your session is not valid. Sign in again.');
    }

    if (!payload.sub) {
      throw new AppError('INVALID_TOKEN', 'Your session is not valid. Sign in again.');
    }

    // §6.2 "short-lived JWT (≤ 15 min)" (ADR 0036 §1). The tenant's API setting is what
    // makes Auth0 mint 15-minute tokens; this is what makes that true whatever the tenant
    // says. `TOKEN_EXPIRED` is a 401 the SPA answers by re-minting through its refresh
    // token and retrying once — never by signing the person out.
    const maxAge = this.config.for(namespace).maxTokenAgeS;
    if (maxAge !== undefined) {
      const age = typeof payload.iat === 'number' ? Math.floor(Date.now() / 1000) - payload.iat : Number.POSITIVE_INFINITY;
      if (age > maxAge + TOKEN_AGE_TOLERANCE_S) {
        throw new AppError('TOKEN_EXPIRED', 'Your session needs refreshing.');
      }
    }

    return {
      subject: payload.sub,
      email: typeof payload[CLAIM_EMAIL] === 'string' ? (payload[CLAIM_EMAIL] as string).trim().toLowerCase() : '',
      name: typeof payload[CLAIM_NAME] === 'string' && (payload[CLAIM_NAME] as string).trim() ? (payload[CLAIM_NAME] as string).trim() : null,
      emailVerified: payload[CLAIM_EMAIL_VERIFIED] === true,
      mfa: payload[CLAIM_MFA] === true,
      mfaEnrolled: typeof payload[CLAIM_MFA_ENROLLED] === 'boolean' ? (payload[CLAIM_MFA_ENROLLED] as boolean) : null,
      mfaAt: typeof payload[CLAIM_MFA_AT] === 'number' && Number.isFinite(payload[CLAIM_MFA_AT]) ? (payload[CLAIM_MFA_AT] as number) : null,
      payload,
    };
  }

  /**
   * jose caches the keys and refetches on an unknown `kid`, so this is one JWKS request
   * per key rotation rather than one per token.
   */
  private keySet(namespace: AuthNamespace) {
    let keySet = this.keySets.get(namespace);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL(this.config.for(namespace).jwksUri), {
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      });
      this.keySets.set(namespace, keySet);
    }
    return keySet;
  }
}
