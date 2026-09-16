import { Injectable, Logger } from '@nestjs/common';
import { JobQueues } from './job-queues.service';
import { QUEUES, SCHEDULES } from './jobs.constants';

/**
 * §13.11 Job Schedulers, registered **idempotently on boot** (architecture §12): BullMQ's
 * `upsertJobScheduler` keys each schedule by id, so a redeploy or a second worker updates
 * the existing schedule instead of adding a duplicate. Every scheduled job runs on the
 * `scheduled` queue with concurrency 1.
 */
@Injectable()
export class SchedulerRegistrar {
  private readonly log = new Logger(SchedulerRegistrar.name);

  constructor(private readonly queues: JobQueues) {}

  async register(): Promise<void> {
    const queue = this.queues.queue(QUEUES.scheduled);
    for (const spec of SCHEDULES) {
      const repeat = spec.every ? { every: spec.every } : { pattern: spec.pattern! };
      await queue.upsertJobScheduler(spec.name, repeat, {
        name: spec.name,
        data: {},
        opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } },
      });
    }
    this.log.log(`${SCHEDULES.length} job schedulers registered (${SCHEDULES.filter((s) => s.status === 'live').length} live)`);
  }
}
