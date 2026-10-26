import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminNumberResponse,
  AdminNumbersQuery,
  Page,
  StaffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import { RuntimeCacheService } from '../runtime-cache';
import { DAY_MS, iso, uuidParam, idMatch, phoneQuery } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';

const WITH = {
  tenant: { select: { name: true } },
  agent: { select: { name: true } },
} satisfies Prisma.PhoneNumberInclude;
type Row = Prisma.PhoneNumberGetPayload<{ include: typeof WITH }>;

/**
 * SA7 "Numbers" and the staff pause/resume (D12 §8). Pause is the customer's D4 pause
 * (`NumbersService.update({paused})`) done from the console: `paused_at` + `status`,
 * then the runtime cache, whose `num:{e164}.number_paused` is what the §13.9 checks
 * decline on. Release, resync and reprovision (admin §9) are the customer's own D4
 * paths and land in P2; nothing here touches the platform.
 */
@Injectable()
export class AdminNumbersService {
  private readonly log = new Logger(AdminNumbersService.name);

  constructor(
    private readonly runtimeCache: RuntimeCacheService,
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
  ) {}

  async list(query: AdminNumbersQuery): Promise<Page<AdminNumberResponse>> {
    const where: Prisma.PhoneNumberWhereInput = {};
    if (query.tenant_id) where.tenantId = query.tenant_id;
    if (query.status) where.status = query.status;
    // The same predicate as the SA1 "Overdue number rentals" count (admin-kpis.service.ts).
    if (query.rental_overdue === 'true') {
      where.rentalOverdueSince = { not: null };
      if (!query.status) where.status = { in: ['active', 'paused'] };
    } else if (query.rental_overdue === 'false') where.rentalOverdueSince = null;
    if (query.q) {
      const digits = phoneQuery(query.q);
      where.OR = [
        ...(digits ? [{ e164: { contains: digits } }] : []),
        { nickname: { contains: query.q, mode: 'insensitive' } },
        // The console's search box promises "E.164, customer, agent" (D13 QA).
        { tenant: { name: { contains: query.q, mode: 'insensitive' } } },
        { agent: { name: { contains: query.q, mode: 'insensitive' } } },
        ...idMatch(query.q),
      ];
    }
    const rows = await adminDb.phoneNumber.findMany({
      where,
      include: WITH,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    const calls = await this.calls7d(page.items.map((r) => r.id));
    return { ...page, items: page.items.map((r) => this.toResponse(r, calls.get(r.id) ?? 0)) };
  }

  async get(idRaw: string): Promise<AdminNumberResponse> {
    const id = uuidParam(idRaw, 'Number');
    const row = await adminDb.phoneNumber.findUnique({ where: { id }, include: WITH });
    if (!row) throw AppError.notFound('Number');
    return this.toResponse(row, (await this.calls7d([id])).get(id) ?? 0);
  }

  async pause(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminNumberResponse> {
    return this.setPaused(staff, idRaw, body, request, true);
  }

  async resume(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminNumberResponse> {
    return this.setPaused(staff, idRaw, body, request, false);
  }

  private async setPaused(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
    paused: boolean,
  ): Promise<AdminNumberResponse> {
    const id = uuidParam(idRaw, 'Number');
    // The workspace pause's checks (QA-034): the role must be allowed to pause at all,
    // and support pauses only against one of this workspace's tickets (resume takes none).
    await this.limits.assertCan(staff, 'can_pause_tenant');
    const row = await adminDb.phoneNumber.findUnique({
      where: { id },
      select: { id: true, tenantId: true, status: true, pausedAt: true },
    });
    if (!row) throw AppError.notFound('Number');
    if (paused) await this.limits.assertPauseTicket(staff, row.tenantId, body.ticket_id, 'number');
    if (row.status === 'released' || row.status === 'releasing')
      throw new AppError('CONFLICT', 'This number has been released.');
    if (row.status === 'failed' || row.status === 'provisioning')
      throw new AppError(
        'CONFLICT',
        `A ${row.status} number cannot be ${paused ? 'paused' : 'resumed'}.`,
      );
    const already = paused ? row.status === 'paused' : row.status === 'active';
    if (!already) {
      const action = paused ? 'number.paused' : 'number.resumed';
      await adminDb.$transaction(async (tx) => {
        await tx.phoneNumber.update({
          where: { id },
          data: {
            status: paused ? 'paused' : 'active',
            pausedAt: paused ? (row.pausedAt ?? new Date()) : null,
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: row.tenantId,
            action,
            targetType: 'number',
            targetId: id,
            metaJson: { by: 'staff', reason_code: body.reason_code },
          },
        });
        await this.audit.record(
          {
            staff,
            action,
            targetType: 'phone_number',
            targetId: id,
            tenantId: row.tenantId,
            reasonCode: body.reason_code,
            note: body.note,
            before: { status: row.status },
            after: { status: paused ? 'paused' : 'active' },
            request,
          },
          tx,
        );
      });
      await this.runtimeCache.refresh(row.tenantId);
      this.log[paused ? 'warn' : 'log'](
        `number ${id} ${paused ? 'paused' : 'resumed'} by ${staff.email} (${body.reason_code})`,
      );
    }
    return this.get(id);
  }

  private async calls7d(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await adminDb.call.groupBy({
      by: ['numberId'],
      where: { numberId: { in: ids }, createdAt: { gte: new Date(Date.now() - 7 * DAY_MS) } },
      _count: { _all: true },
    });
    return new Map(rows.filter((r) => r.numberId).map((r) => [r.numberId!, r._count._all]));
  }

  private toResponse(r: Row, calls7d: number): AdminNumberResponse {
    return {
      id: r.id,
      tenant_id: r.tenantId,
      tenant_name: r.tenant.name,
      agent_id: r.agentId,
      agent_name: r.agent?.name ?? null,
      e164: r.e164,
      type: r.type,
      status: r.status,
      paused_at: iso(r.pausedAt),
      forwarding_status: r.forwardingStatus,
      rental_credits: r.rentalCredits,
      next_rental_at: iso(r.nextRentalAt),
      rental_overdue_since: iso(r.rentalOverdueSince),
      error: r.error,
      calls_7d: calls7d,
      created_at: r.createdAt.toISOString(),
    };
  }
}
