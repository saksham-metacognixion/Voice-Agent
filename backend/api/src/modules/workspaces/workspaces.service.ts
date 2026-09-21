import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, withWorkspace } from '@portal/db';
import {
  type CreateWorkspaceRequest,
  type UpdateWorkspaceRequest,
  type WorkspaceChecklist,
  type WorkspaceResponse,
  businessHours as businessHoursSchema,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { RuntimeCacheService } from '../runtime-cache';
import { WalletService } from '../wallet';

/**
 * §13.2 — sign-up and workspace creation, and the D6 workspace settings behind it.
 *
 *     POST /workspaces → transaction: tenants row (plan trial), memberships (Owner),
 *       credit_ledger +20 (reason trial, expires +30 days), default notification_settings,
 *       audit_log → response includes the workspace id.
 *
 * Every one of those five is in **one** transaction, including the trial grant. That last
 * one is the reason `WalletService.withWalletTx` exists: the wallet is still the only
 * thing that writes `credit_ledger`, but here it writes inside a transaction it did not
 * open, so a failure anywhere — a duplicate name, a bad timezone, a wallet policy that
 * cannot be read — leaves no workspace at all rather than one with no credits, or credits
 * with no owner.
 *
 * On `adminDb`, deliberately and unavoidably: RLS scopes every query to
 * `app.tenant_id`, and at this point the workspace does not exist yet. ADR 0006 names
 * workspace creation as one of the four legitimate admin-connection cases.
 */
@Injectable()
export class WorkspacesService {
  private readonly log = new Logger(WorkspacesService.name);

  constructor(
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly runtimeCache: RuntimeCacheService,
  ) {}

  /**
   * POST /workspaces (A4 "Continue").
   *
   * Duplicate submission is handled the way a double-clicked button should be: the same
   * user creating the same-named workspace twice gets the first one back, not a second
   * workspace with a second trial grant. The check runs under an advisory lock keyed on
   * (user, normalised name), so two requests in flight at once cannot both pass it —
   * this is a real serialisation point, not a `if (!exists) create()`.
   */
  async create(user: AuthenticatedUser, input: CreateWorkspaceRequest, ip?: string): Promise<WorkspaceResponse> {
    assertTimezone(input.timezone);
    const { policy, configVersion } = await this.config.walletPolicy();

    const { workspaceId, reused, writes } = await adminDb.$transaction(
      async (tx) => {
        await lockCreation(tx, user.userId, input.name);

        const existing = await tx.tenant.findFirst({
          where: {
            name: { equals: input.name.trim(), mode: 'insensitive' },
            memberships: { some: { userId: user.userId, role: 'owner' } },
          },
          select: { id: true },
        });
        if (existing) {
          return { workspaceId: existing.id, reused: true, writes: [] };
        }

        const tenant = await tx.tenant.create({
          data: {
            name: input.name.trim(),
            country: input.country,
            timezone: input.timezone,
            website: input.website,
            planTier: 'trial',
            onboardingStep: 1,
            ...(input.phone ? { addressJson: { phone: input.phone } as Prisma.InputJsonValue } : {}),
          },
        });

        await tx.membership.create({ data: { tenantId: tenant.id, userId: user.userId, role: 'owner' } });

        // §15: user_id NULL is the workspace-level default row. The partial unique index
        // in the RLS migration is what keeps there being exactly one.
        await tx.notificationSetting.create({ data: { tenantId: tenant.id, userId: null } });

        const { writes } = await this.wallet.withWalletTx(tx, tenant.id, (wallet) =>
          this.wallet.trialGrant(tx, wallet, tenant.id, policy.trial_credits, policy.trial_validity_days, configVersion),
        );

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            actorUserId: user.userId,
            action: 'workspace.created',
            targetType: 'workspace',
            targetId: tenant.id,
            ip: ip ?? null,
            metaJson: {
              country: input.country,
              timezone: input.timezone,
              trial_credits: policy.trial_credits,
              config_version: configVersion,
            } as Prisma.InputJsonValue,
          },
        });

        return { workspaceId: tenant.id, reused: false, writes };
      },
      { timeout: 15_000, maxWait: 5_000 },
    );

    if (reused) {
      this.log.warn(`user ${user.userId} re-submitted "${input.name}"; returning the existing workspace ${workspaceId}`);
      return this.get({ userId: user.userId, workspaceId, role: 'owner' });
    }

    // After the commit: a `wallet` SSE frame for a balance that then rolled back would be
    // a number the customer can see and the database cannot.
    await this.wallet.notify(workspaceId, writes);
    // Fills `caps:{ws}` and `bal:{ws}` so the first inbound call does not meet a cold
    // cache (CLAUDE.md: refresh from every mutating path). Never fatal — the 5-minute
    // schedule is the backstop.
    await this.runtimeCache
      .refresh(workspaceId)
      .catch((error: unknown) => this.log.warn(`runtime-cache warm for the new workspace failed: ${String(error)}`));

    this.log.log(`workspace ${workspaceId} created by ${user.userId} with ${policy.trial_credits} trial credits`);
    return this.get({ userId: user.userId, workspaceId, role: 'owner' });
  }

  /** GET /workspace — the signed-in workspace, with the caller's own role. */
  async get(ctx: WorkspaceContext): Promise<WorkspaceResponse> {
    const tenant = await withWorkspace(ctx, (db) => db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId } }));
    return toResponse(tenant, ctx.role);
  }

  /** PATCH /workspace — D6 Settings. Owner or admin (§6.1 "change workspace settings"). */
  async update(ctx: WorkspaceContext, input: UpdateWorkspaceRequest, ip?: string): Promise<WorkspaceResponse> {
    if (input.timezone) assertTimezone(input.timezone);

    const data: Prisma.TenantUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (input.website !== undefined) data.website = input.website;
    if (input.recording_default !== undefined) data.recordingDefault = input.recording_default;
    if (input.retention_days !== undefined) data.retentionDays = input.retention_days;
    if (input.onboarding_step !== undefined) data.onboardingStep = input.onboarding_step;
    if (input.business_hours !== undefined) {
      data.businessHoursJson =
        input.business_hours === null
          ? Prisma.DbNull
          : (businessHoursSchema.parse(input.business_hours) as unknown as Prisma.InputJsonValue);
    }

    const tenant = await withWorkspace(ctx, async (db) => {
      const updated = await db.tenant.update({ where: { id: ctx.workspaceId }, data });
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'workspace.updated',
          targetType: 'workspace',
          targetId: ctx.workspaceId,
          ip: ip ?? null,
          metaJson: { fields: Object.keys(data) } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });

    // Business hours and the timezone are both baked into `num:{e164}`, which the §13.9
    // hours check reads without touching Postgres. A settings save that did not refresh
    // would leave the agent answering on yesterday's opening times for five minutes.
    if (input.business_hours !== undefined || input.timezone !== undefined || input.name !== undefined) {
      await this.runtimeCache
        .refresh(ctx.workspaceId)
        .catch((error: unknown) => this.log.warn(`runtime-cache refresh after a settings change failed: ${String(error)}`));
    }
    return toResponse(tenant, ctx.role);
  }

  /**
   * GET /workspace/checklist — §6.4 onboarding gating, answered by the server so the
   * portal's route guards and the backend cannot disagree about whether onboarding is done.
   */
  async checklist(ctx: WorkspaceContext): Promise<WorkspaceChecklist> {
    const state = await withWorkspace(ctx, async (db) => {
      const [tenant, agents, published, generated, purchases, numbers] = await Promise.all([
        db.tenant.findUniqueOrThrow({
          where: { id: ctx.workspaceId },
          select: { onboardingStep: true, onboardingCompletedAt: true },
        }),
        db.agent.count({ where: { tenantId: ctx.workspaceId, deletedAt: null } }),
        db.agent.count({ where: { tenantId: ctx.workspaceId, deletedAt: null, publishedVersion: { not: null } } }),
        db.agentVersion.count({ where: { agent: { tenantId: ctx.workspaceId }, promptText: { not: null } } }),
        db.purchase.count({ where: { tenantId: ctx.workspaceId, status: 'paid' } }),
        db.phoneNumber.count({ where: { tenantId: ctx.workspaceId, status: { in: ['active', 'provisioning'] } } }),
      ]);
      return { tenant, agents, published, generated, purchases, numbers };
    });

    const checklist = {
      workspace_created: true,
      agent_created: state.agents > 0,
      agent_generated: state.generated > 0,
      agent_published: state.published > 0,
      credits_purchased: state.purchases > 0,
      number_attached: state.numbers > 0,
      onboarding_step: state.tenant.onboardingStep,
    };
    return {
      ...checklist,
      // §6.4 redirects to /onboarding/* until there is a published agent; the rest of the
      // list is progress, not a gate.
      complete: Boolean(state.tenant.onboardingCompletedAt) || checklist.agent_published,
    };
  }

  /** Every workspace the signed-in user belongs to — the A7 switcher. */
  async listForUser(userId: string): Promise<Array<{ id: string; name: string; role: string }>> {
    const rows = await adminDb.membership.findMany({
      where: { userId },
      include: { tenant: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({ id: row.tenant.id, name: row.tenant.name, role: row.role }));
  }
}

function toResponse(
  tenant: {
    id: string;
    name: string;
    country: string;
    timezone: string;
    website: string | null;
    planTier: string;
    concurrencyCap: number;
    kbAllowance: number;
    businessHoursJson: unknown;
    recordingDefault: boolean;
    retentionDays: number;
    onboardingStep: number;
    onboardingCompletedAt: Date | null;
    pausedAt: Date | null;
    pausedReason: string | null;
    createdAt: Date;
  },
  role: WorkspaceContext['role'],
): WorkspaceResponse {
  return {
    id: tenant.id,
    name: tenant.name,
    country: tenant.country,
    timezone: tenant.timezone,
    website: tenant.website,
    plan_tier: tenant.planTier as WorkspaceResponse['plan_tier'],
    concurrency_cap: tenant.concurrencyCap,
    kb_allowance: tenant.kbAllowance,
    business_hours: businessHoursSchema.safeParse(tenant.businessHoursJson).data ?? null,
    recording_default: tenant.recordingDefault,
    retention_days: tenant.retentionDays,
    onboarding_step: tenant.onboardingStep,
    onboarding_completed_at: tenant.onboardingCompletedAt?.toISOString() ?? null,
    paused: tenant.pausedAt !== null,
    paused_reason: tenant.pausedReason,
    role,
    created_at: tenant.createdAt.toISOString(),
  };
}

/**
 * A transaction-scoped advisory lock on (user, normalised name).
 *
 * It is what makes the duplicate check above a real one. Two simultaneous POSTs would
 * otherwise both find nothing and both create a workspace — the classic
 * check-then-act race, and the one that costs two trial grants. Transaction-scoped, so
 * it is released by the commit or the rollback and never leaks with a pooled connection.
 */
async function lockCreation(tx: Prisma.TransactionClient, userId: string, name: string): Promise<void> {
  const key = `workspace:create:${userId}:${name.trim().toLowerCase()}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/**
 * The timezone reaches Retell (`agent.timezone`) and drives the §13.9 hours check, so a
 * typo here is an agent that answers at the wrong time of day. Node's own tz database is
 * the cheapest possible check and needs no dependency.
 */
function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new AppError('BAD_REQUEST', `"${timezone}" is not a time zone we recognise.`, [
      { field: 'timezone', message: 'Pick a time zone from the list' },
    ]);
  }
}
