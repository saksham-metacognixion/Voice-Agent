import { Injectable, Logger } from '@nestjs/common';
import { adminDb, withWorkspace } from '@portal/db';
import type {
  CreateSupportTicketRequest,
  Page,
  SupportTicketMessage,
  SupportTicketMessageRequest,
  SupportTicketResponse,
  SupportTicketsQuery,
  TicketCategory,
  TicketStatus,
} from '@portal/schemas';
import { ticketCategory } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, toPage } from '../../common/pagination';
import type { WorkspaceContext } from '../auth';
import { firstResponseDue, resolutionDue } from '../admin/support-sla';

/** "Support" is what the customer sees for an unassigned ticket, and the staff's first name otherwise. */
const SUPPORT_NAME = 'Support';

type TicketRow = Awaited<ReturnType<typeof readTickets>>[number];

async function readTickets(
  db: Parameters<Parameters<typeof withWorkspace>[1]>[0],
  where: { tenantId: string; id?: number; status?: TicketStatus },
  paging: { take: number; cursorId?: number },
) {
  return db.supportTicket.findMany({
    where,
    include: {
      // The RLS policy on ticket_messages hides `is_internal` rows from portal_app — this
      // include cannot see them however it is written (ADR 0006).
      messages: {
        orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
        select: { id: true, authorType: true, authorId: true, body: true, createdAt: true },
      },
      requester: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: paging.take,
    ...(paging.cursorId ? { cursor: { id: paging.cursorId }, skip: 1 } : {}),
  });
}

/**
 * D7 Help "My tickets" (spec §16 additions, D13): the customer's own view of `support_tickets`.
 * Every read and write runs inside `withWorkspace`, so RLS scopes the rows and drops internal
 * notes before this code sees them. The assignee's name is the one thing read outside that
 * transaction: `staff_users` has no portal_app grant, so it is looked up on `adminDb` after
 * the tenant-scoped read closes — a name, never an email or an id.
 */
@Injectable()
export class SupportService {
  private readonly log = new Logger(SupportService.name);

  async create(
    ctx: WorkspaceContext,
    body: CreateSupportTicketRequest,
  ): Promise<SupportTicketResponse> {
    const now = new Date();
    const id = await withWorkspace(ctx, async (db) => {
      if (body.linked_call_id) {
        const call = await db.call.findFirst({
          where: { id: body.linked_call_id, tenantId: ctx.workspaceId },
          select: { id: true },
        });
        if (!call)
          throw new AppError('VALIDATION_FAILED', 'That call is not in this workspace.', [
            { field: 'linked_call_id', message: 'Unknown call' },
          ]);
      }
      const ticket = await db.supportTicket.create({
        data: {
          tenantId: ctx.workspaceId,
          requesterUserId: ctx.userId,
          subject: body.subject,
          category: body.category ?? null,
          priority: 'normal',
          status: 'open',
          slaFirstResponseDue: firstResponseDue(now, 'normal'),
          slaResolutionDue: resolutionDue(now),
          linkedCallIds: body.linked_call_id ? [body.linked_call_id] : [],
          createdAt: now,
        },
        select: { id: true },
      });
      await db.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: 'customer',
          authorId: ctx.userId,
          body: body.body,
          isInternal: false,
        },
      });
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'support.ticket_opened',
          targetType: 'ticket',
          targetId: String(ticket.id),
          ip: ctx.ip ?? null,
          metaJson: { subject: body.subject, category: body.category ?? null },
        },
      });
      return ticket.id;
    });
    this.log.log(`ticket #${id} opened by ${ctx.userId} in ${ctx.workspaceId}`);
    return this.one(ctx, id);
  }

  async list(
    ctx: WorkspaceContext,
    query: SupportTicketsQuery,
  ): Promise<Page<SupportTicketResponse>> {
    const position = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorId = position ? Number(position.id) : undefined;
    if (position && (!Number.isInteger(cursorId) || (cursorId as number) <= 0))
      throw new AppError(
        'INVALID_CURSOR',
        'That page link is no longer valid. Start from the first page.',
      );
    const where = { tenantId: ctx.workspaceId, ...(query.status ? { status: query.status } : {}) };
    const { rows, total } = await withWorkspace(ctx, async (db) => ({
      rows: await readTickets(db, where, { take: query.limit + 1, cursorId }),
      total: await db.supportTicket.count({ where }),
    }));
    const page = toPage(rows, query);
    const names = await this.assigneeNames(page.items.map((r) => r.assigneeStaffId));
    return { ...page, items: page.items.map((r) => this.shape(r, names)), total };
  }

  async reply(
    ctx: WorkspaceContext,
    id: number,
    body: SupportTicketMessageRequest,
  ): Promise<SupportTicketResponse> {
    await withWorkspace(ctx, async (db) => {
      const ticket = await db.supportTicket.findFirst({
        where: { id, tenantId: ctx.workspaceId },
        select: { id: true, status: true },
      });
      if (!ticket) throw AppError.notFound('Ticket');
      if (ticket.status === 'closed')
        throw new AppError(
          'CONFLICT',
          'This ticket is closed. Open a new one if you need more help.',
        );
      await db.ticketMessage.create({
        data: {
          ticketId: id,
          authorType: 'customer',
          authorId: ctx.userId,
          body: body.body,
          isInternal: false,
        },
      });
      // A customer message on a pending or resolved ticket puts it back in the queue.
      if (ticket.status !== 'open')
        await db.supportTicket.update({
          where: { id },
          data: { status: 'open', resolvedAt: null },
        });
    });
    return this.one(ctx, id);
  }

  private async one(ctx: WorkspaceContext, id: number): Promise<SupportTicketResponse> {
    const rows = await withWorkspace(ctx, (db) =>
      readTickets(db, { tenantId: ctx.workspaceId, id }, { take: 1 }),
    );
    const row = rows[0];
    if (!row) throw AppError.notFound('Ticket');
    const names = await this.assigneeNames([row.assigneeStaffId]);
    return this.shape(row, names);
  }

  /** First names only; the customer never sees a staff email or id. */
  private async assigneeNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    const map = new Map<string, string>();
    if (!unique.length) return map;
    const rows = await adminDb.staffUser.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    for (const r of rows) map.set(r.id, firstName(r.name));
    return map;
  }

  private shape(r: TicketRow, names: Map<string, string>): SupportTicketResponse {
    const requesterName = r.requester?.name || r.requester?.email || null;
    return {
      id: r.id,
      subject: r.subject,
      category: categoryOf(r.category),
      status: r.status as TicketStatus,
      assignee_name: (r.assigneeStaffId && names.get(r.assigneeStaffId)) || SUPPORT_NAME,
      requester_user_id: r.requesterUserId,
      linked_call_ids: r.linkedCallIds,
      messages: r.messages.map((m): SupportTicketMessage => ({
        id: m.id,
        author_type: m.authorType,
        author_name:
          m.authorType === 'staff'
            ? (r.assigneeStaffId && names.get(r.assigneeStaffId)) || SUPPORT_NAME
            : m.authorType === 'customer'
              ? m.authorId === r.requesterUserId
                ? requesterName
                : null
              : null,
        body: m.body,
        created_at: m.createdAt.toISOString(),
      })),
      last_message_at: r.messages.at(-1)?.createdAt.toISOString() ?? null,
      resolved_at: r.resolvedAt?.toISOString() ?? null,
      closed_at: r.closedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
    };
  }
}

function firstName(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first || SUPPORT_NAME;
}

function categoryOf(value: string | null): TicketCategory | null {
  const parsed = ticketCategory.safeParse(value);
  return parsed.success ? parsed.data : null;
}
