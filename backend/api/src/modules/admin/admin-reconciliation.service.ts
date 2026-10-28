import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminReconciliationRun,
  AdminReconciliationRunRequest,
  AdminReconciliationsQuery,
  Page,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import { CallReconciliationService, previousUtcDay } from '../calls';
import { DAY_MS, iso, num } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';

/** How many missing / extra call ids a run carries to the console; the counts are whole. */
const IDS_SHOWN = 50;

type Row = Prisma.ReconciliationRunGetPayload<object>;

/**
 * SA12 "Reconciliation" (admin §9, §14.2): the nightly `reconcile-calls` runs — the
 * platform's calls for a UTC day against ours — and a run on demand for one day. The run
 * is the schedule's own `CallReconciliationService.run`: upserted per window, so running a
 * day again refreshes its row, and its ops alert stays once per window whoever runs it.
 */
@Injectable()
export class AdminReconciliationService {
  constructor(
    private readonly reconciliation: CallReconciliationService,
    private readonly audit: StaffAuditService,
  ) {}

  async list(query: AdminReconciliationsQuery): Promise<Page<AdminReconciliationRun>> {
    const rows = await adminDb.reconciliationRun.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: [{ windowStart: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    return { ...page, items: page.items.map(toRun) };
  }

  /**
   * One UTC day, default yesterday (the schedule's window). Today and later are refused:
   * a window still filling up would report every call of the afternoon as missing.
   */
  async run(staff: StaffContext, body: AdminReconciliationRunRequest, request: FastifyRequest): Promise<AdminReconciliationRun> {
    const window = body.date ? dayWindow(body.date) : previousUtcDay(new Date());
    if (window.end.getTime() > Date.now()) throw new AppError('VALIDATION_FAILED', 'Only a day that has ended can be reconciled.', [{ field: 'date', message: 'Pick yesterday or earlier.' }]);
    const day = window.start.toISOString().slice(0, 10);
    await this.audit.record({ staff, action: 'reconciliation.run_requested', targetType: 'reconciliation_window', targetId: day, reasonCode: body.reason_code, note: body.note, request });
    const outcome = await this.reconciliation.run(new Date(), window);
    await this.audit.record({ staff, action: 'reconciliation.ran', targetType: 'reconciliation_run', targetId: outcome.runId, after: { day, status: outcome.status, alerted: outcome.alerted }, request });
    return toRun(await adminDb.reconciliationRun.findUniqueOrThrow({ where: { id: outcome.runId } }));
  }
}

function dayWindow(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== date)
    throw new AppError('VALIDATION_FAILED', 'Not a calendar day.', [{ field: 'date', message: 'A day as YYYY-MM-DD' }]);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

function ids(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toRun(r: Row): AdminReconciliationRun {
  const missing = ids(r.missingIds);
  const extra = ids(r.extraIds);
  return {
    id: r.id,
    window_start: r.windowStart.toISOString(),
    window_end: r.windowEnd.toISOString(),
    status: r.status as AdminReconciliationRun['status'],
    provider_calls: r.providerCalls,
    internal_calls: r.internalCalls,
    matched_calls: r.matchedCalls,
    missing_ids: missing.slice(0, IDS_SHOWN),
    missing_count: missing.length,
    extra_ids: extra.slice(0, IDS_SHOWN),
    extra_count: extra.length,
    provider_seconds: r.providerSeconds,
    internal_seconds: r.internalSeconds,
    drift_pct: num(r.driftPct),
    threshold_pct: num(r.thresholdPct),
    alerted_at: iso(r.alertedAt),
    error: r.error,
    updated_at: r.updatedAt.toISOString(),
  };
}
