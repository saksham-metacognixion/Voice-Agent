import { Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { CLAIM_EMAIL_VERIFIED, CLAIM_MFA } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { AuthConfig } from './auth.config';
import type { AuthNamespace } from './auth.types';

export interface VerifiedToken {
  subject: string;
  email: string;
  emailVerified: boolean;
  mfa: boolean;
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

    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      emailVerified: payload[CLAIM_EMAIL_VERIFIED] === true,
      mfa: payload[CLAIM_MFA] === true,
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
