import { Injectable } from '@nestjs/common';
import { Prisma, withWorkspace } from '@portal/db';
import type { DncAddRequest, DncEntryResponse, Page, PaginationQuery } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { WorkspaceContext } from '../auth';
import { parseTyped } from '../calls';
import { maskNumber, readDestination } from './destination';

/**
 * D18 — the workspace's own do-not-call list (47 CFR 64.1200(d)(6): a person's request not
 * to be called is honoured by the business that was asked; CRTC UTR Part II likewise).
 * Every outbound callback is checked against it (`OutboundCallService`). Adding is open to
 * whoever handles calls (editor and up); removing someone who asked not to be called is
 * owner/admin, and both are audited with the number masked.
 */
@Injectable()
export class DncService {
  async list(ctx: WorkspaceContext, query: PaginationQuery): Promise<Page<DncEntryResponse>> {
    return withWorkspace(ctx, async (db) => {
      const rows = await db.dncEntry.findMany({
        where: { tenantId: ctx.workspaceId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(query),
      });
      const page = toPage(rows, query);
      const ids = [...new Set(page.items.map((r) => r.createdBy).filter((id): id is string => id !== null))];
      // Co-members only (users_read_co_members): someone who has left reads as no one.
      const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
      const names = new Map(users.map((u) => [u.id, u.name ?? u.email]));
      return { ...page, items: page.items.map((r) => toResponse(r, r.createdBy ? (names.get(r.createdBy) ?? null) : null)) };
    });
  }

  /** POST /dnc — a typed number, or the other party of a D2 call. Already listed answers the entry as it is. */
  async add(ctx: WorkspaceContext, body: DncAddRequest): Promise<DncEntryResponse> {
    return withWorkspace(ctx, async (db) => {
      let e164: string;
      if (body.call_id !== undefined) {
        const call = await db.call.findFirst({
          where: { id: body.call_id, tenantId: ctx.workspaceId },
          select: { direction: true, channel: true, fromNumber: true, toNumber: true },
        });
        if (!call) throw AppError.notFound('Call');
        const other = readDestination(call.channel === 'phone' ? (call.direction === 'inbound' ? call.fromNumber : call.toNumber) : null);
        if (!other.ok) throw new AppError('DESTINATION_INVALID', 'This call has no phone number to add.');
        e164 = other.e164;
      } else {
        const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { country: true } });
        const parsed = parseTyped(body.number!, [tenant.country]);
        if (!parsed?.isValid()) {
          const message = 'That is not a phone number we recognise.';
          throw new AppError('VALIDATION_FAILED', message, [{ field: 'number', message }]);
        }
        e164 = parsed.number;
      }

      const existing = await db.dncEntry.findUnique({ where: { tenantId_e164: { tenantId: ctx.workspaceId, e164 } } });
      if (existing) return toResponse(existing, null);
      const row = await db.dncEntry.create({
        data: { tenantId: ctx.workspaceId, e164, source: body.call_id !== undefined ? 'call' : 'manual', reason: body.reason ?? null, createdBy: ctx.userId },
      });
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'dnc.added',
          targetType: 'dnc_entry',
          targetId: row.id,
          ip: ctx.ip ?? null,
          metaJson: { number: maskNumber(e164), source: row.source, call_id: body.call_id ?? null, request_id: ctx.requestId ?? null },
        },
      });
      return toResponse(row, null);
    });
  }

  async remove(ctx: WorkspaceContext, id: string): Promise<{ deleted: true }> {
    return withWorkspace(ctx, async (db) => {
      const row = await db.dncEntry.findFirst({ where: { id, tenantId: ctx.workspaceId } });
      if (!row) throw AppError.notFound('Entry');
      await db.dncEntry.delete({ where: { id } });
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'dnc.removed',
          targetType: 'dnc_entry',
          targetId: id,
          ip: ctx.ip ?? null,
          metaJson: { number: maskNumber(row.e164), request_id: ctx.requestId ?? null },
        },
      });
      return { deleted: true as const };
    });
  }
}

type DncRow = Prisma.DncEntryGetPayload<object>;

function toResponse(r: DncRow, createdByName: string | null): DncEntryResponse {
  return {
    id: r.id,
    e164: r.e164,
    source: r.source === 'call' ? 'call' : 'manual',
    reason: r.reason,
    created_by_name: createdByName,
    created_at: r.createdAt.toISOString(),
  };
}
