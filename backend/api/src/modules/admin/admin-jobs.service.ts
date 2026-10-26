import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type { AdminJobResponse, AdminJobsQuery, Page, StaffActionRequest } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import { JOBS, JobQueues, type ActivationJob, type PromptingJob, queueOfJobType } from '../jobs';
import { iso, record, uuidParam } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';

const WITH = { tenant: { select: { name: true } } } satisfies Prisma.JobInclude;
type Row = Prisma.JobGetPayload<{ include: typeof WITH }>;

/** How much of `steps_json` a list row carries; the detail carries it all. */
const STEP_KEYS_IN_LIST = [
  'agent_id',
  'mode',
  'customer_reason',
  'activation_status',
  'step',
  'attempt',
  'error_kind',
  'queued',
];

/**
 * SA12 "Jobs" (D12 §10): every `jobs` row, what the queue says about it, and the two
 * staff actions. Retry re-enqueues the payload the row was created with (`payload_json`)
 * under the same deterministic BullMQ id, so a customer polling `GET /jobs/:id` sees the
 * same job come back to life; `JobQueues.add(..., verify)` replaces the spent failed job
 * that holds the id. Discard writes the row off with a customer-safe reason and drops
 * whatever the queue still holds, so the partial unique index stops joining it.
 */
@Injectable()
export class AdminJobsService {
  private readonly log = new Logger(AdminJobsService.name);

  constructor(
    private readonly queues: JobQueues,
    private readonly audit: StaffAuditService,
  ) {}

  async list(query: AdminJobsQuery): Promise<Page<AdminJobResponse>> {
    const where: Prisma.JobWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.tenant_id) where.tenantId = query.tenant_id;
    const rows = await adminDb.job.findMany({
      where,
      include: WITH,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    const items = await Promise.all(page.items.map((r) => this.toResponse(r, false)));
    return { ...page, items };
  }

  async get(idRaw: string): Promise<AdminJobResponse> {
    const id = uuidParam(idRaw, 'Job');
    const row = await adminDb.job.findUnique({ where: { id }, include: WITH });
    if (!row) throw AppError.notFound('Job');
    return this.toResponse(row, true);
  }

  async retry(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminJobResponse> {
    const id = uuidParam(idRaw, 'Job');
    const row = await adminDb.job.findUnique({ where: { id }, include: WITH });
    if (!row) throw AppError.notFound('Job');
    if (row.status !== 'failed')
      throw new AppError(
        'CONFLICT',
        `Only a failed job can be retried; this one is ${row.status}.`,
      );
    const queue = queueOfJobType(row.type);
    const payload = row.payloadJson as Record<string, unknown> | null;
    if (!queue || !payload)
      throw new AppError('CONFLICT', 'This job type cannot be retried from the console.');
    if (row.tenantId) {
      const tenant = await adminDb.tenant.findUnique({
        where: { id: row.tenantId },
        select: { pausedAt: true },
      });
      if (tenant?.pausedAt)
        throw new AppError(
          'WORKSPACE_PAUSED',
          'The workspace is paused; resume it before retrying its jobs.',
        );
    }

    // Re-open the row first: the partial unique index guarantees one active job per
    // (agent, type), so a customer who started a fresh one meanwhile collides here. The
    // row and its audit row commit together; the enqueue that follows cannot join a
    // transaction, so a refused enqueue is reverted and recorded as its own row.
    try {
      await adminDb.$transaction(async (tx) => {
        await tx.job.update({
          where: { id },
          data: {
            status: 'queued',
            error: null,
            stepsJson: {
              ...record(row.stepsJson),
              retried_by_staff_at: new Date().toISOString(),
              retries: Number(record(row.stepsJson).retries ?? 0) + 1,
            } as Prisma.InputJsonValue,
          },
        });
        await this.audit.record(
          {
            staff,
            action: 'job.retried',
            targetType: 'job',
            targetId: id,
            tenantId: row.tenantId,
            reasonCode: body.reason_code,
            note: body.note,
            before: { status: 'failed', error: row.error },
            after: { status: 'queued' },
            request,
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AppError(
          'CONFLICT',
          'The customer already has a newer job of this type in flight.',
        );
      throw error;
    }
    const outcome =
      row.type === JOBS.activateAgent
        ? await this.queues.enqueueActivation(payload as unknown as ActivationJob)
        : await this.queues.enqueuePrompting(payload as unknown as PromptingJob);
    if (outcome === 'failed') {
      await adminDb.$transaction(async (tx) => {
        await tx.job.update({
          where: { id },
          data: { status: 'failed', error: row.error, stepsJson: row.stepsJson ?? Prisma.DbNull },
        });
        await this.audit.record(
          {
            staff,
            action: 'job.retry_failed',
            targetType: 'job',
            targetId: id,
            tenantId: row.tenantId,
            reasonCode: body.reason_code,
            before: { status: 'queued' },
            after: { status: 'failed', enqueue: outcome },
            request,
          },
          tx,
        );
      });
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'The queue did not accept the job. Nothing changed; try again in a moment.',
      );
    }
    this.log.log(`job ${id} (${row.type}) retried by ${staff.email}: ${outcome}`);
    return this.get(id);
  }

  async discard(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminJobResponse> {
    const id = uuidParam(idRaw, 'Job');
    const row = await adminDb.job.findUnique({ where: { id }, include: WITH });
    if (!row) throw AppError.notFound('Job');
    if (row.status === 'succeeded')
      throw new AppError('CONFLICT', 'A succeeded job cannot be discarded.');
    const queue = queueOfJobType(row.type);
    if (queue) {
      const state = await this.queues.stateOf(queue.queue, queue.bullId(id));
      if (state === 'active')
        throw new AppError(
          'CONFLICT',
          'This job is running right now; wait for it to finish or fail.',
        );
      if (state === 'unknown')
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          'The queue did not answer; try again in a moment.',
        );
      if (state !== 'missing') {
        // The request is on record before the queue is touched, and a removal that fails is
        // a failure, not a success with a log line (QA-038): a job left in the queue would
        // still run while the row and the console said "discarded".
        const audit = { staff, targetType: 'job', targetId: id, tenantId: row.tenantId, reasonCode: body.reason_code, note: body.note, request } as const;
        await this.audit.record({ ...audit, action: 'job.discard_requested', before: { status: row.status, queue_state: state } });
        try {
          const job = await this.queues.queue(queue.queue).getJob(queue.bullId(id));
          await job?.remove();
        } catch (error) {
          this.log.warn(`discard ${id}: could not remove queue job (${String(error)})`);
          await this.audit.record({ ...audit, action: 'job.discard_failed', after: { error: 'queue job could not be removed' } });
          throw new AppError(
            'CONFLICT',
            'The job could not be taken off the queue — it may have just started. Nothing was discarded; check its state and try again.',
          );
        }
      }
    }
    const steps = {
      ...record(row.stepsJson),
      discarded_by_staff_at: new Date().toISOString(),
      customer_reason: 'This job was cancelled by support. Start it again when you are ready.',
    };
    await adminDb.$transaction(async (tx) => {
      await tx.job.update({
        where: { id },
        data: {
          status: 'failed',
          error: `discarded by staff (${body.reason_code})`,
          stepsJson: steps as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(
        {
          staff,
          action: 'job.discarded',
          targetType: 'job',
          targetId: id,
          tenantId: row.tenantId,
          reasonCode: body.reason_code,
          note: body.note,
          before: { status: row.status },
          after: { status: 'failed' },
          request,
        },
        tx,
      );
    });
    this.log.warn(`job ${id} (${row.type}) discarded by ${staff.email} (${body.reason_code})`);
    return this.get(id);
  }

  private async toResponse(r: Row, full: boolean): Promise<AdminJobResponse> {
    const steps = record(r.stepsJson);
    const queue = queueOfJobType(r.type);
    const queueState =
      queue && (r.status === 'queued' || r.status === 'running' || r.status === 'failed')
        ? await this.queues.stateOf(queue.queue, queue.bullId(r.id), 300)
        : null;
    const attempts =
      Number(steps.attempt ?? steps.attempts ?? 0) || (r.status === 'queued' ? 0 : 1);
    const shown = full
      ? steps
      : Object.fromEntries(Object.entries(steps).filter(([k]) => STEP_KEYS_IN_LIST.includes(k)));
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      tenant_id: r.tenantId,
      tenant_name: r.tenant?.name ?? null,
      agent_id: typeof steps.agent_id === 'string' ? steps.agent_id : null,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
      started_at:
        typeof steps.started_at === 'string'
          ? steps.started_at
          : r.status === 'queued'
            ? null
            : iso(r.updatedAt),
      finished_at:
        r.status === 'succeeded' || r.status === 'failed' ? r.updatedAt.toISOString() : null,
      attempts,
      queue_state: queueState,
      error: r.error,
      customer_reason: typeof steps.customer_reason === 'string' ? steps.customer_reason : null,
      can_retry: r.status === 'failed' && Boolean(queue) && r.payloadJson !== null,
      can_discard: r.status !== 'succeeded',
      steps: shown,
    };
  }
}
