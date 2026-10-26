import { Injectable, Logger } from '@nestjs/common';
import { adminDb, withWorkspace } from '@portal/db';
import { ActivationEvents, type AcceptedJob, type ActivationView } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { EventsService } from '../events';
import { JOBS, JobQueues, JobRecordsService } from '../jobs';
import { initialSteps, parseSteps, toView } from './activation-state';

/**
 * §13.8 — the request half. Two ways in, one job:
 *
 *   POST /agents/:id/activate         W7 after Checkout returns, D3 "Go live"
 *   BillingService.onPurchaseCredited  the paid session carried `agent_id` (W7's flow)
 *
 * Both call `start()`, which creates the `jobs` row (type `activate-agent`) — or joins
 * the one already running for this agent, through the same partial unique index the
 * prompting jobs use — and enqueues `activate-<jobs.id>`. Nothing here touches the
 * platform; the worker does, one persisted step at a time.
 */
@Injectable()
export class ActivationService {
  private readonly log = new Logger(ActivationService.name);

  constructor(
    private readonly jobs: JobRecordsService,
    private readonly queues: JobQueues,
    private readonly events: EventsService,
  ) {}

  /** POST /agents/:id/activate. */
  async activate(ctx: WorkspaceContext, agentId: string, versionNo?: number): Promise<AcceptedJob> {
    const agent = await withWorkspace(ctx, async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { pausedAt: true } });
      if (tenant.pausedAt) throw new AppError('WORKSPACE_PAUSED', 'This workspace is paused. Contact support to go live.');
      const row = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null }, select: { id: true, draftVersion: true, publishedVersion: true } });
      if (!row) throw AppError.notFound('Agent');
      // The version the publish step will take, checked for a script now: every agent is
      // created with an empty draft v1, so "has a draft" said nothing, and an ungenerated
      // agent got a 202 and a job that could only fail at publish (QA-021).
      const wanted = versionNo ?? row.draftVersion ?? row.publishedVersion;
      const version = wanted
        ? await db.agentVersion.findUnique({ where: { agentId_versionNo: { agentId, versionNo: wanted } }, select: { promptText: true } })
        : null;
      if (wanted && !version) throw AppError.notFound(`Version ${wanted}`);
      if (!version?.promptText) throw new AppError('AGENT_NOT_GENERATED', 'Generate the agent before going live.');
      return row;
    });
    return this.start({ workspaceId: ctx.workspaceId, agentId: agent.id, userId: ctx.userId, versionNo });
  }

  /**
   * Creates or joins the activation job and queues it. Shared with the billing hook, so
   * it takes plain ids: the caller has already established the agent is the workspace's.
   */
  async start(input: { workspaceId: string; agentId: string; userId: string; versionNo?: number }): Promise<AcceptedJob> {
    const steps = initialSteps(input.agentId, { versionNo: input.versionNo, requestedBy: input.userId });
    let { jobId, joined } = await this.jobs.createOrJoin({ workspaceId: input.workspaceId, type: JOBS.activateAgent, agentId: input.agentId, steps });

    if (joined) {
      const lost = await this.jobs.reconcileIfLost(jobId);
      if (lost) {
        await this.announceLost(lost.workspaceId ?? input.workspaceId, lost.jobId, input.agentId);
        ({ jobId, joined } = await this.jobs.createOrJoin({ workspaceId: input.workspaceId, type: JOBS.activateAgent, agentId: input.agentId, steps }));
      }
    }
    if (joined) {
      this.log.log(`agent ${input.agentId}: activation already in flight as job ${jobId}`);
      return { job_id: jobId };
    }

    const payload = { jobId, workspaceId: input.workspaceId, agentId: input.agentId, userId: input.userId, versionNo: input.versionNo };
    await this.jobs.recordPayload(jobId, payload);
    const queued = await this.queues.enqueueActivation(payload);
    if (queued === 'failed') {
      await this.jobs.fail(jobId, 'Could not queue the activation job.', { ...steps, activation_status: 'failed', customer_reason: NOT_QUEUED }, 0);
      throw new AppError('UPSTREAM_UNAVAILABLE', NOT_QUEUED);
    }
    this.log.log(`agent ${input.agentId}: activation queued as job ${jobId} (${queued})`);
    return { job_id: jobId };
  }

  /** GET /agents/:id/activation — the newest activation of this agent, or 404 when there is none. */
  async latest(ctx: WorkspaceContext, agentId: string): Promise<ActivationView> {
    const row = await withWorkspace(ctx, async (db) => {
      const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId }, select: { id: true } });
      if (!agent) throw AppError.notFound('Agent');
      return db.job.findFirst({
        where: { tenantId: ctx.workspaceId, type: JOBS.activateAgent, stepsJson: { path: ['agent_id'], equals: agentId } },
        orderBy: { createdAt: 'desc' },
      });
    });
    if (!row) throw AppError.notFound('Activation');
    return toView(parseSteps(row.stepsJson, agentId), row);
  }

  /** GET /activations/:id — one activation by job id, workspace-scoped. */
  async get(ctx: WorkspaceContext, jobId: string): Promise<ActivationView> {
    const row = await withWorkspace(ctx, (db) => db.job.findFirst({ where: { id: jobId, tenantId: ctx.workspaceId, type: JOBS.activateAgent } }));
    if (!row) throw AppError.notFound('Activation');
    const steps = parseSteps(row.stepsJson, '');
    return toView(steps, row);
  }

  private async announceLost(workspaceId: string, jobId: string, agentId: string): Promise<void> {
    const row = await adminDb.job.findUnique({ where: { id: jobId } });
    if (!row) return;
    await this.events
      .publish(workspaceId, ActivationEvents.topic(jobId), ActivationEvents.failed, toView(parseSteps(row.stepsJson, agentId), row))
      .catch(() => null);
  }
}

const NOT_QUEUED = 'We could not start putting your agent live just now. Try again in a moment.';
