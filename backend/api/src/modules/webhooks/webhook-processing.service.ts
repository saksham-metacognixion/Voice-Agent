import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import type Stripe from 'stripe';
import { StripeEventHandler } from '../billing';
import { JobQueues } from '../jobs';
import { DisposableEmailRefused, SecondIdentityRefused, UsersService } from '../auth';
import { RetellEventHandler } from './retell-events.handler';
import { WebhookEventsService, settledWithNote } from './webhook-events.service';

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
    private readonly users: UsersService,
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

    const result = await this.events.process(row.id, () => this.dispatch(row));
    await this.events.attribute(row);
    this.log.log(`${row.provider} ${row.eventType} ${row.externalId}: ${JSON.stringify(result)}`);
    return result as { outcome: string; reason?: string };
  }

  /**
   * SA12 "Replay" (D12): runs the stored event through its handler again whether or not
   * it was processed. Safe because every handler is idempotent — the call debit collides
   * on `credit_ledger (ref_id) WHERE reason = 'call'`, a Stripe fulfilment finds the
   * purchase already `paid`, the auth upsert is keyed on the `sub` — so a replay is a way
   * to re-derive state after a bug fix, never a way to bill twice. The outcome lands on
   * the row like a first delivery.
   */
  async replay(eventId: string): Promise<{ outcome: string; reason?: string }> {
    const row = await adminDb.webhookEvent.findUnique({
      where: { id: eventId },
      select: { id: true, provider: true, eventType: true, externalId: true, payloadJson: true, processedAt: true },
    });
    if (!row) return { outcome: 'ignored', reason: `webhook_events ${eventId} does not exist` };
    const result = await this.events.process(row.id, () => this.dispatch(row));
    // A replay is how a row from before `tenant_id` existed, or one settled while its call
    // had no row yet, gets its workspace too.
    await this.events.attribute(row);
    this.log.warn(`replay ${row.provider} ${row.eventType} ${row.externalId}: ${JSON.stringify(result)}`);
    return result as { outcome: string; reason?: string };
  }

  private async dispatch(row: { provider: string; payloadJson: unknown }): Promise<unknown> {
    {
      switch (row.provider) {
        case 'retell':
          return this.retell.handle(row.payloadJson);
        case 'stripe':
          return this.stripe.handle(row.payloadJson as unknown as Pick<Stripe.Event, 'id' | 'type' | 'data'>);
        case 'auth':
          // §13.2 step 1. The upsert is idempotent on the Auth0 `sub`, so a replay — from
          // the provider, from the sweeper, or from SA12 — mirrors the same user again
          // rather than creating a second one.
          //
          // A second identity for an email someone already holds is refused for good, so
          // it settles the event instead of throwing: thrown, it spent eight attempts and
          // then the sweeper replaced the spent job and started over, for ever. The
          // reason stays on the row for SA12.
          try {
            return await this.users.upsert(this.users.parse(row.payloadJson));
          } catch (error) {
            if (error instanceof DisposableEmailRefused) {
              return settledWithNote({ outcome: 'refused', reason: 'disposable_email' }, error.message);
            }
            if (!(error instanceof SecondIdentityRefused)) throw error;
            return settledWithNote({ outcome: 'refused', reason: 'email_belongs_to_another_identity' }, error.message);
          }
        default:
          return { outcome: 'ignored' as const, reason: `no handler for provider ${row.provider}` };
      }
    }
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
      if (row.provider !== 'retell' && row.provider !== 'stripe' && row.provider !== 'auth') continue;
      if ((await this.queues.enqueueWebhook(row.id, row.provider)) !== 'failed') queued += 1;
    }
    if (rows.length) this.log.warn(`webhook sweeper: ${rows.length} unprocessed, ${queued} re-enqueued`);
    return { found: rows.length, queued };
  }
}
