import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, isUniqueViolation, withWorkspace } from '@portal/db';
import { type JobProgress, type JobResponse, jobProgress as jobProgressSchema } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { JobQueues, type QueueJobState, queueOfJobType } from './job-queues.service';

/**
 * A queued or running row untouched for this long is checked against the queue. Long
 * enough that the API's create-row-then-enqueue window (milliseconds) can never be
 * mistaken for a dead job, short enough that a customer is not left on a spinner.
 */
export const STALE_JOB_AFTER_MS = 60_000;
/** The same check, applied when a request is about to *join* an in-flight job. */
export const JOIN_GRACE_MS = 30_000;

/** What the customer reads for a job the sweeper wrote off. */
export const LOST_JOB_REASON = 'This job was interrupted before it finished. Your brief is saved — try again.';

/** A queue state that means "nobody will ever run this job again". */
const LOST_STATES = new Set<QueueJobState>(['missing', 'completed', 'failed']);

export interface LostJob {
  jobId: string;
  workspaceId: string | null;
  agentId: string | null;
  type: string;
  /** What BullMQ said about the job's id when the row was written off. */
  queueState: QueueJobState;
}

/**
 * The `jobs` table (§15) — the customer-visible half of a long operation.
 *
 * §16: "Long operations return `202 {job_id}`; the client subscribes to SSE and falls back
 * to `GET /jobs/:id` every 3 s." Two things follow, and they are why this is a row in
 * Postgres and not a BullMQ lookup:
 *
 *   - the client needs an answer after a reconnect, a page reload, or a worker restart,
 *     and BullMQ removes completed jobs on a timer;
 *   - the row is workspace-scoped, so RLS answers "is this your job?" rather than a
 *     service remembering to check.
 *
 * `steps_json` is the job's own progress ledger (`{provider, latency_ms, version_id, …}`).
 * The worker writes it as it goes, which is what makes a retried job able to skip work it
 * already finished — see the generation worker's use of `version_id`. It is **internal**:
 * it names the provider, the model, the Retell sync and whatever an SDK put in an error.
 * `get()` hands the customer an explicit whitelist built from it, never the ledger.
 *
 * Rows that die are reconciled, not abandoned. A worker killed mid-generation leaves the
 * row `running` while BullMQ has already lost, retried or failed the job; and
 * `jobs_one_active_per_target_idx` would then make every later request *join* that dead
 * row forever. `reconcileStale` (the `job-sweeper` schedule) and `reconcileIfLost` (the
 * join path) ask the queue what became of the job and write the row off only when the
 * queue says nothing will ever run it again.
 */
@Injectable()
export class JobRecordsService {
  private readonly log = new Logger(JobRecordsService.name);

  constructor(private readonly queues: JobQueues) {}

  /** Creates a queued row. Runs on `adminDb`: callers are routes *and* jobs. */
  async create(input: { workspaceId: string; type: string; steps?: Record<string, unknown> }): Promise<string> {
    const row = await adminDb.job.create({
      data: {
        tenantId: input.workspaceId,
        type: input.type,
        status: 'queued',
        stepsJson: (input.steps ?? {}) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Creates the job, or hands back the one already doing this work.
   *
   * The guarantee is `jobs_one_active_per_target_idx`, a partial unique index on
   * `(steps_json->>'agent_id', type) WHERE status IN ('queued','running')`. Two requests
   * that both got past a `findActive` read — the classic check-then-act race, and the one
   * that costs a customer two generations — collide in Postgres instead, and the loser
   * reads back the winner's id. `joined` lets the caller skip the enqueue it no longer
   * needs to do.
   */
  async createOrJoin(input: {
    workspaceId: string;
    type: string;
    agentId: string;
    steps?: Record<string, unknown>;
  }): Promise<{ jobId: string; joined: boolean }> {
    try {
      const jobId = await this.create({
        workspaceId: input.workspaceId,
        type: input.type,
        steps: { ...input.steps, agent_id: input.agentId },
      });
      return { jobId, joined: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.findActive(input.workspaceId, input.type, input.agentId);
      if (existing) {
        this.log.log(`${input.type} for agent ${input.agentId}: joined the in-flight job ${existing}`);
        return { jobId: existing, joined: true };
      }
      // The winner finished between the collision and this read, which makes the work the
      // caller asked for genuinely undone. Try once more; a second collision is a real
      // error and belongs to the caller.
      const jobId = await this.create({
        workspaceId: input.workspaceId,
        type: input.type,
        steps: { ...input.steps, agent_id: input.agentId },
      });
      return { jobId, joined: false };
    }
  }

  /**
   * Marks a job running, unless it has already finished.
   *
   * `updateMany` with the status in the predicate rather than a read-then-write: a job
   * BullMQ delivered twice would otherwise reopen a succeeded row and the client would
   * watch a finished generation go back to "running".
   */
  async markRunning(jobId: string, steps?: Record<string, unknown>): Promise<boolean> {
    const { count } = await adminDb.job.updateMany({
      where: { id: jobId, status: { in: ['queued', 'running'] } },
      data: { status: 'running', ...(steps ? { stepsJson: steps as Prisma.InputJsonValue } : {}) },
    });
    return count === 1;
  }

  async succeed(jobId: string, steps: Record<string, unknown>): Promise<void> {
    await adminDb.job.update({
      where: { id: jobId },
      data: { status: 'succeeded', error: null, stepsJson: steps as Prisma.InputJsonValue },
    });
  }

  /**
   * `attemptsLeft` tells the difference between "this attempt failed" and "this job
   * failed": only the last attempt marks the row failed, so a client polling through a
   * retry sees `running`, not a failure that is about to be retried anyway.
   *
   * `error` is the diagnostic — it may name the provider or quote an SDK. What the
   * customer reads is `steps.customer_reason`; callers set it (see `get()`).
   */
  async fail(jobId: string, error: string, steps: Record<string, unknown>, attemptsLeft: number): Promise<void> {
    await adminDb.job.update({
      where: { id: jobId },
      data: {
        status: attemptsLeft > 0 ? 'running' : 'failed',
        error: error.slice(0, 2_000),
        stepsJson: steps as Prisma.InputJsonValue,
      },
    });
  }

  async steps(jobId: string): Promise<Record<string, unknown>> {
    const row = await adminDb.job.findUnique({ where: { id: jobId }, select: { stepsJson: true } });
    return (row?.stepsJson ?? {}) as Record<string, unknown>;
  }

  /** Merges into `steps_json` rather than replacing it, so progress accumulates. */
  async addSteps(jobId: string, steps: Record<string, unknown>): Promise<Record<string, unknown>> {
    const merged = { ...(await this.steps(jobId)), ...steps };
    await adminDb.job
      .update({ where: { id: jobId }, data: { stepsJson: merged as Prisma.InputJsonValue } })
      .catch((error: unknown) => this.log.warn(`job ${jobId}: could not record progress: ${String(error)}`));
    return merged;
  }

  /**
   * The newest job of a type that is still going, if any.
   *
   * The read half of the duplicate-submission guard for §13.3. It answers the common
   * case — a second "Generate" a second later — without touching the database's error
   * path; `createOrJoin` is what makes the answer race-free.
   */
  async findActive(workspaceId: string, type: string, agentId: string): Promise<string | null> {
    const row = await adminDb.job.findFirst({
      where: {
        tenantId: workspaceId,
        type,
        status: { in: ['queued', 'running'] },
        // `path` reaches into steps_json; Prisma compiles it to a jsonb path equality.
        stepsJson: { path: ['agent_id'], equals: agentId },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  // ------------------------------------------------------------------ recovery

  /**
   * `job-sweeper` (§13.11): writes off queued/running rows whose queue job is gone.
   *
   * "Gone" is BullMQ's word, not a guess from a timestamp. For every row untouched for
   * `olderThanMs` the deterministic id (`gen-<id>` / `patch-<id>`) is looked up:
   *
   *   active | waiting | delayed | prioritized   somebody will run it — leave it alone,
   *                                              however old. A stopped worker is not a
   *                                              dead job; the queue is holding it.
   *   unknown                                   Redis did not answer — leave it alone.
   *   missing | failed | completed              nothing will ever run it again — the row is
   *                                              marked failed with a customer-safe reason.
   *
   * `failed` here is a job BullMQ itself failed ("job stalled more than allowable limit")
   * after a worker died holding it: our handler never ran its catch, so nothing else
   * writes the row. `missing` is an API that died between creating the row and enqueuing,
   * or a job BullMQ removed after it settled. Idempotent: the write is conditional on the
   * row still being queued/running, so two sweepers, or a sweeper racing a late worker,
   * cannot fail a row twice or reopen one.
   */
  async reconcileStale(options: { olderThanMs?: number; limit?: number; now?: Date } = {}): Promise<LostJob[]> {
    const olderThanMs = options.olderThanMs ?? STALE_JOB_AFTER_MS;
    const now = options.now ?? new Date();
    const rows = await adminDb.job.findMany({
      where: {
        status: { in: ['queued', 'running'] },
        updatedAt: { lt: new Date(now.getTime() - olderThanMs) },
      },
      orderBy: { updatedAt: 'asc' },
      take: options.limit ?? 100,
      select: { id: true, tenantId: true, type: true, stepsJson: true },
    });

    const lost: LostJob[] = [];
    for (const row of rows) {
      const outcome = await this.reconcileRow(row);
      if (outcome) lost.push(outcome);
    }
    if (rows.length) this.log.warn(`job sweeper: ${rows.length} stale row(s) checked, ${lost.length} written off as lost`);
    return lost;
  }

  /**
   * The join-path half. A request about to join an in-flight job first asks whether that
   * job still exists in the queue — so a customer whose generation died with a worker
   * gets a fresh job on their next click instead of the sweeper's next tick. Only rows
   * untouched for `graceMs` are checked: a row younger than that may be between its
   * INSERT and its enqueue.
   */
  async reconcileIfLost(jobId: string, graceMs = JOIN_GRACE_MS, now = new Date()): Promise<LostJob | null> {
    const row = await adminDb.job.findUnique({
      where: { id: jobId },
      select: { id: true, tenantId: true, type: true, stepsJson: true, status: true, updatedAt: true },
    });
    if (!row || (row.status !== 'queued' && row.status !== 'running')) return null;
    if (row.updatedAt.getTime() > now.getTime() - graceMs) return null;
    return this.reconcileRow(row);
  }

  private async reconcileRow(row: { id: string; tenantId: string | null; type: string; stepsJson: unknown }): Promise<LostJob | null> {
    const backing = queueOfJobType(row.type);
    if (!backing) return null; // not a queue-backed job type we know how to check
    const bullId = backing.bullId(row.id);

    const state = await this.queues.stateOf(backing.queue, bullId);
    if (!LOST_STATES.has(state)) return null;

    const steps = (row.stepsJson ?? {}) as Record<string, unknown>;
    const { count } = await adminDb.job.updateMany({
      where: { id: row.id, status: { in: ['queued', 'running'] } },
      data: {
        status: 'failed',
        error: `lost: queue job ${bullId} is ${state}; written off by the job sweeper`,
        stepsJson: {
          ...steps,
          error_kind: 'lost',
          queue_state: state,
          lost_at: new Date().toISOString(),
          customer_reason: LOST_JOB_REASON,
        } as Prisma.InputJsonValue,
      },
    });
    if (count === 0) return null; // a late worker settled it first — that is the outcome we wanted

    const agentId = typeof steps.agent_id === 'string' ? steps.agent_id : null;
    this.log.warn(`job ${row.id} (${row.type}, agent ${agentId ?? '?'}) written off: queue job ${bullId} is ${state}`);
    return { jobId: row.id, workspaceId: row.tenantId, agentId, type: row.type, queueState: state };
  }

  // ------------------------------------------------------------------ read

  /**
   * GET /jobs/:id — workspace-scoped, so another workspace's job id is a 404.
   *
   * An explicit whitelist, not the row. `steps_json` carries `provider`, `model`,
   * `retell_sync`, `retell_error` and the like; `error` quotes whatever the provider or
   * the Retell SDK said. None of that is the customer's to read (CLAUDE.md: the voice
   * platform is never named in customer-facing copy). What they get is progress they can
   * act on and, on failure, the one sentence the worker wrote for them.
   */
  async get(ctx: WorkspaceContext, jobId: string): Promise<JobResponse> {
    const row = await withWorkspace(ctx, (db) =>
      db.job.findFirst({ where: { id: jobId, tenantId: ctx.workspaceId } }),
    );
    if (!row) throw AppError.notFound('Job');
    return toJobResponse(row);
  }
}

/** Row → wire shape. Exported so the whitelist itself can be unit-tested against a hostile row. */
export function toJobResponse(row: {
  id: string;
  type: string;
  status: string;
  stepsJson: unknown;
  createdAt: Date;
  updatedAt: Date;
}): JobResponse {
  const steps = (row.stepsJson && typeof row.stepsJson === 'object' ? row.stepsJson : {}) as Record<string, unknown>;
  const progress: JobProgress = jobProgressSchema.parse({
    agent_id: uuidOrNull(steps.agent_id),
    mode: steps.mode === 'generate' || steps.mode === 'regenerate' || steps.mode === 'feedback' ? steps.mode : null,
    base_version: intOrNull(steps.base_version),
    version_no: intOrNull(steps.version_id),
    changes: intOrNull(steps.changes),
    refused: typeof steps.refused === 'boolean' ? steps.refused : null,
    explanation: typeof steps.explanation === 'string' ? steps.explanation.slice(0, 600) : null,
    lint_findings: intOrNull(steps.lint_findings),
    // D6 §13.8 — the activation worker writes these under stable names (ActivationWorker).
    activation_status: enumOrNull(steps.activation_status, ['pending', 'publishing', 'provisioning', 'binding', 'marking_live', 'live', 'failed']),
    activation_step: enumOrNull(steps.activation_step, ['publish', 'provision', 'bind', 'mark_live', 'notify']),
    number_id: uuidOrNull(steps.number_id),
    e164: typeof steps.e164 === 'string' && /^\+\d{7,15}$/.test(steps.e164) ? steps.e164 : null,
  });
  const customerReason = typeof steps.customer_reason === 'string' ? steps.customer_reason : null;
  return {
    id: row.id,
    type: row.type,
    status: row.status as JobResponse['status'],
    progress,
    error: row.status === 'failed' ? (customerReason ?? GENERIC_FAILURE) : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const GENERIC_FAILURE = 'Something went wrong. Your brief is saved — try again.';

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function enumOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}
