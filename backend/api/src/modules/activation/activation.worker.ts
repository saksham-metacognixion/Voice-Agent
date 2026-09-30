import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Prisma, adminDb } from '@portal/db';
import { ActivationEvents, type ActivationStep } from '@portal/schemas';
import { AgentEvents, AgentPublishService } from '../agents';
import { OpsAlertService } from '../alerts';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { EventsService } from '../events';
import { type ActivationJob, JobRecordsService } from '../jobs';
import { NumberProvisioningService, ProvisioningError, classifyError, newInboundToken } from '../numbers';
import { RuntimeCacheService } from '../runtime-cache';
import { WalletService } from '../wallet';
import { failActiveSpan, reportError } from '../../observability';
import {
  type ActivationSteps,
  beginStep,
  completeStep,
  failStep,
  markLive,
  nextStep,
  parseSteps,
  skipStep,
  toView,
} from './activation-state';

/**
 * §13.8 — the worker half.
 *
 *     publish → provision → bind → mark_live → notify
 *
 * A durable workflow, not a transaction: each step is read → (platform) → write, its
 * outcome is persisted in `jobs.steps_json` before the next step starts, and a run
 * resumes at the first step that is not `completed`. So a worker that dies after buying
 * the number and before binding it comes back, finds `provision: completed` with the
 * number id, and binds — it does not buy again. The steps themselves are idempotent
 * underneath (`AgentPublishService.publish` returns `already_published`,
 * `NumberProvisioningService` looks before it buys), which is what makes a *duplicate
 * delivery* of the same job — BullMQ after a stall — converge too.
 *
 * Retries: three attempts (`ACTIVATION_JOB_OPTIONS`), and only for failures classified
 * retryable. A lint failure, a missing plan, no paid purchase, a platform 4xx: those end
 * the job on the first attempt with a reason the customer can act on. After the last
 * attempt the workflow is `failed`, the number row (if one was created) is `failed`, the
 * customer's stream gets one `failed` frame and operations get one alert. The agent is
 * never marked live before `bind` has completed.
 */
type PendingPlan = Prisma.PhonePlanGetPayload<{ include: { number: true } }>;

@Injectable()
export class ActivationWorker {
  private readonly log = new Logger(ActivationWorker.name);

  constructor(
    private readonly jobs: JobRecordsService,
    private readonly publishing: AgentPublishService,
    private readonly numbers: NumberProvisioningService,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly runtimeCache: RuntimeCacheService,
    private readonly events: EventsService,
    private readonly alerts: OpsAlertService,
  ) {}

  async run(job: Job<ActivationJob>): Promise<{ outcome: string; reason?: string }> {
    const data = job.data;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    const running = await this.jobs.markRunning(data.jobId);
    if (!running) return { outcome: 'ignored', reason: 'job already finished' };

    const row = await adminDb.job.findUniqueOrThrow({ where: { id: data.jobId } });
    if (row.tenantId !== data.workspaceId) {
      await this.jobs.fail(data.jobId, 'workspace mismatch between job row and payload', { agent_id: data.agentId, activation_status: 'failed' }, 0);
      return { outcome: 'ignored', reason: 'workspace mismatch' };
    }
    let state: ActivationSteps = { ...parseSteps(row.stepsJson, data.agentId), attempt, max_attempts: maxAttempts };
    if (attempt === 1) await this.publish(data, ActivationEvents.started, state, row);

    let step: ActivationStep | null = nextStep(state);
    try {
      while (step) {
        state = await this.save(data.jobId, beginStep(state, step));
        await this.publish(data, ActivationEvents.progress, state, row);
        state = await this.runStep(step, data, state);
        state = await this.save(data.jobId, state);
        step = nextStep(state);
      }

      state = await this.save(data.jobId, markLive(state));
      await this.jobs.succeed(data.jobId, state as unknown as Record<string, unknown>);
      await this.publish(data, ActivationEvents.live, state, row);
      this.log.log(`agent ${data.agentId}: LIVE on ${state.e164 ?? 'its existing number'} (activation ${data.jobId}, attempt ${attempt})`);
      return { outcome: 'live' };
    } catch (raw) {
      const error = classifyError(raw);
      const failedStep = step ?? 'notify';
      const willRetry = error.retryable && attempt < maxAttempts;
      // Resume from what was *persisted*, not from this frame's copy: a step saves facts
      // (the number row it created) before the call that then throws, and those facts are
      // what the retry and the failure clean-up need. The row is the state; this is why.
      const persisted = await adminDb.job.findUnique({ where: { id: data.jobId }, select: { stepsJson: true } });
      if (persisted) state = { ...parseSteps(persisted.stepsJson, data.agentId), attempt, max_attempts: maxAttempts };
      state = await this.save(data.jobId, failStep(state, failedStep, { kind: error.kind, detail: error.message, customerReason: error.customerReason }, !willRetry));
      await this.jobs.fail(data.jobId, `${failedStep}: ${error.kind}: ${error.message}`, state as unknown as Record<string, unknown>, willRetry ? maxAttempts - attempt : 0);
      this.log.error(`agent ${data.agentId}: activation ${data.jobId} step ${failedStep} failed on attempt ${attempt}/${maxAttempts} (${error.kind}: ${error.message}); ${willRetry ? 'retrying' : 'FAILED'}`);

      if (willRetry) throw error;

      await this.finaliseFailure(data, state, failedStep, error, attempt, row);
      return { outcome: 'failed', reason: `${failedStep}: ${error.kind}` };
    }
  }

  // ------------------------------------------------------------------ steps

  private async runStep(step: ActivationStep, data: ActivationJob, state: ActivationSteps): Promise<ActivationSteps> {
    switch (step) {
      case 'publish':
        return this.stepPublish(data, state);
      case 'provision':
        return this.stepProvision(data, state);
      case 'bind':
        return this.stepBind(data, state);
      case 'mark_live':
        return this.stepMarkLive(data, state);
      case 'notify':
        return this.stepNotify(data, state);
    }
  }

  /** §13.6 through the same service the route uses: leased, linted, idempotent. */
  private async stepPublish(data: ActivationJob, state: ActivationSteps): Promise<ActivationSteps> {
    const ctx = this.ctx(data);
    const result = await this.publishing.publish(ctx, data.agentId, data.versionNo ?? state.version_no);
    return completeStep(state, 'publish', { version_no: result.version_no, already_published: result.already_published, lint_warnings: result.lint.findings.length });
  }

  /**
   * Finds or creates the `phone_numbers` row for the agent's pending plan and provisions
   * it. Guards that spend money are here, not on W6: a paid purchase must exist (§5.4,
   * "no phone number before first purchase") and the plan's number cap must not be hit.
   * An agent that already has an active number and no pending plan skips the two number
   * steps: this activation is a republish, not a first go-live.
   */
  private async stepProvision(data: ActivationJob, state: ActivationSteps): Promise<ActivationSteps> {
    const existingId = typeof state.number_id === 'string' ? state.number_id : null;
    let numberId = existingId;

    if (!numberId) {
      const found = await this.locateNumber(data);
      if (found.kind === 'active') {
        // Nothing to buy: the plan was executed by an earlier activation.
        return skipStep(completeStepFacts(state, { number_id: found.number.id, e164: found.number.e164, forwarding_from: found.number.forwardingFrom, forwarding_status: found.number.forwardingStatus }), 'provision', 'agent already has an active number');
      }
      if (found.kind === 'none') {
        throw new ProvisioningError('no_plan', 'Choose a phone number option before going live.', `agent ${data.agentId} has no pending phone plan and no active number`);
      }
      await this.assertBillingState(data.workspaceId);
      numberId = found.kind === 'row' ? await this.refreshNumberRow(found.plan, found.number) : await this.createNumberRow(data, found.plan);
      state = completeStepFacts(state, { number_id: numberId });
      await this.save(data.jobId, state);
    }

    const outcome = await this.numbers.provision(numberId, data.workspaceId);
    const number = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: numberId }, select: { forwardingFrom: true, forwardingStatus: true } });
    return completeStep(
      completeStepFacts(state, { number_id: numberId, e164: outcome.e164, forwarding_from: number.forwardingFrom, forwarding_status: number.forwardingStatus }),
      'provision',
      { number_id: numberId, e164: outcome.e164, already_provisioned: outcome.alreadyProvisioned },
    );
  }

  private async stepBind(data: ActivationJob, state: ActivationSteps): Promise<ActivationSteps> {
    if (state.steps.provision?.status === 'skipped') return skipStep(state, 'bind', 'number already bound');
    const numberId = typeof state.number_id === 'string' ? state.number_id : null;
    if (!numberId) throw new ProvisioningError('number_missing', 'The number was not provisioned.', 'bind reached without a number id');
    const bound = await this.numbers.bind(numberId, data.workspaceId);
    return completeStep(state, 'bind', { e164: bound.e164, updated_binding: bound.updated });
  }

  /**
   * The authoritative state change, and the only place activation writes `agents.status`:
   * live — unless staff paused the agent, which publishing respects too (ADR 0012 §4).
   * The plan becomes `executed`, onboarding completes, and the runtime cache is refreshed
   * so the §13.9 hot path answers for this number on the next ring.
   */
  private async stepMarkLive(data: ActivationJob, state: ActivationSteps): Promise<ActivationSteps> {
    const numberId = typeof state.number_id === 'string' ? state.number_id : null;
    const result = await adminDb.$transaction(async (tx) => {
      const agent = await tx.agent.findFirstOrThrow({ where: { id: data.agentId, tenantId: data.workspaceId } });
      if (agent.deletedAt) throw new ProvisioningError('agent_missing', 'This agent no longer exists.', 'agent was deleted during activation');
      if (agent.publishedVersion === null) throw new ProvisioningError('not_published', 'The agent is not published.', 'mark_live reached with published_version null');
      if (numberId) {
        const number = await tx.phoneNumber.findFirstOrThrow({ where: { id: numberId, tenantId: data.workspaceId } });
        if (number.status !== 'active' && number.status !== 'paused') {
          throw new ProvisioningError('number_missing', 'The number is not ready.', `mark_live reached with number ${numberId} ${number.status}`);
        }
      }
      const status = agent.status === 'paused' ? 'paused' : 'live';
      await tx.agent.update({ where: { id: agent.id }, data: { status } });
      const plans = await tx.phonePlan.updateMany({ where: { agentId: agent.id, tenantId: data.workspaceId, status: 'pending', ...(numberId ? { number: { id: numberId } } : {}) }, data: { status: 'executed' } });
      await tx.tenant.updateMany({ where: { id: data.workspaceId, onboardingCompletedAt: null }, data: { onboardingCompletedAt: new Date(), onboardingStep: 7 } });
      await tx.auditLog.create({
        data: {
          tenantId: data.workspaceId,
          actorUserId: data.userId,
          action: 'agent.activated',
          targetType: 'agent',
          targetId: agent.id,
          metaJson: { activation_id: data.jobId, number_id: numberId, e164: state.e164 ?? null, version_no: agent.publishedVersion, status, plans_executed: plans.count } as Prisma.InputJsonValue,
        },
      });
      return { status, versionNo: agent.publishedVersion, plansExecuted: plans.count };
    });
    await this.runtimeCache.refresh(data.workspaceId).catch((e: unknown) => this.log.warn(`runtime-cache refresh after mark_live failed: ${String(e)}`));
    return completeStep(state, 'mark_live', { agent_status: result.status, version_no: result.versionNo, plans_executed: result.plansExecuted });
  }

  /** The agent's own stream learns it is live; the activation stream gets its `live` frame from `run()`. */
  private async stepNotify(data: ActivationJob, state: ActivationSteps): Promise<ActivationSteps> {
    await this.events
      .publish(data.workspaceId, AgentEvents.topic(data.agentId), 'activated', { agent_id: data.agentId, activation_id: data.jobId, number_id: state.number_id ?? null, e164: state.e164 ?? null })
      .catch(() => null);
    return completeStep(state, 'notify', { channels: ['sse'] });
  }

  // ------------------------------------------------------------------ helpers

  private ctx(data: ActivationJob): WorkspaceContext {
    return { userId: data.userId ?? '', workspaceId: data.workspaceId, role: 'owner' };
  }

  private async locateNumber(data: ActivationJob) {
    const plan = await adminDb.phonePlan.findFirst({ where: { agentId: data.agentId, tenantId: data.workspaceId, status: 'pending' }, include: { number: true } });
    if (plan?.number) return { kind: 'row' as const, plan, number: plan.number };
    if (plan) return { kind: 'plan' as const, plan };
    const active = await adminDb.phoneNumber.findFirst({ where: { agentId: data.agentId, tenantId: data.workspaceId, status: { in: ['active', 'paused'] } } });
    if (active) return { kind: 'active' as const, number: active };
    return { kind: 'none' as const };
  }

  private async assertBillingState(workspaceId: string): Promise<void> {
    const [paid, balance, caps, held] = await Promise.all([
      adminDb.purchase.count({ where: { tenantId: workspaceId, status: 'paid' } }),
      this.wallet.balance(workspaceId),
      this.config.capsFor(workspaceId),
      adminDb.phoneNumber.count({ where: { tenantId: workspaceId, status: { in: ['provisioning', 'active', 'paused'] } } }),
    ]);
    if (paid === 0) throw new ProvisioningError('no_purchase', 'Buy a credit pack before going live on a phone number.', `workspace ${workspaceId} has no paid purchase`);
    if (balance <= 0) throw new ProvisioningError('no_purchase', 'Top up your credits before going live on a phone number.', `workspace ${workspaceId} balance is ${balance}`);
    if (held >= caps.max_numbers) {
      throw new ProvisioningError('plan_limit', `Your plan includes ${caps.max_numbers} phone number${caps.max_numbers === 1 ? '' : 's'}. Release one or upgrade to add another.`, `workspace ${workspaceId} holds ${held} numbers, cap ${caps.max_numbers}`);
    }
  }

  /**
   * The `phone_numbers` row for a plan. `plan_id` is unique, so two runs cannot create two.
   *
   * The monthly rental comes from `pricing_configs.recurring.number_rental_credits` (§5.3),
   * never from a constant here — a rental the D7 `number-rental` job then charges has to be
   * the number SA5 published, not one compiled in (CLAUDE.md, Configuration). BYO SIP is 0.
   */
  private async createNumberRow(data: ActivationJob, plan: PendingPlan): Promise<string> {
    try {
      const row = await adminDb.phoneNumber.create({
        data: {
          tenantId: data.workspaceId,
          agentId: data.agentId,
          planId: plan.id,
          inboundToken: newInboundToken(),
          ...(await this.numberFieldsOf(plan)),
          status: 'provisioning',
        },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      // Lost the race with a duplicate delivery of this very job: adopt its row.
      const existing = await adminDb.phoneNumber.findUnique({ where: { planId: plan.id }, select: { id: true } });
      if (existing) return existing.id;
      throw error;
    }
  }

  /**
   * A failed activation leaves its row behind (`plan_id` is unique), and a retry finds it.
   * When nothing was ever provisioned for it — no e164 yet, so the platform holds nothing
   * we know of — the row is re-cut from the plan as it is *now*: a customer who hit "no
   * numbers in area code 236" and chose another on W6 must not be sent back for 236 on
   * every retry (30 Sep). A row with an e164 is left alone; that number exists. The
   * nickname lookup in `buy` still adopts one a lost answer bought under the old choice.
   */
  private async refreshNumberRow(plan: PendingPlan, number: NonNullable<PendingPlan['number']>): Promise<string> {
    if (number.e164 || (number.status !== 'provisioning' && number.status !== 'failed')) return number.id;
    await adminDb.phoneNumber.updateMany({
      where: { id: number.id, e164: null, status: { in: ['provisioning', 'failed'] } },
      data: { ...(await this.numberFieldsOf(plan)), status: 'provisioning', error: null },
    });
    return number.id;
  }

  /** What a number row copies from its plan. SIP carries its E.164 from the sealed details. */
  private async numberFieldsOf(plan: PendingPlan) {
    const isSip = plan.option === 'sip';
    const { config: pricing } = await this.config.currentPricing();
    const sipNumber = isSip && plan.sipJson && typeof plan.sipJson === 'object' ? (plan.sipJson as { number?: string }).number ?? null : null;
    return {
      type: isSip ? ('custom_sip' as const) : ('retell_twilio' as const),
      e164: sipNumber,
      nickname: plan.nickname,
      country: plan.country,
      areaCode: plan.areaCode,
      tollFree: plan.tollFree,
      rentalCredits: isSip ? 0 : Math.round(pricing.recurring.number_rental_credits),
      hoursMode: plan.hoursMode,
      hoursOverrideJson: plan.hoursOverrideJson ?? Prisma.DbNull,
      transferTargetsJson: plan.transferTargetsJson ?? Prisma.DbNull,
      allowedCountries: plan.allowedCountries,
      forwardingFrom: plan.option === 'forward' ? plan.existingNumber : null,
      forwardingStatus: plan.option === 'forward' ? ('waiting_for_customer' as const) : null,
      carrier: plan.option === 'forward' ? plan.carrier : null,
    };
  }

  private async save(jobId: string, state: ActivationSteps): Promise<ActivationSteps> {
    await adminDb.job.update({ where: { id: jobId }, data: { stepsJson: state as unknown as Prisma.InputJsonValue } });
    return state;
  }

  private async publish(data: ActivationJob, type: string, state: ActivationSteps, row: { id: string; createdAt: Date }): Promise<void> {
    const view = toView(state, { id: row.id, status: state.activation_status === 'failed' ? 'failed' : 'running', createdAt: row.createdAt, updatedAt: new Date() });
    await this.events.publish(data.workspaceId, ActivationEvents.topic(data.jobId), type, view).catch(() => null);
  }

  private async finaliseFailure(data: ActivationJob, state: ActivationSteps, step: ActivationStep, error: ProvisioningError, attempts: number, row: { id: string; createdAt: Date }): Promise<void> {
    const numberId = typeof state.number_id === 'string' ? state.number_id : null;
    if (numberId && (step === 'provision' || step === 'bind')) {
      // The row was created for this activation; a bought number that *was* provisioned
      // keeps its e164 so support can see exactly what the platform holds.
      await this.numbers.markFailed(numberId, error.customerReason, `${step}: ${error.kind}: ${error.message}`).catch(() => undefined);
      await this.runtimeCache.refresh(data.workspaceId).catch(() => undefined);
    }
    await this.publish(data, ActivationEvents.failed, state, row);
    // The handler returns after this, so BullMQ records success: neither the worker's
    // final-attempt report nor `inSpan` sees the failure unless it is reported here.
    failActiveSpan(error);
    reportError(error, {
      tags: { queue: 'provisioning', job: 'activate-agent', failed_step: step, error_kind: error.kind },
      extra: { workspace_id: data.workspaceId, agent_id: data.agentId, activation_job_id: data.jobId, attempts, retryable: error.retryable, number_id: numberId, platform_status: error.options.status ?? null },
    });
    await this.alerts.send({
      kind: 'activation_failed',
      severity: 'critical',
      title: `Agent activation failed after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
      fields: {
        workspace_id: data.workspaceId,
        agent_id: data.agentId,
        activation_job_id: data.jobId,
        failed_step: step,
        attempts,
        error_kind: error.kind,
        retryable: error.retryable,
        error: error.message,
        number_id: numberId,
        e164: typeof state.e164 === 'string' ? state.e164 : null,
        platform_status: error.options.status ?? null,
      },
    });
  }
}

/** Adds top-level facts (number id, e164, forwarding) without touching a step record. */
function completeStepFacts(state: ActivationSteps, facts: Partial<ActivationSteps>): ActivationSteps {
  return { ...state, ...facts };
}
