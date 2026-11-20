import { Injectable, Logger } from '@nestjs/common';
import { JobQueues } from './job-queues.service';
import { QUEUES, SCHEDULES, type ScheduleSpec } from './jobs.constants';

export interface SchedulerRegistration {
  /** Schedules upserted this call — always every entry of `SCHEDULES`. */
  registered: string[];
  /** Scheduler ids found in Redis that no longer exist in `SCHEDULES`, removed. */
  removed: string[];
  /** Job schedulers present after the call, from Redis. */
  present: number;
}

/**
 * §13.11 Job Schedulers, registered **idempotently on boot** (architecture §12).
 *
 * BullMQ's `upsertJobScheduler` keys each schedule by id: a redeploy, a worker restart or a
 * second worker updates the existing schedule rather than adding a duplicate, and a
 * changed interval replaces the pending next run. Two things are added here so the queue
 * cannot drift from the code:
 *
 *   - a scheduler whose id is no longer in `SCHEDULES` (renamed, retired) is removed —
 *     otherwise it would fire forever into a handler nobody registered and fail every tick;
 *   - the result is read back from Redis and logged, so "registered exactly once" is a
 *     number in the worker's boot line, not an assumption.
 *
 * Every scheduled job runs on the `scheduled` queue with concurrency 1 per worker, and each
 * tick takes a per-schedule Redis lock (ScheduledModule), so two workers never run the same
 * schedule at once.
 */
@Injectable()
export class SchedulerRegistrar {
  private readonly log = new Logger(SchedulerRegistrar.name);

  constructor(private readonly queues: JobQueues) {}

  async register(): Promise<SchedulerRegistration> {
    const queue = this.queues.queue(QUEUES.scheduled);
    const wanted = new Set<string>(SCHEDULES.map((s) => s.name));

    const existing = await queue.getJobSchedulers(0, -1, true);
    const removed: string[] = [];
    for (const scheduler of existing) {
      const id = scheduler.key ?? scheduler.name;
      if (!id || wanted.has(id)) continue;
      await queue.removeJobScheduler(id);
      removed.push(id);
      this.log.warn(`schedule ${id}: removed — no longer in SCHEDULES`);
    }

    const registered: string[] = [];
    for (const spec of SCHEDULES) {
      const repeat = spec.every ? { every: spec.every } : { pattern: spec.pattern! };
      await queue.upsertJobScheduler(spec.name, repeat, {
        name: spec.name,
        data: {},
        opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } },
      });
      registered.push(spec.name);
      this.log.log(`schedule ${spec.name}: ${describe(spec)} (${spec.status})`);
    }

    const present = (await queue.getJobSchedulers(0, -1, true)).length;
    this.log.log(`${present} job schedulers present (${registered.length} registered, ${removed.length} removed, ${SCHEDULES.filter((s) => s.status === 'live').length} live)`);
    if (present !== SCHEDULES.length) this.log.error(`expected ${SCHEDULES.length} job schedulers after registration, found ${present}`);
    return { registered, removed, present };
  }
}

export function describe(spec: ScheduleSpec): string {
  if (spec.every) return spec.every % 60_000 === 0 ? `every ${spec.every / 60_000} min` : `every ${spec.every} ms`;
  return `cron "${spec.pattern}"`;
}
