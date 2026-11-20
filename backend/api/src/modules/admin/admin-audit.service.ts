import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import {
  ADMIN_AUDIT_EXPORT_MAX_ROWS,
  type AdminAuditEntry,
  type AdminAuditFilters,
  type AdminAuditQuery,
  type Page,
} from '@portal/schemas';
import { cursorArgs, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import { csvCell } from '../calls';
import { UUID_RE } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';

/** Rows read per round trip while streaming the export. */
const EXPORT_BATCH = 500;

const ROW_INCLUDE = {
  staff: { select: { email: true } },
  tenant: { select: { name: true } },
} satisfies Prisma.StaffAuditLogInclude;

type AuditRow = Prisma.StaffAuditLogGetPayload<{ include: typeof ROW_INCLUDE }>;

export const AUDIT_CSV_COLUMNS = [
  'created_at',
  'staff_email',
  'action',
  'target_type',
  'target_id',
  'customer_id',
  'customer_name',
  'reason_code',
  'note',
  'ip',
  'request_id',
  'view_as_session',
  'before',
  'after',
] as const;

/**
 * SA14 (admin §10): the staff audit log, as a page and as a CSV. Both read the same
 * filters (`auditWhere`), so an export is exactly the rows the screen was showing.
 * `before`/`after` were redacted when the row was written (`StaffAuditService.redact`).
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly audit: StaffAuditService) {}

  async list(query: AdminAuditQuery): Promise<Page<AdminAuditEntry>> {
    const rows = await adminDb.staffAuditLog.findMany({
      where: auditWhere(query),
      include: ROW_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    return { ...page, items: page.items.map(toEntry) };
  }

  /**
   * An export is itself a row of the log (`audit.exported`, with the filters): what it
   * carries — notes, IPs, before/after — leaves the console. Written before the first
   * byte, so a failure here is an ordinary error response and nothing is sent.
   */
  async recordExport(staff: StaffContext, filters: AdminAuditFilters, request: FastifyRequest): Promise<void> {
    await this.audit.record({ staff, action: 'audit.exported', targetType: 'staff_audit_log', after: { filters }, request });
  }

  /** `GET /admin/audit/export`: keyset batches, newest first, at most `ADMIN_AUDIT_EXPORT_MAX_ROWS`. */
  async *exportCsv(filters: AdminAuditFilters): AsyncGenerator<string> {
    const where = auditWhere(filters);
    yield `${AUDIT_CSV_COLUMNS.join(',')}\r\n`;

    let last: { createdAt: Date; id: string } | null = null;
    let written = 0;
    while (written < ADMIN_AUDIT_EXPORT_MAX_ROWS) {
      const take = Math.min(EXPORT_BATCH, ADMIN_AUDIT_EXPORT_MAX_ROWS - written);
      const after: Prisma.StaffAuditLogWhereInput | null = last
        ? {
            OR: [
              { createdAt: { lt: last.createdAt } },
              { createdAt: last.createdAt, id: { lt: last.id } },
            ],
          }
        : null;
      const rows: AuditRow[] = await adminDb.staffAuditLog.findMany({
        where: after ? { AND: [where, after] } : where,
        include: ROW_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
      });
      for (const row of rows) yield auditCsvRow(row);
      written += rows.length;
      if (rows.length < take) return;
      last = rows[rows.length - 1]!;
    }
  }
}

/**
 * The filters as a Prisma predicate. A typed `staff` or `customer` that is an id matches
 * that id; anything else matches part of the staff email or name, or of the workspace
 * name, case ignored — so "padma" and "Bright" find rows instead of being dropped.
 */
export function auditWhere(f: AdminAuditFilters): Prisma.StaffAuditLogWhereInput {
  const and: Prisma.StaffAuditLogWhereInput[] = [];
  if (f.staff_id) and.push({ staffId: f.staff_id });
  if (f.staff)
    and.push(
      UUID_RE.test(f.staff)
        ? { staffId: f.staff.toLowerCase() }
        : {
            staff: {
              OR: [
                { email: { contains: f.staff, mode: 'insensitive' } },
                { name: { contains: f.staff, mode: 'insensitive' } },
              ],
            },
          },
    );
  if (f.tenant_id) and.push({ tenantId: f.tenant_id });
  if (f.customer)
    and.push(
      UUID_RE.test(f.customer)
        ? { tenantId: f.customer.toLowerCase() }
        : { tenant: { name: { contains: f.customer, mode: 'insensitive' } } },
    );
  if (f.action) and.push({ action: { startsWith: f.action } });
  if (f.target_id) and.push({ targetId: f.target_id });
  return and.length ? { AND: and } : {};
}

function toEntry(r: AuditRow): AdminAuditEntry {
  return {
    id: r.id,
    staff_id: r.staffId,
    staff_email: r.staff.email,
    action: r.action,
    target_type: r.targetType,
    target_id: r.targetId,
    tenant_id: r.tenantId,
    tenant_name: r.tenant?.name ?? null,
    reason_code: r.reasonCode,
    note: r.note,
    before: r.beforeJson ?? null,
    after: r.afterJson ?? null,
    ip: r.ip,
    impersonation_id: r.impersonationId,
    request_id: r.requestId,
    created_at: r.createdAt.toISOString(),
  };
}

export function auditCsvRow(r: AuditRow): string {
  const json = (v: Prisma.JsonValue | null) => (v === null ? null : JSON.stringify(v));
  const cells = [
    r.createdAt.toISOString(),
    r.staff.email,
    r.action,
    r.targetType,
    r.targetId,
    r.tenantId,
    r.tenant?.name ?? null,
    r.reasonCode,
    r.note,
    r.ip,
    r.requestId,
    r.impersonationId,
    json(r.beforeJson),
    json(r.afterJson),
  ];
  return `${cells.map(csvCell).join(',')}\r\n`;
}
