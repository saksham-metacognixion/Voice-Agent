import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { adminDb } from '@portal/db';
import type { StaffRole } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { IS_PUBLIC, REQUIRED_STAFF_ROLES, REQUIRE_EMAIL_VERIFIED } from './auth.decorators';
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

    const staff = await adminDb.staffUser.findUnique({
      where: { authProviderId: verified.subject },
      select: { id: true, email: true, role: true, active: true },
    });

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
        select: { id: true, email: true },
      })) ?? (await this.provision(verified));

    if (!user) {
      // No row, and the token carries no email we trust to make one from: the
      // Post-User-Registration Action (§13.2) has not landed and the Post-Login Action is
      // an older build. Nothing to do but say so.
      throw new AppError('UNAUTHENTICATED', 'We have no account for this sign-in yet.');
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
  private async provision(verified: VerifiedToken): Promise<{ id: string; email: string } | null> {
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
    return adminDb.user.findUnique({ where: { id: outcome.userId }, select: { id: true, email: true } });
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
