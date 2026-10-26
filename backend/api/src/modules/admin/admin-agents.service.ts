import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminAgentResponse,
  AdminAgentsQuery,
  Page,
  StaffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import { AgentEvents } from '../agents';
import type { StaffContext } from '../auth';
import { EventsService } from '../events';
import { RuntimeCacheService } from '../runtime-cache';
import { DAY_MS, iso, uuidParam, idMatch } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';

const WITH = {
  tenant: { select: { name: true } },
  phoneNumbers: {
    where: { status: { in: ['provisioning', 'active', 'paused'] as const } },
    select: { id: true, e164: true, status: true },
  },
  _count: { select: { knowledgeSources: true } },
} satisfies Prisma.AgentInclude;

type Row = Prisma.AgentGetPayload<{ include: typeof WITH }>;

/**
 * SA2 "Agents" tab and the staff pause/resume (D12 §7). The same local-state rule as the
 * customer's D3 pause (`AgentPublishService.pause`): `agents.status` is the truth,
 * `num:{e164}.agent_live` is what the §13.9 checks decline on, so a paused agent stops
 * answering as soon as the runtime cache is refreshed — no platform call, so a platform
 * outage cannot stop staff from pulling an agent off the phone. The customer's SSE stream
 * gets the same `paused` / `resumed` frame D3 listens for, so an open dashboard updates.
 */
@Injectable()
export class AdminAgentsService {
  private readonly log = new Logger(AdminAgentsService.name);

  constructor(
    private readonly runtimeCache: RuntimeCacheService,
    private readonly events: EventsService,
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
  ) {}

  async list(query: AdminAgentsQuery): Promise<Page<AdminAgentResponse>> {
    const where: Prisma.AgentWhereInput = { deletedAt: null };
    if (query.tenant_id) where.tenantId = query.tenant_id;
    if (query.status) where.status = query.status;
    if (query.q)
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        // The search box promises "Agent name, customer…" (QA-047).
        { tenant: { name: { contains: query.q, mode: 'insensitive' } } },
        { retellAgentId: query.q },
        ...idMatch(query.q),
      ];
    const rows = await adminDb.agent.findMany({
      where,
      include: WITH,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    const calls = await this.calls7d(page.items.map((r) => r.id));
    return { ...page, items: page.items.map((r) => this.toResponse(r, calls.get(r.id) ?? 0)) };
  }

  async get(idRaw: string): Promise<AdminAgentResponse> {
    const id = uuidParam(idRaw, 'Agent');
    const row = await adminDb.agent.findUnique({ where: { id }, include: WITH });
    if (!row) throw AppError.notFound('Agent');
    return this.toResponse(row, (await this.calls7d([id])).get(id) ?? 0);
  }

  async pause(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminAgentResponse> {
    const id = uuidParam(idRaw, 'Agent');
    // The workspace pause's checks (QA-034): the role must be allowed to pause at all,
    // and support only against one of this workspace's tickets.
    await this.limits.assertCan(staff, 'can_pause_tenant');
    const agent = await adminDb.agent.findUnique({
      where: { id },
      select: { id: true, tenantId: true, status: true, deletedAt: true },
    });
    if (!agent || agent.deletedAt) throw AppError.notFound('Agent');
    await this.limits.assertPauseTicket(staff, agent.tenantId, body.ticket_id, 'agent');
    if (agent.status !== 'paused') {
      await adminDb.$transaction(async (tx) => {
        await tx.agent.update({ where: { id }, data: { status: 'paused' } });
        await tx.auditLog.create({
          data: {
            tenantId: agent.tenantId,
            action: 'agent.paused',
            targetType: 'agent',
            targetId: id,
            metaJson: { by: 'staff', was: agent.status, reason_code: body.reason_code },
          },
        });
        await this.audit.record(
          {
            staff,
            action: 'agent.paused',
            targetType: 'agent',
            targetId: id,
            tenantId: agent.tenantId,
            reasonCode: body.reason_code,
            note: body.note,
            before: { status: agent.status },
            after: { status: 'paused' },
            request,
          },
          tx,
        );
      });
      await this.runtimeCache.refresh(agent.tenantId);
      await this.events.publish(agent.tenantId, AgentEvents.topic(id), AgentEvents.paused, {
        agent_id: id,
        by: 'staff',
      });
      this.log.warn(`agent ${id} paused by ${staff.email} (${body.reason_code})`);
    }
    return this.get(id);
  }

  async resume(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminAgentResponse> {
    const id = uuidParam(idRaw, 'Agent');
    await this.limits.assertCan(staff, 'can_pause_tenant');
    const agent = await adminDb.agent.findUnique({
      where: { id },
      select: { id: true, tenantId: true, status: true, deletedAt: true, publishedVersion: true },
    });
    if (!agent || agent.deletedAt) throw AppError.notFound('Agent');
    if (agent.status === 'paused') {
      // Back to what it was (QA-043): staff may pause a draft, and a draft has no version
      // to put on the phone, so it resumes as a draft rather than staying stuck.
      const status = agent.publishedVersion === null ? 'draft' : 'live';
      await adminDb.$transaction(async (tx) => {
        await tx.agent.update({ where: { id }, data: { status } });
        await tx.auditLog.create({
          data: {
            tenantId: agent.tenantId,
            action: 'agent.resumed',
            targetType: 'agent',
            targetId: id,
            metaJson: {
              by: 'staff',
              version_no: agent.publishedVersion,
              reason_code: body.reason_code,
            },
          },
        });
        await this.audit.record(
          {
            staff,
            action: 'agent.resumed',
            targetType: 'agent',
            targetId: id,
            tenantId: agent.tenantId,
            reasonCode: body.reason_code,
            note: body.note,
            before: { status: 'paused' },
            after: { status },
            request,
          },
          tx,
        );
      });
      await this.runtimeCache.refresh(agent.tenantId);
      await this.events.publish(agent.tenantId, AgentEvents.topic(id), AgentEvents.resumed, {
        agent_id: id,
        by: 'staff',
      });
      this.log.log(`agent ${id} resumed by ${staff.email}`);
    }
    return this.get(id);
  }

  private async calls7d(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await adminDb.call.groupBy({
      by: ['agentId'],
      where: { agentId: { in: ids }, createdAt: { gte: new Date(Date.now() - 7 * DAY_MS) } },
      _count: { _all: true },
    });
    return new Map(rows.filter((r) => r.agentId).map((r) => [r.agentId!, r._count._all]));
  }

  private toResponse(r: Row, calls7d: number): AdminAgentResponse {
    return {
      id: r.id,
      tenant_id: r.tenantId,
      tenant_name: r.tenant.name,
      name: r.name,
      template_id: r.templateId,
      industry: r.industry,
      tier: r.tier,
      status: r.status,
      draft_version: r.draftVersion,
      published_version: r.publishedVersion,
      numbers: r.phoneNumbers.map((n) => ({ id: n.id, e164: n.e164, status: n.status })),
      knowledge_sources: r._count.knowledgeSources,
      calls_7d: calls7d,
      deleted_at: iso(r.deletedAt),
      created_at: r.createdAt.toISOString(),
    };
  }
}
