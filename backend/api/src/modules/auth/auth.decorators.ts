import {
  type ExecutionContext,
  SetMetadata,
  createParamDecorator,
  type CustomDecorator,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { MemberRole, StaffRole } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { StaffContext, WorkspaceContext } from './auth.types';

export const IS_PUBLIC = 'auth:public';
export const NO_WORKSPACE = 'auth:no-workspace';
export const REQUIRED_ROLES = 'auth:roles';
export const REQUIRED_STAFF_ROLES = 'auth:staff-roles';
export const REQUIRE_EMAIL_VERIFIED = 'auth:email-verified';
export const ALLOW_IMPERSONATION_WRITE = 'auth:allow-impersonation-write';

/** No token at all: webhooks (§16), health, and the public pricing/flags reads. */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC, true);

/** Authenticated, but before a workspace exists or is chosen — POST /workspaces, GET /me. */
export const NoWorkspace = (): CustomDecorator => SetMetadata(NO_WORKSPACE, true);

/** Spec §6.1 role matrix. Listed explicitly; there is no implicit hierarchy here. */
export const Roles = (...roles: MemberRole[]): CustomDecorator =>
  SetMetadata(REQUIRED_ROLES, roles);

/** Admin §2.2 role matrix, enforced server-side and never only in the UI. */
export const StaffRoles = (...roles: StaffRole[]): CustomDecorator =>
  SetMetadata(REQUIRED_STAFF_ROLES, roles);

/** Spec §6.2: email verification is mandatory before any test call or purchase. */
export const RequireEmailVerified = (): CustomDecorator =>
  SetMetadata(REQUIRE_EMAIL_VERIFIED, true);

/**
 * Admin §7.4: a view-as session may call this mutating route. Exactly one route carries
 * it — `POST /impersonation/end`, the banner's Exit — and it exists so that ending the
 * session is not itself refused as a write.
 */
export const AllowImpersonationWrite = (): CustomDecorator => SetMetadata(ALLOW_IMPERSONATION_WRITE, true);

/** ctx = {userId, workspaceId, role} — the §6.2 request context. */
export const Ctx = createParamDecorator(
  (_data: unknown, host: ExecutionContext): WorkspaceContext => {
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    if (!request.ctx) {
      throw new AppError(
        'WORKSPACE_REQUIRED',
        'This route needs a workspace. Remove @NoWorkspace() or send X-Workspace-Id.',
      );
    }
    return request.ctx;
  },
);

/** ctx.staff = {id, role} — admin §2.1. */
export const StaffCtx = createParamDecorator(
  (_data: unknown, host: ExecutionContext): StaffContext => {
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    if (!request.staff) {
      throw new AppError('STAFF_ONLY', 'This route is staff only.');
    }
    return request.staff;
  },
);
