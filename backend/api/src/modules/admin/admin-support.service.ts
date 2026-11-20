import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminCannedResponseRequest,
  AdminCreateTicketRequest,
  AdminCreditAdjustResponse,
  AdminTicketAdjustment,
  AdminTicketDetail,
  AdminTicketMacroRequest,
  AdminTicketMacroResponse,
  AdminTicketMessage,
  AdminTicketMessageRequest,
  AdminTicketSummary,
  AdminTicketsQuery,
  AdminUpdateTicketRequest,
  CannedResponse,
  DeletedResponse,
  Page,
  TicketCategory,
  TicketMacro,
  TicketPriority,
  TicketStatus,
} from '@portal/schemas';
import { ticketCategory, ticketPriority } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, toPage } from '../../common/pagination';
import { ActivationService } from '../activation';
import type { StaffContext } from '../auth';
import { JOBS, JobRecordsService } from '../jobs';
import { WalletService } from '../wallet';
import { AdminCustomersService } from './admin-customers.service';
import { AdminCallsService } from './admin-calls.service';
import { derivedUuid, iso, num, uuidParam } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { firstResponseDue, resolutionDue } from './support-sla';

/** The macro's own roles (admin §2.2): money for the two credit macros, the support trio for a re-run. */
const MACRO_ROLES: Record<TicketMacro, ReadonlyArray<StaffContext['role']>> = {
  comp_credits: ['super_admin', 'ops', 'finance', 'support'],
  refund_call: ['super_admin', 'ops', 'finance', 'support'],
  rerun_activation: ['super_admin', 'ops', 'support'],
};

type TicketRow = Prisma.SupportTicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

const TICKET_INCLUDE = {
  tenant: { select: { id: true, name: true, pausedAt: true } },
  assignee: { select: { id: true, name: true, email: true } },
  requester: { select: { id: true, email: true } },
  _count: { select: { messages: true } },
  messages: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { createdAt: true } },
} satisfies Prisma.SupportTicketInclude;

/**
 * Admin §4 SA4 (D13): the ticket queue, the thread, the three macros and the canned
 * responses. Reads cross workspaces on `adminDb`; every write that the customer can see —
 * a public reply, a status change, a macro — lands in `staff_audit_log` inside the same
 * transaction. The macros never move credits themselves: `comp_credits` and `refund_call`
 * go through `AdminCustomersService.adjustCredits` (the wallet lock, the role limits, the
 * `credit_adjustments` row with this ticket's id), and `rerun_activation` through
 * `ActivationService.start`, the same job W7 and D3 "Go live" queue.
 */
@Injectable()
export class AdminSupportService {
  private readonly log = new Logger(AdminSupportService.name);

  constructor(
    private readonly audit: StaffAuditService,
    private readonly customers: AdminCustomersService,
    private readonly calls: AdminCallsService,
    private readonly wallet: WalletService,
    private readonly activation: ActivationService,
    private readonly jobs: JobRecordsService,
  ) {}

  // ------------------------------------------------------------------ queue

  async list(staff: StaffContext, query: AdminTicketsQuery): Promise<Page<AdminTicketSummary>> {
    const where: Prisma.SupportTicketWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.tenant_id) where.tenantId = query.tenant_id;
    if (query.assignee_staff_id)
      where.assigneeStaffId =
        query.assignee_staff_id === 'me' ? staff.staffId : query.assignee_staff_id;
    if (query.q) {
      const q = query.q;
      where.OR = [
        { subject: { contains: q, mode: 'insensitive' } },
        { tenant: { name: { contains: q, mode: 'insensitive' } } },
        ...(/^\d{1,9}$/.test(q) ? [{ id: Number(q) }] : []),
      ];
    }
    const position = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorId = position ? Number(position.id) : undefined;
    if (position && (!Number.isInteger(cursorId) || (cursorId as number) <= 0))
      throw new AppError(
        'INVALID_CURSOR',
        'That page link is no longer valid. Start from the first page.',
      );
    const [rows, total] = await Promise.all([
      adminDb.supportTicket.findMany({
        where,
        include: TICKET_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
      adminDb.supportTicket.count({ where }),
    ]);
    const page = toPage(rows, query);
    return { ...page, items: page.items.map((r) => this.summary(r)), total };
  }

  async get(idRaw: string | number): Promise<AdminTicketDetail> {
    const id = ticketParam(idRaw);
    const row = await adminDb.supportTicket.findUnique({ where: { id }, include: TICKET_INCLUDE });
    if (!row) throw AppError.notFound('Ticket');
    return this.detail(row);
  }

  // ------------------------------------------------------------------ writes

  async create(
    staff: StaffContext,
    body: AdminCreateTicketRequest,
    request: FastifyRequest,
  ): Promise<AdminTicketDetail> {
    const tenant = await adminDb.tenant.findUnique({
      where: { id: body.tenant_id },
      select: { id: true },
    });
    if (!tenant) throw AppError.notFound('Customer');
    if (body.requester_user_id) {
      const member = await adminDb.membership.count({
        where: { tenantId: body.tenant_id, userId: body.requester_user_id },
      });
      if (!member)
        throw new AppError(
          'VALIDATION_FAILED',
          'The requester is not a member of this workspace.',
          [{ field: 'requester_user_id', message: 'Not a member of this workspace' }],
        );
    }
    const callIds = await this.ownedCalls(body.tenant_id, body.linked_call_ids ?? []);
    const purchaseIds = await this.ownedPurchases(body.tenant_id, body.linked_purchase_ids ?? []);
    const now = new Date();
    const id = await adminDb.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({
        data: {
          tenantId: body.tenant_id,
          requesterUserId: body.requester_user_id ?? null,
          subject: body.subject,
          category: body.category ?? null,
          priority: body.priority,
          status: 'open',
          slaFirstResponseDue: firstResponseDue(now, body.priority),
          slaResolutionDue: resolutionDue(now),
          // A ticket staff open with a message is answered from its first second.
          firstRespondedAt: body.body ? now : null,
          linkedCallIds: callIds,
          linkedPurchaseIds: purchaseIds,
          createdAt: now,
        },
        select: { id: true },
      });
      if (body.body) {
        await tx.ticketMessage.create({
          data: {
            ticketId: ticket.id,
            authorType: 'staff',
            authorId: staff.staffId,
            body: body.body,
            isInternal: false,
          },
        });
      }
      await this.audit.record(
        {
          staff,
          action: 'ticket.created',
          targetType: 'ticket',
          targetId: String(ticket.id),
          tenantId: body.tenant_id,
          note: body.note,
          after: {
            subject: body.subject,
            category: body.category ?? null,
            priority: body.priority,
            requester_user_id: body.requester_user_id ?? null,
            linked_call_ids: callIds,
            linked_purchase_ids: purchaseIds,
            with_message: Boolean(body.body),
          },
          request,
        },
        tx,
      );
      return ticket.id;
    });
    this.log.log(`ticket #${id} opened by ${staff.email} for ${body.tenant_id}`);
    return this.get(id);
  }

  async update(
    staff: StaffContext,
    idRaw: string,
    body: AdminUpdateTicketRequest,
    request: FastifyRequest,
  ): Promise<AdminTicketDetail> {
    const id = ticketParam(idRaw);
    const current = await adminDb.supportTicket.findUnique({ where: { id } });
    if (!current) throw AppError.notFound('Ticket');
    const data: Prisma.SupportTicketUpdateInput = {};
    if (body.priority !== undefined) data.priority = body.priority;
    if (body.category !== undefined) data.category = body.category;
    if (body.tags !== undefined) data.tags = body.tags;
    if (body.assignee_staff_id !== undefined) {
      if (body.assignee_staff_id === null) data.assignee = { disconnect: true };
      else {
        const assigneeId = body.assignee_staff_id === 'me' ? staff.staffId : body.assignee_staff_id;
        const exists = await adminDb.staffUser.findFirst({
          where: { id: assigneeId, active: true },
          select: { id: true },
        });
        if (!exists)
          throw new AppError(
            'VALIDATION_FAILED',
            'That staff member does not exist or is inactive.',
            [{ field: 'assignee_staff_id', message: 'Unknown staff member' }],
          );
        data.assignee = { connect: { id: assigneeId } };
      }
    }
    if (body.status !== undefined && body.status !== current.status) {
      const now = new Date();
      data.status = body.status;
      switch (body.status) {
        case 'resolved':
          data.resolvedAt = now;
          data.closedAt = null;
          break;
        case 'closed':
          data.closedAt = now;
          data.resolvedAt = current.resolvedAt ?? now;
          break;
        default:
          // open / pending: a reopen clears both timestamps.
          data.resolvedAt = null;
          data.closedAt = null;
      }
    }
    const before = snapshot(current);
    await adminDb.$transaction(async (tx) => {
      const updated = await tx.supportTicket.update({ where: { id }, data });
      await this.audit.record(
        {
          staff,
          action: 'ticket.updated',
          targetType: 'ticket',
          targetId: String(id),
          tenantId: current.tenantId,
          before,
          after: snapshot(updated),
          request,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async addMessage(
    staff: StaffContext,
    idRaw: string,
    body: AdminTicketMessageRequest,
    request: FastifyRequest,
  ): Promise<AdminTicketDetail> {
    const id = ticketParam(idRaw);
    const current = await adminDb.supportTicket.findUnique({ where: { id } });
    if (!current) throw AppError.notFound('Ticket');
    if (current.status === 'closed' && !body.is_internal)
      throw new AppError(
        'CONFLICT',
        'This ticket is closed. Reopen it to reply, or add an internal note.',
      );
    await adminDb.$transaction(async (tx) => {
      const message = await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorType: 'staff',
          authorId: staff.staffId,
          body: body.body,
          isInternal: body.is_internal,
        },
        select: { id: true },
      });
      if (!body.is_internal) {
        await tx.supportTicket.update({
          where: { id },
          data: {
            firstRespondedAt: current.firstRespondedAt ?? new Date(),
            ...(current.status === 'open' ? { status: 'pending' } : {}),
          },
        });
      }
      await this.audit.record(
        {
          staff,
          action: body.is_internal ? 'ticket.noted' : 'ticket.replied',
          targetType: 'ticket',
          targetId: String(id),
          tenantId: current.tenantId,
          after: {
            message_id: message.id,
            is_internal: body.is_internal,
            chars: body.body.length,
            status_after:
              !body.is_internal && current.status === 'open' ? 'pending' : current.status,
          },
          request,
        },
        tx,
      );
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------ macros

  async macro(
    staff: StaffContext,
    idRaw: string,
    macro: TicketMacro,
    body: AdminTicketMacroRequest,
    request: FastifyRequest,
  ): Promise<AdminTicketMacroResponse> {
    const id = ticketParam(idRaw);
    if (!MACRO_ROLES[macro].includes(staff.role))
      throw AppError.forbiddenRole(MACRO_ROLES[macro].map((r) => r.replace('_', ' ')).join(', '));
    const ticket = await adminDb.supportTicket.findUnique({
      where: { id },
      select: { id: true, tenantId: true, status: true },
    });
    if (!ticket) throw AppError.notFound('Ticket');
    if (ticket.status === 'closed')
      throw new AppError('CONFLICT', 'This ticket is closed. Reopen it before running a macro.');

    let adjustment: AdminCreditAdjustResponse | null = null;
    let jobId: string | null = null;
    let line: string;
    let after: Record<string, unknown>;

    switch (macro) {
      case 'comp_credits': {
        if (body.credits === undefined)
          throw new AppError('VALIDATION_FAILED', 'Credits are required for this macro.', [
            { field: 'credits', message: 'Required' },
          ]);
        const key = derivedUuid(`ticket-${id}-comp-${body.idempotency_key ?? randomUUID()}`);
        const comp = await this.customers.adjustCreditsOnce(
          staff,
          ticket.tenantId,
          {
            delta: body.credits,
            reason_code: body.reason_code,
            note: body.note,
            customer_text: body.customer_text ?? `Goodwill credit (ticket #${id})`,
            ticket_id: id,
            idempotency_key: key,
          },
          request,
        );
        adjustment = comp.adjustment;
        // A retry of the same dialog moved nothing: it posts no second line and no second audit row.
        if (comp.replayed) return { macro, ticket: await this.get(id), adjustment, job_id: null };
        line = `Comped ${fmt(adjustment.delta)} credits (${body.reason_code}). Balance is now ${fmt(adjustment.balance_after)}.`;
        after = {
          credits: adjustment.delta,
          adjustment_id: adjustment.adjustment_id,
          balance_after: adjustment.balance_after,
        };
        break;
      }
      case 'refund_call': {
        if (!body.call_id)
          throw new AppError('VALIDATION_FAILED', 'A call id is required for this macro.', [
            { field: 'call_id', message: 'Required' },
          ]);
        // The Calls page's refund too: keyed on the call alone, so a duplicate ticket — or
        // a refund from SA8 — does not refund it a second time (review, 28 Sep).
        const refund = await this.calls.refundCall(
          staff,
          body.call_id,
          { reason_code: body.reason_code, note: body.note, customer_text: body.customer_text, ticket_id: id },
          request,
          ticket.tenantId,
        );
        adjustment = refund.adjustment;
        line = `Refunded ${fmt(refund.credits)} credits for call ${body.call_id} (${body.reason_code}). Balance is now ${fmt(adjustment.balance_after)}.`;
        after = {
          call_id: body.call_id,
          credits: refund.credits,
          adjustment_id: adjustment.adjustment_id,
          balance_after: adjustment.balance_after,
        };
        break;
      }
      case 'rerun_activation': {
        jobId = await this.rerunActivation(ticket.tenantId);
        line = `Re-ran the agent activation (job ${jobId}; ${body.reason_code}).`;
        after = { job_id: jobId };
        break;
      }
    }

    await adminDb.$transaction(async (tx) => {
      await tx.ticketMessage.create({
        data: { ticketId: id, authorType: 'system', authorId: null, body: line, isInternal: false },
      });
      await this.audit.record(
        {
          staff,
          action: `ticket.macro.${macro}`,
          targetType: 'ticket',
          targetId: String(id),
          tenantId: ticket.tenantId,
          reasonCode: body.reason_code,
          note: body.note,
          after,
          request,
        },
        tx,
      );
    });
    this.log.log(`ticket #${id}: macro ${macro} by ${staff.email}`);
    return { macro, ticket: await this.get(id), adjustment, job_id: jobId };
  }

  /** The workspace's agent — live first, then the newest generated one — queued for activation on behalf of the owner. */
  private async rerunActivation(tenantId: string): Promise<string> {
    const tenant = await adminDb.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { pausedAt: true },
    });
    if (tenant.pausedAt)
      throw new AppError(
        'WORKSPACE_PAUSED',
        'This workspace is paused; resume it before re-running the activation.',
      );
    const agents = await adminDb.agent.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, draftVersion: true, publishedVersion: true },
    });
    const agent =
      agents.find((a) => a.status === 'live') ??
      agents.find((a) => a.publishedVersion || a.draftVersion) ??
      agents[0];
    if (!agent) throw new AppError('CONFLICT', 'This workspace has no agent to activate.');
    if (!agent.draftVersion && !agent.publishedVersion)
      throw new AppError(
        'CONFLICT',
        'The agent has not been generated yet; there is nothing to activate.',
      );
    const running = await this.jobs.findActive(tenantId, JOBS.activateAgent, agent.id);
    if (running)
      throw new AppError(
        'ACTIVATION_IN_PROGRESS',
        `An activation is already running (job ${running}).`,
      );
    const owner =
      (await adminDb.membership.findFirst({
        where: { tenantId, role: 'owner' },
        select: { userId: true },
      })) ??
      (await adminDb.membership.findFirst({ where: { tenantId }, select: { userId: true } }));
    if (!owner)
      throw new AppError('CONFLICT', 'This workspace has no members to activate on behalf of.');
    const { job_id } = await this.activation.start({
      workspaceId: tenantId,
      agentId: agent.id,
      userId: owner.userId,
    });
    return job_id;
  }

  // ------------------------------------------------------------------ canned responses

  async listCanned(): Promise<CannedResponse[]> {
    const rows = await adminDb.cannedResponse.findMany({ orderBy: [{ title: 'asc' }] });
    return rows.map(cannedOf);
  }

  async createCanned(
    staff: StaffContext,
    body: AdminCannedResponseRequest,
    request: FastifyRequest,
  ): Promise<CannedResponse> {
    const row = await adminDb.$transaction(async (tx) => {
      const created = await tx.cannedResponse.create({
        data: {
          title: body.title,
          body: body.body,
          category: body.category ?? null,
          updatedBy: staff.staffId,
        },
      });
      await this.audit.record(
        {
          staff,
          action: 'canned_response.created',
          targetType: 'canned_response',
          targetId: created.id,
          after: { title: body.title, category: body.category ?? null },
          request,
        },
        tx,
      );
      return created;
    });
    return cannedOf(row);
  }

  async deleteCanned(
    staff: StaffContext,
    idRaw: string,
    request: FastifyRequest,
  ): Promise<DeletedResponse> {
    const id = uuidParam(idRaw, 'Canned response');
    const row = await adminDb.cannedResponse.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Canned response');
    await adminDb.$transaction(async (tx) => {
      await tx.cannedResponse.delete({ where: { id } });
      await this.audit.record(
        {
          staff,
          action: 'canned_response.deleted',
          targetType: 'canned_response',
          targetId: id,
          before: { title: row.title, category: row.category },
          request,
        },
        tx,
      );
    });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ shapes

  private summary(r: TicketRow): AdminTicketSummary {
    return {
      id: r.id,
      tenant_id: r.tenantId,
      tenant_name: r.tenant.name,
      subject: r.subject,
      category: categoryOf(r.category),
      priority: priorityOf(r.priority),
      status: r.status as TicketStatus,
      assignee: r.assignee
        ? { id: r.assignee.id, name: r.assignee.name, email: r.assignee.email }
        : null,
      requester: r.requester ? { id: r.requester.id, email: r.requester.email } : null,
      message_count: r._count.messages,
      last_message_at: iso(r.messages[0]?.createdAt),
      first_responded_at: iso(r.firstRespondedAt),
      resolved_at: iso(r.resolvedAt),
      closed_at: iso(r.closedAt),
      sla_first_response_due: iso(r.slaFirstResponseDue),
      sla_resolution_due: iso(r.slaResolutionDue),
      tags: r.tags,
      linked_call_ids: r.linkedCallIds,
      linked_purchase_ids: r.linkedPurchaseIds,
      created_at: r.createdAt.toISOString(),
    };
  }

  private async detail(r: TicketRow): Promise<AdminTicketDetail> {
    const [messages, adjustments, balance] = await Promise.all([
      adminDb.ticketMessage.findMany({
        where: { ticketId: r.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      adminDb.creditAdjustment.findMany({
        where: { ticketId: r.id },
        include: { staff: { select: { email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.wallet.balance(r.tenantId),
    ]);
    const staffIds = [
      ...new Set(
        messages
          .filter((m) => m.authorType === 'staff' && m.authorId)
          .map((m) => m.authorId as string),
      ),
    ];
    const userIds = [
      ...new Set(
        messages
          .filter((m) => m.authorType === 'customer' && m.authorId)
          .map((m) => m.authorId as string),
      ),
    ];
    const [staffRows, userRows] = await Promise.all([
      staffIds.length
        ? adminDb.staffUser.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, name: true, email: true },
          })
        : [],
      userIds.length
        ? adminDb.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          })
        : [],
    ]);
    const authors = new Map<string, { id: string; name: string | null; email: string | null }>();
    for (const s of staffRows) authors.set(s.id, { id: s.id, name: s.name, email: s.email });
    for (const u of userRows) authors.set(u.id, { id: u.id, name: u.name, email: u.email });
    return {
      ...this.summary(r),
      messages: messages.map((m): AdminTicketMessage => ({
        id: m.id,
        author_type: m.authorType,
        author: m.authorId ? (authors.get(m.authorId) ?? null) : null,
        body: m.body,
        is_internal: m.isInternal,
        created_at: m.createdAt.toISOString(),
      })),
      tenant: { id: r.tenant.id, name: r.tenant.name, paused_at: iso(r.tenant.pausedAt), balance },
      adjustments: adjustments.map((a): AdminTicketAdjustment => ({
        id: a.id,
        delta: num(a.delta),
        reason_code: a.reasonCode,
        note: a.note,
        customer_text: a.customerText,
        staff_email: a.staff.email,
        created_at: a.createdAt.toISOString(),
      })),
    };
  }

  private async ownedCalls(tenantId: string, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const found = await adminDb.call.findMany({
      where: { id: { in: unique }, tenantId },
      select: { id: true },
    });
    if (found.length !== unique.length)
      throw new AppError('VALIDATION_FAILED', 'A linked call does not belong to this workspace.', [
        { field: 'linked_call_ids', message: 'Not this workspace’s call' },
      ]);
    return unique;
  }

  private async ownedPurchases(tenantId: string, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const found = await adminDb.purchase.count({ where: { id: { in: unique }, tenantId } });
    if (found !== unique.length)
      throw new AppError(
        'VALIDATION_FAILED',
        'A linked purchase does not belong to this workspace.',
        [{ field: 'linked_purchase_ids', message: 'Not this workspace’s purchase' }],
      );
    return unique;
  }
}

/** A ticket number in a path: a positive integer, else 404 — never a Postgres cast error. */
export function ticketParam(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw AppError.notFound('Ticket');
  return n;
}

function snapshot(t: {
  status: string;
  priority: string;
  category: string | null;
  assigneeStaffId: string | null;
  tags: string[];
}) {
  return {
    status: t.status,
    priority: t.priority,
    category: t.category,
    assignee_staff_id: t.assigneeStaffId,
    tags: t.tags,
  };
}

function categoryOf(value: string | null): TicketCategory | null {
  const parsed = ticketCategory.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function priorityOf(value: string): TicketPriority {
  const parsed = ticketPriority.safeParse(value);
  return parsed.success ? parsed.data : 'normal';
}

function cannedOf(r: {
  id: string;
  title: string;
  body: string;
  category: string | null;
  updatedAt: Date;
}): CannedResponse {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    category: categoryOf(r.category),
    updated_at: r.updatedAt.toISOString(),
  };
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Moved to `admin.helpers` (the call refund derives its key too); kept here for its importers. */
export { derivedUuid };
