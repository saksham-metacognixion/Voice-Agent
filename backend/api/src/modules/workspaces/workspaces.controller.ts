import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  type AcceptInviteResponse,
  type AuditEntryResponse,
  type Page,
  type InviteResponse,
  type MemberResponse,
  type WorkspaceChecklist,
  type WorkspaceResponse,
  auditLogQuery,
  createWorkspaceRequest,
  inviteRequest,
  transferOwnershipRequest,
  updateMemberRequest,
  updateWorkspaceRequest,
  uuid,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, NoWorkspace, RequireEmailVerified, Roles } from '../auth';
import type { AuthenticatedUser, WorkspaceContext } from '../auth';
import { MembersService } from './members.service';
import { WorkspacesService } from './workspaces.service';

/**
 * Workspaces and membership (§16).
 *
 * Three of these routes are `@NoWorkspace()`, and each for a reason that is worth stating
 * because the decorator switches off the tenancy guard:
 *
 *   POST /workspaces          there is no workspace yet — this creates one
 *   GET  /workspaces          the A7 switcher, which lists the ones you belong to
 *   POST /invites/:token/accept  you are not a member yet; the token is the authorisation
 *
 * They are still authenticated, and each of them derives its scope from the signed-in
 * user rather than from anything the client sends. No route on this controller takes a
 * workspace id from a body or a path.
 */
@Controller()
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly members: MembersService,
  ) {}

  /** A4 — the only way a workspace comes into existence (§13.2). */
  @Post('workspaces')
  @NoWorkspace()
  @RequireEmailVerified()
  create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<WorkspaceResponse> {
    return this.workspaces.create(authOf(request), createWorkspaceRequest.parse(body), request.ip);
  }

  /** A7 workspace switcher: name, role and id for each membership. */
  @Get('workspaces')
  @NoWorkspace()
  mine(@Req() request: FastifyRequest): Promise<Array<{ id: string; name: string; role: string }>> {
    // Admin §7.4 (D12): a view-as session sees exactly the workspace it was opened for,
    // not every workspace the owner belongs to — the switcher must not become a way in.
    if (request.impersonation) {
      return Promise.resolve([{ id: request.impersonation.tenantId, name: request.impersonation.tenantName, role: 'owner' }]);
    }
    return this.workspaces.listForUser(authOf(request).userId);
  }

  @Get('workspace')
  get(@Ctx() ctx: WorkspaceContext): Promise<WorkspaceResponse> {
    return this.workspaces.get(ctx);
  }

  /** §6.1: "change workspace settings — Owner, Admin". */
  @Patch('workspace')
  @Roles('owner', 'admin')
  update(@Ctx() ctx: WorkspaceContext, @Req() request: FastifyRequest, @Body() body: unknown): Promise<WorkspaceResponse> {
    return this.workspaces.update(ctx, updateWorkspaceRequest.parse(body), request.ip);
  }

  @Get('workspace/checklist')
  checklist(@Ctx() ctx: WorkspaceContext): Promise<WorkspaceChecklist> {
    return this.workspaces.checklist(ctx);
  }

  /** §6.1: "transfer ownership — Owner only". The service checks it again. */
  @Post('workspace/transfer-ownership')
  @Roles('owner')
  transfer(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<MemberResponse[]> {
    return this.members.transferOwnership(ctx, transferOwnershipRequest.parse(body).user_id);
  }

  /** D6 Audit log — "Owner/Admin" (spec p. 39). */
  @Get('audit-log')
  @Roles('owner', 'admin')
  auditLog(@Ctx() ctx: WorkspaceContext, @Query() query: unknown): Promise<Page<AuditEntryResponse>> {
    return this.workspaces.auditLog(ctx, auditLogQuery.parse(query));
  }

  // ------------------------------------------------------------------ members

  @Get('members')
  listMembers(@Ctx() ctx: WorkspaceContext): Promise<MemberResponse[]> {
    return this.members.list(ctx);
  }

  @Patch('members/:id')
  @Roles('owner', 'admin')
  updateMember(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<MemberResponse> {
    return this.members.updateRole(ctx, membershipId(id), updateMemberRequest.parse(body));
  }

  @Delete('members/:id')
  @Roles('owner', 'admin')
  removeMember(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<{ removed: boolean }> {
    return this.members.remove(ctx, membershipId(id));
  }

  // ------------------------------------------------------------------ invites (A8)

  @Get('invites')
  @Roles('owner', 'admin')
  listInvites(@Ctx() ctx: WorkspaceContext): Promise<InviteResponse[]> {
    return this.members.listInvites(ctx);
  }

  @Post('invites')
  @Roles('owner', 'admin')
  @RequireEmailVerified()
  invite(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<InviteResponse> {
    return this.members.invite(ctx, inviteRequest.parse(body));
  }

  @Delete('invites/:id')
  @Roles('owner', 'admin')
  revokeInvite(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<{ revoked: boolean }> {
    return this.members.revokeInvite(ctx, membershipId(id));
  }

  /**
   * A8 Join workspace. No `X-Workspace-Id` — the invitee has no membership to send one
   * for — so the token is both the identifier and the authorisation, and it is checked
   * against the signed-in email as well as against its own expiry.
   */
  @Post('invites/:token/accept')
  @NoWorkspace()
  @RequireEmailVerified()
  accept(@Req() request: FastifyRequest, @Param('token') token: string): Promise<AcceptInviteResponse> {
    if (!token || token.length < 16 || token.length > 200) {
      throw new AppError('INVITE_INVALID', 'That invite link is not valid.');
    }
    return this.members.acceptInvite(authOf(request), token);
  }
}

/**
 * `@NoWorkspace()` routes have `request.auth` but no `ctx`, so they read the user
 * directly. The guard has already verified the token and loaded the row.
 */
function authOf(request: FastifyRequest): AuthenticatedUser {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  return auth;
}

function membershipId(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw AppError.notFound('Member');
  return parsed.data;
}
