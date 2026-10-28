import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminNumberResponse,
  AdminNumberResyncResponse,
  AdminNumbersQuery,
  Page,
  StaffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import { JobQueues, QUEUES, provisionNumberBullId } from '../jobs';
import { NumberProvisioningService, classifyError } from '../numbers';
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
 * decline on. Release, resync and reprovision (admin §9) go through the services the
 * customer's D4 and the provisioning job use (`NumberProvisioningService`, `JobQueues`):
 * the console never talks to the voice platform on its own.
 */
@Injectable()
export class AdminNumbersService {
  private readonly log = new Logger(AdminNumbersService.name);

  constructor(
    private readonly runtimeCache: RuntimeCacheService,
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
    private readonly provisioning: NumberProvisioningService,
    private readonly queues: JobQueues,
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

  // ------------------------------------------------------------------ release / resync / reprovision (admin §9)

  /**
   * Releases the number for the customer — the customer's D4 DELETE, which a paused
   * workspace cannot reach. Platform first, row kept as `released` (calls reference it);
   * a platform failure leaves it `releasing`, and a second press finishes the job. The
   * request is audited before the platform is asked, the outcome after.
   */
  async release(staff: StaffContext, idRaw: string, body: StaffActionRequest, request: FastifyRequest): Promise<AdminNumberResponse> {
    const row = await this.platformRow(idRaw);
    if (row.status === 'released') throw new AppError('CONFLICT', 'This number has already been released.');
    const live = await adminDb.call.count({ where: { numberId: row.id, status: 'in_progress' } });
    if (live > 0) throw new AppError('NUMBER_IN_USE', 'This number is on a call right now. Try again when it ends.');
    await this.recordBoth(staff, row, 'number.release_requested', body, request, { status: row.status, e164: row.e164 }, undefined);
    try {
      await this.provisioning.release(row.id, row.tenantId);
    } catch (error) {
      await this.audit.record({ staff, action: 'number.release_failed', targetType: 'phone_number', targetId: row.id, tenantId: row.tenantId, reasonCode: body.reason_code, after: { error: messageOf(error) }, request });
      this.log.error(`number ${row.id}: staff release failed: ${messageOf(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'The voice platform did not release the number. It no longer answers; press Release again to finish.');
    }
    await this.audit.record({ staff, action: 'number.released', targetType: 'phone_number', targetId: row.id, tenantId: row.tenantId, reasonCode: body.reason_code, before: { status: row.status }, after: { status: 'released' }, request });
    this.log.warn(`number ${row.id} (${row.e164 ?? 'no e164'}) released by ${staff.email} (${body.reason_code})`);
    return this.get(row.id);
  }

  /**
   * Re-points the platform number at the agent's `latest_published` and our inbound
   * webhook when they drifted (`bind`: read, compare, update only on a difference), then
   * rebuilds the runtime cache. Safe to press on a correct number: it reads and changes nothing.
   */
  async resync(staff: StaffContext, idRaw: string, body: StaffActionRequest, request: FastifyRequest): Promise<AdminNumberResyncResponse> {
    const row = await this.platformRow(idRaw);
    if (row.status !== 'active' && row.status !== 'paused')
      throw new AppError('CONFLICT', row.status === 'failed' ? 'A failed number is re-provisioned, not re-synced.' : `A ${row.status} number cannot be re-synced.`);
    let updated: boolean;
    try {
      ({ updated } = await this.provisioning.bind(row.id, row.tenantId));
    } catch (raw) {
      const error = classifyError(raw);
      this.log.error(`number ${row.id}: staff resync failed (${error.kind}: ${error.message})`);
      if (error.retryable) throw new AppError('UPSTREAM_UNAVAILABLE', 'The voice platform did not answer. Nothing changed; try again in a moment.');
      throw new AppError('CONFLICT', error.customerReason);
    }
    await this.runtimeCache.refresh(row.tenantId);
    await this.recordBoth(staff, row, 'number.resynced', body, request, undefined, { updated });
    return { ...(await this.get(row.id)), updated };
  }

  /**
   * Starts a failed number's provisioning again: the row goes back to `provisioning` and
   * the off-wizard `provision-number` job is queued, with its look-before-you-buy (a number
   * the dead run did buy is adopted, never bought twice). The id the failed run left behind
   * is freed first, or the queue would keep it for an hour and run nothing.
   */
  async reprovision(staff: StaffContext, idRaw: string, body: StaffActionRequest, request: FastifyRequest): Promise<AdminNumberResponse> {
    const row = await this.platformRow(idRaw);
    if (row.status !== 'failed') throw new AppError('CONFLICT', `Only a failed number can be re-provisioned; this one is ${row.status}.`);
    const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { id: row.tenantId }, select: { pausedAt: true } });
    if (tenant.pausedAt) throw new AppError('WORKSPACE_PAUSED', 'The workspace is paused; resume it before re-provisioning its numbers.');
    const held = await this.queues.freeFinished(QUEUES.provisioning, provisionNumberBullId(row.id));
    if (held === 'busy') throw new AppError('CONFLICT', 'This number is already being provisioned.');
    if (held === 'unknown') throw new AppError('UPSTREAM_UNAVAILABLE', 'The queue did not answer; try again in a moment.');

    await adminDb.$transaction(async (tx) => {
      const moved = await tx.phoneNumber.updateMany({ where: { id: row.id, status: 'failed' }, data: { status: 'provisioning', error: null } });
      if (moved.count === 0) throw new AppError('CONFLICT', 'The number changed while you were looking; reload it.');
      await this.recordBoth(staff, row, 'number.reprovision_requested', body, request, { status: 'failed', error: row.error }, { status: 'provisioning' }, tx);
    });
    const queued = await this.queues.enqueueProvisionNumber({ numberId: row.id, workspaceId: row.tenantId, userId: null });
    if (queued === 'failed') {
      await adminDb.phoneNumber.updateMany({ where: { id: row.id, status: 'provisioning' }, data: { status: 'failed', error: row.error } });
      await this.audit.record({ staff, action: 'number.reprovision_failed', targetType: 'phone_number', targetId: row.id, tenantId: row.tenantId, reasonCode: body.reason_code, after: { enqueue: queued }, request });
      throw new AppError('UPSTREAM_UNAVAILABLE', 'The queue did not accept the job. Nothing changed; try again in a moment.');
    }
    this.log.log(`number ${row.id} re-provision queued by ${staff.email} (${queued})`);
    return this.get(row.id);
  }

  private async platformRow(idRaw: string) {
    const id = uuidParam(idRaw, 'Number');
    const row = await adminDb.phoneNumber.findUnique({ where: { id }, select: { id: true, tenantId: true, status: true, e164: true, error: true } });
    if (!row) throw AppError.notFound('Number');
    return row;
  }

  /** The staff row and the customer's own `audit_log` row, in one transaction (the caller's when it has one). */
  private async recordBoth(
    staff: StaffContext,
    row: { id: string; tenantId: string },
    action: string,
    body: StaffActionRequest,
    request: FastifyRequest,
    before: unknown,
    after: unknown,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const write = async (db: Prisma.TransactionClient) => {
      await db.auditLog.create({ data: { tenantId: row.tenantId, action, targetType: 'number', targetId: row.id, metaJson: { by: 'staff', reason_code: body.reason_code } } });
      await this.audit.record({ staff, action, targetType: 'phone_number', targetId: row.id, tenantId: row.tenantId, reasonCode: body.reason_code, note: body.note, before, after, request }, db);
    };
    if (tx) await write(tx);
    else await adminDb.$transaction(write);
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
      caller_id_verified: r.callerIdVerifiedAt !== null,
      caller_id_verified_via: r.callerIdVerifiedAt !== null && (r.callerIdVerifiedVia === 'purchase' || r.callerIdVerifiedVia === 'staff') ? r.callerIdVerifiedVia : null,
      created_at: r.createdAt.toISOString(),
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
