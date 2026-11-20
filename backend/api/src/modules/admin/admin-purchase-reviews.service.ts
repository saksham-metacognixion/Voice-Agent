import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import {
  type AdminPurchaseReview,
  type AdminPurchaseReviewsQuery,
  FIRST_PURCHASE_REVIEW_TRIGGER,
  type Page,
  type PurchaseStatus,
  type StaffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { portalUrl } from '../../common/env';
import { cursorArgs, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import { NotificationsService } from '../notifications';
import { iso, uuidParam } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';

type Decision = 'approve' | 'reject';

/**
 * SA9 "Purchase reviews" — §17's manual review of a first purchase over the limit
 * (ADR 0036 §3). The customer side files the review (`BillingService.requestReview`);
 * this is the other half.
 *
 * A decision is one transaction: the review moves `open → approved | rejected` by a
 * conditional update (a second reviewer, a double click, a retry finds it decided and gets
 * `409 CONFLICT`, never a second decision), the purchase moves `in_review → approved |
 * rejected` the same way, and the `staff_audit_log` row and the workspace's own
 * `audit_log` row are written inside it — no audit, no decision. The email to the
 * workspace's owners and admins goes through the outbox after the commit, keyed on the
 * review, so a retried delivery never mails twice.
 *
 * Approval moves no money: it lets the customer's next checkout of that pack at that
 * price open a Stripe session (`BillingService.takeApproval`). Rejection moves none either
 * — nothing was ever charged.
 */
@Injectable()
export class AdminPurchaseReviewsService {
  private readonly log = new Logger(AdminPurchaseReviewsService.name);

  constructor(
    private readonly audit: StaffAuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(query: AdminPurchaseReviewsQuery): Promise<Page<AdminPurchaseReview>> {
    const where: Prisma.FraudReviewWhereInput = { trigger: FIRST_PURCHASE_REVIEW_TRIGGER };
    if (query.status) where.status = query.status;
    if (query.tenant_id) where.tenantId = query.tenant_id;
    const [rows, total] = await Promise.all([
      adminDb.fraudReview.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: INCLUDE, ...cursorArgs(query) }),
      adminDb.fraudReview.count({ where }),
    ]);
    const page = toPage(rows, query);
    return { ...page, items: await Promise.all(page.items.map((r) => this.toResponse(r))), total };
  }

  async decide(staff: StaffContext, idRaw: string, decision: Decision, body: StaffActionRequest, request: FastifyRequest): Promise<AdminPurchaseReview> {
    const id = uuidParam(idRaw, 'Purchase review');
    const review = await adminDb.fraudReview.findUnique({ where: { id }, include: INCLUDE });
    if (!review || review.trigger !== FIRST_PURCHASE_REVIEW_TRIGGER) throw AppError.notFound('Purchase review');
    if (review.status !== 'open') throw new AppError('CONFLICT', `This review was already ${review.status}.`);

    const status = decision === 'approve' ? 'approved' : 'rejected';
    const action = decision === 'approve' ? 'purchase.review_approved' : 'purchase.review_rejected';
    const decidedAt = new Date();

    await adminDb.$transaction(async (tx) => {
      const moved = await tx.fraudReview.updateMany({
        where: { id, status: 'open' },
        data: { status, decision: status, reviewerId: staff.staffId, note: body.note ?? null, decidedAt },
      });
      if (moved.count !== 1) throw new AppError('CONFLICT', 'Someone else decided this review a moment ago.');
      if (review.purchaseId) {
        await tx.purchase.updateMany({ where: { id: review.purchaseId, status: 'in_review' }, data: { status: status as PurchaseStatus } });
      }
      await this.audit.record(
        {
          staff,
          action,
          targetType: 'purchase',
          targetId: review.purchaseId ?? id,
          tenantId: review.tenantId,
          reasonCode: body.reason_code,
          note: body.note,
          request,
          before: { review_status: 'open', purchase_status: review.purchase?.status ?? null },
          after: { review_status: status, purchase_status: status, amount_cents: review.amountCents, currency: review.currency },
        },
        tx,
      );
      await tx.auditLog.create({
        data: {
          tenantId: review.tenantId,
          actorUserId: null,
          action,
          targetType: 'purchase',
          targetId: review.purchaseId ?? id,
          metaJson: { by: 'staff', reason_code: body.reason_code, review_id: id, amount_cents: review.amountCents, currency: review.currency } as Prisma.InputJsonValue,
        },
      });
    });

    await this.notifyCustomer(review.tenantId, review.tenant.name, id, decision).catch((error: unknown) =>
      this.log.warn(`review ${id}: customer email not sent: ${error instanceof Error ? error.message : String(error)}`),
    );
    const fresh = await adminDb.fraudReview.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    return this.toResponse(fresh);
  }

  /** Owners and admins — the roles that can pay (§6.1). Never a staff note: the email says only the outcome. */
  private async notifyCustomer(tenantId: string, tenantName: string, reviewId: string, decision: Decision): Promise<void> {
    const people = await adminDb.membership.findMany({
      where: { tenantId, role: { in: ['owner', 'admin'] } },
      select: { user: { select: { id: true, email: true, name: true } } },
    });
    const link = `${portalUrl()}/app/wallet`;
    for (const { user } of people) {
      const subject = decision === 'approve' ? `${tenantName}: your purchase is approved` : `${tenantName}: we could not approve your purchase`;
      const text = [
        `Hi ${user.name ?? 'there'},`,
        '',
        decision === 'approve'
          ? `We have reviewed the first purchase for ${tenantName} and it is approved. You can complete the payment here: ${link}`
          : `We have reviewed the first purchase for ${tenantName} and could not approve it. Nothing was charged. Reply to this email or contact support and we will help.`,
      ].join('\n');
      await this.notifications.deliver({
        workspaceId: tenantId,
        userId: user.id,
        kind: 'purchase_review',
        dedupeKey: `purchase_review:${reviewId}:${user.id}`,
        email: { to: user.email, subject, text },
        payload: { review_id: reviewId, decision },
      });
    }
  }

  private async toResponse(r: Row): Promise<AdminPurchaseReview> {
    const requester = r.purchaseId
      ? await adminDb.auditLog.findFirst({
          where: { tenantId: r.tenantId, action: 'purchase.review_requested', targetId: r.purchaseId },
          select: { actor: { select: { email: true } } },
        })
      : null;
    return {
      id: r.id,
      tenant_id: r.tenantId,
      tenant_name: r.tenant.name,
      tenant_country: r.tenant.country,
      purchase_id: r.purchaseId,
      purchase_status: (r.purchase?.status as PurchaseStatus | undefined) ?? null,
      pack_id: r.purchase?.packId ?? null,
      amount_cents: r.amountCents,
      currency: r.currency,
      credits: r.purchase?.credits ?? null,
      status: r.status as AdminPurchaseReview['status'],
      tenant_created_at: r.tenant.createdAt.toISOString(),
      requested_by_email: requester?.actor?.email ?? null,
      reviewer_email: r.reviewer?.email ?? null,
      decision_note: r.note,
      decided_at: iso(r.decidedAt),
      created_at: r.createdAt.toISOString(),
    };
  }
}

const INCLUDE = {
  tenant: { select: { name: true, country: true, createdAt: true } },
  purchase: { select: { status: true, packId: true, credits: true } },
  reviewer: { select: { email: true } },
} satisfies Prisma.FraudReviewInclude;
type Row = Prisma.FraudReviewGetPayload<{ include: typeof INCLUDE }>;
