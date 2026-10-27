import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminWebhookEventDetail,
  AdminWebhookEventResponse,
  AdminWebhookEventsQuery,
  AdminWebhookReplayResponse,
  Page,
  StaffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import { JobQueues, QUEUES } from '../jobs';
import { WebhookProcessingService, webhookTenantHint } from '../webhooks';
import { iso, uuidParam, idMatch } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';
import { redactWebhookPayload } from './webhook-payload';

/**
 * SA12 "Webhook events" (D12 §11). The rows are `webhook_events` as the receivers store
 * them (§13.10). The customer is `webhook_events.tenant_id`, which the worker writes once
 * the event is processed — for a call, the workspace `calls` billed it to, found by the
 * agent / number fallback when the call carried no metadata (ADR 0011 §2). A row not
 * settled yet falls back to what its payload says (`webhookTenantHint`): Stripe's
 * `metadata.workspace_id`, Retell's `call.metadata.tenant_id`. Reading the payload alone
 * showed "–" for a call billed to a workspace, and left it off that customer's tab.
 * Replay runs the stored body through the same handler the queue runs
 * (`WebhookProcessingService.replay`), inline, so the staff member sees the outcome.
 *
 * The stored body is a whole call for the voice platform — recordings and transcript
 * included — so opening one is a logged read (QA-033): the sensitive fields are blanked
 * unless the role has `can_listen_recordings`, and every view writes `webhook.payload_viewed`
 * (which fields were sensitive and whether they were shown, never their values). The list
 * and the replay answer carry no payload at all.
 */
@Injectable()
export class AdminWebhooksService {
  private readonly log = new Logger(AdminWebhooksService.name);

  constructor(
    private readonly processing: WebhookProcessingService,
    private readonly queues: JobQueues,
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
  ) {}

  async list(query: AdminWebhookEventsQuery): Promise<Page<AdminWebhookEventResponse>> {
    const where: Prisma.WebhookEventWhereInput = {};
    if (query.provider) where.provider = query.provider;
    if (query.status === 'processed') where.processedAt = { not: null };
    if (query.status === 'pending') Object.assign(where, { processedAt: null, error: null });
    if (query.status === 'failed')
      Object.assign(where, { processedAt: null, error: { not: null } });
    if (query.q)
      where.OR = [
        { externalId: { contains: query.q } },
        { eventType: { contains: query.q } },
        ...idMatch(query.q),
      ];
    if (query.tenant_id) {
      // The settled workspace, or — for a row the worker has not attributed yet — what the
      // payload names. A row attributed to another workspace never matches on its payload.
      where.AND = [
        {
          OR: [
            { tenantId: query.tenant_id },
            {
              tenantId: null,
              OR: [
                {
                  payloadJson: {
                    path: ['data', 'object', 'metadata', 'workspace_id'],
                    equals: query.tenant_id,
                  },
                },
                { payloadJson: { path: ['call', 'metadata', 'tenant_id'], equals: query.tenant_id } },
                {
                  payloadJson: {
                    path: ['data', 'object', 'metadata', 'tenant_id'],
                    equals: query.tenant_id,
                  },
                },
              ],
            },
          ],
        },
      ];
    }
    const rows = await adminDb.webhookEvent.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    const items = await this.decorate(page.items);
    return { ...page, items };
  }

  async get(
    staff: StaffContext,
    idRaw: string,
    request: FastifyRequest,
  ): Promise<AdminWebhookEventDetail> {
    const id = uuidParam(idRaw, 'Webhook event');
    const row = await adminDb.webhookEvent.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Webhook event');
    const [item] = await this.decorate([row]);
    const { can_listen_recordings: full } = await this.limits.limitsFor(staff.role);
    const blanked = redactWebhookPayload(row.payloadJson);
    // Audited before it is answered: no audit row, no payload.
    await this.audit.record({
      staff,
      action: 'webhook.payload_viewed',
      targetType: 'webhook_event',
      targetId: id,
      tenantId: item!.tenant_id,
      after: {
        provider: row.provider,
        event_type: row.eventType,
        access: blanked.redacted.length === 0 ? 'no_sensitive_fields' : full ? 'full' : 'redacted',
        sensitive_fields: blanked.redacted,
      },
      request,
    });
    return {
      ...item!,
      payload: full ? row.payloadJson : blanked.payload,
      payload_redacted: !full && blanked.redacted.length > 0,
    };
  }

  async replay(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminWebhookReplayResponse> {
    const id = uuidParam(idRaw, 'Webhook event');
    const row = await adminDb.webhookEvent.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Webhook event');
    const before = { processed_at: iso(row.processedAt), error: row.error };
    const tenantId = this.tenantOf(row);
    // A replay runs the handler's own transactions (a credit, a call row), which no audit
    // write can join. The request is therefore recorded *before* anything runs — no audit
    // row, no write — and the outcome as a second row once the handler has answered.
    await this.audit.record({
      staff,
      action: 'webhook.replay_requested',
      targetType: 'webhook_event',
      targetId: id,
      tenantId,
      reasonCode: body.reason_code,
      note: body.note,
      before,
      request,
    });
    let result: { outcome: string; reason?: string };
    try {
      result = await this.processing.replay(id);
    } catch (error) {
      result = {
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    // The replay may have just attributed the row (`WebhookEventsService.attribute`).
    const fresh = await adminDb.webhookEvent.findUniqueOrThrow({ where: { id } });
    await this.audit.record({
      staff,
      action: 'webhook.replayed',
      targetType: 'webhook_event',
      targetId: id,
      tenantId: this.tenantOf(fresh) ?? tenantId,
      reasonCode: body.reason_code,
      note: body.note,
      before,
      after: { outcome: result.outcome, reason: result.reason ?? null },
      request,
    });
    this.log.warn(
      `webhook ${id} (${row.provider} ${row.eventType}) replayed by ${staff.email}: ${result.outcome}`,
    );
    // The row as it is now, without its body: a replay is not a payload view.
    const [event] = await this.decorate([fresh]);
    return { event: event!, outcome: result.outcome, reason: result.reason ?? null };
  }

  private async decorate(
    rows: Array<{
      id: string;
      provider: string;
      externalId: string;
      eventType: string;
      payloadJson: unknown;
      receivedAt: Date;
      processedAt: Date | null;
      error: string | null;
      tenantId: string | null;
    }>,
  ): Promise<AdminWebhookEventResponse[]> {
    const tenantIds = [
      ...new Set(
        rows
          .map((r) => this.tenantOf(r))
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    const tenants = tenantIds.length
      ? await adminDb.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    return Promise.all(
      rows.map(async (r) => {
        const tenantId = this.tenantOf(r);
        const queueState = r.processedAt
          ? null
          : await this.queues.stateOf(QUEUES.webhooks, `wh-${r.id}`, 300);
        return {
          id: r.id,
          provider: r.provider,
          external_id: r.externalId,
          event_type: r.eventType,
          status: r.processedAt ? 'processed' : r.error ? 'failed' : 'pending',
          tenant_id: tenantId,
          tenant_name: tenantId ? (names.get(tenantId) ?? null) : null,
          received_at: r.receivedAt.toISOString(),
          processed_at: iso(r.processedAt),
          error: r.error,
          queue_state: queueState,
          attempts: null,
        } satisfies AdminWebhookEventResponse;
      }),
    );
  }

  /** The settled workspace, else what the payload names (a row the worker has not attributed yet). */
  private tenantOf(row: { provider: string; payloadJson: unknown; tenantId: string | null }): string | null {
    return row.tenantId ?? webhookTenantHint(row.provider, row.payloadJson).tenantId;
  }
}
