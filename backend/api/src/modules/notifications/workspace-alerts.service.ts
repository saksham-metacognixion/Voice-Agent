import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, isUniqueViolation, withWorkspace } from '@portal/db';
import type { ActiveAlertsResponse, AlertResponse, AlertType } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { EventsService } from '../events';

/** The `alerts` SSE topic (§16) and its frame types, named once. */
export const AlertEvents = {
  topic: 'alerts',
  /** `{alert}` — a new open alert for the D1 banner. */
  opened: 'opened',
  /** `{id, key}` — the condition cleared. */
  resolved: 'resolved',
  dismissed: 'dismissed',
} as const;

/** Key of the §5.4 auto top-up alert: one open row per workspace, resolved when a top-up lands. */
export const AUTO_TOPUP_FAILED_KEY = 'auto_topup_failed';

export interface OpenAlertInput {
  type: AlertType;
  /** Dedupe key of the open state; see `alerts_open_key_idx`. */
  key: string;
  threshold?: number | null;
  meta?: Record<string, unknown>;
  channel?: string;
}

export type OpenAlertOutcome = { created: true; id: string } | { created: false; id: string | null };

/**
 * The customer-facing alert state (§5.4 low balance, §5.3 rental, §14.3 concurrency).
 *
 * An alert is a row in `alerts` with a `key`. While the row is open (`resolved_at` NULL)
 * the same key cannot be opened again — `alerts_open_key_idx` refuses the INSERT — which
 * is the whole anti-spam rule: a schedule that runs every fifteen minutes and finds the
 * balance still low creates nothing. `resolve()` closes the row when the condition
 * clears, and the *next* crossing opens a fresh one. Dismissal is a member hiding a
 * banner; it does not change the state machine.
 *
 * Writes run on `adminDb` (schedules and listeners have no request context); the two
 * customer reads run inside `withWorkspace` so RLS is the second guard.
 */
@Injectable()
export class WorkspaceAlertsService {
  private readonly log = new Logger(WorkspaceAlertsService.name);

  constructor(private readonly events: EventsService) {}

  /**
   * Opens the alert unless one with this key is already open. Idempotent under two
   * concurrent callers: one INSERT, and `alerts_open_key_idx` decides — the loser reads
   * the winner's row. One round trip on the path every call-ended debit takes.
   */
  async open(workspaceId: string, input: OpenAlertInput): Promise<OpenAlertOutcome> {
    let row: Awaited<ReturnType<typeof adminDb.alert.create>>;
    try {
      row = await adminDb.alert.create({
        data: {
          tenantId: workspaceId,
          type: input.type,
          key: input.key,
          threshold: input.threshold ?? null,
          channel: input.channel ?? 'in_app',
          sentAt: new Date(),
          metaJson: (input.meta ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await adminDb.alert.findFirst({ where: { tenantId: workspaceId, key: input.key, resolvedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      return { created: false, id: existing?.id ?? null };
    }
    await this.events.publish(workspaceId, AlertEvents.topic, AlertEvents.opened, { alert: toResponse(row) }).catch(() => null);
    return { created: true, id: row.id };
  }

  /** Closes every open alert whose key matches exactly, or starts with `prefix`. Returns how many closed. */
  async resolve(workspaceId: string, match: { key: string } | { prefix: string }): Promise<number> {
    const where: Prisma.AlertWhereInput = {
      tenantId: workspaceId,
      resolvedAt: null,
      ...('key' in match ? { key: match.key } : { key: { startsWith: match.prefix } }),
    };
    const open = await adminDb.alert.findMany({ where, select: { id: true, key: true } });
    if (open.length === 0) return 0;
    const now = new Date();
    const { count } = await adminDb.alert.updateMany({ where: { id: { in: open.map((a) => a.id) }, resolvedAt: null }, data: { resolvedAt: now } });
    for (const alert of open) {
      await this.events.publish(workspaceId, AlertEvents.topic, AlertEvents.resolved, { id: alert.id, key: alert.key }).catch(() => null);
    }
    return count;
  }

  /** Keys of the alerts currently open for a workspace and type, for the pure deciders. */
  async openKeys(workspaceId: string, type: AlertType): Promise<Set<string>> {
    const rows = await adminDb.alert.findMany({ where: { tenantId: workspaceId, type, resolvedAt: null, key: { not: null } }, select: { key: true } });
    return new Set(rows.map((r) => r.key!));
  }

  // ------------------------------------------------------------------ customer reads

  /** GET /alerts/active — open and not dismissed, newest first. */
  async active(ctx: WorkspaceContext): Promise<ActiveAlertsResponse> {
    const rows = await withWorkspace(ctx, (db) =>
      db.alert.findMany({ where: { tenantId: ctx.workspaceId, resolvedAt: null, dismissedAt: null }, orderBy: { createdAt: 'desc' }, take: 50 }),
    );
    return { items: rows.map(toResponse) };
  }

  /** POST /alerts/:id/dismiss — hides the banner for everyone in the workspace. */
  async dismiss(ctx: WorkspaceContext, alertId: string): Promise<{ dismissed: boolean }> {
    const result = await withWorkspace(ctx, async (db) => {
      const row = await db.alert.findUnique({ where: { id: alertId }, select: { id: true, dismissedAt: true } });
      if (!row) throw AppError.notFound('Alert');
      if (row.dismissedAt) return { dismissed: false };
      await db.alert.update({ where: { id: alertId }, data: { dismissedAt: new Date() } });
      return { dismissed: true };
    });
    if (result.dismissed) await this.events.publish(ctx.workspaceId, AlertEvents.topic, AlertEvents.dismissed, { id: alertId }).catch(() => null);
    return result;
  }
}

export function toResponse(row: { id: string; type: string; threshold: Prisma.Decimal | null; metaJson: Prisma.JsonValue | null; createdAt: Date; resolvedAt: Date | null }): AlertResponse {
  return {
    id: row.id,
    type: row.type as AlertType,
    threshold: row.threshold === null ? null : row.threshold.toNumber(),
    meta: row.metaJson && typeof row.metaJson === 'object' && !Array.isArray(row.metaJson) ? (row.metaJson as Record<string, unknown>) : null,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
  };
}
