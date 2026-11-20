import { Injectable, Logger } from '@nestjs/common';
import { adminDb, isUniqueViolation } from '@portal/db';
import {
  type AccountResponse,
  type ForgetDevicesResponse,
  MFA_REAUTH_WINDOW_S,
  type MfaDisableResponse,
  type SignInMethodsResponse,
  TERMS_VERSION,
  type TermsStatus,
  VERIFICATION_RESEND_COOLDOWN_S,
  VERIFICATION_RESEND_MAX_PER_HOUR,
  type VerificationEmailResponse,
  mfaRequiredFor,
  signInMethodOf,
  termsAcceptanceRequired,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Auth0ManagementService, WorkspaceMfaService, recordAccountEvent } from '../auth';
import type { AuthenticatedUser } from '../auth';
import { RedisCache, redisKeys } from '../redis';

const HOUR_MS = 3_600_000;

/** The outcome of A2's two limits, decided from what Redis holds. Pure, so the edges are tested without a clock. */
export function resendDecision(input: { now: number; cooldownStartedAt: number | null; sentThisHour: number }):
  | { allow: true }
  | { allow: false; retryAfterS: number } {
  if (input.cooldownStartedAt !== null) {
    const left = Math.ceil((input.cooldownStartedAt + VERIFICATION_RESEND_COOLDOWN_S * 1000 - input.now) / 1000);
    if (left > 0) return { allow: false, retryAfterS: left };
  }
  if (input.sentThisHour > VERIFICATION_RESEND_MAX_PER_HOUR) {
    return { allow: false, retryAfterS: Math.max(1, Math.ceil((HOUR_MS - (input.now % HOUR_MS)) / 1000)) };
  }
  return { allow: true };
}

/**
 * `GET /me`, `POST /me/terms`, `POST /me/verification-email` (ADR 0036 §6, §8), and D6
 * Security's `POST /me/mfa/disable` and `GET /me/sign-in-methods`.
 *
 * Terms: `users.tos_accepted_at` + `tos_version` are the latest acceptance and every
 * acceptance is also its own `terms_acceptances` row (who, which version, when, from
 * where). A new `TERMS_VERSION` asks again and never rewrites the record of the older one.
 *
 * Resend: the cooldown is one `SET NX EX 60` whose value is when it started (so the
 * refusal can say how long is left); the hourly cap is a fixed-window counter on the clock
 * hour. Both are atomic in Redis, so two tabs pressing at once send one email. Redis
 * silent refuses — an email that might be the sixth this hour is not worth guessing.
 */
@Injectable()
export class AccountService {
  private readonly log = new Logger(AccountService.name);

  constructor(
    private readonly cache: RedisCache,
    private readonly auth0: Auth0ManagementService,
    private readonly mfa: WorkspaceMfaService,
  ) {}

  async me(person: AuthenticatedUser): Promise<AccountResponse> {
    const user = await adminDb.user.findUniqueOrThrow({
      where: { id: person.userId },
      select: { id: true, email: true, name: true, tosVersion: true, tosAcceptedAt: true },
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      email_verified: person.emailVerified,
      mfa: person.mfa,
      terms: termsOf(user),
    };
  }

  async acceptTerms(person: AuthenticatedUser, version: string, from: { ip: string | null; userAgent: string | null }): Promise<TermsStatus> {
    if (version !== TERMS_VERSION) {
      throw new AppError('CONFLICT', 'These terms have been updated. Reload the page to read the current version.');
    }
    const acceptedAt = new Date();
    try {
      await adminDb.$transaction([
        adminDb.termsAcceptance.create({ data: { userId: person.userId, version, acceptedAt, ip: from.ip, userAgent: from.userAgent } }),
        adminDb.user.update({ where: { id: person.userId }, data: { tosVersion: version, tosAcceptedAt: acceptedAt } }),
      ]);
      this.log.log(`user ${person.userId} accepted terms ${version}`);
    } catch (error) {
      // Accepted this version already (a double click, a second tab): the first record stands.
      if (!isUniqueViolation(error)) throw error;
    }
    const user = await adminDb.user.findUniqueOrThrow({ where: { id: person.userId }, select: { tosVersion: true, tosAcceptedAt: true } });
    return termsOf(user);
  }

  async forgetDevices(person: AuthenticatedUser, ip: string | null): Promise<ForgetDevicesResponse> {
    let outcome: 'applied' | 'skipped';
    try {
      outcome = await this.auth0.forgetRememberedDevices(person.subject);
    } catch (error) {
      this.log.warn(`forget devices for ${person.userId}: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not reach the sign-in service just now. Try again in a moment.');
    }
    if (outcome === 'skipped') throw new AppError('NOT_CONFIGURED', 'Remembered devices cannot be managed in this environment.');
    await recordAccountEvent({ userId: person.userId, action: 'auth.devices_forgotten', ip });
    return { forgotten: true };
  }

  async resendVerification(person: AuthenticatedUser): Promise<VerificationEmailResponse> {
    if (person.emailVerified) return { status: 'already_verified', retry_after_s: 0 };
    if (!this.auth0.configured) {
      throw new AppError('NOT_CONFIGURED', 'Verification emails cannot be resent in this environment.');
    }
    // The token may predate the click on the link: ask the provider before mailing again.
    const facts = await this.auth0.getUser(person.subject).catch(() => null);
    if (facts?.email_verified) return { status: 'already_verified', retry_after_s: 0 };

    const now = Date.now();
    const cooldownKey = redisKeys.verifyEmailCooldown(person.userId);
    const took = await this.cache.setIfAbsent(cooldownKey, String(now), VERIFICATION_RESEND_COOLDOWN_S);
    if (!took) {
      const started = await this.cache.get(cooldownKey);
      if (started === null) throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not send the email just now. Try again in a moment.');
      const refusal = resendDecision({ now, cooldownStartedAt: Number(started), sentThisHour: 0 });
      throw rateLimited(refusal.allow ? 1 : refusal.retryAfterS);
    }
    const sent = await this.cache.increment(redisKeys.verifyEmailHour(person.userId, Math.floor(now / HOUR_MS)), 2 * 3600);
    if (sent === null) throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not send the email just now. Try again in a moment.');
    const decision = resendDecision({ now, cooldownStartedAt: null, sentThisHour: sent });
    if (!decision.allow) throw rateLimited(decision.retryAfterS);

    try {
      await this.auth0.sendVerificationEmail(person.subject);
    } catch (error) {
      // The provider refused: give the slot back so "Resend" works again at once.
      await this.cache.del(cooldownKey);
      this.log.warn(`verification email for ${person.userId}: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not send the email just now. Try again in a moment.');
    }
    return { status: 'sent', retry_after_s: VERIFICATION_RESEND_COOLDOWN_S };
  }

  /**
   * D6 Security "MFA … disable (with re-auth)". Three refusals before anything changes:
   * the session did not pass a second factor in the last `MFA_REAUTH_WINDOW_S` (the
   * portal answers `MFA_REQUIRED` with a fresh challenge); the person is an owner or admin
   * of a workspace where §6.2 requires the factor (`MFA_STILL_REQUIRED`, naming it); the
   * identity provider cannot be asked. Then every authenticator and remembered device is
   * removed, the row says so and each workspace's audit log records it.
   *
   * The access token in hand keeps its `mfa` claim until it expires (15 minutes); that is
   * harmless here, because no workspace of theirs needs it.
   */
  async disableMfa(person: AuthenticatedUser, ip: string | null): Promise<MfaDisableResponse> {
    const now = Math.floor(Date.now() / 1000);
    if (!person.mfa || !person.mfaAt || now - person.mfaAt > MFA_REAUTH_WINDOW_S) {
      throw new AppError('MFA_REQUIRED', 'Confirm with your authenticator app first, then turn it off.');
    }
    const memberships = await adminDb.membership.findMany({
      where: { userId: person.userId, role: { in: ['owner', 'admin'] } },
      select: { role: true, tenant: { select: { id: true, name: true } } },
    });
    for (const membership of memberships) {
      const state = await this.mfa.state(membership.tenant.id);
      if (mfaRequiredFor(membership.role, state)) {
        throw new AppError(
          'MFA_STILL_REQUIRED',
          `Two-factor stays on while you are ${membership.role === 'owner' ? 'the owner' : 'an admin'} of ${membership.tenant.name}: auto top-up is on or its balance is high.`,
        );
      }
    }
    let removed: 'applied' | 'skipped';
    try {
      removed = await this.auth0.resetMfa(person.subject);
      if (removed === 'applied') await this.auth0.forgetRememberedDevices(person.subject);
    } catch (error) {
      this.log.warn(`disable MFA for ${person.userId}: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not reach the sign-in service just now. Try again in a moment.');
    }
    if (removed === 'skipped') throw new AppError('NOT_CONFIGURED', 'Two-factor cannot be managed in this environment.');
    await adminDb.user.update({ where: { id: person.userId }, data: { mfaEnabled: false } });
    await recordAccountEvent({ userId: person.userId, action: 'auth.mfa_disabled', ip });
    this.log.log(`user ${person.userId} turned two-factor off`);
    return { disabled: true };
  }

  /** D6 Security "connected SSO accounts": how this person can sign in. */
  async signInMethods(person: AuthenticatedUser): Promise<SignInMethodsResponse> {
    let identities: Array<{ provider: string; connection: string }> | null;
    try {
      identities = await this.auth0.identities(person.subject);
    } catch (error) {
      this.log.warn(`sign-in methods for ${person.userId}: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not reach the sign-in service just now. Try again in a moment.');
    }
    if (identities === null) return { available: false, methods: [] };
    return { available: true, methods: identities.map((i) => ({ method: signInMethodOf(i.provider), connection: i.connection })) };
  }
}

function termsOf(user: { tosVersion: string | null; tosAcceptedAt: Date | null }): TermsStatus {
  return {
    current_version: TERMS_VERSION,
    accepted_version: user.tosVersion,
    accepted_at: user.tosAcceptedAt?.toISOString() ?? null,
    required: termsAcceptanceRequired(user.tosVersion),
  };
}

/** The wait rides in `fields` as `retry_after_s`, so A2's countdown reads a number, never the sentence. */
function rateLimited(retryAfterS: number): AppError {
  return new AppError('RATE_LIMITED', `You can ask for another email in ${retryAfterS} seconds.`, [{ field: 'retry_after_s', message: String(retryAfterS) }]);
}
