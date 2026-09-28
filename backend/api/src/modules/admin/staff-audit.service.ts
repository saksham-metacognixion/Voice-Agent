import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type { ReasonCode } from '@portal/schemas';
import type { StaffContext } from '../auth';

export interface StaffAuditInput {
  staff: StaffContext;
  /** `<area>.<verb>`: `customer.paused`, `credits.adjusted`, `pricing.published`, `impersonation.started`… */
  action: string;
  targetType?: string;
  targetId?: string;
  tenantId?: string | null;
  reasonCode?: ReasonCode | null;
  note?: string | null;
  before?: unknown;
  after?: unknown;
  impersonationId?: string | null;
  /** For the IP and the request id. */
  request?: Pick<FastifyRequest, 'ip' | 'id'> | null;
}

/**
 * Field names that hold a credential. Matched on names, not the substring `key`: a flag's
 * `key`, an adjustment's `idempotency_key` and a Stripe `lookup_key` are identifiers, and
 * blanking them left SA14 unable to say which flag changed (review, 28 Sep).
 */
const SECRET_KEY =
  /(secret|password|passwd|token|authorization|cookie|credential|api_?key|private_?key|signing_?key|access_?key)/i;

/**
 * Admin §10: every customer-affecting staff write lands in `staff_audit_log` — who, what,
 * on which resource, in which workspace, why (Appendix B), the before/after, the IP and
 * the request id. The table is append-only (ADR 0006), so a row written here is the
 * record; there is no update path.
 *
 * A write that cannot be audited is a write that did not happen: this runs *inside* the
 * caller's transaction when one is open (`tx`), so the mutation and its audit row commit
 * together, and a failure here rolls the mutation back.
 */
@Injectable()
export class StaffAuditService {
  private readonly log = new Logger(StaffAuditService.name);

  async record(
    input: StaffAuditInput,
    tx: Prisma.TransactionClient | typeof adminDb = adminDb,
  ): Promise<string> {
    const row = await tx.staffAuditLog.create({
      data: {
        staffId: input.staff.staffId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        tenantId: input.tenantId ?? null,
        reasonCode: input.reasonCode ?? null,
        note: input.note ?? null,
        beforeJson:
          input.before === undefined
            ? Prisma.DbNull
            : (redact(input.before) as Prisma.InputJsonValue),
        afterJson:
          input.after === undefined
            ? Prisma.DbNull
            : (redact(input.after) as Prisma.InputJsonValue),
        ip: input.request?.ip ?? null,
        impersonationId: input.impersonationId ?? null,
        requestId: input.request?.id ? String(input.request.id) : null,
      },
      select: { id: true },
    });
    this.log.log(
      `${input.staff.email} ${input.action}${input.targetId ? ` ${input.targetType ?? ''}:${input.targetId}` : ''}${input.reasonCode ? ` (${input.reasonCode})` : ''}`,
    );
    return row.id;
  }
}

/** Before/after snapshots never carry a secret-looking field, whatever the caller passed. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v);
    return out;
  }
  return value;
}
