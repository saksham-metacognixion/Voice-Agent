import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { adminDb } from '@portal/db';
import type { StaffRole } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { IS_PUBLIC, REQUIRED_STAFF_ROLES, REQUIRE_EMAIL_VERIFIED } from './auth.decorators';
import { IMPERSONATION_PREFIX, ImpersonationTokenService } from './impersonation-token';

/**
 * The placeholder prefix `AdminStaffService` writes into `staff_users.auth_provider_id`
 * for an invite (D13). Spelt here as well because `auth` is global and imports nothing
 * from `admin`; `admin-staff.test.ts` pins the two spellings together.
 */
export const STAFF_INVITE_PREFIX = 'invite|';
import { JwtVerifier, type VerifiedToken } from './jwt-verifier.service';
import { UsersService } from './users.service';
import type { AuthNamespace } from './auth.types';

/** Admin §2.1 — /admin/* is the staff namespace. Everything else is the customer one. */
export const STAFF_PATH_PREFIX = '/admin';

export function namespaceForPath(path: string): AuthNamespace {
  const clean = path.split('?')[0] ?? '';
  return clean === STAFF_PATH_PREFIX || clean.startsWith(`${STAFF_PATH_PREFIX}/`)
    ? 'staff'
    : 'customer';
}

/**
 * Authentication, first of the two global guards.
 *
 * Verifies the bearer token against the JWKS for the route's namespace, then loads the
 * matching row. It does not look at workspaces at all — WorkspaceGuard does that next.
 *
 * The namespace comes from the URL, not the token. A customer token presented to
 * /admin/* is checked against the staff tenant's JWKS, fails on `iss`, and comes back
 * 401 — there is no code path where a customer token authenticates a staff route.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifier,
    private readonly users: UsersService,
    private readonly impersonation: ImpersonationTokenService,
  ) {}

  async canActivate(host: ExecutionContext): Promise<boolean> {
    if (host.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      host.getHandler(),
      host.getClass(),
    ]);
    if (isPublic) return true;

    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const namespace = namespaceForPath(request.url);
    const token = bearerToken(request);

    // Admin §7.4 (D12): a staff member's read-only view of a workspace presents the
    // API-minted impersonation credential, never an Auth0 token. Customer namespace only:
    // on /admin/* the prefix is simply not a JWT and fails like any other garbage.
    if (namespace === 'customer' && token.startsWith(IMPERSONATION_PREFIX)) {
      return this.authenticateImpersonation(request, token);
    }

    const verified = await this.verifier.verify(token, namespace);

    return namespace === 'staff'
      ? this.authenticateStaff(request, verified)
      : this.authenticateCustomer(request, host, verified);
  }

  private async authenticateStaff(
    request: FastifyRequest,
    verified: Awaited<ReturnType<JwtVerifier['verify']>>,
  ): Promise<boolean> {
    // Admin §2.1: MFA is mandatory. The Post-Login Action stamps the claim; a token
    // without it never came through that flow and is refused outright.
    if (!verified.mfa) {
      throw new AppError('MFA_REQUIRED', 'Staff sign-in requires multi-factor authentication.');
    }

    // `mfa_enforced` on the row is informational for now: the claim is required of
    // everyone, and a per-person exemption would need a second sign-in flow at the
    // tenant. Until then a false there changes nothing here (SA13, D13).

    // Read on every request, never cached: SA13's deactivate takes effect on the
    // person's very next call, with no token to revoke.
    const select = { id: true, email: true, role: true, active: true } as const;
    let staff = await adminDb.staffUser.findUnique({ where: { authProviderId: verified.subject }, select });

    // SA13 invite (D13): an invited colleague's row carries a placeholder
    // `auth_provider_id` until they first sign in. The token's `sub` is unknown, but the
    // email our staff Post-Login Action stamps (`https://portal/email`, the only claim
    // trusted for this, as on the customer side) names the invite. `updateMany` with the
    // placeholder in its `where` binds it atomically: the first request wins, a racing
    // second one finds the row already bound and reads it by `sub`, and a *different*
    // identity for the same email later matches nothing and is refused below.
    if (!staff && verified.email) {
      const bound = await adminDb.staffUser.updateMany({
        where: { email: verified.email, authProviderId: `${STAFF_INVITE_PREFIX}${verified.email}`, active: true },
        data: { authProviderId: verified.subject },
      });
      if (bound.count === 1) {
        this.logger.log(`staff invite for ${verified.email} bound to ${verified.subject}`);
        // An invite sent without a name takes the identity provider's (QA-065); a name
        // the inviter typed is kept, and SA13 can correct either.
        if (verified.name) {
          await adminDb.staffUser.updateMany({ where: { authProviderId: verified.subject, name: null }, data: { name: verified.name } });
        }
      }
      staff = await adminDb.staffUser.findUnique({ where: { authProviderId: verified.subject }, select });
    }

    if (!staff) {
      this.logger.warn(`staff token for unknown subject ${verified.subject}`);
      throw new AppError('STAFF_ONLY', 'This account has no staff access.');
    }
    if (!staff.active) {
      throw new AppError('STAFF_ONLY', 'This staff account is disabled.');
    }

    request.staff = {
      staffId: staff.id,
      subject: verified.subject,
      email: staff.email,
      role: staff.role,
    };
    return true;
  }

  private async authenticateCustomer(
    request: FastifyRequest,
    host: ExecutionContext,
    verified: Awaited<ReturnType<JwtVerifier['verify']>>,
  ): Promise<boolean> {
    // A staff route reached with a customer token dies at the JWKS check above; the
    // reverse — a staff token on a customer route — dies here, because the staff tenant
    // issues no `users` row and stamps no `https://portal/email` claim to make one from.
    const user =
      (await adminDb.user.findUnique({
        where: { authProviderId: verified.subject },
        select: { id: true, email: true, lockedAt: true, sessionsRevokedAt: true },
      })) ?? (await this.provision(verified));

    if (!user) {
      // No row, and the token carries no email we trust to make one from: the
      // Post-User-Registration Action (§13.2) has not landed and the Post-Login Action is
      // an older build. Nothing to do but say so.
      throw new AppError('UNAUTHENTICATED', 'We have no account for this sign-in yet.');
    }
    // SA3 "Lock" (D12). The identity provider is blocked too, but a token minted before
    // the lock is still valid for its lifetime; the row is what refuses it now.
    if (user.lockedAt) {
      throw new AppError('ACCOUNT_LOCKED', 'This account has been locked. Contact support.');
    }
    // SA3 "Force logout" (D12). Revoking at the provider stops new tokens; this refuses the
    // ones already issued. `iat` is whole seconds, so the comparison is on whole seconds and
    // strict: a sign-in right after an unlock is never refused, at the cost of a token minted
    // earlier in the very second of the revocation surviving it (under a second of exposure).
    if (user.sessionsRevokedAt && typeof verified.payload.iat === 'number' && verified.payload.iat < Math.floor(user.sessionsRevokedAt.getTime() / 1000)) {
      throw new AppError('INVALID_TOKEN', 'Your session was ended. Sign in again.');
    }

    const needsVerifiedEmail = this.reflector.getAllAndOverride<boolean>(REQUIRE_EMAIL_VERIFIED, [
      host.getHandler(),
      host.getClass(),
    ]);
    if (needsVerifiedEmail && !verified.emailVerified) {
      throw new AppError('EMAIL_UNVERIFIED', 'Confirm your email address first.');
    }

    request.auth = {
      userId: user.id,
      subject: verified.subject,
      email: user.email,
      emailVerified: verified.emailVerified,
      mfa: verified.mfa,
    };
    return true;
  }

  /**
   * Admin §7.4 view-as (D12). The token names one `impersonation_sessions` row; the row
   * is read on every request so an ended session (the console's Exit, the banner's Exit,
   * or expiry) is refused immediately rather than when the HMAC lapses. The request then
   * looks like the workspace *owner* to every read — `ctx.userId` is the owner's, because
   * D5/D6 read "my" settings by it — and `request.impersonation` is what WorkspaceGuard
   * uses to pin the workspace and refuse every write.
   */
  private async authenticateImpersonation(request: FastifyRequest, token: string): Promise<boolean> {
    const claims = this.impersonation.verify(token);
    if (!claims) throw new AppError('INVALID_TOKEN', 'This view-as link has expired. Start it again from the console.');

    const session = await adminDb.impersonationSession.findUnique({
      where: { id: claims.sessionId },
      select: {
        id: true,
        staffId: true,
        tenantId: true,
        mode: true,
        endedAt: true,
        expiresAt: true,
        staff: { select: { email: true, active: true } },
        tenant: { select: { name: true, memberships: { where: { role: 'owner' }, select: { userId: true }, take: 1 } } },
      },
    });
    if (!session || session.staffId !== claims.staffId || session.tenantId !== claims.tenantId) {
      throw new AppError('INVALID_TOKEN', 'This view-as link is not valid.');
    }
    if (session.endedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new AppError('INVALID_TOKEN', 'This view-as session has ended.');
    }
    if (session.mode !== 'view') throw new AppError('INVALID_TOKEN', 'Only read-only sessions can use this link.');
    if (!session.staff.active) throw new AppError('STAFF_ONLY', 'This staff account is disabled.');
    const owner = session.tenant.memberships[0];
    if (!owner) throw new AppError('NOT_A_MEMBER', 'This workspace has no owner to view as.');

    request.auth = {
      userId: owner.userId,
      subject: `staff:${session.staffId}`,
      email: session.staff.email,
      emailVerified: true,
      mfa: true,
    };
    request.impersonation = {
      id: session.id,
      staffId: session.staffId,
      staffEmail: session.staff.email,
      tenantId: session.tenantId,
      tenantName: session.tenant.name,
      mode: 'view',
      expiresAt: session.expiresAt,
    };
    return true;
  }

  /**
   * §13.2's last line of defence. The registration webhook is fire-and-forget on Auth0's
   * side and the Post-Login webhook is best-effort too, so a verified token for a `sub`
   * we have never heard of is a real customer, not an intruder: the signature, issuer and
   * audience checks have already passed. If the token carries the email our Post-Login
   * Action stamps, the row is made here — through the same idempotent upsert the webhooks
   * use, so a burst of first requests racing through this guard produces one row.
   *
   * Only the namespaced claim is trusted. A standard `email` claim is not: nothing in our
   * pipeline vouches for it, and a row is what every membership points at.
   */
  private async provision(verified: VerifiedToken): Promise<{ id: string; email: string; lockedAt: Date | null; sessionsRevokedAt: Date | null } | null> {
    if (!verified.email) return null;
    const outcome = await this.users.upsert({
      event_type: 'user.login',
      external_id: verified.subject,
      email: verified.email,
      email_verified: verified.emailVerified,
      name: verified.name,
    });
    if (outcome.outcome === 'created') {
      this.logger.warn(`users row for ${verified.subject} provisioned from the access token — the registration webhook never arrived`);
    }
    return adminDb.user.findUnique({ where: { id: outcome.userId }, select: { id: true, email: true, lockedAt: true, sessionsRevokedAt: true } });
  }
}

/**
 * Authorisation for staff routes, checked against the role matrix (admin §2.2).
 * The numeric limits — how many credits, how large a refund — live in staff_role_limits
 * and are enforced in the services that spend them.
 */
@Injectable()
export class StaffRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(host: ExecutionContext): boolean {
    if (host.getType() !== 'http') return true;

    const allowed = this.reflector.getAllAndOverride<StaffRole[]>(REQUIRED_STAFF_ROLES, [
      host.getHandler(),
      host.getClass(),
    ]);
    if (!allowed?.length) return true;

    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const staff = request.staff;
    if (!staff) throw new AppError('STAFF_ONLY', 'This route is staff only.');

    if (!allowed.includes(staff.role)) {
      throw new AppError(
        'FORBIDDEN_ROLE',
        `This action is limited to: ${allowed.join(', ').replace(/_/g, ' ')}.`,
      );
    }
    return true;
  }
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) {
    throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  }
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  }
  return token;
}
