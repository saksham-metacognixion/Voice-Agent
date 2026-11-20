import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import { webhookTenantHint } from './webhook-tenant';

export type WebhookProviderName = 'retell' | 'stripe' | 'auth';

export interface StoreInput {
  provider: WebhookProviderName;
  /** Stripe `event.id`; Retell `call_id`; Auth0 the `sub` of the user that was created. */
  externalId: string;
  eventType: string;
  payload: unknown;
}

export type StoreResult =
  /** First time we see it: process it. */
  | { kind: 'new'; id: string }
  /** Seen before and processed: answer 204 and do nothing. */
  | { kind: 'duplicate'; id: string }
  /** Seen before but processing failed or never finished: process it again. */
  | { kind: 'retry'; id: string; attempts: number };

/**
 * Exactly-once for provider webhooks (§13.10, §14.2), backed by the unique key
 * `webhook_events (provider, external_id, event_type)`.
 *
 * "Exactly once" here means exactly one *successful* processing. A duplicate of an event
 * that finished is a 204 no-op. A duplicate of one that failed is a retry — otherwise the
 * first transient error would make the event undeliverable forever, which for a
 * `checkout.session.completed` means a customer who paid and got nothing.
 *
 * Always on the admin connection: the workspace is only known after the payload is parsed
 * (ADR 0006).
 */
@Injectable()
export class WebhookEventsService {
  private readonly log = new Logger(WebhookEventsService.name);

  /**
   * `createMany({ skipDuplicates })`, not `create()` in a try/catch: Prisma logs every
   * query error at `error` level before the exception reaches us, so catching a duplicate
   * still printed a red `Unique constraint failed` line on every provider retry — a
   * routine, expected, handled event that looked like a failure in the logs. This
   * compiles to `INSERT … ON CONFLICT DO NOTHING`, so the database still holds the
   * guarantee and nothing throws on the ordinary replay. The id is generated here rather
   * than by the column default because createMany returns a count, not a row.
   */
  async store(input: StoreInput): Promise<StoreResult> {
    const id = randomUUID();
    const { count } = await adminDb.webhookEvent.createMany({
      data: [
        {
          id,
          provider: input.provider,
          externalId: input.externalId,
          eventType: input.eventType,
          payloadJson: input.payload as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return { kind: 'new', id };

    const existing = await adminDb.webhookEvent.findUniqueOrThrow({
      where: { provider_externalId_eventType: { provider: input.provider, externalId: input.externalId, eventType: input.eventType } },
      select: { id: true, processedAt: true, error: true },
    });
    if (existing.processedAt) {
      this.log.log(`${input.provider} ${input.eventType} ${input.externalId}: duplicate, already processed`);
      return { kind: 'duplicate', id: existing.id };
    }
    this.log.warn(`${input.provider} ${input.eventType} ${input.externalId}: seen before, not yet processed — retrying`);
    return { kind: 'retry', id: existing.id, attempts: existing.error ? 1 : 0 };
  }

  /** `note` is kept in `error` for an event that settled on a refusal (`settledWithNote`). */
  markProcessed(id: string, note: string | null = null): Promise<unknown> {
    return adminDb.webhookEvent.update({ where: { id }, data: { processedAt: new Date(), error: note } });
  }

  markFailed(id: string, error: unknown): Promise<unknown> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return adminDb.webhookEvent.update({ where: { id }, data: { error: message.slice(0, 2000) } });
  }

  /**
   * Records which workspace a processed event was settled against (`webhook_events.tenant_id`),
   * so SA12 names the customer the call was billed to. Run after the handler, not before:
   * for a call let through without metadata only the `calls` row knows (ADR 0011 §2).
   *
   *   - voice platform: the `calls` row's workspace, written on **every** row of the call
   *     still without one — a transfer event stored before the row existed is named when
   *     its `call_ended` lands; else our metadata, for an event with no call row
   *   - Stripe: our metadata, else the workspace holding the object's customer
   *   - auth: none
   *
   * Never fails the event: it is processed already, and the console falls back to the
   * payload. Returns the workspace, or null when there is none to name.
   */
  async attribute(row: { id: string; provider: string; externalId: string; payloadJson: unknown }): Promise<string | null> {
    try {
      const hint = webhookTenantHint(row.provider, row.payloadJson);
      if (row.provider === 'retell') {
        const call = await adminDb.call.findUnique({ where: { id: row.externalId }, select: { tenantId: true } });
        const tenantId = call?.tenantId ?? (await this.existingTenant(hint.tenantId));
        if (!tenantId) return null;
        await adminDb.webhookEvent.updateMany({
          where: call ? { provider: 'retell', externalId: row.externalId, tenantId: null } : { id: row.id, tenantId: null },
          data: { tenantId },
        });
        return tenantId;
      }
      if (row.provider === 'stripe') {
        const tenantId =
          (await this.existingTenant(hint.tenantId)) ??
          (hint.stripeCustomerId
            ? ((await adminDb.tenant.findUnique({ where: { stripeCustomerId: hint.stripeCustomerId }, select: { id: true } }))?.id ?? null)
            : null);
        if (!tenantId) return null;
        await adminDb.webhookEvent.updateMany({ where: { id: row.id, tenantId: null }, data: { tenantId } });
        return tenantId;
      }
      return null;
    } catch (error) {
      this.log.warn(`webhook ${row.id}: workspace not recorded: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** A workspace id the payload names, if that workspace exists (the column is a foreign key). */
  private async existingTenant(id: string | null): Promise<string | null> {
    if (!id) return null;
    return (await adminDb.tenant.findUnique({ where: { id }, select: { id: true } }))?.id ?? null;
  }

  /**
   * Runs `process` for a stored event and records the outcome. Rethrows so the caller
   * decides the HTTP answer: Stripe gets a 5xx and retries itself until the D4 queue owns
   * retries; Retell never does (ADR 0003).
   */
  async process<T>(id: string, process: () => Promise<T>): Promise<T> {
    try {
      const result = await process();
      await this.markProcessed(id, SETTLED_NOTE in Object(result) ? (result as Settled)[SETTLED_NOTE] : null);
      return result;
    } catch (error) {
      await this.markFailed(id, error).catch(() => undefined);
      throw error;
    }
  }

  /** SA12 "Replay": re-run one stored event through its handler, idempotently. */
  async replay<T>(id: string, handler: (payload: unknown) => Promise<T>): Promise<T> {
    const row = await adminDb.webhookEvent.findUniqueOrThrow({ where: { id } });
    return this.process(id, () => handler(row.payloadJson));
  }
}

const SETTLED_NOTE = Symbol('webhook settled note');
type Settled = { [SETTLED_NOTE]: string };

/**
 * A handler result for an event that is done but did not do what it asked — processed,
 * so it is never retried, with the reason kept on the row where SA12 shows it.
 */
export function settledWithNote<T extends object>(result: T, note: string): T {
  return Object.assign(result, { [SETTLED_NOTE]: note.slice(0, 2000) });
}
