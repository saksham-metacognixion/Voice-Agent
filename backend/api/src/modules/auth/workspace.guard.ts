import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { adminDb } from '@portal/db';
import { type MemberRole, WORKSPACE_HEADER } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { IS_PUBLIC, NO_WORKSPACE, REQUIRED_ROLES } from './auth.decorators';
import { namespaceForPath } from './auth.guard';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenancy, second of the two global guards. Spec §6.2:
 *   verify JWT → load user → load membership for (user, workspace) → deny if missing
 *   → attach ctx = {userId, workspaceId, role}
 *
 * The membership lookup runs on the admin connection, because at this point we have not
 * established that this user may see this workspace — that is precisely the question.
 * Everything downstream runs through withWorkspace(ctx.workspaceId), where RLS takes
 * over as the second guard.
 *
 * Staff routes skip this entirely: staff have no membership, and their access to a
 * customer's data is governed by the role matrix and the audit log instead.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(host: ExecutionContext): Promise<boolean> {
    if (host.getType() !== 'http') return true;

    const skip = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      host.getHandler(),
      host.getClass(),
    ]);
    if (skip) return true;

    const request = host.switchToHttp().getRequest<FastifyRequest>();
    if (namespaceForPath(request.url) === 'staff') return true;

    const noWorkspace = this.reflector.getAllAndOverride<boolean>(NO_WORKSPACE, [
      host.getHandler(),
      host.getClass(),
    ]);
    if (noWorkspace) return true;

    const auth = request.auth;
    if (!auth) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

    const workspaceId = headerValue(request, WORKSPACE_HEADER);
    if (!workspaceId) {
      throw new AppError('WORKSPACE_REQUIRED', 'Choose a workspace to continue.');
    }
    if (!UUID_RE.test(workspaceId)) {
      // Fail before this reaches a uuid cast in Postgres, where it would be a 500.
      throw new AppError('NOT_A_MEMBER', 'You do not have access to that workspace.');
    }

    const membership = await adminDb.membership.findUnique({
      where: { tenantId_userId: { tenantId: workspaceId, userId: auth.userId } },
      select: { role: true },
    });

    // Same answer whether the workspace is someone else's or does not exist: a 404 here
    // would let anyone probe for valid workspace ids.
    if (!membership) {
      throw new AppError('NOT_A_MEMBER', 'You do not have access to that workspace.');
    }

    request.ctx = { userId: auth.userId, workspaceId, role: membership.role };

    this.assertRole(host, membership.role);
    return true;
  }

  private assertRole(host: ExecutionContext, role: MemberRole): void {
    const allowed = this.reflector.getAllAndOverride<MemberRole[]>(REQUIRED_ROLES, [
      host.getHandler(),
      host.getClass(),
    ]);
    if (!allowed?.length) return;

    if (!allowed.includes(role)) {
      throw new AppError('FORBIDDEN_ROLE', `This action needs the ${allowed.join(' or ')} role.`);
    }
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}
