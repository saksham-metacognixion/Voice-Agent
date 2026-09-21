import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { type Job, type JobsOptions, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { bullConnection, bullPrefix } from './jobs.connection';
import {
  type ActivationJob,
  type InboundDecisionJob,
  JOBS,
  type KnowledgeSyncJob,
  type ProcessWebhookJob,
  type PromptingJob,
  type ProvisionNumberJob,
  QUEUES,
  type QueueName,
  type RefreshNumberJob,
  type WarmWorkspaceJob,
} from './jobs.constants';

/** `requeued` = the id was held by a job that had exhausted its attempts; it was dropped and added again. */
export type EnqueueResult = 'queued' | 'exists' | 'requeued' | 'failed';

/**
 * Where a job id stands in its queue. BullMQ's own states, plus `missing` (no job holds
 * the id) and `unknown` (Redis did not answer in time — never treated as either).
 */
export type QueueJobState =
  | 'missing'
  | 'unknown'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'active'
  | 'waiting'
  | 'waiting-children'
  | 'prioritized';

/**
 * The BullMQ id of a prompting job, from the `jobs` row's type and id — `gen-<id>` for a
 * generation, `patch-<id>` for a feedback patch. One function, used by the enqueue and by
 * the sweeper that later asks the queue what became of it, so the two cannot drift.
 * Null for a type that does not run on the prompting queue.
 */
export function promptingBullId(type: string, jobId: string): string | null {
  if (type === JOBS.generateAgent) return `gen-${safeId(jobId)}`;
  if (type === JOBS.patchAgent) return `patch-${safeId(jobId)}`;
  return null;
}

/** The BullMQ id of a §13.8 activation job, from its `jobs` row id. */
export function activationBullId(jobId: string): string {
  return `activate-${safeId(jobId)}`;
}

/** Which queue a `jobs.type` runs on, for the sweeper. Null for types that are not queue-backed. */
export function queueOfJobType(type: string): { queue: QueueName; bullId: (jobId: string) => string } | null {
  if (type === JOBS.generateAgent || type === JOBS.patchAgent) return { queue: QUEUES.prompting, bullId: (id) => promptingBullId(type, id)! };
  if (type === JOBS.activateAgent) return { queue: QUEUES.provisioning, bullId: activationBullId };
  return null;
}

/**
 * D6 activation: three attempts, exponential from 5 s. The worker classifies what is
 * worth a retry. `ACTIVATION_BACKOFF_MS` exists for the e2e suite, which cannot wait
 * fifteen seconds per retried scenario; it is not a production knob.
 */
export const ACTIVATION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 5_000 },
  removeOnFail: { age: 7 * 86_400 },
};

/** Read at enqueue time, not import time: the e2e harness sets the override after the module graph has loaded. */
function activationJobOptions(): JobsOptions {
  const override = Number(process.env.ACTIVATION_BACKOFF_MS);
  return Number.isFinite(override) && override > 0 ? { ...ACTIVATION_JOB_OPTIONS, backoff: { type: 'exponential', delay: Math.max(50, override) } } : ACTIVATION_JOB_OPTIONS;
}

/**
 * Retries are ours, not the provider's (architecture §11): eight attempts with
 * exponential backoff from 2 s covers roughly ten minutes of a Postgres or Retell blip.
 * A job that still fails after that stays in the failed set for a week (SA12 "Jobs"
 * retry/discard); the webhook row keeps the error text.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 5_000 },
  removeOnFail: { age: 7 * 86_400 },
};

/**
 * Cache repairs — `warm-workspace` and `refresh-number`. Their ids are deterministic so a
 * burst of misses on one workspace enqueues one job rather than hundreds, but that dedup
 * must only last while the job is *pending*. Under DEFAULT_JOB_OPTIONS a completed repair
 * holds its id for an hour and a failed one for a week, so the next hot-path miss on the
 * same workspace would be swallowed long after the repair it asked for had finished.
 * These jobs are idempotent and cheap, every failed attempt is already logged by
 * `WorkerRuntime`, and `runtime-cache-refresh` re-drives them every five minutes — so
 * nothing is kept by holding the id, and a real repair is lost by holding it.
 */
export const REPAIR_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** How long `add()` may wait for Redis. The inbound path is on a 300 ms budget overall. */
export const ENQUEUE_TIMEOUT_MS = 1_000;

/**
 * The producer side of BullMQ: one Queue per name, built lazily so a process that never
 * enqueues never connects. `add()` never throws — a queue that cannot be reached is
 * reported as `failed` and logged, because every caller has a fallback that does not
 * involve failing the request: stored webhook rows are re-enqueued by the sweeper, and
 * the inbound path answers Retell regardless (ADR 0003 §12).
 *
 * Job ids are deterministic (`wh-<event id>`, `inbound-<call id>`), which is the queue
 * side of exactly-once: a second `add()` for the same id while the first is anywhere in
 * the queue is a no-op (`exists`). The exception is a job that has already failed for
 * good: BullMQ keeps failed jobs for a week (SA12 "Jobs"), and their ids with them, so an
 * `add()` for one would be a silent no-op forever — the sweeper would report a re-enqueue
 * every minute and nothing would run. Those are removed and added again (`requeued`), for
 * the callers that pass `verify`; telling the two apart costs a read-back, so the ones
 * that only need the job to exist do not pay for it.
 */
@Injectable()
export class JobQueues implements OnApplicationShutdown {
  private readonly log = new Logger(JobQueues.name);
  private readonly queues = new Map<QueueName, Queue>();
  readonly prefix = bullPrefix();

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: bullConnection(process.env.REDIS_URL, 'producer'),
        prefix: this.prefix,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      queue.on('error', (error: Error) => this.log.warn(`queue ${name}: ${error.message}`));
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * `verify` costs one extra round trip and buys the difference between `queued`,
   * `exists` and `requeued`. Callers that only need the job to exist leave it off.
   */
  async add<T extends object>(
    queueName: QueueName,
    jobName: string,
    data: T,
    options: JobsOptions & { jobId: string },
    timeoutMs = ENQUEUE_TIMEOUT_MS,
    verify = false,
  ): Promise<EnqueueResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.addOnce(queueName, jobName, data, options, verify),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`enqueue timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.log.error(`enqueue ${queueName}/${jobName} ${options.jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return 'failed';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async addOnce<T extends object>(
    queueName: QueueName,
    jobName: string,
    data: T,
    options: JobsOptions & { jobId: string },
    verify: boolean,
  ): Promise<EnqueueResult> {
    const queue = this.queue(queueName);
    const job = await queue.add(jobName, data, options);
    if (!verify) return 'queued';

    // `queue.add()` cannot tell us whether the id was already taken. BullMQ builds the Job
    // it returns *locally* and then overwrites only `job.id` from Redis, so a duplicate
    // comes back indistinguishable from a fresh add — `timestamp` is this moment,
    // `attemptsMade` is 0, `finishedOn` is undefined. The Lua (addStandardJob) returns the
    // existing id and emits a `duplicated` event, neither of which reaches the caller. The
    // stored hash is the only place the truth is, so read it back.
    const stored = await queue.getJob(options.jobId);
    // Nothing holds the id: the job ran and was removed, or was trimmed. Ours is queued.
    if (!stored) return 'queued';
    // The script stores the timestamp the client generated, so an exact match means the
    // row in Redis is the one this very call wrote.
    if (stored.timestamp === job.timestamp) return 'queued';
    if (!(await isSpent(stored))) return 'exists';

    this.log.warn(`enqueue ${queueName}/${jobName} ${options.jobId}: replacing a job that had already failed for good`);
    await stored.remove();
    await queue.add(jobName, data, options);
    return 'requeued';
  }

  /**
   * Verified: this is the one enqueue whose silent no-op costs money. A `wh-<id>` job that
   * exhausted its eight attempts keeps its id in the failed set for a week, so without the
   * read-back the sweeper would re-enqueue it every minute, BullMQ would refuse every time,
   * the sweeper would count it as queued — and that `call_ended` would never bill.
   */
  enqueueWebhook(eventId: string, provider: ProcessWebhookJob['provider']): Promise<EnqueueResult> {
    return this.add<ProcessWebhookJob>(QUEUES.webhooks, JOBS.processWebhook, { eventId, provider }, { jobId: `wh-${eventId}` }, ENQUEUE_TIMEOUT_MS, true);
  }

  /** From the hot path: short timeout, the answer to Retell is not waiting on this. */
  enqueueInboundDecision(job: InboundDecisionJob): Promise<EnqueueResult> {
    return this.add<InboundDecisionJob>(QUEUES.calls, JOBS.inboundDecision, job, { jobId: `inbound-${safeId(job.callId)}` }, 250);
  }

  /**
   * §13.3 / §13.5. The BullMQ id is derived from the `jobs` row, which is what makes a
   * duplicate submission a no-op: the service reuses an in-flight row rather than
   * creating a second one, so the second POST enqueues the same id and BullMQ refuses it.
   * `verify` is on for the same reason `enqueueWebhook` has it — an id held by a job that
   * failed for good would otherwise swallow every later attempt, and the customer would
   * watch a spinner forever.
   */
  enqueuePrompting(job: PromptingJob): Promise<EnqueueResult> {
    const name = job.mode === 'feedback' ? JOBS.patchAgent : JOBS.generateAgent;
    return this.add<PromptingJob>(
      QUEUES.prompting,
      name,
      job,
      {
        jobId: promptingBullId(name, job.jobId)!,
        // Three, not eight: a generation the customer is watching is worth about a minute
        // of retrying, not ten. After that the job row carries the reason and W2 offers
        // "try again", which is a better answer than a version appearing five minutes later.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
      },
      ENQUEUE_TIMEOUT_MS,
      true,
    );
  }

  /**
   * D6 W4. One job per source; a poll re-enqueue carries `-p<n>` so it does not collide
   * with the id of the run that scheduled it. `verify` for the same reason as prompting.
   */
  enqueueKnowledgeSync(job: KnowledgeSyncJob, options: { delayMs?: number } = {}): Promise<EnqueueResult> {
    // A completed job keeps its id for an hour (DEFAULT_JOB_OPTIONS), so the delete of a
    // source that synced fine must not reuse the sync's id — it would be refused silently.
    const suffix = job.poll ? `-p${job.poll}` : job.purpose === 'delete' ? '-del' : '';
    return this.add<KnowledgeSyncJob>(
      QUEUES.provisioning,
      JOBS.knowledgeSync,
      job,
      { jobId: `ksync-${safeId(job.sourceId)}${suffix}`, attempts: 4, backoff: activationJobOptions().backoff, delay: options.delayMs },
      ENQUEUE_TIMEOUT_MS,
      true,
    );
  }

  /** D6 §11: buy/import outside the wizard. Deterministic on the row, so a double click is one purchase. */
  enqueueProvisionNumber(job: ProvisionNumberJob): Promise<EnqueueResult> {
    return this.add<ProvisionNumberJob>(
      QUEUES.provisioning,
      JOBS.provisionNumber,
      job,
      { ...activationJobOptions(), jobId: `provnum-${safeId(job.numberId)}` },
      ENQUEUE_TIMEOUT_MS,
      true,
    );
  }

  /** D6 §13.8. Same shape as prompting: the id is the `jobs` row, so a join enqueues a no-op. */
  enqueueActivation(job: ActivationJob): Promise<EnqueueResult> {
    return this.add<ActivationJob>(
      QUEUES.provisioning,
      JOBS.activateAgent,
      job,
      { ...activationJobOptions(), jobId: activationBullId(job.jobId) },
      ENQUEUE_TIMEOUT_MS,
      true,
    );
  }

  enqueueWarmWorkspace(workspaceId: string): Promise<EnqueueResult> {
    return this.add<WarmWorkspaceJob>(QUEUES.calls, JOBS.warmWorkspace, { workspaceId }, { ...REPAIR_JOB_OPTIONS, jobId: `warm-${workspaceId}` }, 250);
  }

  enqueueRefreshNumber(e164: string): Promise<EnqueueResult> {
    return this.add<RefreshNumberJob>(QUEUES.calls, JOBS.refreshNumber, { e164 }, { ...REPAIR_JOB_OPTIONS, jobId: `refresh-number-${safeId(e164)}` }, 250);
  }

  /**
   * What the queue currently holds for an id. Never throws: a Redis that does not answer
   * within the budget is `unknown`, which every caller treats as "leave it alone" — the
   * job sweeper must never write a row off because Redis blinked.
   */
  async stateOf(queueName: QueueName, jobId: string, timeoutMs = ENQUEUE_TIMEOUT_MS): Promise<QueueJobState> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async (): Promise<QueueJobState> => {
          const job = await this.queue(queueName).getJob(jobId);
          if (!job) return 'missing';
          const state = await job.getState();
          return state === 'unknown' ? 'unknown' : (state as QueueJobState);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`getState timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.log.warn(`stateOf ${queueName}/${jobId}: ${error instanceof Error ? error.message : String(error)}`);
      return 'unknown';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A fresh id for rows that have no natural one (a declined call whose webhook carried no call_id). */
  static syntheticCallId(): string {
    return `dec_${randomUUID()}`;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
    this.queues.clear();
  }
}

/**
 * A job holding this id that will never run again: it finished in the failed set with its
 * attempts used up. A job still being retried, or one that completed, is left alone —
 * completing is the outcome we wanted, and re-running a retrying job would double the work.
 */
export async function isSpent(job: Pick<Job, 'finishedOn' | 'attemptsMade' | 'opts' | 'isFailed'>): Promise<boolean> {
  if (!job.finishedOn) return false;
  const attempts = job.opts.attempts ?? 1;
  return job.attemptsMade >= attempts && (await job.isFailed());
}

/** BullMQ job ids are Redis key fragments: keep them to a safe alphabet. */
function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}
