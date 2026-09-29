import { timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { adminDb, isUniqueViolation } from '@portal/db';
import { type AuthWebhookEvent, authWebhookEvent } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { isDisposableEmail } from './disposable-email';

export type AuthUpsertOutcome =
  | { outcome: 'created'; userId: string }
  | { outcome: 'updated'; userId: string }
  | { outcome: 'unchanged'; userId: string };

/**
 * §13.2 step 1 — "Auth provider creates user → webhook `user.created` → `users` upsert".
 *
 * The identity lives in Auth0 (ADR 0002); this table holds the local mirror every
 * membership and audit row points at. `auth_provider_id` is the `sub` claim and is the
 * only key that matters: emails change, `sub` does not.
 *
 * Three callers, one upsert:
 *
 *   1. the Post-User-Registration Action → `POST /webhooks/auth` (`user.registered`),
 *      processed by the worker — the normal path;
 *   2. the Post-Login Action → the same route (`user.login`) — the documented safety net
 *      for a registration webhook that never arrived (the trigger is fire-and-forget on
 *      Auth0's side);
 *   3. `AuthGuard`, when a verified customer token arrives for a `sub` with no row and
 *      carries our namespaced email claim — provisioning on first request, so that a
 *      missed webhook *and* a missed login webhook still cannot lock a person out.
 *
 * Idempotency is therefore the whole job. Auth0 retries its Actions, the webhook is
 * stored in `webhook_events` and re-processed by the sweeper, several first requests can
 * race through the guard, and a user who signs up, is deleted and signs up again produces
 * the same event twice — so this is an upsert on `sub`, not a create, a concurrent create
 * of the same `sub` is folded into "unchanged", and a duplicate email is handled rather
 * than thrown. Nothing here creates a workspace: that is `POST /workspaces`, a separate
 * step the customer takes in A4.
 *
 * It lives in `auth` because the guard needs it and `auth` is the global module every
 * feature module already inherits; `workspaces` re-exports it for its older importers.
 */
@Injectable()
export class UsersService {
  private readonly log = new Logger(UsersService.name);

  /**
   * Validates the payload. A malformed body is a 400 the Action can see in its logs, and
   * nothing is stored — there is no user to mirror.
   */
  parse(body: unknown): AuthWebhookEvent {
    const parsed = authWebhookEvent.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        'BAD_REQUEST',
        'That is not a user event we recognise.',
        parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || '(body)', message: issue.message })),
      );
    }
    return parsed.data;
  }

  /**
   * Creates or refreshes the local user.
   *
   * `upsert` on `auth_provider_id` does the ordinary case in one statement. The case it
   * cannot do is a *different* `sub` arriving with an email that is already taken — two
   * Auth0 connections for one person (Google and password, say). That is not a duplicate
   * to merge blindly: it is two identities, and the one that already exists keeps the
   * email. The second is recorded and refused, loudly, rather than silently stealing it.
   */
  async upsert(event: AuthWebhookEvent): Promise<AuthUpsertOutcome> {
    const email = event.email.toLowerCase();

    try {
      const existing = await adminDb.user.findUnique({
        where: { authProviderId: event.external_id },
        select: { id: true, email: true, name: true, avatarUrl: true },
      });

      if (existing) {
        const next = { email, name: event.name ?? existing.name, avatarUrl: event.picture ?? existing.avatarUrl };
        const unchanged =
          existing.email === next.email && existing.name === next.name && existing.avatarUrl === next.avatarUrl;
        if (unchanged) return { outcome: 'unchanged', userId: existing.id };

        await adminDb.user.update({ where: { id: existing.id }, data: next });
        return { outcome: 'updated', userId: existing.id };
      }

      // Looked up first rather than left to the unique index: Prisma logs every query
      // error at `error` level before the exception reaches the catch below, so a refusal
      // that is routine (and settled) printed a red `Unique constraint failed` each time.
      // The catch still covers the race between this read and the insert.
      const byEmail = await adminDb.user.findUnique({ where: { email }, select: { authProviderId: true } });
      if (byEmail) this.refuseSecondIdentity(event, email, byEmail.authProviderId);

      // §6.2: no new account on a throwaway address. Only a *new* row is refused — an
      // account that already exists keeps working if its domain joins the list later.
      if (isDisposableEmail(email)) {
        this.log.warn(`${event.event_type} for ${event.external_id} refused: disposable email domain`);
        throw new DisposableEmailRefused(event.external_id);
      }

      const created = await adminDb.user.create({
        data: {
          authProviderId: event.external_id,
          email,
          name: event.name ?? null,
          avatarUrl: event.picture ?? null,
        },
        select: { id: true },
      });
      this.log.log(`user ${created.id} mirrored from ${event.external_id}`);
      return { outcome: 'created', userId: created.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Two possibilities, and they need different answers.
      const bySub = await adminDb.user.findUnique({ where: { authProviderId: event.external_id }, select: { id: true } });
      if (bySub) {
        // A concurrent delivery of the same event won the race. That is exactly once
        // working, not a failure.
        return { outcome: 'unchanged', userId: bySub.id };
      }

      const byEmail = await adminDb.user.findUnique({ where: { email }, select: { authProviderId: true } });
      if (byEmail) this.refuseSecondIdentity(event, email, byEmail.authProviderId);
      throw error;
    }
  }

  /**
   * Throws `CONFLICT` when `email` belongs to another `sub`. Permanent, not transient:
   * the guard answers it as a 409, and the webhook handler settles the event on it
   * rather than retrying (`SecondIdentityRefused`).
   */
  private refuseSecondIdentity(event: AuthWebhookEvent, email: string, owner: string): void {
    if (sameSubject(owner, event.external_id)) return;
    this.log.warn(
      `${event.event_type} for ${event.external_id} carries ${email}, which already belongs to ${owner}; refusing to reassign it`,
    );
    throw new SecondIdentityRefused(event.external_id);
  }
}

/**
 * The one `upsert` failure that retrying can never fix: the email already belongs to
 * another `sub`. A 409 on the guard's path; a settled refusal on the webhook's.
 */
export class SecondIdentityRefused extends AppError {
  constructor(readonly subject: string) {
    super('CONFLICT', 'That email address is already registered to a different sign-in method.');
  }
}

/**
 * §6.2: the address is on the disposable list. Settled on the webhook's path (retrying
 * cannot change a domain), a 403 `EMAIL_DISPOSABLE` on the guard's.
 */
export class DisposableEmailRefused extends AppError {
  constructor(readonly subject: string) {
    super('EMAIL_DISPOSABLE', 'Temporary email addresses cannot be used. Sign up with your work or personal email instead.');
  }
}

function sameSubject(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
