import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import { bullConnection, bullPrefix } from './jobs.connection';
import { QUEUES, type QueueName } from './jobs.constants';

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<unknown>;

/**
 * Feature modules register what runs for each (queue, job name) pair at module init —
 * the same service classes the routes call (CLAUDE.md, "Routes call services; job
 * processors call the same services"). The registry is process-wide and passive: nothing
 * runs until `WorkerRuntime.start()` creates the BullMQ Workers, which only the worker
 * entrypoint (and the e2e suite) does. The API process registers handlers it never uses,
 * which is cheap and keeps one module graph for both entrypoints.
 */
@Injectable()
export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register<T>(queue: QueueName, jobName: string, handler: JobHandler<T>): void {
    const key = `${queue}/${jobName}`;
    if (this.handlers.has(key)) throw new Error(`job handler for ${key} is already registered`);
    this.handlers.set(key, handler as JobHandler);
  }

  resolve(queue: QueueName, jobName: string): JobHandler | undefined {
    return this.handlers.get(`${queue}/${jobName}`);
  }

  names(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

/**
 * Per-queue concurrency. Scheduled jobs run one at a time on purpose: they sweep tables.
 * `prompting` is held at four because each job is an LLM round trip against a provider
 * rate limit — more workers would turn a 429 into eight 429s and spend the ≤ 10 s p95 on
 * backoff rather than on generation.
 */
const CONCURRENCY: Record<QueueName, number> = { webhooks: 8, calls: 8, prompting: 4, scheduled: 1 };

/**
 * One BullMQ Worker per queue, dispatching by job name through the registry. A job whose
 * name nobody registered fails loudly rather than being silently completed — that is a
 * deploy skew between API and worker, and it should page.
 */
@Injectable()
export class WorkerRuntime implements OnApplicationShutdown {
  private readonly log = new Logger(WorkerRuntime.name);
  private readonly workers: Worker[] = [];

  constructor(private readonly registry: JobHandlerRegistry) {}

  get running(): boolean {
    return this.workers.length > 0;
  }

  async start(queues: readonly QueueName[] = Object.values(QUEUES)): Promise<void> {
    if (this.running) return;
    const prefix = bullPrefix();
    for (const name of queues) {
      const worker = new Worker(
        name,
        async (job) => {
          const handler = this.registry.resolve(name, job.name);
          if (!handler) throw new Error(`no handler registered for ${name}/${job.name}`);
          return handler(job);
        },
        { connection: bullConnection(process.env.REDIS_URL, 'worker'), prefix, concurrency: CONCURRENCY[name] },
      );
      worker.on('failed', (job, error) =>
        this.log.warn(`${name}/${job?.name ?? '?'} ${job?.id ?? '?'} attempt ${job?.attemptsMade ?? '?'} failed: ${error.message}`),
      );
      worker.on('error', (error) => this.log.warn(`worker ${name}: ${error.message}`));
      this.workers.push(worker);
    }
    await Promise.all(this.workers.map((w) => w.waitUntilReady()));
    this.log.log(`workers up on ${queues.join(', ')} (prefix ${prefix}); handlers: ${this.registry.names().join(', ')}`);
  }

  async stop(): Promise<void> {
    const workers = this.workers.splice(0);
    await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }
}
