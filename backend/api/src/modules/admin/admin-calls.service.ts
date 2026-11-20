import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminCallFlagRequest,
  AdminCallResponse,
  AdminCallsQuery,
  AdminCreditAdjustResponse,
  Page,
  ReasonCode,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import { AdminCustomersService } from './admin-customers.service';
import { derivedUuid, iso, num, numOrNull, phoneQuery, record } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';

const WITH = {
  tenant: { select: { name: true } },
  agent: { select: { name: true } },
} satisfies Prisma.CallInclude;
type Row = Prisma.CallGetPayload<{ include: typeof WITH }>;

export interface CallRefundInput {
  reason_code: ReasonCode;
  note?: string;
  customer_text?: string;
  ticket_id?: number;
}

/**
 * SA8 and the SA2 "Calls" tab (D12 §4): the customer's D2 row plus the owner and the
 * platform cost. No transcript in a list and no recording link at all — recording
 * access is a logged, ticketed action (admin §10) that lands with SA8 in P2.
 *
 * Two writes (admin §9): a refund, which is a credit adjustment keyed on the call alone —
 * the SA4 `refund_call` macro and the Calls page are one path, so a call is refunded once
 * whichever screen asks — and a flag for a second look, whose history is the audit log.
 */
@Injectable()
export class AdminCallsService {
  private readonly log = new Logger(AdminCallsService.name);

  constructor(
    private readonly customers: AdminCustomersService,
    private readonly audit: StaffAuditService,
  ) {}

  async list(query: AdminCallsQuery): Promise<Page<AdminCallResponse>> {
    const where: Prisma.CallWhereInput = {};
    if (query.tenant_id) where.tenantId = query.tenant_id;
    if (query.status === 'missed') where.status = 'declined';
    else if (query.status) where.status = query.status;
    if (query.flagged) where.flaggedAt = query.flagged === 'true' ? { not: null } : null;
    if (query.q) {
      // SA8: call id, either number, and — D13 QA — the customer's or the agent's name,
      // so a support person can type what the caller told them. Numbers only for a query
      // that looks like one (QA-045).
      const digits = phoneQuery(query.q);
      where.OR = [
        { id: { startsWith: query.q } },
        ...(digits ? [{ fromNumber: { contains: digits } }, { toNumber: { contains: digits } }] : []),
        { tenant: { name: { contains: query.q, mode: 'insensitive' } } },
        { agent: { name: { contains: query.q, mode: 'insensitive' } } },
      ];
    }
    const rows = await adminDb.call.findMany({
      where,
      include: WITH,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    const refunds = await this.refundsOf(page.items);
    return { ...page, items: page.items.map((r) => toCall(r, refunds.get(r.id) ?? null)) };
  }

  async get(id: string): Promise<AdminCallResponse> {
    const row = await adminDb.call.findUnique({ where: { id }, include: WITH });
    if (!row) throw AppError.notFound('Call');
    return toCall(row, (await this.refundsOf([row])).get(row.id) ?? null);
  }

  /**
   * Gives back what the call cost — the agent leg and, for a transferred call, the
   * transferred leg — as one credit adjustment whose id is derived from the workspace and
   * the call. A second refund of the same call, from this route, from any ticket, or a
   * race of two of them, is `409 CONFLICT` naming where it happened; the credits move once.
   * `tenantId`, when given (a ticket's), must be the call's.
   */
  async refundCall(
    staff: StaffContext,
    callId: string,
    input: CallRefundInput,
    request: FastifyRequest,
    tenantId?: string,
  ): Promise<{ adjustment: AdminCreditAdjustResponse; credits: number }> {
    const call = await adminDb.call.findFirst({
      where: { id: callId, ...(tenantId ? { tenantId } : {}) },
      select: { id: true, tenantId: true, creditsCharged: true, transferCreditsCharged: true, startedAt: true, createdAt: true },
    });
    if (!call) throw AppError.notFound('Call');
    const charged = Math.round((num(call.creditsCharged) + num(call.transferCreditsCharged)) * 100) / 100;
    if (charged <= 0) throw new AppError('CONFLICT', 'This call was not charged; there is nothing to refund.');
    const key = refundKey(call.tenantId, call.id);
    const earlier = await adminDb.creditAdjustment.findUnique({ where: { id: key }, select: { ticketId: true } });
    if (earlier) throw alreadyRefunded(call.id, earlier.ticketId);
    const when = (call.startedAt ?? call.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const refund = await this.customers.adjustCreditsOnce(
      staff,
      call.tenantId,
      {
        delta: charged,
        reason_code: input.reason_code,
        note: [`Refund of call ${call.id}`, input.note].filter(Boolean).join(' — '),
        customer_text: input.customer_text ?? `Refund for the call on ${when} UTC`,
        ticket_id: input.ticket_id,
        idempotency_key: key,
      },
      request,
    );
    // Two requests racing past the check above: the credits moved once, for the other one.
    if (refund.replayed) {
      const winner = await adminDb.creditAdjustment.findUnique({ where: { id: key }, select: { ticketId: true } });
      throw alreadyRefunded(call.id, winner?.ticketId ?? null);
    }
    this.log.log(`call ${call.id} refunded ${charged} credits by ${staff.email} (${input.reason_code})`);
    return { adjustment: refund.adjustment, credits: charged };
  }

  /** Sets or clears the flag. Setting an already flagged call replaces its note; clearing an unflagged one writes nothing. */
  async flag(staff: StaffContext, id: string, body: AdminCallFlagRequest, request: FastifyRequest): Promise<AdminCallResponse> {
    const call = await adminDb.call.findUnique({ where: { id }, select: { id: true, tenantId: true, flaggedAt: true, flagNote: true } });
    if (!call) throw AppError.notFound('Call');
    if (!body.flagged && !call.flaggedAt) return this.get(id);
    await adminDb.$transaction(async (tx) => {
      await tx.call.update({
        where: { id },
        data: body.flagged
          ? { flaggedAt: call.flaggedAt ?? new Date(), flaggedBy: staff.staffId, flagNote: body.note ?? null }
          : { flaggedAt: null, flaggedBy: null, flagNote: null },
      });
      await this.audit.record(
        {
          staff,
          action: body.flagged ? 'call.flagged' : 'call.unflagged',
          targetType: 'call',
          targetId: id,
          tenantId: call.tenantId,
          reasonCode: body.reason_code,
          note: body.note,
          before: { flagged: Boolean(call.flaggedAt), note: call.flagNote },
          after: { flagged: body.flagged, note: body.flagged ? (body.note ?? null) : null },
          request,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** The refunded credits per call on a page: the adjustment ids are derived, so one lookup answers them all. */
  private async refundsOf(rows: Array<{ id: string; tenantId: string }>): Promise<Map<string, number>> {
    if (!rows.length) return new Map();
    const byKey = new Map(rows.map((r) => [refundKey(r.tenantId, r.id), r.id]));
    const found = await adminDb.creditAdjustment.findMany({ where: { id: { in: [...byKey.keys()] } }, select: { id: true, delta: true } });
    return new Map(found.map((a) => [byKey.get(a.id)!, num(a.delta)]));
  }
}

/** The one adjustment id a call's refund may have: keyed on the call, never on who asked. */
export function refundKey(tenantId: string, callId: string): string {
  return derivedUuid(`refund-call-${tenantId}-${callId}`);
}

function alreadyRefunded(callId: string, ticketId: number | null): AppError {
  return new AppError(
    'CONFLICT',
    ticketId ? `Call ${callId} was already refunded on ticket #${ticketId}.` : `Call ${callId} was already refunded.`,
  );
}

function toCall(r: Row, refunded: number | null): AdminCallResponse {
  const analysis = record(r.analysisJson);
  return {
    id: r.id,
    agent_id: r.agentId,
    agent_version: r.agentVersion,
    number_id: r.numberId,
    channel: r.channel,
    direction: r.direction,
    is_test: r.isTest,
    from_number: r.fromNumber,
    to_number: r.toNumber,
    started_at: iso(r.startedAt),
    ended_at: iso(r.endedAt),
    duration_s: r.durationS,
    disconnection_reason: r.disconnectionReason,
    tier: r.tier,
    rate: num(r.rate),
    config_version: r.configVersion,
    credits_charged: numOrNull(r.creditsCharged),
    transfer_credits_charged: numOrNull(r.transferCreditsCharged),
    status: r.status === 'declined' ? 'missed' : r.status,
    decline_reason: r.declineReason,
    outcome: r.outcome,
    handled_at: iso(r.handledAt),
    note: r.note,
    has_recording: Boolean(r.recordingUrl),
    sentiment: typeof analysis.user_sentiment === 'string' ? analysis.user_sentiment : null,
    created_at: r.createdAt.toISOString(),
    tenant_id: r.tenantId,
    tenant_name: r.tenant.name,
    agent_name: r.agent?.name ?? null,
    retell_cost_cents: r.retellCostCents,
    flagged_at: iso(r.flaggedAt),
    flag_note: r.flagNote,
    refunded_credits: refunded,
  };
}
