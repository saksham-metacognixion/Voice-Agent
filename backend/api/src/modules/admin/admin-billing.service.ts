import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminAutoTopupStatusResponse,
  AdminBillingPurchase,
  AdminBillingSummaryResponse,
  AdminFailedTopup,
  AdminFailedTopupsQuery,
  AdminPurchaseDetail,
  AdminPurchasesQuery,
  AdminRange,
  AdminRefundRequest,
  AdminRefundResponse,
  AdminTopupRetryResponse,
  Page,
  ReasonCode,
  StaffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import {
  AutoTopupService,
  StripeGateway,
  TOPUP_FAILURE_COOLDOWN_MS,
  TOPUP_IN_FLIGHT_MS,
  type TopupAttemptOutcome,
} from '../billing';
import { RuntimeCacheService } from '../runtime-cache';
import { REFUND_REF_TYPE, WalletService } from '../wallet';
import { toPurchase } from './admin-customers.service';
import { DAY_MS, idMatch, iso, num, rangeWindow, uuidParam } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';

type PurchaseRow = Prisma.PurchaseGetPayload<{ include: { tenant: { select: { name: true } } } }>;
type RefundRow = Prisma.RefundGetPayload<{
  include: { staff: { select: { id: true; name: true; email: true } } };
}>;

/** The `refunds.status` values this service writes. */
type RefundState = 'pending' | 'succeeded' | 'failed';

/**
 * SA9 Billing & finance (admin §4 SA9, D13): purchases across every workspace, refunds
 * through Stripe with the credits drawn back through the wallet, the failed auto top-ups
 * and the basic revenue report. Reads cross workspaces on `adminDb` (ADR 0006); the two
 * money writes go through the same code the customer path uses — `WalletService.withWallet`
 * for the ledger, `AutoTopupService` for the top-up rules — and are audited twice
 * (`staff_audit_log` inside the write's transaction, the workspace's own `audit_log`).
 *
 * A refund is three steps that cannot share one transaction (the middle one is Stripe):
 *
 *   1. claim   — `refunds` row `pending` + `purchase.refund_requested`, in one transaction
 *   2. Stripe  — `refunds.create` under idempotency key `refund-<row id>`
 *   3. settle  — under the wallet lock: the `refund` ledger debit (idempotent on the row
 *                id), the row `succeeded`, the purchase `refunded` when nothing is left,
 *                the workspace audit row and `purchase.refunded`
 *
 * The row id is the console's `idempotency_key`, so a double click, a retry after a
 * timeout or a second tab answers the existing refund; a retry of a row whose Stripe
 * call failed retries that row with the same key, and a retry of one whose Stripe call
 * succeeded but whose settle did not gets the same Stripe refund back and settles it.
 */
@Injectable()
export class AdminBillingService {
  private readonly log = new Logger(AdminBillingService.name);

  constructor(
    private readonly wallet: WalletService,
    private readonly stripe: StripeGateway,
    private readonly topups: AutoTopupService,
    private readonly runtimeCache: RuntimeCacheService,
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
  ) {}

  // ------------------------------------------------------------------ purchases

  async listPurchases(query: AdminPurchasesQuery): Promise<Page<AdminBillingPurchase>> {
    const where: Prisma.PurchaseWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.tenant_id) where.tenantId = query.tenant_id;
    if (query.is_auto_topup) where.isAutoTopup = query.is_auto_topup === 'true';
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (query.q) {
      const q = query.q;
      where.OR = [
        { tenant: { name: { contains: q, mode: 'insensitive' } } },
        ...idMatch(q),
        { stripeSessionId: q },
        { stripePaymentIntent: q },
      ];
    }
    const [rows, total] = await Promise.all([
      adminDb.purchase.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { tenant: { select: { name: true } } },
        ...cursorArgs(query),
      }),
      adminDb.purchase.count({ where }),
    ]);
    const page = toPage(rows, query);
    return { ...page, items: await this.enrich(page.items), total };
  }

  async purchaseDetail(idRaw: string): Promise<AdminPurchaseDetail> {
    const id = uuidParam(idRaw, 'Purchase');
    const purchase = await adminDb.purchase.findUnique({
      where: { id },
      include: { tenant: { select: { name: true } } },
    });
    if (!purchase) throw AppError.notFound('Purchase');
    const [item] = await this.enrich([purchase]);
    const refunds = await adminDb.refund.findMany({
      where: { purchaseId: id },
      orderBy: { createdAt: 'asc' },
      include: { staff: { select: { id: true, name: true, email: true } } },
    });
    const [ledger, lots, invoice] = await Promise.all([
      adminDb.creditLedger.findMany({
        where: {
          tenantId: purchase.tenantId,
          OR: [
            { refType: 'purchase', refId: id },
            ...(refunds.length
              ? [{ refType: REFUND_REF_TYPE, refId: { in: refunds.map((r) => r.id) } }]
              : []),
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      adminDb.creditLot.findMany({ where: { purchaseId: id }, orderBy: { createdAt: 'asc' } }),
      adminDb.invoice.findFirst({ where: { purchaseId: id }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      ...item!,
      refunds: refunds.map(toRefund),
      ledger: ledger.map((r) => ({
        id: r.id,
        delta: num(r.delta),
        balance_after: num(r.balanceAfter),
        reason: r.reason,
        ref_type: r.refType,
        ref_id: r.refId,
        created_at: r.createdAt.toISOString(),
      })),
      lots: lots.map((l) => ({
        id: l.id,
        credits_total: num(l.creditsTotal),
        credits_remaining: num(l.creditsRemaining),
        expires_at: l.expiresAt.toISOString(),
      })),
      invoice: invoice
        ? {
            number: invoice.number,
            status: invoice.status,
            amount_paid_cents: invoice.amountPaidCents,
            hosted_url: invoice.hostedUrl,
            pdf_url: invoice.pdfUrl,
          }
        : purchase.invoiceUrl
          ? {
              number: null,
              status: null,
              amount_paid_cents: null,
              hosted_url: purchase.invoiceUrl,
              pdf_url: null,
            }
          : null,
    };
  }

  /** The SA2 row plus tenant name, pack name and what has been / can still be refunded. */
  private async enrich(rows: PurchaseRow[]): Promise<AdminBillingPurchase[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const packIds = [...new Set(rows.map((r) => r.packId).filter((p): p is string => p !== null))];
    const [refunded, packs] = await Promise.all([
      adminDb.refund.groupBy({
        by: ['purchaseId'],
        where: { purchaseId: { in: ids }, status: 'succeeded' },
        _sum: { amountCents: true },
      }),
      packIds.length
        ? adminDb.pack.findMany({
            where: { id: { in: packIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const refundedBy = new Map(refunded.map((g) => [g.purchaseId, g._sum.amountCents ?? 0]));
    const packName = new Map(packs.map((p) => [p.id, p.name]));
    return rows.map((r) => {
      const refundedCents = refundedBy.get(r.id) ?? 0;
      return {
        ...toPurchase(r),
        tenant_name: r.tenant.name,
        pack_name: r.packId ? (packName.get(r.packId) ?? null) : null,
        refunded_cents: refundedCents,
        refundable_cents: r.status === 'paid' ? Math.max(0, r.amountCents - refundedCents) : 0,
      };
    });
  }

  // ------------------------------------------------------------------ refunds (admin §4 SA9)

  async refund(
    staff: StaffContext,
    idRaw: string,
    body: AdminRefundRequest,
    request: FastifyRequest,
  ): Promise<AdminPurchaseDetail> {
    const id = uuidParam(idRaw, 'Purchase');
    const refundId = body.idempotency_key ?? randomUUID();
    const purchase = await adminDb.purchase.findUnique({
      where: { id },
      include: { refunds: true },
    });
    if (!purchase) throw AppError.notFound('Purchase');
    const tenantId = purchase.tenantId;

    // The replay is answered before anything else: the first attempt already moved the
    // money, and a retry must never be refused by a limit or a state it caused itself.
    const existing = await adminDb.refund.findUnique({ where: { id: refundId } });
    if (existing) {
      if (existing.purchaseId !== id)
        throw new AppError(
          'CONFLICT',
          'This idempotency key was already used for another purchase.',
        );
      if (existing.status === 'succeeded') return this.purchaseDetail(id);
    }

    if (purchase.status !== 'paid') {
      throw new AppError(
        'CONFLICT',
        `Only a paid purchase can be refunded; this one is ${purchase.status}.`,
      );
    }
    const refundedCents = purchase.refunds
      .filter((r) => r.status === 'succeeded')
      .reduce((sum, r) => sum + r.amountCents, 0);
    const refundable = purchase.amountCents - refundedCents;
    if (refundable <= 0)
      throw new AppError('CONFLICT', 'This purchase has already been refunded in full.');
    // A retry keeps the row's amount: the Stripe idempotency key binds the original parameters.
    const amountCents = existing ? existing.amountCents : (body.amount_cents ?? refundable);
    if (amountCents < 1 || amountCents > refundable) {
      throw new AppError(
        'VALIDATION_FAILED',
        `The amount must be between 1 and ${refundable} cents (what is left to refund).`,
        [{ field: 'amount_cents', message: `Between 1 and ${refundable}` }],
      );
    }
    // The role cap is per purchase: what this purchase has already given back (or has in
    // flight on another key) counts, so ten partial refunds cannot add up past it.
    const inFlightCents = purchase.refunds
      .filter((r) => r.status === 'pending' && r.id !== refundId)
      .reduce((sum, r) => sum + r.amountCents, 0);
    await this.limits.assertRefund(staff, amountCents, refundedCents + inFlightCents);
    const creditsReversed = existing
      ? num(existing.creditsReversed)
      : roundCredits((purchase.credits * amountCents) / purchase.amountCents);

    // A Checkout purchase carries its PaymentIntent from fulfilment; an older row may only
    // hold the session, in which case the intent is read from Stripe and remembered.
    let paymentIntentId = purchase.stripePaymentIntent;
    if (!paymentIntentId && purchase.stripeSessionId) {
      try {
        paymentIntentId = (await this.stripe.retrieveCheckoutSession(purchase.stripeSessionId))
          .payment_intent;
      } catch (error) {
        this.log.warn(
          `refund ${refundId}: could not read session ${purchase.stripeSessionId}: ${String(error)}`,
        );
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          'We could not reach the payment provider. Please try again in a moment.',
        );
      }
      if (paymentIntentId)
        await adminDb.purchase.updateMany({
          where: { id, stripePaymentIntent: null },
          data: { stripePaymentIntent: paymentIntentId },
        });
    }
    if (!paymentIntentId)
      throw new AppError('CONFLICT', 'This purchase has no payment on file to refund.');

    // 1. Claim: the row and its request audit, in one transaction. Two requests racing on
    //    the same key collide on the primary key; the loser is told the first is in flight.
    //    A retry of a `failed` row counts an attempt, and takes it only if the row is
    //    still failed — two retries racing cannot both reach Stripe on fresh keys.
    const audit = { staff, tenantId, reasonCode: body.reason_code, note: body.note, request };
    const retryAfterFailure = existing?.status === 'failed';
    let attempts = existing?.attempts ?? 0;
    try {
      await adminDb.$transaction(async (tx) => {
        if (retryAfterFailure) {
          const claimed = await tx.refund.updateMany({
            where: { id: refundId, status: 'failed' satisfies RefundState },
            data: { status: 'pending' satisfies RefundState, attempts: { increment: 1 } },
          });
          if (claimed.count === 0)
            throw new AppError('CONFLICT', 'A refund with this key is already in progress.');
          attempts += 1;
        } else if (!existing) {
          // (An existing row still `pending` is a request that died mid-flight: it is
          // re-sent as it is, on the key it already used.)
          await tx.refund.create({
            data: {
              id: refundId,
              purchaseId: id,
              amountCents,
              creditsReversed,
              reasonCode: body.reason_code,
              staffId: staff.staffId,
              status: 'pending' satisfies RefundState,
            },
          });
        }
        await this.audit.record(
          {
            ...audit,
            action: 'purchase.refund_requested',
            targetType: 'refund',
            targetId: refundId,
            after: {
              purchase_id: id,
              amount_cents: amountCents,
              credits_reversed: creditsReversed,
              refundable_before: refundable,
              retry: Boolean(existing),
              attempt: attempts,
              ticket_id: body.ticket_id ?? null,
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError('CONFLICT', 'A refund with this key is already in progress.');
      }
      throw error;
    }

    // 2. Stripe, outside every transaction. Stripe stores an error under its idempotency
    //    key for 24 h, so a retry after a failure uses a fresh key — after looking for a
    //    refund the failed attempt may have made anyway (a timeout that did reach Stripe).
    let stripeRefund: { id: string; status: string };
    try {
      stripeRefund =
        (attempts > 0 ? await this.stripe.findRefund(paymentIntentId, refundId) : null) ??
        (await this.stripe.refundPaymentIntent({
          paymentIntentId,
          amountCents,
          idempotencyKey: attempts > 0 ? `refund-${refundId}-r${attempts}` : `refund-${refundId}`,
          reason: stripeReasonFor(body.reason_code),
          metadata: { purchase_id: id, refund_id: refundId, workspace_id: tenantId },
        }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailed(audit, refundId, id, message);
      this.log.error(`refund ${refundId} on purchase ${id}: Stripe refused (${message})`);
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'The payment provider did not accept the refund. Nothing was reversed; try again from the same dialog.',
      );
    }
    if (stripeRefund.status === 'failed' || stripeRefund.status === 'canceled') {
      await this.markFailed(
        audit,
        refundId,
        id,
        `stripe refund ${stripeRefund.id} is ${stripeRefund.status}`,
      );
      throw new AppError(
        'CONFLICT',
        `The payment provider could not complete the refund (${stripeRefund.status}). Nothing was reversed.`,
      );
    }

    // 3. Settle under the wallet lock: ledger, row, purchase, both audit rows.
    await this.wallet.withWallet(tenantId, async (tx, wallet) => {
      const row = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (row.status === 'succeeded') return;
      const write =
        creditsReversed > 0
          ? await wallet.debit({
              credits: creditsReversed,
              reason: 'refund',
              refType: REFUND_REF_TYPE,
              refId: refundId,
            })
          : null;
      await tx.refund.update({
        where: { id: refundId },
        data: { status: 'succeeded' satisfies RefundState, stripeRefundId: stripeRefund.id },
      });
      const agg = await tx.refund.aggregate({
        where: { purchaseId: id, status: 'succeeded' },
        _sum: { amountCents: true },
      });
      const full = (agg._sum.amountCents ?? 0) >= purchase.amountCents;
      if (full) await tx.purchase.update({ where: { id }, data: { status: 'refunded' } });
      await tx.auditLog.create({
        data: {
          tenantId,
          action: 'purchase.refunded',
          targetType: 'purchase',
          targetId: id,
          metaJson: {
            by: 'staff',
            reason_code: body.reason_code,
            amount_cents: amountCents,
            currency: purchase.currency,
            credits_reversed: creditsReversed,
            ledger_id: write?.id ?? null,
            full,
          },
        },
      });
      await this.audit.record(
        {
          ...audit,
          action: 'purchase.refunded',
          targetType: 'refund',
          targetId: refundId,
          before: { purchase_status: 'paid', refunded_cents: refundedCents },
          after: {
            purchase_id: id,
            amount_cents: amountCents,
            currency: purchase.currency,
            credits_reversed: creditsReversed,
            ledger_id: write?.id ?? null,
            balance_after: write?.balance_after ?? null,
            stripe_refund_id: stripeRefund.id,
            purchase_status: full ? 'refunded' : 'paid',
            ticket_id: body.ticket_id ?? null,
          },
        },
        tx,
      );
    });
    // The ledger listeners (SSE `wallet`, low-balance) fired inside `withWallet`; the hot
    // path's projection is refreshed the way every other ledger-moving staff write does it.
    await this.runtimeCache
      .refresh(tenantId)
      .catch((e) => this.log.warn(`runtime cache refresh after refund failed: ${String(e)}`));
    this.log.log(
      `refund ${refundId}: ${amountCents} ${purchase.currency} of purchase ${id} by ${staff.email} (${body.reason_code}), ${creditsReversed} credits reversed`,
    );
    return this.purchaseDetail(id);
  }

  /** The row is `failed` and the failure audited; the same key retries it. Never throws past the caller's own error. */
  private async markFailed(
    audit: {
      staff: StaffContext;
      tenantId: string;
      reasonCode: ReasonCode;
      note?: string;
      request: FastifyRequest;
    },
    refundId: string,
    purchaseId: string,
    error: string,
  ): Promise<void> {
    await adminDb
      .$transaction(async (tx) => {
        await tx.refund.update({
          where: { id: refundId },
          data: { status: 'failed' satisfies RefundState },
        });
        await this.audit.record(
          {
            ...audit,
            action: 'purchase.refund_failed',
            targetType: 'refund',
            targetId: refundId,
            after: { purchase_id: purchaseId, error: error.slice(0, 500) },
          },
          tx,
        );
      })
      .catch((e) =>
        this.log.error(`refund ${refundId}: could not record the failure: ${String(e)}`),
      );
  }

  // ------------------------------------------------------------------ auto top-ups (§5.4)

  async failedTopups(
    query: AdminFailedTopupsQuery,
    now = new Date(),
  ): Promise<Page<AdminFailedTopup>> {
    const where: Prisma.PurchaseWhereInput = {
      isAutoTopup: true,
      OR: [
        { status: 'abandoned' },
        { status: 'pending', createdAt: { lt: new Date(now.getTime() - TOPUP_IN_FLIGHT_MS) } },
      ],
      ...(query.tenant_id ? { tenantId: query.tenant_id } : {}),
    };
    const [rows, total] = await Promise.all([
      adminDb.purchase.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { tenant: { select: { name: true, autoTopupJson: true } } },
        ...cursorArgs(query),
      }),
      adminDb.purchase.count({ where }),
    ]);
    const page = toPage(rows, query);
    const tenantIds = [...new Set(page.items.map((r) => r.tenantId))];
    const alerts = tenantIds.length
      ? await adminDb.alert.findMany({
          where: { tenantId: { in: tenantIds }, type: 'auto_topup_failed', resolvedAt: null },
          select: { tenantId: true, createdAt: true, sentAt: true },
        })
      : [];
    const alertFor = new Map(alerts.map((a) => [a.tenantId, a]));
    return {
      ...page,
      total,
      items: page.items.map((r) => {
        const settings = AutoTopupService.parse(r.tenant.autoTopupJson);
        const alert = alertFor.get(r.tenantId);
        return {
          ...toPurchase(r),
          tenant_name: r.tenant.name,
          auto_topup_enabled: settings?.enabled === true,
          card_last4: settings?.card_last4 ?? null,
          cooldown_until:
            r.status === 'abandoned' && r.failureReason
              ? new Date(r.updatedAt.getTime() + TOPUP_FAILURE_COOLDOWN_MS).toISOString()
              : null,
          alert_open: Boolean(alert),
          last_notified: iso(alert?.sentAt ?? alert?.createdAt ?? null),
        };
      }),
    };
  }

  /**
   * SA9 "Retry now": runs the §5.4 evaluation for the workspace of a failed top-up, past
   * the decline cooldown but under every other rule (in flight, disabled, no card, above
   * threshold). Credits still arrive only from Stripe's confirmation.
   */
  async retryTopup(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminTopupRetryResponse> {
    const id = uuidParam(idRaw, 'Auto top-up');
    const purchase = await adminDb.purchase.findUnique({
      where: { id },
      select: { id: true, tenantId: true, isAutoTopup: true, status: true, failureReason: true },
    });
    if (!purchase || !purchase.isAutoTopup) throw AppError.notFound('Auto top-up');
    const audit = {
      staff,
      tenantId: purchase.tenantId,
      reasonCode: body.reason_code,
      note: body.note,
      request,
      targetType: 'purchase',
      targetId: id,
    };
    // The request is recorded before the provider call, the outcome after it (ADR 0021 §1).
    await this.audit.record({
      ...audit,
      action: 'topup.retry_requested',
      after: { status: purchase.status, failure_reason: purchase.failureReason },
    });
    let outcome: TopupAttemptOutcome;
    try {
      outcome = await this.topups.evaluate(purchase.tenantId, 'staff', { ignoreCooldown: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.audit.record({
        ...audit,
        action: 'topup.retry_failed',
        after: { error: message.slice(0, 500) },
      });
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'We could not reach the payment provider. The pending top-up will be reconciled by the sweep.',
      );
    }
    const answer: AdminTopupRetryResponse = {
      outcome: outcome.outcome,
      purchase_id: 'purchaseId' in outcome ? outcome.purchaseId : null,
      reason: outcome.outcome === 'charged' ? outcome.status : outcome.reason,
    };
    await this.audit.record({
      ...audit,
      action: 'topup.retried',
      after: { ...answer, retried_purchase_id: id },
    });
    if (outcome.outcome === 'skipped' && outcome.reason === 'in_flight') {
      throw new AppError(
        'CONFLICT',
        'A top-up for this workspace is already in flight and its charge may still land. Try again in 30 minutes.',
      );
    }
    this.log.log(
      `top-up retry on ${purchase.tenantId} by ${staff.email}: ${answer.outcome}${answer.reason ? ` (${answer.reason})` : ''}`,
    );
    return answer;
  }

  /** SA9 "Disable auto top-up": the same settings write as `PUT /wallet/auto-topup {enabled:false}`, by staff. The customer can switch it back on. */
  async disableAutoTopup(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminAutoTopupStatusResponse> {
    const id = uuidParam(idRaw, 'Customer');
    const tenant = await adminDb.tenant.findUnique({
      where: { id },
      select: { autoTopupJson: true },
    });
    if (!tenant) throw AppError.notFound('Customer');
    const current = AutoTopupService.parse(tenant.autoTopupJson);
    const next = AutoTopupService.disabled(current);
    if (current?.enabled) {
      await adminDb.$transaction(async (tx) => {
        await this.topups.writeSettings(tx, id, next, 'disabled', {
          actorUserId: null,
          meta: { by: 'staff', reason_code: body.reason_code },
        });
        await this.audit.record(
          {
            staff,
            action: 'topup.disabled',
            targetType: 'tenant',
            targetId: id,
            tenantId: id,
            reasonCode: body.reason_code,
            note: body.note,
            before: { enabled: true, pack_id: current.pack_id, threshold: current.threshold },
            after: { enabled: false, ticket_id: body.ticket_id ?? null },
            request,
          },
          tx,
        );
      });
      this.log.log(`auto top-up on ${id} disabled by ${staff.email} (${body.reason_code})`);
    }
    return {
      tenant_id: id,
      enabled: false,
      pack_id: next.pack_id,
      threshold: next.threshold,
      card_last4: next.card_last4,
    };
  }

  // ------------------------------------------------------------------ revenue report

  /**
   * Sales are purchases created in the window that were paid (`paid`, or `refunded`
   * since — a refunded sale was still a sale, and its refund is counted on the other
   * side). SA1's `credit_sales` counts `paid` rows by `updated_at`; this report keys on
   * `created_at` so a refund cannot move a sale out of its month.
   */
  async summary(range: AdminRange, now = new Date()): Promise<AdminBillingSummaryResponse> {
    const { from, to } = rangeWindow(range, now);
    const sold: Prisma.PurchaseWhereInput = {
      status: { in: ['paid', 'refunded'] },
      createdAt: { gte: from, lte: to },
    };
    const [sales, byPack, refunds, failedTopups, salesByDay, refundsByDay] = await Promise.all([
      adminDb.purchase.groupBy({
        by: ['currency'],
        where: sold,
        _sum: { amountCents: true, credits: true },
        _count: { _all: true },
      }),
      adminDb.purchase.groupBy({
        by: ['packId'],
        where: sold,
        _sum: { amountCents: true, credits: true },
        _count: { _all: true },
      }),
      adminDb.refund.findMany({
        where: { status: 'succeeded', createdAt: { gte: from, lte: to } },
        select: {
          amountCents: true,
          creditsReversed: true,
          purchase: { select: { currency: true } },
        },
      }),
      adminDb.purchase.count({
        where: { isAutoTopup: true, status: 'abandoned', updatedAt: { gte: from, lte: to } },
      }),
      adminDb.$queryRaw<Array<{ day: string; cents: bigint; n: bigint }>>(
        Prisma.sql`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, coalesce(sum(amount_cents), 0)::bigint AS cents, count(*)::bigint AS n FROM purchases WHERE status IN ('paid', 'refunded') AND created_at >= ${from} AND created_at <= ${to} GROUP BY 1`,
      ),
      adminDb.$queryRaw<Array<{ day: string; cents: bigint }>>(
        Prisma.sql`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, coalesce(sum(amount_cents), 0)::bigint AS cents FROM refunds WHERE status = 'succeeded' AND created_at >= ${from} AND created_at <= ${to} GROUP BY 1`,
      ),
    ]);
    const packIds = byPack.map((g) => g.packId).filter((p): p is string => p !== null);
    const packs = packIds.length
      ? await adminDb.pack.findMany({
          where: { id: { in: packIds } },
          select: { id: true, name: true },
        })
      : [];
    const packName = new Map(packs.map((p) => [p.id, p.name]));

    const refundsByCurrency = new Map<
      string,
      { count: number; amount_cents: number; credits_reversed: number }
    >();
    for (const r of refunds) {
      const currency = r.purchase.currency;
      const entry = refundsByCurrency.get(currency) ?? {
        count: 0,
        amount_cents: 0,
        credits_reversed: 0,
      };
      entry.count += 1;
      entry.amount_cents += r.amountCents;
      entry.credits_reversed = roundCredits(entry.credits_reversed + num(r.creditsReversed));
      refundsByCurrency.set(currency, entry);
    }

    const byDay = new Map<string, AdminBillingSummaryResponse['series'][number]>();
    for (
      let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
      t <= to.getTime();
      t += DAY_MS
    ) {
      const day = new Date(t).toISOString().slice(0, 10);
      byDay.set(day, { day, sales_cents: 0, refunds_cents: 0, purchases: 0 });
    }
    for (const r of salesByDay) {
      const d = byDay.get(r.day);
      if (d) {
        d.sales_cents = Number(r.cents);
        d.purchases = Number(r.n);
      }
    }
    for (const r of refundsByDay) {
      const d = byDay.get(r.day);
      if (d) d.refunds_cents = Number(r.cents);
    }

    return {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      sales: sales.map((g) => ({
        currency: g.currency,
        purchases: g._count._all,
        amount_cents: g._sum.amountCents ?? 0,
        credits: g._sum.credits ?? 0,
      })),
      refunds: [...refundsByCurrency.entries()].map(([currency, r]) => ({ currency, ...r })),
      failed_topups: failedTopups,
      packs: byPack
        .map((g) => ({
          pack_id: g.packId ?? 'custom',
          pack_name: g.packId ? (packName.get(g.packId) ?? null) : null,
          purchases: g._count._all,
          credits: g._sum.credits ?? 0,
          amount_cents: g._sum.amountCents ?? 0,
        }))
        .sort((a, b) => b.amount_cents - a.amount_cents),
      series: [...byDay.values()],
    };
  }
}

function toRefund(r: RefundRow): AdminRefundResponse {
  return {
    id: r.id,
    purchase_id: r.purchaseId,
    amount_cents: r.amountCents,
    credits_reversed: num(r.creditsReversed),
    status: (['pending', 'succeeded', 'failed'] as const).includes(r.status as RefundState)
      ? (r.status as RefundState)
      : 'pending',
    reason_code: r.reasonCode,
    staff: { id: r.staff.id, name: r.staff.name, email: r.staff.email },
    stripe_refund_id: r.stripeRefundId,
    created_at: r.createdAt.toISOString(),
  };
}

/** Stripe's three refund reasons, from Appendix B's fourteen. Anything else is "the customer asked". */
function stripeReasonFor(code: ReasonCode): 'duplicate' | 'fraudulent' | 'requested_by_customer' {
  if (code === 'fraud_suspected' || code === 'abuse_policy') return 'fraudulent';
  if (code === 'billing_error') return 'duplicate';
  return 'requested_by_customer';
}

/** Credits to two decimals, the wallet's own precision (§5.1). */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100;
}
