import { Injectable } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import type { AdminCallResponse, AdminCallsQuery, Page } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import { iso, num, numOrNull, phoneQuery, record } from './admin.helpers';

const WITH = {
  tenant: { select: { name: true } },
  agent: { select: { name: true } },
} satisfies Prisma.CallInclude;
type Row = Prisma.CallGetPayload<{ include: typeof WITH }>;

/**
 * SA8 and the SA2 "Calls" tab (D12 §4): the customer's D2 row plus the owner and the
 * platform cost. No transcript in a list and no recording link at all — recording
 * access is a logged, ticketed action (admin §10) that lands with SA8 in P2.
 */
@Injectable()
export class AdminCallsService {
  async list(query: AdminCallsQuery): Promise<Page<AdminCallResponse>> {
    const where: Prisma.CallWhereInput = {};
    if (query.tenant_id) where.tenantId = query.tenant_id;
    if (query.status === 'missed') where.status = 'declined';
    else if (query.status) where.status = query.status;
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
    return { ...page, items: page.items.map(toCall) };
  }

  async get(id: string): Promise<AdminCallResponse> {
    const row = await adminDb.call.findUnique({ where: { id }, include: WITH });
    if (!row) throw AppError.notFound('Call');
    return toCall(row);
  }
}

function toCall(r: Row): AdminCallResponse {
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
  };
}
