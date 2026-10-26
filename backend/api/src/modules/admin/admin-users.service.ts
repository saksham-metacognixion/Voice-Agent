import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminUserActionResponse,
  AdminUserResponse,
  AdminUsersQuery,
  Page,
  StaffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import { Auth0ManagementService, type StaffContext } from '../auth';
import { iso, uuidParam, idMatch } from './admin.helpers';
import { StaffAuditService, type StaffAuditInput } from './staff-audit.service';

const WITH = {
  memberships: { include: { tenant: { select: { name: true } } } },
} satisfies Prisma.UserInclude;
type Row = Prisma.UserGetPayload<{ include: typeof WITH }>;

/**
 * SA3 (D12 §9): the people, across workspaces, and the four account actions. Each action
 * changes the identity provider *and* our row: the provider is where sign-in happens,
 * the row is what the API enforces (a locked user is refused by AuthGuard whatever token
 * they hold) and what survives a provider outage. When the Management API is not
 * configured the response says `provider: skipped`, so a dev box never reports a
 * verification it did not perform.
 */
@Injectable()
export class AdminUsersService {
  private readonly log = new Logger(AdminUsersService.name);

  constructor(
    private readonly auth0: Auth0ManagementService,
    private readonly audit: StaffAuditService,
  ) {}

  async list(query: AdminUsersQuery): Promise<Page<AdminUserResponse>> {
    const where: Prisma.UserWhereInput = {};
    if (query.tenant_id) where.memberships = { some: { tenantId: query.tenant_id } };
    if (query.q)
      where.OR = [
        { email: { contains: query.q, mode: 'insensitive' } },
        { name: { contains: query.q, mode: 'insensitive' } },
        { authProviderId: query.q },
        ...idMatch(query.q),
      ];
    const rows = await adminDb.user.findMany({
      where,
      include: WITH,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    return { ...page, items: page.items.map((r) => this.toResponse(r, null)) };
  }

  async get(idRaw: string): Promise<AdminUserResponse> {
    const id = uuidParam(idRaw, 'User');
    const row = await adminDb.user.findUnique({ where: { id }, include: WITH });
    if (!row) throw AppError.notFound('User');
    // One provider read on the detail only; the list never fans out to Auth0.
    const facts = await this.auth0.getUser(row.authProviderId).catch((error: unknown) => {
      this.log.warn(`auth0 read for ${row.id} failed: ${String(error)}`);
      return null;
    });
    return this.toResponse(row, facts?.email_verified ?? null);
  }

  async verifyEmail(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    const user = await this.load(idRaw);
    const provider = await this.provider(() =>
      this.auth0.setEmailVerified(user.authProviderId, true),
    );
    await this.commit(user, 'user.email_verified', null, {
      staff,
      reasonCode: body.reason_code,
      note: body.note,
      after: { email: user.email, provider },
      request,
    });
    return { user: await this.get(user.id), provider };
  }

  async resetMfa(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    const user = await this.load(idRaw);
    const provider = await this.provider(() => this.auth0.resetMfa(user.authProviderId));
    await this.commit(
      user,
      'user.mfa_reset',
      { mfaEnabled: false },
      {
        staff,
        reasonCode: body.reason_code,
        note: body.note,
        before: { mfa_enabled: user.mfaEnabled },
        after: { mfa_enabled: false, provider },
        request,
      },
    );
    this.log.warn(`MFA reset for ${user.email} by ${staff.email} (${body.reason_code})`);
    return { user: await this.get(user.id), provider };
  }

  async lock(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    const user = await this.load(idRaw);
    const provider = await this.provider(() => this.auth0.setBlocked(user.authProviderId, true));
    // Sessions too: a lock that leaves a refresh token alive is a lock that ends in an hour.
    // Our `sessions_revoked_at` below refuses every token already issued either way; the
    // provider's half is recorded, not swallowed (QA-042), so staff can see it and retry.
    let sessions: 'applied' | 'skipped' | 'failed';
    let providerError: string | null = null;
    try {
      sessions = await this.auth0.revokeSessions(user.authProviderId);
    } catch (error) {
      sessions = 'failed';
      providerError = 'The account is locked, but the identity provider did not revoke its sessions. Tokens already issued are refused by the API; force logout to retry the revoke.';
      this.log.error(`lock ${user.id}: provider session revoke failed (${String(error)})`);
    }
    const reason = body.note ? `${body.reason_code}: ${body.note}` : body.reason_code;
    await this.commit(
      user,
      'user.locked',
      { lockedAt: user.lockedAt ?? new Date(), lockedReason: reason, sessionsRevokedAt: new Date() },
      {
        staff,
        reasonCode: body.reason_code,
        note: body.note,
        before: { locked: user.lockedAt !== null },
        after: { locked: true, provider, sessions },
        request,
      },
      { reason_code: body.reason_code },
    );
    if (sessions === 'failed')
      await this.audit.record({
        staff,
        action: 'user.lock_provider_failed',
        targetType: 'user',
        targetId: user.id,
        reasonCode: body.reason_code,
        after: { sessions, provider_error: providerError },
        request,
      });
    this.log.warn(`user ${user.email} locked by ${staff.email} (${body.reason_code})`);
    return { user: await this.get(user.id), provider, provider_error: providerError };
  }

  async unlock(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    const user = await this.load(idRaw);
    const provider = await this.provider(() => this.auth0.setBlocked(user.authProviderId, false));
    await this.commit(
      user,
      'user.unlocked',
      { lockedAt: null, lockedReason: null },
      {
        staff,
        reasonCode: body.reason_code,
        note: body.note,
        before: { locked: user.lockedAt !== null, reason: user.lockedReason },
        after: { locked: false, provider },
        request,
      },
    );
    return { user: await this.get(user.id), provider };
  }

  async forceLogout(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    const user = await this.load(idRaw);
    // Ours first: every token issued until now is refused by AuthGuard from this line on, so
    // the logout holds even when the identity provider is down or refuses the call.
    const revokedAt = new Date();
    // The revoke and its audit row commit together, before the provider is asked.
    await this.commit(
      user,
      'user.force_logout',
      { sessionsRevokedAt: revokedAt },
      {
        staff,
        reasonCode: body.reason_code,
        note: body.note,
        after: { sessions_revoked_at: revokedAt.toISOString() },
        request,
      },
    );
    let provider: 'applied' | 'skipped' | 'failed';
    let providerError: string | null = null;
    try {
      provider = await this.auth0.revokeSessions(user.authProviderId);
    } catch (error) {
      // Not a 503: the logout happened. Staff are told the provider half did not, and can retry.
      provider = 'failed';
      providerError = 'The identity provider did not revoke its sessions; tokens already issued are refused by the API, but a refresh may still mint new ones until you retry.';
      this.log.error(`force logout ${user.id}: provider revoke failed (${String(error)})`);
    }
    // The provider's answer is its own row: the log is append-only, and the logout above
    // stands whatever the provider said.
    await this.audit.record({
      staff,
      action: provider === 'failed' ? 'user.force_logout_provider_failed' : 'user.force_logout_provider',
      targetType: 'user',
      targetId: user.id,
      reasonCode: body.reason_code,
      after: { provider, provider_error: providerError },
      request,
    });
    return { user: await this.get(user.id), provider, provider_error: providerError };
  }

  /**
   * The row change, the `staff_audit_log` row and the workspace `audit_log` rows of every
   * membership commit together (CLAUDE.md: no audit row, no write). The identity provider
   * has already been told by the time this runs; a failure here rolls our side back and
   * the staff member retries, which the provider calls tolerate (they are idempotent).
   */
  private async commit(
    user: Row,
    action: string,
    data: Prisma.UserUpdateInput | null,
    audit: Omit<StaffAuditInput, 'staff' | 'action' | 'targetType' | 'targetId'> & { staff: StaffContext },
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    await adminDb.$transaction(async (tx) => {
      if (data) await tx.user.update({ where: { id: user.id }, data });
      await this.audit.record(
        { ...audit, action, targetType: 'user', targetId: user.id },
        tx,
      );
      for (const m of user.memberships)
        await tx.auditLog.create({
          data: {
            tenantId: m.tenantId,
            action,
            targetType: 'user',
            targetId: user.id,
            metaJson: { by: 'staff', ...meta } as Prisma.InputJsonValue,
          },
        });
    });
  }

  private async load(idRaw: string): Promise<Row> {
    const id = uuidParam(idRaw, 'User');
    const row = await adminDb.user.findUnique({ where: { id }, include: WITH });
    if (!row) throw AppError.notFound('User');
    return row;
  }

  /** A provider failure is a 503 the staff member sees; nothing local changes on it. */
  private async provider(
    call: () => Promise<'applied' | 'skipped'>,
  ): Promise<'applied' | 'skipped'> {
    try {
      return await call();
    } catch (error) {
      this.log.error(`identity provider call failed: ${String(error)}`);
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'The identity provider did not accept the change. Nothing was changed; try again in a moment.',
      );
    }
  }

  private toResponse(r: Row, emailVerified: boolean | null): AdminUserResponse {
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      mfa_enabled: r.mfaEnabled,
      email_verified: emailVerified,
      locked_at: iso(r.lockedAt),
      locked_reason: r.lockedReason,
      sessions_revoked_at: iso(r.sessionsRevokedAt),
      created_at: r.createdAt.toISOString(),
      memberships: r.memberships.map((m) => ({
        tenant_id: m.tenantId,
        tenant_name: m.tenant.name,
        role: m.role,
      })),
    };
  }
}
