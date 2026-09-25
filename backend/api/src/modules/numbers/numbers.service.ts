import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, withWorkspace, type WorkspaceDb } from '@portal/db';
import type { BuyNumberRequest, Carrier, ForwardingGuide, ImportNumberRequest, NumberAccepted, PhoneNumberResponse, UpdateNumberRequest } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { SipCredentialsCipher } from '../crypto';
import { JobQueues } from '../jobs';
import { RetellGateway } from '../retell';
import { RuntimeCacheService } from '../runtime-cache';
import { WalletService } from '../wallet';
import { forwardingGuideFor } from './forwarding-guide';
import { newInboundToken } from './number-provisioning.service';
import { toNumberResponse } from './number-response';
import { NumberProvisioningService } from './number-provisioning.service';

const PROVISIONING_STATUSES = ['provisioning', 'active', 'paused'] as const;
/** The plan's stored SIP credentials, which `toNumberResponse` redacts to host, username and a has-password flag. */
const WITH_PLAN_SIP = { plan: { select: { sipJson: true } } } as const;

/**
 * D4 Numbers and the two out-of-wizard entry points (§16): `GET /numbers · POST
 * /numbers/buy · POST /numbers/import · GET /numbers/:id · PATCH /numbers/:id · DELETE
 * /numbers/:id · GET /numbers/forwarding-guide`.
 *
 * Buy and import create the row and queue `provision-number`; nothing on the request
 * path talks to the platform except the re-point in PATCH (one call) and the release in
 * DELETE — both read → platform → write with no transaction held open, both idempotent.
 *
 * Every read filters on `tenant_id` under RLS. A row id from another workspace is a 404
 * here and an empty result in Postgres; neither can be told apart from a random uuid.
 */
@Injectable()
export class NumbersService {
  private readonly log = new Logger(NumbersService.name);

  constructor(
    private readonly config: PlatformConfigService,
    private readonly queues: JobQueues,
    private readonly provisioning: NumberProvisioningService,
    private readonly runtimeCache: RuntimeCacheService,
    private readonly retell: RetellGateway,
    private readonly sip: SipCredentialsCipher,
    private readonly wallet: WalletService,
  ) {}

  async list(ctx: WorkspaceContext): Promise<PhoneNumberResponse[]> {
    return withWorkspace(ctx, async (db) => {
      const rows = await db.phoneNumber.findMany({ where: { tenantId: ctx.workspaceId }, orderBy: { createdAt: 'asc' }, include: WITH_PLAN_SIP });
      const counts = await this.calls7d(db, ctx, rows.map((r) => r.id));
      return rows.map((row) => toNumberResponse(row, counts.get(row.id) ?? 0));
    });
  }

  async get(ctx: WorkspaceContext, numberId: string): Promise<PhoneNumberResponse> {
    return withWorkspace(ctx, async (db) => {
      const row = await this.loadNumber(db, ctx, numberId);
      const counts = await this.calls7d(db, ctx, [row.id]);
      return toNumberResponse(row, counts.get(row.id) ?? 0);
    });
  }

  guide(carrier: Carrier, destination: string | null): ForwardingGuide {
    return forwardingGuideFor(carrier, destination);
  }

  /** Option A (and B, with `forward_from`) outside the wizard. */
  async buy(ctx: WorkspaceContext, input: BuyNumberRequest): Promise<NumberAccepted> {
    await this.assertMayProvision(ctx);
    // §5.3 rental from the published pricing config, not the column default: the D7
    // `number-rental` job charges this number, so it must be SA5's, not a constant.
    const { config: pricing } = await this.config.currentPricing();
    const row = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, input.agent_id);
      await this.assertUnderCap(db, ctx);
      const created = await db.phoneNumber.create({
        data: {
          tenantId: ctx.workspaceId,
          agentId: agent.id,
          type: 'retell_twilio',
          country: input.country,
          areaCode: input.area_code ?? null,
          tollFree: input.toll_free,
          nickname: input.nickname ?? null,
          inboundToken: newInboundToken(),
          rentalCredits: Math.round(pricing.recurring.number_rental_credits),
          hoursMode: input.hours_mode,
          hoursOverrideJson: input.hours_override ? (input.hours_override as Prisma.InputJsonValue) : Prisma.DbNull,
          transferTargetsJson: input.transfer_targets as unknown as Prisma.InputJsonValue,
          allowedCountries: input.allowed_countries,
          forwardingFrom: input.forward_from ?? null,
          forwardingStatus: input.forward_from ? 'waiting_for_customer' : null,
          carrier: input.forward_from ? (input.carrier ?? 'other') : null,
          status: 'provisioning',
        },
      });
      await this.audit(db, ctx, 'number.buy_requested', created.id, { agent_id: agent.id, country: input.country, area_code: input.area_code ?? null, toll_free: input.toll_free, forward_from: input.forward_from ?? null });
      return created;
    });
    return this.queueProvisioning(ctx, row);
  }

  /** Option C outside the wizard. The password is sealed before the row exists. */
  async import(ctx: WorkspaceContext, input: ImportNumberRequest): Promise<NumberAccepted> {
    const flags = await this.config.flagsFor(ctx.workspaceId);
    if (!flags.gates.sip_import) throw new AppError('PLAN_LIMIT', 'Bringing your own SIP trunk is available on higher plans.');
    if (!this.sip.configured) throw new AppError('NOT_CONFIGURED', 'SIP import is unavailable right now. We have been notified.');
    await this.assertMayProvision(ctx);

    const row = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, input.agent_id);
      await this.assertUnderCap(db, ctx);
      const clash = await db.phoneNumber.findFirst({ where: { e164: input.sip.number, status: { in: [...PROVISIONING_STATUSES] } }, select: { id: true } });
      if (clash) throw new AppError('NUMBER_IN_USE', 'That number is already attached to an agent.');

      // The plan row is where SIP credentials live (one place, one AAD), even off-wizard.
      const planId = crypto.randomUUID();
      const sealed = await this.sip.seal(planId, { number: input.sip.number, host: input.sip.host, username: input.sip.username, password: input.sip.password });
      const plan = await db.phonePlan.create({
        data: {
          id: planId,
          tenantId: ctx.workspaceId,
          agentId: agent.id,
          option: 'sip',
          sipJson: sealed as unknown as Prisma.InputJsonValue,
          hoursMode: input.hours_mode,
          transferTargetsJson: input.transfer_targets as unknown as Prisma.InputJsonValue,
          allowedCountries: input.allowed_countries,
          nickname: input.nickname ?? null,
          // Created executed: it is not the agent's W6 choice, it is this import's record.
          status: 'executed',
        },
      });
      const created = await db.phoneNumber.create({
        data: {
          tenantId: ctx.workspaceId,
          agentId: agent.id,
          planId: plan.id,
          type: 'custom_sip',
          e164: input.sip.number,
          nickname: input.nickname ?? null,
          inboundToken: newInboundToken(),
          rentalCredits: 0,
          hoursMode: input.hours_mode,
          hoursOverrideJson: input.hours_override ? (input.hours_override as Prisma.InputJsonValue) : Prisma.DbNull,
          transferTargetsJson: input.transfer_targets as unknown as Prisma.InputJsonValue,
          allowedCountries: input.allowed_countries,
          status: 'provisioning',
        },
      });
      await this.audit(db, ctx, 'number.import_requested', created.id, { agent_id: agent.id, host: input.sip.host, has_password: Boolean(input.sip.password) });
      return created;
    });
    return this.queueProvisioning(ctx, row);
  }

  /**
   * PATCH. Routing and labels change locally and refresh `num:{e164}`; a new `agent_id`
   * also re-points the platform binding (one call, outside the transaction). Provider
   * identity — `e164`, type, token — is not on the request shape at all.
   */
  async update(ctx: WorkspaceContext, numberId: string, patch: UpdateNumberRequest): Promise<PhoneNumberResponse> {
    const { row, repoint } = await withWorkspace(ctx, async (db) => {
      const current = await this.loadNumber(db, ctx, numberId);
      if (current.status === 'released' || current.status === 'releasing') throw new AppError('CONFLICT', 'This number has been released.');

      let repoint: { retellAgentId: string } | null = null;
      const data: Prisma.PhoneNumberUncheckedUpdateInput = {};
      if (patch.nickname !== undefined) data.nickname = patch.nickname;
      if (patch.hours_mode !== undefined) data.hoursMode = patch.hours_mode;
      if (patch.hours_override !== undefined) data.hoursOverrideJson = patch.hours_override ? (patch.hours_override as Prisma.InputJsonValue) : Prisma.DbNull;
      if (patch.transfer_targets !== undefined) data.transferTargetsJson = patch.transfer_targets as unknown as Prisma.InputJsonValue;
      if (patch.allowed_countries !== undefined) data.allowedCountries = patch.allowed_countries;
      if (patch.blocklist !== undefined) data.blocklist = patch.blocklist;
      if (patch.paused !== undefined) {
        data.pausedAt = patch.paused ? (current.pausedAt ?? new Date()) : null;
        if (current.status === 'active' || current.status === 'paused') data.status = patch.paused ? 'paused' : 'active';
      }
      if (patch.forwarding_confirmed !== undefined) {
        if (!current.forwardingFrom) throw new AppError('BAD_REQUEST', 'This number is not a forwarding destination.', [{ field: 'forwarding_confirmed', message: 'Not a forwarding number' }]);
        data.forwardingStatus = patch.forwarding_confirmed ? 'ready' : 'waiting_for_customer';
      }
      if (patch.agent_id !== undefined && patch.agent_id !== current.agentId) {
        const agent = await this.loadAgent(db, ctx, patch.agent_id);
        if (!agent.retellAgentId || agent.publishedVersion === null) {
          throw new AppError('BRIEF_INCOMPLETE', 'Publish that agent before pointing a number at it.', [{ field: 'agent_id', message: 'Agent is not published' }]);
        }
        data.agentId = agent.id;
        if (current.e164 && current.status !== 'provisioning') repoint = { retellAgentId: agent.retellAgentId };
      }

      const updated = await db.phoneNumber.update({ where: { id: current.id }, data, include: WITH_PLAN_SIP });
      await this.audit(db, ctx, 'number.updated', current.id, { fields: Object.keys(patch), agent_id: patch.agent_id ?? null, paused: patch.paused ?? null });
      const counts = await this.calls7d(db, ctx, [current.id]);
      return { row: { ...updated, calls7d: counts.get(current.id) ?? 0 }, repoint };
    });

    if (repoint && row.e164) {
      // Outside the transaction. If this fails the local row already names the new agent;
      // the next `bind` (or the customer's retry) converges the platform side.
      try {
        await this.retell.updatePhoneNumber(row.e164, { agentId: repoint.retellAgentId, numberToken: row.inboundToken });
      } catch (error) {
        this.log.error(`number ${row.id}: re-point on the platform failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not switch this number to the new agent just now. Try again in a moment.');
      }
    }
    await this.runtimeCache.refresh(ctx.workspaceId).catch((e: unknown) => this.log.warn(`runtime-cache refresh after number patch failed: ${String(e)}`));
    return toNumberResponse(row);
  }

  /** DELETE — releases on the platform first, then marks the row `released` (soft; calls reference it). */
  async remove(ctx: WorkspaceContext, numberId: string): Promise<{ released: boolean }> {
    await withWorkspace(ctx, async (db) => {
      const row = await this.loadNumber(db, ctx, numberId);
      const live = await db.call.count({ where: { numberId: row.id, tenantId: ctx.workspaceId, status: 'in_progress' } });
      if (live > 0) throw new AppError('NUMBER_IN_USE', 'This number is on a call right now. Try again when it ends.');
      await this.audit(db, ctx, 'number.release_requested', row.id, { e164: row.e164, status_before: row.status });
    });
    try {
      return await this.provisioning.release(numberId, ctx.workspaceId);
    } catch (error) {
      this.log.error(`number ${numberId}: release failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not release this number just now. It is no longer answering; try again in a moment to finish.');
    }
  }

  // ------------------------------------------------------------------ helpers

  private async queueProvisioning(ctx: WorkspaceContext, row: { id: string }): Promise<NumberAccepted> {
    const queued = await this.queues.enqueueProvisionNumber({ numberId: row.id, workspaceId: ctx.workspaceId, userId: ctx.userId });
    if (queued === 'failed') {
      await this.provisioning.markFailed(row.id, 'We could not start setting up this number. Try again in a moment.', 'enqueue failed').catch(() => undefined);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not start setting up this number. Try again in a moment.');
    }
    const fresh = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: row.id }, include: WITH_PLAN_SIP });
    this.log.log(`number ${row.id}: provisioning queued (${queued}) in workspace ${ctx.workspaceId}`);
    return { number: toNumberResponse(fresh), job_id: row.id };
  }

  /** §5.4: no phone number before the first purchase. Off-wizard buys check it here; the activation job checks it in `provision`. */
  private async assertMayProvision(ctx: WorkspaceContext): Promise<void> {
    const paid = await withWorkspace(ctx, (db) => db.purchase.count({ where: { tenantId: ctx.workspaceId, status: 'paid' } }));
    if (paid === 0) throw new AppError('NO_CREDITS', 'Buy a credit pack before adding a phone number.');
    const balance = await this.wallet.balance(ctx.workspaceId);
    if (balance <= 0) throw new AppError('NO_CREDITS', 'Top up your credits before adding a phone number.');
  }

  private async assertUnderCap(db: WorkspaceDb, ctx: WorkspaceContext): Promise<void> {
    const caps = await this.config.capsFor(ctx.workspaceId);
    const held = await db.phoneNumber.count({ where: { tenantId: ctx.workspaceId, status: { in: [...PROVISIONING_STATUSES] } } });
    if (held >= caps.max_numbers) {
      throw new AppError('PLAN_LIMIT', caps.max_numbers === 0 ? 'Your plan does not include a phone number yet.' : `Your plan includes ${caps.max_numbers} phone number${caps.max_numbers === 1 ? '' : 's'}. Upgrade to add another.`);
    }
  }

  /**
   * D4 "calls 7d": one grouped count for the numbers on the page, declined calls included.
   * Counted on `started_at` — when the call reached the number, which is what the column
   * says, and the column the `(number_id, started_at)` index covers; a row `created_at`
   * counts when we learned of it, which `call-recovery` can set days later.
   */
  private async calls7d(db: WorkspaceDb, ctx: WorkspaceContext, numberIds: string[]): Promise<Map<string, number>> {
    if (numberIds.length === 0) return new Map();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const groups = await db.call.groupBy({ by: ['numberId'], where: { tenantId: ctx.workspaceId, numberId: { in: numberIds }, startedAt: { gte: since } }, _count: { _all: true } });
    return new Map(groups.filter((g) => g.numberId).map((g) => [g.numberId as string, g._count._all]));
  }

  private async loadNumber(db: WorkspaceDb, ctx: WorkspaceContext, numberId: string) {
    const row = await db.phoneNumber.findFirst({ where: { id: numberId, tenantId: ctx.workspaceId }, include: WITH_PLAN_SIP });
    if (!row) throw AppError.notFound('Phone number');
    return row;
  }

  private async loadAgent(db: WorkspaceDb, ctx: WorkspaceContext, agentId: string) {
    const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null }, select: { id: true, retellAgentId: true, publishedVersion: true } });
    if (!agent) throw AppError.notFound('Agent');
    return agent;
  }

  private async audit(db: WorkspaceDb, ctx: WorkspaceContext, action: string, targetId: string, meta: Record<string, unknown>): Promise<void> {
    await db.auditLog.create({
      data: { tenantId: ctx.workspaceId, actorUserId: ctx.userId, action, targetType: 'phone_number', targetId, metaJson: meta as Prisma.InputJsonValue },
    });
  }
}
