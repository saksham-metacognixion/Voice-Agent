import { describe, expect, it } from 'vitest';
import { JobHandlerRegistry } from './job-handlers';
import { DEFAULT_JOB_OPTIONS, JobQueues, REPAIR_JOB_OPTIONS, isSpent } from './job-queues.service';
import { bullConnection, bullPrefix } from './jobs.connection';
import { JOBS, QUEUES, SCHEDULED_JOBS, SCHEDULES, scheduleLockTtlS } from './jobs.constants';

describe('queue and job names', () => {
  it('names five queues and keeps every job on one of them', () => {
    expect(Object.values(QUEUES)).toEqual(['webhooks', 'calls', 'prompting', 'provisioning', 'scheduled']);
    expect(new Set(Object.values(JOBS)).size).toBe(Object.values(JOBS).length);
  });

  it('schedules every §13.11 job exactly once, with a usable interval or cron', () => {
    const scheduled = Object.values(SCHEDULED_JOBS);
    expect(SCHEDULES.map((s) => s.name).sort()).toEqual([...scheduled].sort());
    expect(new Set(SCHEDULES.map((s) => s.name)).size).toBe(SCHEDULES.length);
    for (const spec of SCHEDULES) {
      expect(Boolean(spec.every) !== Boolean(spec.pattern), `${spec.name} needs exactly one of every/pattern`).toBe(true);
      if (spec.every) expect(spec.every, spec.name).toBeGreaterThanOrEqual(60_000);
      if (spec.pattern) expect(spec.pattern, spec.name).toMatch(/^[\d*/, -]+( [\d*/, -]+){4}$/);
    }
  });

  it('marks which schedules actually do something today, so a skeleton is never mistaken for live', () => {
    const live = SCHEDULES.filter((s) => s.status === 'live').map((s) => s.name);
    expect(live).toEqual([
      'runtime-cache-refresh',
      'webhook-sweeper',
      'job-sweeper',
      'credit-expiry',
      'number-rental',
      'low-balance-alerts',
      'auto-topup',
      'reconcile-calls',
      'voice-cache',
      'concurrency-monitor',
      'number-release',
      'daily-digest',
    ]);
    // D7: the digest is hourly and timezone-aware, never one UTC midnight run.
    expect(SCHEDULES.find((s) => s.name === 'daily-digest')?.pattern).toMatch(/^\d+ \* \* \* \*$/);
  });

  it('gives every schedule a lock TTL that outlives one tick but not the next hour', () => {
    for (const spec of SCHEDULES) {
      const ttl = scheduleLockTtlS(spec);
      expect(ttl, spec.name).toBeGreaterThanOrEqual(60);
      expect(ttl, spec.name).toBeLessThanOrEqual(3_600);
      if (spec.every) expect(ttl * 1000, spec.name).toBeGreaterThanOrEqual(spec.every);
    }
  });
});

describe('JobHandlerRegistry', () => {
  it('resolves a handler by queue and job name', () => {
    const registry = new JobHandlerRegistry();
    const handler = async () => 'done';
    registry.register(QUEUES.calls, JOBS.inboundDecision, handler);
    expect(registry.resolve(QUEUES.calls, JOBS.inboundDecision)).toBe(handler);
    expect(registry.resolve(QUEUES.webhooks, JOBS.inboundDecision)).toBeUndefined();
    expect(registry.names()).toEqual(['calls/inbound-decision']);
  });

  it('refuses a second handler for the same job — two writers for one job is always a bug', () => {
    const registry = new JobHandlerRegistry();
    registry.register(QUEUES.webhooks, JOBS.processWebhook, async () => undefined);
    expect(() => registry.register(QUEUES.webhooks, JOBS.processWebhook, async () => undefined)).toThrow(/already registered/);
  });
});

describe('bullConnection', () => {
  it('parses a plain redis URL', () => {
    expect(bullConnection('redis://localhost:6379', 'worker')).toMatchObject({ host: 'localhost', port: 6379, maxRetriesPerRequest: null });
  });

  it('carries credentials, a database number and TLS from a rediss URL', () => {
    const options = bullConnection('rediss://user:p%40ss@redis.internal:6380/3', 'worker') as Record<string, unknown>;
    expect(options).toMatchObject({ host: 'redis.internal', port: 6380, username: 'user', password: 'p@ss', db: 3 });
    expect(options.tls).toEqual({});
  });

  it('lets a producer fail fast while a worker may queue offline', () => {
    expect(bullConnection('redis://localhost:6379', 'producer')).toMatchObject({ enableOfflineQueue: false });
    expect(bullConnection('redis://localhost:6379', 'worker')).toMatchObject({ enableOfflineQueue: true });
  });

  it('says which variable to set rather than connecting to nothing', () => {
    expect(() => bullConnection(undefined, 'worker')).toThrow(/REDIS_URL/);
  });

  it('namespaces every key by environment so two environments on one Redis never share a queue', () => {
    expect(bullPrefix({ APP_ENV: 'dev' } as NodeJS.ProcessEnv)).toBe('portal:dev');
    expect(bullPrefix({ APP_ENV: 'dev', BULLMQ_PREFIX: 'portal:test-run' } as NodeJS.ProcessEnv)).toBe('portal:test-run');
  });
});

describe('isSpent — when a deterministic job id may be reused', () => {
  const job = (over: Partial<{ finishedOn: number; attemptsMade: number; attempts: number; failed: boolean }> = {}) => ({
    finishedOn: over.finishedOn,
    attemptsMade: over.attemptsMade ?? 0,
    opts: { attempts: over.attempts ?? 8 },
    isFailed: async () => over.failed ?? false,
  });

  it('is true only for a job that failed with its attempts used up', async () => {
    await expect(isSpent(job({ finishedOn: Date.now(), attemptsMade: 8, attempts: 8, failed: true }))).resolves.toBe(true);
  });

  it('leaves a job that is still queued or still being retried alone', async () => {
    await expect(isSpent(job({ attemptsMade: 0 }))).resolves.toBe(false);
    await expect(isSpent(job({ attemptsMade: 3, attempts: 8 }))).resolves.toBe(false);
  });

  it('leaves a completed job alone — that is the outcome we wanted', async () => {
    await expect(isSpent(job({ finishedOn: Date.now(), attemptsMade: 1, attempts: 8, failed: false }))).resolves.toBe(false);
  });
});

/**
 * A stand-in for BullMQ's Queue that reproduces the one behaviour the requeue logic turns
 * on: `add()` returns a Job the client built *locally* — `Job.create` overwrites only
 * `job.id` from Redis — so a duplicate id comes back looking brand new, with this
 * moment's timestamp, no attempts made and no `finishedOn`. The Lua (addStandardJob)
 * returns the existing id and emits a `duplicated` event, neither of which reaches the
 * caller. Anything the caller wants to know about a held id has to be read back.
 */
class FakeQueue {
  readonly stored = new Map<string, { id: string; timestamp: number; attemptsMade: number; finishedOn?: number; failed: boolean; opts: { attempts?: number } }>();
  readonly adds: string[] = [];
  reads = 0;

  async add(name: string, data: object, opts: { jobId: string; attempts?: number }) {
    this.adds.push(opts.jobId);
    const job = { id: opts.jobId, name, data, opts, timestamp: Date.now(), attemptsMade: 0, finishedOn: undefined as number | undefined };
    if (!this.stored.has(opts.jobId)) {
      this.stored.set(opts.jobId, { id: opts.jobId, timestamp: job.timestamp, attemptsMade: 0, failed: false, opts });
    }
    return job;
  }

  async getJob(jobId: string) {
    this.reads += 1;
    const row = this.stored.get(jobId);
    if (!row) return undefined;
    return { ...row, isFailed: async () => row.failed, remove: async () => void this.stored.delete(jobId) };
  }

  /** Seeds an id already held by an older job, as Redis would hold it. */
  hold(jobId: string, over: Partial<{ attemptsMade: number; finishedOn: number; failed: boolean; attempts: number }> = {}): void {
    this.stored.set(jobId, {
      id: jobId,
      timestamp: Date.now() - 60_000,
      attemptsMade: over.attemptsMade ?? 0,
      finishedOn: over.finishedOn,
      failed: over.failed ?? false,
      opts: { attempts: over.attempts ?? 8 },
    });
  }
}

function withFakeQueue(): { queues: JobQueues; fake: FakeQueue } {
  const queues = new JobQueues();
  const fake = new FakeQueue();
  (queues as unknown as { queues: Map<string, unknown> }).queues.set(QUEUES.webhooks, fake);
  return { queues, fake };
}

describe('JobQueues.add — telling a fresh enqueue from an id that is already held', () => {
  const data = { eventId: 'evt_1', provider: 'retell' as const };

  it('reports a genuinely new job as queued', async () => {
    const { queues, fake } = withFakeQueue();
    expect(await queues.add(QUEUES.webhooks, JOBS.processWebhook, data, { jobId: 'wh-1' }, 1_000, true)).toBe('queued');
    expect(fake.adds).toEqual(['wh-1']);
  });

  it('reports an id held by a job still waiting or still retrying as exists, and adds nothing', async () => {
    const { queues, fake } = withFakeQueue();
    fake.hold('wh-1');
    expect(await queues.add(QUEUES.webhooks, JOBS.processWebhook, data, { jobId: 'wh-1' }, 1_000, true)).toBe('exists');
    fake.hold('wh-2', { attemptsMade: 3, finishedOn: Date.now(), failed: true });
    expect(await queues.add(QUEUES.webhooks, JOBS.processWebhook, data, { jobId: 'wh-2' }, 1_000, true)).toBe('exists');
  });

  it('leaves an id held by a job that completed alone — that is the outcome we wanted', async () => {
    const { queues, fake } = withFakeQueue();
    fake.hold('wh-1', { attemptsMade: 1, finishedOn: Date.now(), failed: false });
    expect(await queues.add(QUEUES.webhooks, JOBS.processWebhook, data, { jobId: 'wh-1' }, 1_000, true)).toBe('exists');
  });

  /*
   * The failure this closes. A `wh-<id>` job that burns its eight attempts sits in the
   * failed set for a week holding its id (SA12 "Jobs"). `webhook-sweeper` re-enqueues it
   * every 60 s; BullMQ answers with the existing job, which — built locally — is
   * indistinguishable from a fresh add. The sweeper counts a re-enqueue that never
   * happened, nothing ever runs, and that `call_ended` is never billed.
   */
  it('drops and re-adds an id held by a job that had already failed for good', async () => {
    const { queues, fake } = withFakeQueue();
    fake.hold('wh-1', { attemptsMade: 8, attempts: 8, finishedOn: Date.now(), failed: true });
    expect(await queues.add(QUEUES.webhooks, JOBS.processWebhook, data, { jobId: 'wh-1' }, 1_000, true)).toBe('requeued');
    // Added twice: the refused first add, then the real one after the corpse was removed.
    expect(fake.adds).toEqual(['wh-1', 'wh-1']);
    const replacement = await fake.getJob('wh-1');
    expect(replacement?.finishedOn).toBeUndefined();
    expect(replacement?.attemptsMade).toBe(0);
  });

  it('enqueueWebhook verifies — it is the one enqueue whose silent no-op costs money', async () => {
    const { queues, fake } = withFakeQueue();
    fake.hold('wh-evt_9', { attemptsMade: 8, attempts: 8, finishedOn: Date.now(), failed: true });
    expect(await queues.enqueueWebhook('evt_9', 'retell')).toBe('requeued');
  });

  it('skips the read-back for callers that only need the job to exist', async () => {
    const { queues, fake } = withFakeQueue();
    fake.hold('wh-1');
    expect(await queues.add(QUEUES.webhooks, JOBS.processWebhook, data, { jobId: 'wh-1' })).toBe('queued');
    expect(fake.reads).toBe(0);
  });

  it('reports a queue it cannot reach as failed rather than throwing at the caller', async () => {
    const { queues, fake } = withFakeQueue();
    fake.add = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await queues.add(QUEUES.webhooks, JOBS.processWebhook, data, { jobId: 'wh-1' }, 1_000, true)).toBe('failed');
  });
});

describe('job options', () => {
  it('keeps a failed webhook job for a week, with its id, for SA12 retry/discard', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(8);
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({ age: 7 * 86_400 });
  });

  /*
   * Cache repairs dedupe on a deterministic id so a burst of hot-path misses enqueues one
   * job. Under the defaults that dedup outlived the repair — an hour for a completed job,
   * a week for a failed one — so the next miss on the same workspace was swallowed long
   * after the repair it asked for had finished.
   */
  it('frees a cache repair’s id the moment it settles, so the next miss is not swallowed', () => {
    expect(REPAIR_JOB_OPTIONS.removeOnComplete).toBe(true);
    expect(REPAIR_JOB_OPTIONS.removeOnFail).toBe(true);
    expect(REPAIR_JOB_OPTIONS.attempts).toBe(3);
  });
});
