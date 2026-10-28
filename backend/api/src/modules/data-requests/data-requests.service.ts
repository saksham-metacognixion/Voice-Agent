import { Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation, withWorkspace, type WorkspaceDb } from '@portal/db';
import {
  WORKSPACE_DELETION_DUE_DAYS,
  workspaceNameMatches,
  type DeleteWorkspaceRequest,
  type WorkspaceDeletionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { OpsAlertService } from '../alerts';
import type { WorkspaceContext } from '../auth';
import { insertCustomerTicket } from '../support';

const DAY_MS = 86_400_000;
/** The partial unique index that makes "one open deletion request per workspace" a fact. */
const OPEN_DELETE_INDEX = 'data_requests_open_delete_idx';

const OPEN_DELETE = (workspaceId: string) => ({ tenantId: workspaceId, type: 'delete' as const, executedAt: null, cancelledAt: null });
const REQUEST_SELECT = {
  id: true,
  createdAt: true,
  dueAt: true,
  ticketId: true,
  requestedBy: true,
} as const;

/**
 * D6 "Delete workspace" (QA-081, spec p. 39, §17) — the customer's half of it.
 *
 * §17 makes a workspace deletion an anonymisation job run by staff: the ledger, the audit
 * log and the calls are append-only billing history and a `DELETE` of the tenant would
 * hit their triggers. So this route *asks*: one open `data_requests` row (`delete`, due in
 * `WORKSPACE_DELETION_DUE_DAYS`), a support ticket in the workspace that staff work it from
 * in SA4, an `audit_log` row and an ops alert. Nothing is deleted, released or forfeited
 * here, and there is no staff-side deletion job yet — carrying it out stays staff's §17
 * procedure.
 *
 * The owner may withdraw the request until staff carry it out: the 30 days are the window
 * in which a mistaken (or hostile, from a departing owner's session) request costs
 * nothing, and staff read the withdrawal on the same ticket.
 */
@Injectable()
export class DataRequestsService {
  private readonly log = new Logger(DataRequestsService.name);

  constructor(private readonly ops: OpsAlertService) {}

  /** `GET /workspace/delete-request` — the open request, or null. Any member: it concerns all of them. */
  async openDeletion(ctx: WorkspaceContext): Promise<WorkspaceDeletionRequest | null> {
    return withWorkspace(ctx, async (db) => {
      const row = await db.dataRequest.findFirst({ where: OPEN_DELETE(ctx.workspaceId), select: REQUEST_SELECT });
      return row ? shape(db, row) : null;
    });
  }

  /**
   * `POST /workspace/delete-request {confirm}` — owner only, verified email. `confirm` is
   * the workspace name, typed (spaces and case ignored, as the dialog compares it); a
   * mismatch is a 422 on `confirm`. A second request while one is open answers that one,
   * including when two arrive at once: the partial unique index refuses the loser, which
   * then reads the winner.
   */
  async requestDeletion(ctx: WorkspaceContext, body: DeleteWorkspaceRequest): Promise<WorkspaceDeletionRequest> {
    const now = new Date();
    let outcome: { request: WorkspaceDeletionRequest; created: boolean; name: string };
    try {
      outcome = await withWorkspace(ctx, async (db) => {
        const tenant = await db.tenant.findUnique({ where: { id: ctx.workspaceId }, select: { name: true } });
        if (!tenant) throw AppError.notFound('Workspace');
        if (!workspaceNameMatches(body.confirm, tenant.name)) {
          throw new AppError('VALIDATION_FAILED', 'Type the workspace name exactly to confirm.', [
            { field: 'confirm', message: 'Does not match the workspace name' },
          ]);
        }
        const open = await db.dataRequest.findFirst({ where: OPEN_DELETE(ctx.workspaceId), select: REQUEST_SELECT });
        if (open) return { request: await shape(db, open), created: false, name: tenant.name };

        const dueAt = new Date(now.getTime() + WORKSPACE_DELETION_DUE_DAYS * DAY_MS);
        const ticketId = await insertCustomerTicket(
          db,
          ctx,
          {
            subject: `Delete the workspace “${tenant.name}”`,
            body: deletionTicketBody(tenant.name, dueAt),
            category: 'account',
            priority: 'high',
            resolutionDue: dueAt,
          },
          now,
        );
        const row = await db.dataRequest.create({
          data: { tenantId: ctx.workspaceId, type: 'delete', requestedBy: ctx.userId, dueAt, ticketId, createdAt: now },
          select: REQUEST_SELECT,
        });
        await db.auditLog.create({
          data: {
            tenantId: ctx.workspaceId,
            actorUserId: ctx.userId,
            action: 'workspace.deletion_requested',
            targetType: 'workspace',
            targetId: ctx.workspaceId,
            ip: ctx.ip ?? null,
            metaJson: { data_request_id: row.id, ticket_id: ticketId, due_at: dueAt.toISOString() },
          },
        });
        return { request: await shape(db, row), created: true, name: tenant.name };
      });
    } catch (error) {
      if (!isUniqueViolation(error, OPEN_DELETE_INDEX) && !isUniqueViolation(error)) throw error;
      // Lost the race to another request of the same workspace: answer the one that won.
      const existing = await this.openDeletion(ctx);
      if (!existing) throw error;
      return existing;
    }

    if (outcome.created) {
      this.log.log(`deletion of ${ctx.workspaceId} requested by ${ctx.userId} (ticket #${outcome.request.ticket_id})`);
      // After the transaction, never inside it (no network I/O in withWorkspace); send never rejects.
      void this.ops.send({
        kind: 'workspace_deletion_requested',
        severity: 'warning',
        title: 'A workspace owner asked for the workspace to be deleted',
        fields: {
          workspace_id: ctx.workspaceId,
          workspace: outcome.name,
          ticket_id: outcome.request.ticket_id,
          due_at: outcome.request.due_at,
          data_request_id: outcome.request.id,
        },
      });
    }
    return outcome.request;
  }

  /**
   * `DELETE /workspace/delete-request` — the owner withdraws an open request. `cancelled_at`
   * is the one column the app role may update on `data_requests` (a column grant), so a
   * request can be withdrawn but never marked executed from here. The ticket gets a line
   * saying so, staff get an ops alert, the workspace an audit row. Nothing open answers
   * `{revoked: false}`.
   */
  async withdrawDeletion(ctx: WorkspaceContext): Promise<{ revoked: boolean }> {
    const now = new Date();
    const withdrawn = await withWorkspace(ctx, async (db) => {
      const open = await db.dataRequest.findFirst({ where: OPEN_DELETE(ctx.workspaceId), select: { id: true, ticketId: true } });
      if (!open) return null;
      const { count } = await db.dataRequest.updateMany({ where: { id: open.id, ...OPEN_DELETE(ctx.workspaceId) }, data: { cancelledAt: now } });
      if (count === 0) return null;
      if (open.ticketId !== null) {
        await db.ticketMessage.create({
          data: { ticketId: open.ticketId, authorType: 'customer', authorId: ctx.userId, body: 'The owner withdrew this deletion request. Please do not delete the workspace.', isInternal: false },
        });
        // Back into the queue so staff read it, like any customer message on a pending ticket.
        await db.supportTicket.updateMany({ where: { id: open.ticketId, status: { in: ['pending', 'resolved'] } }, data: { status: 'open', resolvedAt: null } });
      }
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'workspace.deletion_withdrawn',
          targetType: 'workspace',
          targetId: ctx.workspaceId,
          ip: ctx.ip ?? null,
          metaJson: { data_request_id: open.id, ticket_id: open.ticketId },
        },
      });
      return open;
    });
    if (!withdrawn) return { revoked: false };
    void this.ops.send({
      kind: 'workspace_deletion_withdrawn',
      severity: 'warning',
      title: 'A workspace owner withdrew a deletion request',
      fields: { workspace_id: ctx.workspaceId, ticket_id: withdrawn.ticketId, data_request_id: withdrawn.id },
    });
    return { revoked: true };
  }
}

async function shape(db: WorkspaceDb, row: { id: string; createdAt: Date; dueAt: Date | null; ticketId: number | null; requestedBy: string | null }): Promise<WorkspaceDeletionRequest> {
  // Under RLS a co-member is readable and a departed one is not: null, never someone else's name.
  const user = row.requestedBy ? await db.user.findFirst({ where: { id: row.requestedBy }, select: { name: true, email: true } }) : null;
  return {
    id: row.id,
    requested_at: row.createdAt.toISOString(),
    due_at: (row.dueAt ?? new Date(row.createdAt.getTime() + WORKSPACE_DELETION_DUE_DAYS * DAY_MS)).toISOString(),
    requested_by: user ? user.name || user.email : null,
    ticket_id: row.ticketId,
  };
}

/** What staff read first on the SA4 ticket — and the customer under "My tickets". */
export function deletionTicketBody(workspaceName: string, dueAt: Date): string {
  return [
    `The owner asked us to delete the workspace “${workspaceName}”.`,
    '',
    `To be completed by ${dueAt.toISOString().slice(0, 10)}. Deleting it releases every phone number, forfeits any remaining credits and cannot be undone. Billing and call records we must keep are anonymised rather than deleted.`,
    '',
    'Until then the owner can withdraw the request from Settings → Data & privacy.',
  ].join('\n');
}
