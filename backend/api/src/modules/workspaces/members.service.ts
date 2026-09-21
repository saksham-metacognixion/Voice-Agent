import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, isUniqueViolation, withWorkspace } from '@portal/db';
import type {
  AcceptInviteResponse,
  InviteRequest,
  InviteResponse,
  MemberResponse,
  UpdateMemberRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, WorkspaceContext } from '../auth';

/** A8: "Token single-use, 7-day TTL." */
export const INVITE_TTL_MS = 7 * 86_400_000;

/**
 * Members, invites and ownership (§6.1, A8, §16).
 *
 * The role matrix is enforced here, in the service, and never only by a decorator:
 * `@Roles('owner','admin')` says who may reach the route, but "an admin may not change
 * the Owner's role" and "only an Owner transfers ownership" are not ladder rules and
 * cannot be expressed that way (see `enums.ts`, ROLE_RANK).
 *
 * Three invariants, each backed by a database constraint rather than by care:
 *   - exactly one owner per workspace     `memberships_one_owner_idx`
 *   - one person, one membership          `memberships (tenant_id, user_id)` unique
 *   - one live invite per email           `invites_pending_email_idx`
 *
 * Invite tokens are stored as SHA-256 hashes and returned exactly once, at creation.
 * Nothing — not staff, not this service — can read a token back afterwards (A8).
 */
@Injectable()
export class MembersService {
  private readonly log = new Logger(MembersService.name);

  // ------------------------------------------------------------------ members

  /** GET /members. Every role may see who else is in the workspace. */
  async list(ctx: WorkspaceContext): Promise<MemberResponse[]> {
    const rows = await withWorkspace(ctx, (db) =>
      db.membership.findMany({
        where: { tenantId: ctx.workspaceId },
        include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      user_id: row.user.id,
      email: row.user.email,
      name: row.user.name,
      avatar_url: row.user.avatarUrl,
      role: row.role,
      joined_at: row.createdAt.toISOString(),
    }));
  }

  /**
   * PATCH /members/:id {role}.
   *
   * §6.1: an admin may invite and remove members and change roles — but not the Owner's.
   * The owner role itself is not assignable here at all; it moves only through
   * `transferOwnership`, which is atomic and audited.
   */
  async updateRole(ctx: WorkspaceContext, membershipId: string, input: UpdateMemberRequest): Promise<MemberResponse> {
    const updated = await withWorkspace(ctx, async (db) => {
      const membership = await db.membership.findFirst({
        where: { id: membershipId, tenantId: ctx.workspaceId },
        include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
      });
      if (!membership) throw AppError.notFound('Member');

      if (membership.role === 'owner') {
        throw new AppError(
          'OWNER_ONLY',
          "The owner's role is changed by transferring ownership, not by editing it.",
        );
      }
      if (membership.role === input.role) return membership;

      const row = await db.membership.update({
        where: { id: membershipId },
        data: { role: input.role },
        include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
      });
      await this.audit(db, ctx, 'member.role_changed', membership.userId, { from: membership.role, to: input.role });
      return row;
    });

    return {
      id: updated.id,
      user_id: updated.user.id,
      email: updated.user.email,
      name: updated.user.name,
      avatar_url: updated.user.avatarUrl,
      role: updated.role,
      joined_at: updated.createdAt.toISOString(),
    };
  }

  /**
   * DELETE /members/:id.
   *
   * The owner cannot be removed — a workspace with no owner has nobody who can buy
   * credits, transfer it or delete it, and the one-owner index would make the next
   * transfer the only way out. Transfer first, then remove.
   */
  async remove(ctx: WorkspaceContext, membershipId: string): Promise<{ removed: boolean }> {
    return withWorkspace(ctx, async (db) => {
      const membership = await db.membership.findFirst({ where: { id: membershipId, tenantId: ctx.workspaceId } });
      if (!membership) throw AppError.notFound('Member');
      if (membership.role === 'owner') {
        throw new AppError('OWNER_ONLY', 'Transfer ownership before removing the owner from this workspace.');
      }

      await db.membership.delete({ where: { id: membershipId } });
      await this.audit(db, ctx, 'member.removed', membership.userId, { role: membership.role });
      this.log.log(`workspace ${ctx.workspaceId}: removed member ${membership.userId}`);
      return { removed: true };
    });
  }

  /**
   * POST /workspace/transfer-ownership {user_id} — owner only (§6.1).
   *
   * Atomic, and in an order that never violates the one-owner index: the current owner is
   * demoted to admin and the target promoted inside a single transaction, with both rows
   * locked first so two simultaneous transfers cannot interleave. The loser of that race
   * finds the caller is no longer the owner and is refused, rather than producing a
   * workspace with two owners or none.
   */
  async transferOwnership(ctx: WorkspaceContext, targetUserId: string): Promise<MemberResponse[]> {
    if (ctx.role !== 'owner') {
      throw new AppError('OWNER_ONLY', 'Only the workspace owner can transfer ownership.');
    }
    if (targetUserId === ctx.userId) {
      // Not an error worth failing on: the caller already owns it.
      return this.list(ctx);
    }

    await withWorkspace(ctx, async (db) => {
      // Lock both rows in a fixed order (by user id) so two transfers in flight deadlock
      // on neither and serialise on the first.
      const ids = [ctx.userId, targetUserId].sort();
      await db.$executeRaw`
        SELECT 1 FROM memberships
         WHERE tenant_id = ${ctx.workspaceId}::uuid AND user_id = ANY(${ids}::uuid[])
         ORDER BY user_id
         FOR UPDATE`;

      const [current, target] = await Promise.all([
        db.membership.findUnique({ where: { tenantId_userId: { tenantId: ctx.workspaceId, userId: ctx.userId } } }),
        db.membership.findUnique({ where: { tenantId_userId: { tenantId: ctx.workspaceId, userId: targetUserId } } }),
      ]);
      Logger.debug(current,target)

      if (!current || current.role !== 'owner') {
        // Someone else transferred it while this request was in flight.
        throw new AppError('OWNER_ONLY', 'You are no longer the owner of this workspace.');
      }
      if (!target) {
        throw new AppError(
          'NOT_FOUND',
          'That person is not a member of this workspace yet. Invite them first, then transfer ownership.',
        );
      }
      if (target.role === 'owner') return; // Already done — a retried request.

      // Demote before promoting: `memberships_one_owner_idx` would reject the other order.
      await db.membership.update({ where: { id: current.id }, data: { role: 'admin' } });
      await db.membership.update({ where: { id: target.id }, data: { role: 'owner' } });

      await this.audit(db, ctx, 'workspace.ownership_transferred', targetUserId, {
        from_user_id: ctx.userId,
        to_user_id: targetUserId,
      });
      this.log.warn(`workspace ${ctx.workspaceId}: ownership moved from ${ctx.userId} to ${targetUserId}`);
    });

    // The caller is an admin now, so re-read with the role they actually hold.
    return this.list({ ...ctx, role: 'admin' });
  }

  // ------------------------------------------------------------------ invites (A8)

  /**
   * POST /invites {email, role}.
   *
   * Re-inviting someone whose invite is still pending replaces the token rather than
   * stacking a second live one — which is what `invites_pending_email_idx` enforces and
   * what "Resend invite" in D6 means. Inviting an existing member is a 409, because the
   * useful answer is "they are already here", not a token that would do nothing.
   */
  async invite(ctx: WorkspaceContext, input: InviteRequest): Promise<InviteResponse> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await withWorkspace(ctx, async (db) => {
      const existingMember = await db.membership.findFirst({
        where: { tenantId: ctx.workspaceId, user: { email: input.email } },
        select: { id: true },
      });
      if (existingMember) {
        throw new AppError('ALREADY_MEMBER', 'That person is already a member of this workspace.');
      }

      // A pending invite for this address is replaced, so the newest link is the only one
      // that works. Deleting rather than updating keeps `token_hash` unique and leaves no
      // row whose token was superseded but still valid.
      await db.invite.deleteMany({ where: { tenantId: ctx.workspaceId, email: input.email, acceptedAt: null } });

      const row = await db.invite.create({
        data: {
          tenantId: ctx.workspaceId,
          email: input.email,
          role: input.role,
          tokenHash,
          invitedBy: ctx.userId,
          expiresAt,
        },
      });
      await this.audit(db, ctx, 'invite.created', row.id, { email: input.email, role: input.role });
      return row;
    }).catch((error: unknown) => {
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', 'An invite for that address is already on its way.');
      }
      throw error;
    });

    this.log.log(`workspace ${ctx.workspaceId}: invited ${input.email} as ${input.role}`);
    // The one and only time the token exists outside the invitee's inbox. D6 shows it as
    // a copyable link; the email that carries it lands with the notifications module.
    return { ...toInvite(invite), token };
  }

  /** GET /invites — the pending ones. Tokens are never included (A8). */
  async listInvites(ctx: WorkspaceContext): Promise<InviteResponse[]> {
    const rows = await withWorkspace(ctx, (db) =>
      db.invite.findMany({ where: { tenantId: ctx.workspaceId, acceptedAt: null }, orderBy: { createdAt: 'desc' } }),
    );
    return rows.map(toInvite);
  }

  async revokeInvite(ctx: WorkspaceContext, inviteId: string): Promise<{ revoked: boolean }> {
    return withWorkspace(ctx, async (db) => {
      const invite = await db.invite.findFirst({ where: { id: inviteId, tenantId: ctx.workspaceId } });
      if (!invite) throw AppError.notFound('Invite');
      if (invite.acceptedAt) throw new AppError('CONFLICT', 'That invite has already been accepted.');

      await db.invite.delete({ where: { id: inviteId } });
      await this.audit(db, ctx, 'invite.revoked', inviteId, { email: invite.email });
      return { revoked: true };
    });
  }

  /**
   * POST /invites/:token/accept — A8 "Join workspace".
   *
   * Runs on `adminDb` and nothing else could: the caller is, by definition, not yet a
   * member of the workspace the invite belongs to, so RLS would hide the invite row from
   * them. The token is the authorisation, and it is checked against three things —
   * unexpired, unaccepted, and issued to *this* email ("wrong-email login shows explicit
   * error").
   *
   * Idempotent: a second accept by the same user returns the same membership rather than
   * an error, because a double-clicked link is not a mistake worth a red page.
   */
  async acceptInvite(user: AuthenticatedUser, token: string): Promise<AcceptInviteResponse> {
    const tokenHash = hashToken(token);

    return adminDb.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({
        where: { tokenHash },
        include: { tenant: { select: { id: true, name: true } } },
      });
      if (!invite || !constantTimeEqual(invite.tokenHash, tokenHash)) {
        throw new AppError('INVITE_INVALID', 'That invite link is not valid.');
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        throw new AppError('INVITE_INVALID', 'That invite has expired. Ask for a new one.');
      }
      if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new AppError(
          'INVITE_INVALID',
          `That invite was sent to ${invite.email}. Sign in with that address to accept it.`,
        );
      }

      const existing = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: invite.tenantId, userId: user.userId } },
      });
      if (existing) {
        // Already a member — mark the invite used and answer with what they have.
        if (!invite.acceptedAt) await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
        return { workspace_id: invite.tenantId, workspace_name: invite.tenant.name, role: existing.role };
      }
      if (invite.acceptedAt) {
        // Single-use: accepted by somebody, and it was not this user.
        throw new AppError('INVITE_INVALID', 'That invite has already been used.');
      }

      await tx.membership.create({ data: { tenantId: invite.tenantId, userId: user.userId, role: invite.role } });
      await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      await tx.auditLog.create({
        data: {
          tenantId: invite.tenantId,
          actorUserId: user.userId,
          action: 'invite.accepted',
          targetType: 'membership',
          targetId: invite.id,
          metaJson: { email: invite.email, role: invite.role } as Prisma.InputJsonValue,
        },
      });

      this.log.log(`workspace ${invite.tenantId}: ${user.userId} joined as ${invite.role}`);
      return { workspace_id: invite.tenantId, workspace_name: invite.tenant.name, role: invite.role };
    });
  }

  private async audit(
    db: { auditLog: { create: (args: { data: Prisma.AuditLogUncheckedCreateInput }) => Promise<unknown> } },
    ctx: WorkspaceContext,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await db.auditLog.create({
      data: {
        tenantId: ctx.workspaceId,
        actorUserId: ctx.userId,
        action,
        targetType: 'membership',
        targetId,
        metaJson: meta as Prisma.InputJsonValue,
      },
    });
  }
}

function toInvite(row: {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}): InviteResponse {
  return {
    id: row.id,
    email: row.email,
    role: row.role as InviteResponse['role'],
    invited_by: row.invitedBy,
    expires_at: row.expiresAt.toISOString(),
    accepted_at: row.acceptedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

/** Only the hash is stored (A8), so the lookup key is the hash of what was presented. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The lookup above is already by hash, so this is belt and braces — but comparing two
 * secrets with `===` is a habit worth not having.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
