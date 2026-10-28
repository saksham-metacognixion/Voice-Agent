import { Injectable, Logger } from '@nestjs/common';
import { Prisma, isUniqueViolation, withWorkspace, type WorkspaceDb } from '@portal/db';
import type { PhonePlanRequest, PhonePlanResponse } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { SipCredentialsCipher } from '../crypto';
import { toPlanResponse } from './number-response';

/**
 * W6 — `PUT /agents/:id/phone-plan` (§11, §13.8). The customer's number choice, captured
 * before payment and executed by the activation job after it.
 *
 * What the route decides now, so the activation job never fails for a reason the
 * customer could have been told on W6: the option is one the plan tier allows (`sip`
 * needs the `sip_import` gate; `port` is P3 and refused), the fields fit the option, and
 * a SIP password is sealed before the row is written. What it does *not* decide is
 * whether a paid purchase exists — W6 comes before W7 by design, and that check belongs
 * to the step that spends money (`ActivationWorker.provision`).
 *
 * One pending plan per agent, enforced by a partial unique index: a PUT replaces the
 * pending plan in place; an executed plan is history and stays.
 */
@Injectable()
export class PhonePlansService {
  private readonly log = new Logger(PhonePlansService.name);

  constructor(
    private readonly config: PlatformConfigService,
    private readonly sip: SipCredentialsCipher,
  ) {}

  async put(ctx: WorkspaceContext, agentId: string, input: PhonePlanRequest): Promise<PhonePlanResponse> {
    if (input.option === 'port') {
      throw new AppError('BAD_REQUEST', 'Porting a number in is not available yet. Forward your existing number instead.', [
        { field: 'option', message: 'port is not available' },
      ]);
    }
    const flags = await this.config.flagsFor(ctx.workspaceId);
    if (input.option === 'sip') {
      if (!flags.gates.sip_import) {
        throw new AppError('PLAN_LIMIT', 'Bringing your own SIP trunk is available on higher plans.', [{ field: 'option', message: 'sip_import gate is off' }]);
      }
      if (!this.sip.configured) {
        throw new AppError('NOT_CONFIGURED', 'SIP import is unavailable right now. We have been notified.');
      }
    }

    const row = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, agentId);
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { pausedAt: true } });
      if (tenant.pausedAt) throw new AppError('WORKSPACE_PAUSED', 'This workspace is paused. Contact support to continue.');

      const existing = await db.phonePlan.findFirst({ where: { agentId: agent.id, tenantId: ctx.workspaceId, status: 'pending' } });
      const planId = existing?.id;
      const data = await this.planData(ctx, agentId, input, planId);

      const saved = existing
        ? await db.phonePlan.update({ where: { id: existing.id }, data, include: { number: { select: { id: true } } } })
        : await this.createPlan(db, data);

      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: existing ? 'phone_plan.updated' : 'phone_plan.created',
          targetType: 'phone_plan',
          targetId: saved.id,
          ip: ctx.ip ?? null,
          metaJson: { agent_id: agentId, option: input.option, has_sip_password: input.option === 'sip' && Boolean(input.sip.password) } as Prisma.InputJsonValue,
        },
      });
      return saved;
    });

    this.log.log(`agent ${agentId}: phone plan ${row.id} set to ${input.option}`);
    return toPlanResponse(row);
  }

  async get(ctx: WorkspaceContext, agentId: string): Promise<PhonePlanResponse | null> {
    const row = await withWorkspace(ctx, async (db) => {
      await this.loadAgent(db, ctx, agentId);
      return db.phonePlan.findFirst({
        where: { agentId, tenantId: ctx.workspaceId },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], // pending sorts before executed
        include: { number: { select: { id: true } } },
      });
    });
    return row ? toPlanResponse(row) : null;
  }

  private async createPlan(db: WorkspaceDb, data: Prisma.PhonePlanUncheckedCreateInput) {
    try {
      return await db.phonePlan.create({ data, include: { number: { select: { id: true } } } });
    } catch (error) {
      // Two PUTs raced past the read; the partial unique index kept one. Update that one.
      if (!isUniqueViolation(error)) throw error;
      const winner = await db.phonePlan.findFirstOrThrow({ where: { agentId: data.agentId, status: 'pending' } });
      const { tenantId: _t, agentId: _a, ...rest } = data;
      return db.phonePlan.update({ where: { id: winner.id }, data: rest, include: { number: { select: { id: true } } } });
    }
  }

  /**
   * The row for one option. Fields of *other* options are reset to null so a customer
   * who switches from SIP to a bought number leaves no credentials behind.
   */
  private async planData(ctx: WorkspaceContext, agentId: string, input: Exclude<PhonePlanRequest, { option: 'port' }>, planId?: string): Promise<Prisma.PhonePlanUncheckedCreateInput> {
    const base: Prisma.PhonePlanUncheckedCreateInput = {
      tenantId: ctx.workspaceId,
      agentId,
      option: input.option,
      country: null,
      areaCode: null,
      tollFree: false,
      existingNumber: null,
      carrier: null,
      sipJson: Prisma.DbNull,
      nickname: input.nickname ?? null,
      hoursMode: input.hours_mode,
      hoursOverrideJson: input.hours_override ? (input.hours_override as Prisma.InputJsonValue) : Prisma.DbNull,
      transferTargetsJson: input.transfer_targets as unknown as Prisma.InputJsonValue,
      allowedCountries: input.allowed_countries,
      status: 'pending',
    };
    switch (input.option) {
      case 'new':
        return { ...base, country: input.country, areaCode: input.area_code ?? null, tollFree: input.toll_free };
      case 'forward':
        return { ...base, country: input.country, areaCode: input.area_code ?? null, existingNumber: input.existing_number, carrier: input.carrier };
      case 'sip': {
        // Sealed against the plan id it will live under. A new plan has no id yet, so it is
        // minted here and used for the row, which keeps the AAD and the primary key equal.
        const id = planId ?? crypto.randomUUID();
        const sealed = await this.sip.seal(id, { number: input.sip.number, host: input.sip.host, username: input.sip.username, password: input.sip.password });
        return { ...base, id, sipJson: sealed as unknown as Prisma.InputJsonValue };
      }
    }
  }

  private async loadAgent(db: WorkspaceDb, ctx: WorkspaceContext, agentId: string) {
    const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null }, select: { id: true } });
    if (!agent) throw AppError.notFound('Agent');
    return agent;
  }
}
