import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import { OpsAlertService } from '../alerts';
import { RetellGateway } from '../retell';
import { type InternalCallFacts, type ReconciliationMetrics, driftThresholdPct, previousUtcDay, reconcile } from './reconcile';

export type ReconciliationStatus = 'ok' | 'drift' | 'partial' | 'provider_error';

export interface ReconciliationOutcome {
  runId: string;
  window: { start: Date; end: Date };
  status: ReconciliationStatus;
  metrics: ReconciliationMetrics | null;
  thresholdPct: number;
  /** True when *this* run raised the ops alert; a rerun of an already-alerted window is false. */
  alerted: boolean;
  error?: string;
}

/**
 * §13.11 `reconcile-calls` (§14.2): the platform's `list-calls` for a window against our
 * `calls`, persisted in `reconciliation_runs`, alerting once per window when drift is past
 * `RECONCILE_DRIFT_THRESHOLD_PCT`.
 *
 * Idempotent on the window: the row is upserted on `(window_start, window_end)`, so a
 * rerun refreshes the numbers rather than adding a second run, and the ops alert is
 * gated by `alerted_at` with a conditional update — two workers reconciling the same
 * night cannot both page. A provider error is a recorded run (`provider_error`) and one
 * alert, not drift: an empty list from a failing API must never read as "every call is
 * extra". A window the page cap truncated is `partial`, for the same reason.
 *
 * Runs on `adminDb`: the comparison is platform-wide (one platform workspace per
 * environment, ADR 0003), with the per-workspace split kept in `details_json`.
 */
@Injectable()
export class CallReconciliationService {
  private readonly log = new Logger(CallReconciliationService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly ops: OpsAlertService,
  ) {}

  async run(now = new Date(), window = previousUtcDay(now), thresholdPct = driftThresholdPct()): Promise<ReconciliationOutcome> {
    const internal = await this.internalCalls(window.start, window.end);
    const persist = (data: Omit<Prisma.ReconciliationRunUncheckedCreateInput, 'windowStart' | 'windowEnd'>) =>
      adminDb.reconciliationRun.upsert({
        where: { windowStart_windowEnd: { windowStart: window.start, windowEnd: window.end } },
        create: { windowStart: window.start, windowEnd: window.end, ...data },
        update: data,
      });

    let provider: Awaited<ReturnType<RetellGateway['listCallsInWindow']>>;
    try {
      provider = await this.retell.listCallsInWindow(window.start.getTime(), window.end.getTime());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const row = await persist({ status: 'provider_error', internalCalls: internal.length, thresholdPct, error: message.slice(0, 500) });
      this.log.error(`reconcile-calls ${label(window)}: provider list failed: ${message}`);
      const alerted = await this.alertOnce(row.id, {
        kind: 'reconcile_provider_error',
        severity: 'warning',
        title: 'Call reconciliation could not read the voice platform',
        fields: { window_start: window.start.toISOString(), window_end: window.end.toISOString(), internal_calls: internal.length, error: message.slice(0, 200) },
      });
      return { runId: row.id, window, status: 'provider_error', metrics: null, thresholdPct, alerted, error: message };
    }

    const metrics = reconcile(provider.calls, internal);
    const status: ReconciliationStatus = provider.partial ? 'partial' : metrics.drift_pct > thresholdPct ? 'drift' : 'ok';
    const byWorkspace = splitByWorkspace(provider.calls, internal, metrics);
    const row = await persist({
      status,
      providerCalls: metrics.provider_calls,
      internalCalls: metrics.internal_calls,
      matchedCalls: metrics.matched,
      missingIds: metrics.missing.slice(0, 500) as unknown as Prisma.InputJsonValue,
      extraIds: metrics.extra.slice(0, 500) as unknown as Prisma.InputJsonValue,
      providerSeconds: metrics.provider_seconds,
      internalSeconds: metrics.internal_seconds,
      providerCostCents: metrics.provider_cost_cents,
      internalCostCents: metrics.internal_cost_cents,
      driftPct: new Prisma.Decimal(metrics.drift_pct),
      thresholdPct: new Prisma.Decimal(thresholdPct),
      error: null,
      detailsJson: { id_drift_pct: metrics.id_drift_pct, seconds_drift_pct: metrics.seconds_drift_pct, partial: provider.partial, by_workspace: byWorkspace } as Prisma.InputJsonValue,
    });

    this.log.log(
      `reconcile-calls ${label(window)}: provider ${metrics.provider_calls} vs ours ${metrics.internal_calls} (${metrics.matched} matched, ${metrics.missing.length} missing, ${metrics.extra.length} extra); ` +
        `seconds ${metrics.provider_seconds} vs ${metrics.internal_seconds}; cost ${metrics.provider_cost_cents}¢ vs ${metrics.internal_cost_cents}¢; drift ${metrics.drift_pct}% (threshold ${thresholdPct}%) → ${status}`,
    );

    let alerted = false;
    if (status === 'drift' || status === 'partial') {
      alerted = await this.alertOnce(row.id, {
        kind: status === 'drift' ? 'reconcile_drift' : 'reconcile_partial',
        severity: status === 'drift' ? 'critical' : 'warning',
        title: status === 'drift' ? `Call reconciliation drift ${metrics.drift_pct}% exceeds ${thresholdPct}%` : 'Call reconciliation window was truncated by the page cap',
        fields: {
          run_id: row.id,
          window_start: window.start.toISOString(),
          window_end: window.end.toISOString(),
          provider_calls: metrics.provider_calls,
          internal_calls: metrics.internal_calls,
          missing: metrics.missing.length,
          extra: metrics.extra.length,
          id_drift_pct: metrics.id_drift_pct,
          seconds_drift_pct: metrics.seconds_drift_pct,
          missing_sample: metrics.missing.slice(0, 5).join(',') || null,
        },
      });
    }
    return { runId: row.id, window, status, metrics, thresholdPct, alerted };
  }

  /** Sends the alert only if this run flips `alerted_at` from NULL — once per window, whoever runs it. */
  private async alertOnce(runId: string, alert: Parameters<OpsAlertService['send']>[0]): Promise<boolean> {
    const { count } = await adminDb.reconciliationRun.updateMany({ where: { id: runId, alertedAt: null }, data: { alertedAt: new Date() } });
    if (count === 0) return false;
    await this.ops.send(alert);
    return true;
  }

  /** Our calls in the window: everything that reached the platform (declines never did). */
  private async internalCalls(start: Date, end: Date): Promise<InternalCallFacts[]> {
    const rows = await adminDb.call.findMany({
      where: { startedAt: { gte: start, lt: end }, status: { not: 'declined' } },
      select: { id: true, tenantId: true, durationS: true, retellCostCents: true, creditsCharged: true },
    });
    return rows.map((r) => ({ id: r.id, workspace_id: r.tenantId, duration_s: r.durationS, retell_cost_cents: r.retellCostCents, billable: (r.creditsCharged?.toNumber() ?? 0) > 0 }));
  }
}

function label(window: { start: Date; end: Date }): string {
  return `${window.start.toISOString().slice(0, 10)}`;
}

/** Counts per workspace, for the investigation: which tenant the missing calls belong to, where known. */
function splitByWorkspace(
  provider: readonly { call_id: string; workspace_id: string | null }[],
  internal: readonly InternalCallFacts[],
  metrics: ReconciliationMetrics,
): Record<string, { provider: number; internal: number; missing: number; extra: number }> {
  const out: Record<string, { provider: number; internal: number; missing: number; extra: number }> = {};
  const bucket = (ws: string | null) => (out[ws ?? 'unknown'] ??= { provider: 0, internal: 0, missing: 0, extra: 0 });
  const missing = new Set(metrics.missing);
  const extra = new Set(metrics.extra);
  for (const c of provider) {
    const b = bucket(c.workspace_id);
    b.provider += 1;
    if (missing.has(c.call_id)) b.missing += 1;
  }
  for (const c of internal) {
    const b = bucket(c.workspace_id);
    b.internal += 1;
    if (extra.has(c.id)) b.extra += 1;
  }
  return out;
}
