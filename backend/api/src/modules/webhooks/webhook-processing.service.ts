import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import type Stripe from 'stripe';
import { StripeEventHandler } from '../billing';
import { JobQueues } from '../jobs';
import { RetellEventHandler } from './retell-events.handler';
import { WebhookEventsService } from './webhook-events.service';

/** A stored event that is still unprocessed after this long is re-enqueued by the sweeper. */
export const SWEEP_AFTER_MS = 60_000;

/**
 * The worker side of §13.10: takes one `webhook_events` row and runs its provider's
 * handler, exactly once successfully.
 *
 * This is where the Retell rule lives — **never 5xx to Retell after the event is stored**
 * (architecture §11). The HTTP handler stores and answers; failures and retries belong to
 * BullMQ, which backs off, keeps the error on the row and stops after eight attempts
 * rather than letting a provider's retry policy be our queue. Stripe now takes the same
 * path, which retires the 500-on-failure exception ADR 0010 §5 left open for D4.
 */
@Injectable()
export class WebhookProcessingService {
  private readonly log = new Logger(WebhookProcessingService.name);

  constructor(
    private readonly events: WebhookEventsService,
    private readonly retell: RetellEventHandler,
    private readonly stripe: StripeEventHandler,
    private readonly queues: JobQueues,
  ) {}

  /**
   * Processes the row if it has not been processed yet. A job that runs twice for one row
   * (BullMQ delivered it again after a worker died mid-flight) is a no-op the second time,
   * and the handlers are idempotent besides.
   */
  async process(eventId: string): Promise<{ outcome: string; reason?: string }> {
    const row = await adminDb.webhookEvent.findUnique({
      where: { id: eventId },
      select: { id: true, provider: true, eventType: true, externalId: true, payloadJson: true, processedAt: true },
    });
    if (!row) return { outcome: 'ignored', reason: `webhook_events ${eventId} does not exist` };
    if (row.processedAt) return { outcome: 'ignored', reason: 'already processed' };

    const result = await this.events.process(row.id, async () => {
      switch (row.provider) {
        case 'retell':
          return this.retell.handle(row.payloadJson);
        case 'stripe':
          return this.stripe.handle(row.payloadJson as unknown as Pick<Stripe.Event, 'id' | 'type' | 'data'>);
        default:
          return { outcome: 'ignored' as const, reason: `no handler for provider ${row.provider}` };
      }
    });
    this.log.log(`${row.provider} ${row.eventType} ${row.externalId}: ${JSON.stringify(result)}`);
    return result as { outcome: string; reason?: string };
  }

  /**
   * `webhook-sweeper` (§13.11): re-enqueues stored events that were never processed.
   *
   * The gap it closes is narrow and real — the row is committed and then the `add()` to
   * BullMQ fails, which is exactly what happens when Redis is the thing that is down.
   * Deterministic job ids make a re-enqueue of something already queued a no-op.
   */
  async sweep(olderThanMs = SWEEP_AFTER_MS, limit = 200): Promise<{ found: number; queued: number }> {
    const rows = await adminDb.webhookEvent.findMany({
      where: { processedAt: null, receivedAt: { lt: new Date(Date.now() - olderThanMs) } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true, provider: true, eventType: true, externalId: true },
    });
    let queued = 0;
    for (const row of rows) {
      if (row.provider !== 'retell' && row.provider !== 'stripe') continue;
      if ((await this.queues.enqueueWebhook(row.id, row.provider)) !== 'failed') queued += 1;
    }
    if (rows.length) this.log.warn(`webhook sweeper: ${rows.length} unprocessed, ${queued} re-enqueued`);
    return { found: rows.length, queued };
  }
}
