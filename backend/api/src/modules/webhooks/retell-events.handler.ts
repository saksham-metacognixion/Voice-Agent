import { Injectable, Logger } from '@nestjs/common';
import { CallsService, type LifecycleOutcome } from '../calls';
import { parseRetellWebhook } from '../retell';

export type RetellHandlerOutcome = LifecycleOutcome | { outcome: 'ignored'; reason: string };

/**
 * Routes one stored Retell webhook to the metering service (§13.10, §14.1).
 *
 * Idempotent by construction: every branch of `CallsService` re-reads the row before it
 * writes and the ledger debit is guarded by a unique index, so a BullMQ retry, a Retell
 * re-delivery (all three inbound retries carry the same `call_id`, ADR 0003 §1) and the
 * SA12 "Replay" button are the same operation run again.
 *
 * `transfer_*` and anything Retell adds later are stored and acknowledged, never dropped:
 * the payload is in `webhook_events` and can be replayed once a handler exists.
 */
@Injectable()
export class RetellEventHandler {
  private readonly log = new Logger(RetellEventHandler.name);

  constructor(private readonly calls: CallsService) {}

  async handle(payload: unknown): Promise<RetellHandlerOutcome> {
    const parsed = parseRetellWebhook(payload);
    switch (parsed.kind) {
      case 'lifecycle':
        return this.calls.handleLifecycle(parsed.event);
      case 'unsupported':
        this.log.log(`retell ${parsed.eventType} (${parsed.callId ?? 'no call id'}): stored, no handler`);
        return { outcome: 'ignored', reason: `unsupported event type ${parsed.eventType}` };
      case 'malformed':
        // Not thrown: a retry would re-parse the same bytes and fail identically, and
        // eight attempts of that is noise. The row keeps the payload for inspection.
        this.log.error(`retell webhook is malformed: ${parsed.reason}`);
        return { outcome: 'ignored', reason: `malformed payload: ${parsed.reason}` };
    }
  }
}
