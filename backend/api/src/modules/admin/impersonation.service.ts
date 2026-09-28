import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { adminDb } from '@portal/db';
import type {
  AdminImpersonateRequest,
  ImpersonationContext as ImpersonationContextView,
  ImpersonationResponse,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { portalUrl } from '../../common/env';
import {
  IMPERSONATION_TTL_S,
  ImpersonationTokenService,
  type ImpersonationContext,
  type StaffContext,
} from '../auth';
import { iso, uuidParam } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';

/**
 * Where the portal picks the session up: `/impersonate/#session=&key=` (frontend/web).
 * The credential travels in the fragment, never the query string: a query string is
 * written to CloudFront and S3 access logs, browser history and any referrer, and the
 * key is a bearer credential good for an hour of customer reads (review, 28 Sep). A
 * fragment never leaves the browser.
 */
export const PORTAL_IMPERSONATE_PATH = '/impersonate/';

/**
 * Admin §7.4 "View as (read-only)" (D12). A session is a row: who, which workspace,
 * why, until when. Starting one mints the credential the portal presents to the customer
 * API (`ImpersonationTokenService`); ending it — from the console, from the portal's
 * banner, or by expiry — writes `ended_at`, after which AuthGuard refuses the credential
 * on the next request. Both ends are audited as their own actions, so SA14 can answer
 * "who looked at this workspace, and when did they stop".
 *
 * Act-as (writes under a customer's identity) is P2 and has no code path here: the
 * request schema only accepts `view`, and WorkspaceGuard refuses every mutation.
 */
@Injectable()
export class ImpersonationService {
  private readonly log = new Logger(ImpersonationService.name);

  constructor(
    private readonly tokens: ImpersonationTokenService,
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
  ) {}

  async start(
    staff: StaffContext,
    tenantIdRaw: string,
    body: AdminImpersonateRequest,
    request: FastifyRequest,
  ): Promise<ImpersonationResponse> {
    const tenantId = uuidParam(tenantIdRaw, 'Customer');
    await this.limits.assertCan(staff, 'can_view_as_customer');
    const tenant = await adminDb.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        memberships: { where: { role: 'owner' }, select: { id: true }, take: 1 },
      },
    });
    if (!tenant) throw AppError.notFound('Customer');
    if (!tenant.memberships.length)
      throw new AppError('CONFLICT', 'This workspace has no owner to view as.');

    // One open session per (staff, workspace): a second "View as" click reuses it rather
    // than leaving a trail of sessions that all expire an hour apart.
    const now = new Date();
    const existing = await adminDb.impersonationSession.findFirst({
      where: {
        staffId: staff.staffId,
        tenantId,
        mode: 'view',
        endedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { startedAt: 'desc' },
    });
    // The session row and its audit row commit together (CLAUDE.md: no audit row, no write).
    const session =
      existing ??
      (await adminDb.$transaction(async (tx) => {
        const created = await tx.impersonationSession.create({
          data: {
            staffId: staff.staffId,
            tenantId,
            mode: 'view',
            reasonCode: body.reason_code,
            ticketId: body.ticket_id ?? null,
            expiresAt: new Date(now.getTime() + IMPERSONATION_TTL_S * 1000),
          },
        });
        await this.audit.record(
          {
            staff,
            action: 'impersonation.started',
            targetType: 'impersonation_session',
            targetId: created.id,
            tenantId,
            reasonCode: body.reason_code,
            note: body.note ?? null,
            after: {
              mode: 'view',
              expires_at: created.expiresAt.toISOString(),
              ticket_id: body.ticket_id ?? null,
            },
            impersonationId: created.id,
            request,
          },
          tx,
        );
        return created;
      }));
    // A reused session still hands out a fresh hour-long credential, and this click may
    // carry its own reason and ticket: it is audited like `reopen` (review, 28 Sep).
    if (existing)
      await this.audit.record({
        staff,
        action: 'impersonation.reused',
        targetType: 'impersonation_session',
        targetId: existing.id,
        tenantId,
        reasonCode: body.reason_code,
        note: body.note ?? null,
        after: {
          mode: 'view',
          expires_at: existing.expiresAt.toISOString(),
          ticket_id: body.ticket_id ?? null,
        },
        impersonationId: existing.id,
        request,
      });
    this.log.log(
      `${staff.email} views ${tenant.name} (${tenantId}) read-only until ${session.expiresAt.toISOString()}`,
    );
    return this.toResponse(
      { ...session, tenant: { name: tenant.name }, staff: { email: staff.email } },
      this.portalLink(session),
    );
  }

  /**
   * `POST /admin/impersonations/:id/open`: a fresh link for a session that is still open.
   * The key lives in the portal tab's sessionStorage, so once that tab is closed the
   * console banner has nothing to open the portal with (review, 28 Sep). Only the session's
   * own staff member — the key makes requests *as* them — and it is audited: a re-minted
   * credential is worth a row even though no customer state changes.
   */
  async reopen(
    staff: StaffContext,
    idRaw: string,
    request: FastifyRequest,
  ): Promise<ImpersonationResponse> {
    const id = uuidParam(idRaw, 'Impersonation session');
    const session = await adminDb.impersonationSession.findUnique({
      where: { id },
      include: { tenant: { select: { name: true } }, staff: { select: { email: true } } },
    });
    if (!session) throw AppError.notFound('Impersonation session');
    if (session.staffId !== staff.staffId)
      throw new AppError(
        'FORBIDDEN_ROLE',
        'Only the staff member who started this session can open the portal with it.',
      );
    if (session.endedAt || session.expiresAt.getTime() <= Date.now())
      throw new AppError('CONFLICT', 'This view-as session has ended; start a new one.');
    await this.audit.record({
      staff,
      action: 'impersonation.reopened',
      targetType: 'impersonation_session',
      targetId: id,
      tenantId: session.tenantId,
      after: { expires_at: session.expiresAt.toISOString() },
      impersonationId: id,
      request,
    });
    return this.toResponse(session, this.portalLink(session));
  }

  private portalLink(session: { id: string; tenantId: string; staffId: string; expiresAt: Date }): string {
    const key = this.tokens.sign(
      { sessionId: session.id, tenantId: session.tenantId, staffId: session.staffId },
      session.expiresAt,
    );
    const url = new URL(PORTAL_IMPERSONATE_PATH, `${portalUrl()}/`);
    const fragment = new URLSearchParams();
    fragment.set('session', session.id);
    fragment.set('key', key);
    url.hash = fragment.toString();
    return url.toString();
  }

  /** The console's Exit, `DELETE /admin/impersonations/:id`. Only the session's own staff member or a super admin. */
  async endFromAdmin(
    staff: StaffContext,
    idRaw: string,
    request: FastifyRequest,
  ): Promise<{ ended: boolean }> {
    const id = uuidParam(idRaw, 'Impersonation session');
    const session = await adminDb.impersonationSession.findUnique({ where: { id } });
    if (!session) throw AppError.notFound('Impersonation session');
    if (session.staffId !== staff.staffId && staff.role !== 'super_admin')
      throw new AppError(
        'FORBIDDEN_ROLE',
        'Only the staff member who started this session, or a super admin, can end it.',
      );
    return this.end(session.id, 'admin', staff, request);
  }

  /** The portal banner's Exit, `POST /impersonation/end`, carrying the view-as credential itself. */
  async endFromPortal(
    imp: ImpersonationContext,
    request: FastifyRequest,
  ): Promise<{ ended: boolean }> {
    const staff = await adminDb.staffUser.findUnique({
      where: { id: imp.staffId },
      select: { id: true, email: true, role: true, authProviderId: true },
    });
    if (!staff) throw AppError.notFound('Staff member');
    return this.end(
      imp.id,
      'portal',
      { staffId: staff.id, email: staff.email, role: staff.role, subject: staff.authProviderId },
      request,
    );
  }

  private async end(
    id: string,
    via: 'admin' | 'portal',
    staff: StaffContext,
    request: FastifyRequest,
  ): Promise<{ ended: boolean }> {
    return adminDb.$transaction(async (tx) => {
      const { count } = await tx.impersonationSession.updateMany({
        where: { id, endedAt: null },
        data: { endedAt: new Date(), endedVia: via },
      });
      if (count === 0) return { ended: false };
      const session = await tx.impersonationSession.findUniqueOrThrow({
        where: { id },
        select: { tenantId: true, startedAt: true, endedAt: true },
      });
      await this.audit.record(
        {
          staff,
          action: 'impersonation.ended',
          targetType: 'impersonation_session',
          targetId: id,
          tenantId: session.tenantId,
          after: {
            ended_via: via,
            started_at: session.startedAt.toISOString(),
            ended_at: session.endedAt?.toISOString() ?? null,
          },
          impersonationId: id,
          request,
        },
        tx,
      );
      return { ended: true };
    });
  }

  /** What the portal banner shows. */
  context(imp: ImpersonationContext): ImpersonationContextView {
    return {
      id: imp.id,
      tenant_id: imp.tenantId,
      tenant_name: imp.tenantName,
      mode: 'view',
      staff_email: imp.staffEmail,
      expires_at: imp.expiresAt.toISOString(),
    };
  }

  /** Open sessions of one staff member, for the console banner. */
  async openFor(staffId: string): Promise<ImpersonationResponse[]> {
    const rows = await adminDb.impersonationSession.findMany({
      where: { staffId, endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { startedAt: 'desc' },
      include: { tenant: { select: { name: true } }, staff: { select: { email: true } } },
    });
    return rows.map((r) => this.toResponse(r, null));
  }

  async listOpen(): Promise<ImpersonationResponse[]> {
    const rows = await adminDb.impersonationSession.findMany({
      where: { endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { startedAt: 'desc' },
      include: { tenant: { select: { name: true } }, staff: { select: { email: true } } },
    });
    return rows.map((r) => this.toResponse(r, null));
  }

  private toResponse(
    row: {
      id: string;
      tenantId: string;
      staffId: string;
      mode: string;
      startedAt: Date;
      expiresAt: Date;
      endedAt: Date | null;
      tenant: { name: string };
      staff: { email: string };
    },
    portalUrlValue: string | null,
  ): ImpersonationResponse {
    return {
      id: row.id,
      tenant_id: row.tenantId,
      tenant_name: row.tenant.name,
      staff_id: row.staffId,
      staff_email: row.staff.email,
      mode: 'view',
      started_at: row.startedAt.toISOString(),
      expires_at: row.expiresAt.toISOString(),
      ended_at: iso(row.endedAt),
      portal_url: portalUrlValue,
    };
  }
}
