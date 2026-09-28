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
import { WebhookProcessingService } from '../webhooks';
import { iso, record, uuidParam, idMatch } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';

/**
 * SA12 "Webhook events" (D12 §11). The rows are `webhook_events` as the receivers store
 * them (§13.10); the workspace is read out of the payload, because the table carries
 * none — Stripe puts ours in `metadata.workspace_id`, Retell in `call.metadata.tenant_id`.
 * Replay runs the stored body through the same handler the queue runs
 * (`WebhookProcessingService.replay`), inline, so the staff member sees the outcome.
 */
@Injectable()
export class AdminWebhooksService {
  private readonly log = new Logger(AdminWebhooksService.name);

  constructor(
    private readonly processing: WebhookProcessingService,
    private readonly queues: JobQueues,
    private readonly audit: StaffAuditService,
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
      where.AND = [
        {
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

  async get(idRaw: string): Promise<AdminWebhookEventDetail> {
    const id = uuidParam(idRaw, 'Webhook event');
    const row = await adminDb.webhookEvent.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Webhook event');
    const [item] = await this.decorate([row]);
    return { ...item!, payload: row.payloadJson };
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
    const tenantId = this.tenantOf(row.provider, row.payloadJson);
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
    await this.audit.record({
      staff,
      action: 'webhook.replayed',
      targetType: 'webhook_event',
      targetId: id,
      tenantId,
      reasonCode: body.reason_code,
      note: body.note,
      before,
      after: { outcome: result.outcome, reason: result.reason ?? null },
      request,
    });
    this.log.warn(
      `webhook ${id} (${row.provider} ${row.eventType}) replayed by ${staff.email}: ${result.outcome}`,
    );
    return { event: await this.get(id), outcome: result.outcome, reason: result.reason ?? null };
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
    }>,
  ): Promise<AdminWebhookEventResponse[]> {
    const tenantIds = [
      ...new Set(
        rows
          .map((r) => this.tenantOf(r.provider, r.payloadJson))
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
        const tenantId = this.tenantOf(r.provider, r.payloadJson);
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

  private tenantOf(provider: string, payload: unknown): string | null {
    const p = record(payload);
    const candidates =
      provider === 'stripe'
        ? [
            record(record(record(p.data).object).metadata).workspace_id,
            record(record(record(p.data).object).metadata).tenant_id,
          ]
        : provider === 'retell'
          ? [record(record(p.call).metadata).tenant_id]
          : [];
    const found = candidates.find((c) => typeof c === 'string' && /^[0-9a-f-]{36}$/i.test(c));
    return typeof found === 'string' ? found : null;
  }
}
