import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Prisma, adminDb, isUniqueViolation, withWorkspace, type PlanTier } from '@portal/db';
import {
  type AutoTopup,
  type CheckoutConfirmResponse,
  type CheckoutRequest,
  type CheckoutResponse,
  FIRST_PURCHASE_REVIEW_TRIGGER,
  type PricingConfig,
  type PricingPack,
  planTier as planTierEnum,
  purchaseNeedsReview,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { OpsAlertService } from '../alerts';
import { type WorkspaceContext, WorkspaceMfaService, assertTermsAccepted } from '../auth';
import { PlatformConfigService } from '../config';
import { WalletService, addMonths } from '../wallet/wallet.service';
import { type CheckoutSessionFacts, StripeGateway } from './stripe.gateway';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Checkout purchase still `pending` this long after its session was made is asked about. */
export const CHECKOUT_RECONCILE_AFTER_MS = 5 * 60_000;
/** Sessions live 31 minutes; a purchase pending for longer than this is SA9's, not the sweep's. */
export const CHECKOUT_RECONCILE_WINDOW_MS = 48 * 60 * 60_000;

/** Fired after a purchase is credited and the transaction has committed. D6: the activation hook. */
export type PurchaseCreditedListener = (event: { workspaceId: string; purchaseId: string; agentId: string | null; isAutoTopup: boolean }) => void | Promise<void>;

export type FulfilmentOutcome =
  | { outcome: 'credited'; purchaseId: string; credits: number; balance: number }
  | { outcome: 'already_paid'; purchaseId: string }
  | { outcome: 'unpaid'; purchaseId: string }
  | { outcome: 'ignored'; reason: string };

/**
 * §13.7 — money in. Two halves that never run in one request:
 *
 *   createCheckout   customer path: pending purchase → Stripe Checkout Session → URL
 *   fulfil           webhook path: paid session → purchase paid + lot + ledger + plan tier
 *
 * The Postgres rule (ADR 0006) shapes both: read → close → Stripe → reopen. No Stripe call
 * ever runs inside a transaction.
 */
@Injectable()
export class BillingService {
  private readonly log = new Logger(BillingService.name);
  private readonly creditedListeners: PurchaseCreditedListener[] = [];

  constructor(
    private readonly stripe: StripeGateway,
    private readonly config: PlatformConfigService,
    @Inject(forwardRef(() => WalletService)) private readonly wallet: WalletService,
    private readonly mfa: WorkspaceMfaService,
    private readonly alerts: OpsAlertService,
  ) {}

  /** §13.8: the activation module starts the go-live job from here when W7's session carried `agent_id`. */
  onPurchaseCredited(listener: PurchaseCreditedListener): void {
    this.creditedListeners.push(listener);
  }

  private async announceCredited(event: Parameters<PurchaseCreditedListener>[0]): Promise<void> {
    for (const listener of this.creditedListeners) {
      try {
        await listener(event);
      } catch (error) {
        this.log.error(`purchase-credited listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ------------------------------------------------------------------ checkout (customer)

  async createCheckout(ctx: WorkspaceContext, body: CheckoutRequest): Promise<CheckoutResponse> {
    if (await this.config.killSwitch('pause_purchases')) {
      throw new AppError('PURCHASES_PAUSED', 'Purchases are paused for a few minutes. Please try again shortly.');
    }
    // §6.3 A1 (ADR 0036): paying is one of the three doors the Terms gate.
    await assertTermsAccepted(ctx.userId);
    const found = await this.config.purchasablePack(body.pack_id);
    if (!found) throw new AppError('PACK_UNAVAILABLE', 'That pack is not available.');
    const { pack, configVersion } = found;
    if (body.promo_code) {
      // Promo pricing (admin SA6 `promo_codes`) is not wired into the session yet. Until it
      // is, accepting the field would charge full price and record a promo that was never
      // applied — refuse loudly rather than mislead the customer and the ledger.
      throw new AppError('PROMO_INVALID', 'Promo codes are not accepted yet.');
    }

    const tenant = await withWorkspace(ctx, (db) =>
      db.tenant.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { country: true, stripeCustomerId: true, pausedAt: true },
      }),
    );
    if (tenant.pausedAt) throw new AppError('WORKSPACE_PAUSED', 'This workspace is paused. Contact support to resume it.');
    if (pack.regions.length && !pack.regions.includes(tenant.country)) {
      throw new AppError('PACK_UNAVAILABLE', 'That pack is not sold in your country.');
    }
    if (body.agent_id) {
      const agent = await withWorkspace(ctx, (db) => db.agent.findFirst({ where: { id: body.agent_id, tenantId: ctx.workspaceId }, select: { id: true } }));
      if (!agent) throw AppError.notFound('Agent');
    }

    const credits = pack.credits + pack.bonus_credits;

    // §6.2 (ADR 0036): with a card already on file, a purchase that leaves money at risk
    // (a balance over the threshold, auto top-up on) needs a second factor *before* it
    // charges that card. A first purchase types a card in at Stripe, so it is not asked —
    // the rule binds the very next change instead.
    if (tenant.stripeCustomerId) {
      const balance = await this.wallet.balance(ctx.workspaceId);
      await this.mfa.assert(
        { workspaceId: ctx.workspaceId, role: ctx.role, mfa: ctx.mfa ?? false },
        { balance: balance + credits, ...(body.auto_topup?.enabled ? { autoTopupEnabled: true } : {}) },
      );
    }

    // §17 "manual review flag for > $1,000 first purchase" (ADR 0036 §3). The amount is the
    // published pack's, never the request's. A purchase that needs review either rides an
    // approval staff already gave for this pack at this price, or waits for one: no Stripe
    // session exists until then, so nothing can be charged, replayed or webhooked past it.
    const { policy } = await this.config.walletPolicy();
    const hasPaidBefore = (await adminDb.purchase.count({ where: { tenantId: ctx.workspaceId, status: { in: ['paid', 'refunded'] } } })) > 0;
    const needsReview = purchaseNeedsReview({ hasPaidBefore, amountCents: pack.price_cents, limitCents: policy.max_first_purchase_cents_without_review });

    let purchase: { id: string };
    let fromApproval = false;
    if (needsReview) {
      const approved = await this.takeApproval(ctx.workspaceId, pack);
      if (!approved) return this.requestReview(ctx, pack, credits);
      purchase = approved;
      fromApproval = true;
    } else {
      // 1. The pending purchase is the durable record; its id is the Stripe client_reference_id.
      purchase = await withWorkspace(ctx, (db) =>
        db.purchase.create({
          data: {
            tenantId: ctx.workspaceId,
            packId: pack.id,
            amountCents: pack.price_cents,
            currency: pack.currency,
            credits,
            status: 'pending',
            promoCode: body.promo_code,
          },
          select: { id: true },
        }),
      );
    }

    const buyer = await adminDb.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });

    // 2. The Stripe Price from the SA5 sync when it exists; inline price data until then.
    const priceMap = await adminDb.stripePriceMap.findFirst({
      where: { packId: pack.id, currency: pack.currency, configVersion, active: true },
      select: { stripePriceId: true },
    });
    if (!priceMap) this.log.warn(`no stripe_price_map row for ${pack.id}/${pack.currency}/v${configVersion}; using inline price_data`);

    // 3. Stripe, with no transaction open. If Stripe refuses, the purchase must not stay
    //    `pending`: with no session there will never be a `checkout.session.expired` to
    //    abandon it, and SA9 would list a ghost forever. An approved purchase goes back to
    //    `approved`, so the approval is not lost to a Stripe outage.
    let session: { id: string; url: string };
    try {
      session = await this.stripe.createCheckoutSession({
        purchaseId: purchase.id,
        workspaceId: ctx.workspaceId,
        pack,
        configVersion,
        stripePriceId: priceMap?.stripePriceId,
        customerId: tenant.stripeCustomerId,
        customerEmail: buyer?.email,
        autoTopup: body.auto_topup,
        agentId: body.agent_id,
      });
    } catch (error) {
      await adminDb.purchase
        .updateMany({ where: { id: purchase.id, status: 'pending' }, data: { status: fromApproval ? 'approved' : 'abandoned' } })
        .catch((e) => this.log.error(`purchase ${purchase.id}: Stripe failed and the row could not be released: ${String(e)}`));
      throw error;
    }

    // 4. Remember the session so expiry and support can find the purchase from Stripe's side.
    await withWorkspace(ctx, async (db) => {
      await db.purchase.update({ where: { id: purchase.id }, data: { stripeSessionId: session.id } });
      // §6.2 audit (ADR 0036 §9): who started paying for what, and from where.
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'purchase.checkout_started',
          targetType: 'purchase',
          targetId: purchase.id,
          ip: ctx.ip ?? null,
          metaJson: { pack_id: pack.id, amount_cents: pack.price_cents, currency: pack.currency, credits, reviewed: fromApproval } as Prisma.InputJsonValue,
        },
      });
    });

    return { checkout_url: session.url, purchase_id: purchase.id, status: 'checkout' };
  }

  /**
   * The approved first purchase for exactly this pack at exactly this price, moved to
   * `pending` by a conditional update so two tabs cannot both take it. Null when there is
   * none — a pack whose price changed after approval needs a review of its own.
   */
  private async takeApproval(workspaceId: string, pack: PricingPack): Promise<{ id: string } | null> {
    const approved = await adminDb.purchase.findFirst({
      where: { tenantId: workspaceId, status: 'approved', packId: pack.id, amountCents: pack.price_cents, currency: pack.currency, review: { status: 'approved' } },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!approved) return null;
    const taken = await adminDb.purchase.updateMany({ where: { id: approved.id, status: 'approved' }, data: { status: 'pending', stripeSessionId: null } });
    return taken.count === 1 ? approved : null;
  }

  /**
   * Files the §17 review: an `in_review` purchase and its open `fraud_reviews` row in one
   * transaction, plus the workspace's audit row. One open review per workspace
   * (`fraud_reviews_one_open_first_purchase_idx`): a second request — another tab, a
   * retry, a different pack — answers with the one already waiting. Ops is told after the
   * commit; the customer is emailed by staff's decision.
   */
  private async requestReview(ctx: WorkspaceContext, pack: PricingPack, credits: number): Promise<CheckoutResponse> {
    const open = () =>
      adminDb.fraudReview.findFirst({ where: { tenantId: ctx.workspaceId, trigger: FIRST_PURCHASE_REVIEW_TRIGGER, status: 'open' }, select: { id: true, purchaseId: true } });
    const existing = await open();
    if (existing?.purchaseId) return { checkout_url: null, purchase_id: existing.purchaseId, status: 'in_review' };

    let created: { reviewId: string; purchaseId: string };
    try {
      created = await adminDb.$transaction(async (tx) => {
        const purchase = await tx.purchase.create({
          data: { tenantId: ctx.workspaceId, packId: pack.id, amountCents: pack.price_cents, currency: pack.currency, credits, status: 'in_review' },
          select: { id: true },
        });
        const review = await tx.fraudReview.create({
          data: { tenantId: ctx.workspaceId, trigger: FIRST_PURCHASE_REVIEW_TRIGGER, status: 'open', purchaseId: purchase.id, amountCents: pack.price_cents, currency: pack.currency },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            tenantId: ctx.workspaceId,
            actorUserId: ctx.userId,
            action: 'purchase.review_requested',
            targetType: 'purchase',
            targetId: purchase.id,
            ip: ctx.ip ?? null,
            metaJson: { pack_id: pack.id, amount_cents: pack.price_cents, currency: pack.currency, credits, review_id: review.id } as Prisma.InputJsonValue,
          },
        });
        return { reviewId: review.id, purchaseId: purchase.id };
      });
    } catch (error) {
      // Lost the race to a concurrent request: theirs is the open review.
      if (!isUniqueViolation(error)) throw error;
      const winner = await open();
      if (!winner?.purchaseId) throw error;
      return { checkout_url: null, purchase_id: winner.purchaseId, status: 'in_review' };
    }

    void this.alerts.send({
      kind: 'purchase_review_requested',
      severity: 'warning',
      title: 'A first purchase is waiting for review',
      fields: { workspace_id: ctx.workspaceId, purchase_id: created.purchaseId, review_id: created.reviewId, pack_id: pack.id, amount_cents: pack.price_cents, currency: pack.currency },
    });
    this.log.warn(`purchase ${created.purchaseId} (${pack.price_cents} ${pack.currency}, first for ${ctx.workspaceId}) is waiting for review ${created.reviewId}`);
    return { checkout_url: null, purchase_id: created.purchaseId, status: 'in_review' };
  }

  /**
   * POST /wallet/portal-session. The customer id is read from *this* workspace's row and
   * nowhere else — the request carries no customer id, so there is nothing to spoof. A
   * workspace that has never paid has no Stripe customer and is told so.
   */
  async createPortalSession(ctx: WorkspaceContext, returnPath?: string): Promise<{ url: string }> {
    const tenant = await withWorkspace(ctx, (db) => db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { stripeCustomerId: true } }));
    if (!tenant.stripeCustomerId) throw new AppError('NO_PAYMENT_METHOD', 'Buy a pack first — your billing account is created with the first purchase.');
    const returnUrl = `${this.stripe.config.portalUrl}${returnPath ?? '/app/wallet'}`;
    const url = await this.stripe.createPortalSession(tenant.stripeCustomerId, returnUrl);
    await withWorkspace(ctx, (db) =>
      db.auditLog.create({ data: { tenantId: ctx.workspaceId, actorUserId: ctx.userId, action: 'billing.portal_session', targetType: 'workspace', targetId: ctx.workspaceId, ip: ctx.ip ?? null } }),
    ).catch(() => undefined);
    return { url };
  }

  /**
   * POST /wallet/checkout/confirm. Stripe sends the customer back with `session_id` before
   * — or instead of — delivering `checkout.session.completed`: a dev box without
   * `stripe listen`, an endpoint registered for another environment, a delivery Stripe is
   * still retrying. The URL proves nothing, so the session is retrieved from Stripe and
   * handed to the same `fulfil()` the webhook uses — same amount check, same wallet lock,
   * same idempotency, and the same `onPurchaseCredited` announcement that starts W7's
   * activation. Only a purchase of *this* workspace is looked up, so a foreign or unknown
   * id is a 404 and never a Stripe call.
   */
  async confirmCheckout(ctx: WorkspaceContext, sessionId: string): Promise<CheckoutConfirmResponse> {
    const purchase = await withWorkspace(ctx, (db) =>
      db.purchase.findFirst({ where: { tenantId: ctx.workspaceId, stripeSessionId: sessionId, isAutoTopup: false }, select: { id: true, status: true, createdAt: true } }),
    );
    if (!purchase) throw AppError.notFound('Checkout');
    const purchaseCreatedAt = purchase.createdAt.toISOString();
    if (purchase.status !== 'pending') return { purchase_id: purchase.id, status: purchase.status, credited: false, purchase_created_at: purchaseCreatedAt };

    const outcome = await this.settleFromStripe(purchase.id, sessionId);
    const after = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id }, select: { status: true } });
    return { purchase_id: purchase.id, status: after.status, credited: outcome.outcome === 'credited', purchase_created_at: purchaseCreatedAt };
  }

  /**
   * The lost-webhook sweep for Checkout, run by the §13.11 `auto-topup` tick beside the
   * top-up one: a purchase still `pending` five minutes after its session was created is
   * asked about — paid → credited, expired → abandoned, still open → left alone. Nothing
   * older than two days is retrieved for ever; SA9 lists it.
   */
  async reconcilePendingCheckouts(now = new Date()): Promise<{ checked: number; credited: number }> {
    const stale = await adminDb.purchase.findMany({
      where: {
        isAutoTopup: false,
        status: 'pending',
        stripeSessionId: { not: null },
        createdAt: { lt: new Date(now.getTime() - CHECKOUT_RECONCILE_AFTER_MS), gt: new Date(now.getTime() - CHECKOUT_RECONCILE_WINDOW_MS) },
      },
      select: { id: true, stripeSessionId: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const result = { checked: 0, credited: 0 };
    for (const purchase of stale) {
      try {
        const outcome = await this.settleFromStripe(purchase.id, purchase.stripeSessionId!);
        result.checked += 1;
        if (outcome.outcome === 'credited') result.credited += 1;
      } catch (error) {
        this.log.error(`checkout reconcile for purchase ${purchase.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  /**
   * Asks Stripe about one pending purchase's session and settles it through the webhook
   * handlers: paid → `fulfil`, expired → `abandon`, still open → nothing. Throws
   * `UPSTREAM_UNAVAILABLE` when Stripe cannot be reached, and refuses a session whose
   * metadata names another purchase or workspace.
   */
  private async settleFromStripe(purchaseId: string, sessionId: string): Promise<FulfilmentOutcome> {
    let session: CheckoutSessionFacts;
    try {
      session = await this.stripe.retrieveCheckoutSession(sessionId);
    } catch (error) {
      // Stripe answered, and the session does not exist under this key: it can never be
      // paid here, so asking again every tick for two days would only fill the logs. Close
      // it like an expired session. Only an outage (no answer, 5xx, 429) is retried.
      if (isStripeNotFound(error)) {
        const updated = await adminDb.purchase.updateMany({ where: { id: purchaseId, status: 'pending' }, data: { status: 'abandoned', failureReason: 'session_not_found' } });
        this.log.warn(`checkout ${sessionId}: Stripe has no such session; purchase ${purchaseId} ${updated.count ? 'abandoned' : 'was no longer pending'}`);
        return updated.count ? { outcome: 'unpaid', purchaseId } : { outcome: 'ignored', reason: 'purchase not pending' };
      }
      this.log.warn(`checkout ${sessionId}: retrieve failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not reach the payment provider. Please try again in a moment.');
    }
    const ids = this.identify(session);
    if ('reason' in ids || ids.purchaseId !== purchaseId) {
      this.log.error(`checkout ${sessionId}: not purchase ${purchaseId}'s session (${'reason' in ids ? ids.reason : `names ${ids.purchaseId}`})`);
      return { outcome: 'ignored', reason: 'session/purchase mismatch' };
    }
    if (session.status === 'expired') return this.abandon(session);
    return this.fulfil(session);
  }

  // ------------------------------------------------------------------ fulfilment (webhook)

  /**
   * §13.7 step 2, idempotent. `checkout.session.completed` with `payment_status=paid`, or
   * `async_payment_succeeded` later, credits the wallet exactly once per purchase: the
   * status flip and the grant share one locked transaction, so a replay finds `paid` and
   * stops, and a crash between the two cannot happen.
   */
  async fulfil(session: CheckoutSessionFacts): Promise<FulfilmentOutcome> {
    const ids = this.identify(session);
    if ('reason' in ids) return { outcome: 'ignored', reason: ids.reason };
    const { purchaseId, workspaceId } = ids;

    if (session.payment_status !== 'paid') {
      // Delayed methods (bank debits) complete the session before the money arrives;
      // async_payment_succeeded follows and lands here again with `paid`.
      await adminDb.purchase.updateMany({ where: { id: purchaseId, stripeSessionId: null }, data: { stripeSessionId: session.id } });
      return { outcome: 'unpaid', purchaseId };
    }

    const [{ policy, configVersion }, pricing] = await Promise.all([this.config.walletPolicy(), this.config.currentPricing()]);

    const result = await this.wallet.withWallet(workspaceId, async (tx, wallet) => {
      const purchase = await tx.purchase.findUnique({ where: { id: purchaseId } });
      if (!purchase) return { outcome: 'ignored' as const, reason: `purchase ${purchaseId} does not exist` };
      if (purchase.tenantId !== workspaceId) {
        // Metadata and the purchase disagree: refuse rather than credit the wrong wallet.
        this.log.error(`session ${session.id}: purchase ${purchaseId} belongs to ${purchase.tenantId}, metadata says ${workspaceId}`);
        return { outcome: 'ignored' as const, reason: 'workspace mismatch' };
      }
      if (purchase.status === 'paid' || purchase.status === 'refunded') return { outcome: 'already_paid' as const, purchaseId };
      if (purchase.status === 'in_review' || purchase.status === 'approved' || purchase.status === 'rejected') {
        // No session is ever made for these (ADR 0036 §3); a paid one here is not ours to credit.
        this.log.error(`session ${session.id}: purchase ${purchaseId} is ${purchase.status}; refusing to credit`);
        return { outcome: 'ignored' as const, reason: `purchase is ${purchase.status}` };
      }
      // §17 backstop: a first purchase over the limit is credited only with an approved
      // review, however its session came to exist (an older build, a hand-made session).
      // Stripe has the money, so the row stays `pending` for SA9 like an amount mismatch.
      const unreviewed = await this.unreviewedFirstPurchase(tx, purchase, policy.max_first_purchase_cents_without_review);
      if (unreviewed) {
        this.log.error(`session ${session.id}: purchase ${purchaseId} is a first purchase over the review limit with no approval; refusing to credit`);
        await tx.purchase.update({ where: { id: purchaseId }, data: { stripeSessionId: purchase.stripeSessionId ?? session.id, stripePaymentIntent: session.payment_intent, failureReason: 'review_required' } });
        return { outcome: 'review_required' as const, purchaseId };
      }

      const mismatch = amountMismatch(session, purchase);
      if (mismatch) {
        // Stripe charged something other than what this purchase is for, so the credits
        // are not ours to grant. Keep the trail on the row and leave it pending for SA9.
        this.log.error(`session ${session.id}: ${mismatch}; refusing to credit purchase ${purchaseId}`);
        await tx.purchase.update({
          where: { id: purchaseId },
          data: { stripeSessionId: purchase.stripeSessionId ?? session.id, stripePaymentIntent: session.payment_intent },
        });
        return { outcome: 'ignored' as const, reason: mismatch };
      }

      await tx.purchase.update({
        where: { id: purchaseId },
        data: {
          status: 'paid',
          stripeSessionId: purchase.stripeSessionId ?? session.id,
          stripePaymentIntent: session.payment_intent,
          isAutoTopup: false,
        },
      });

      const write = await wallet.grant({
        credits: purchase.credits,
        reason: 'purchase',
        expiresAt: addMonths(new Date(), policy.credit_expiry_months),
        purchaseId,
        refType: 'purchase',
        refId: purchaseId,
        policyVersion: configVersion,
      });

      await this.applyPlanTier(tx, workspaceId, pricing.config, session.customer);
      // §6.2 purchase audit (ADR 0036 §9). Inside the crediting transaction: a replay
      // stops at `already_paid` above, so a purchase completes once in the log too.
      await tx.auditLog.create({
        data: {
          tenantId: workspaceId,
          actorUserId: null,
          action: 'purchase.completed',
          targetType: 'purchase',
          targetId: purchaseId,
          metaJson: { via: 'checkout', pack_id: purchase.packId, amount_cents: purchase.amountCents, currency: purchase.currency, credits: purchase.credits } as Prisma.InputJsonValue,
        },
      });
      return { outcome: 'credited' as const, purchaseId, credits: purchase.credits, balance: write.balance_after };
    });

    if (result.outcome === 'review_required') {
      void this.alerts.send({
        kind: 'purchase_review_bypassed',
        severity: 'critical',
        title: 'A paid first purchase over the review limit was not credited',
        fields: { workspace_id: workspaceId, purchase_id: purchaseId, session_id: session.id },
      });
      return { outcome: 'ignored', reason: 'first purchase needs review' };
    }
    if (result.outcome !== 'credited') return result;

    // Post-commit, best effort, network allowed: caps cache, saved card, invoice link.
    await this.config.refreshCaps(workspaceId).catch((e) => this.log.warn(`refreshCaps failed: ${String(e)}`));
    await this.recordAutoTopup(workspaceId, session, pricing.config).catch((e) => this.log.warn(`auto top-up card not saved: ${String(e)}`));
    await this.recordInvoice(purchaseId, session).catch((e) => this.log.warn(`invoice url not saved: ${String(e)}`));
    this.log.log(`purchase ${purchaseId} credited ${result.credits} to ${workspaceId} (balance ${result.balance})`);
    // §13.8: after the commit, never inside it. The activation module listens and starts
    // the go-live job when the session named an agent. The purchase is credited either way.
    await this.announceCredited({ workspaceId, purchaseId, agentId: UUID_RE.test(session.metadata.agent_id ?? '') ? session.metadata.agent_id! : null, isAutoTopup: false });
    return result;
  }

  /**
   * `checkout.session.expired` (and a failed delayed payment): a pending purchase is
   * abandoned. One that staff approved (ADR 0036 §3) goes back to `approved` instead, so
   * a customer who closed the Stripe tab can pay later without a second review.
   */
  async abandon(session: CheckoutSessionFacts): Promise<FulfilmentOutcome> {
    const ids = this.identify(session);
    if ('reason' in ids) return { outcome: 'ignored', reason: ids.reason };
    const review = await adminDb.fraudReview.findUnique({ where: { purchaseId: ids.purchaseId }, select: { status: true } });
    const approved = review?.status === 'approved';
    const updated = await adminDb.purchase.updateMany({
      where: { id: ids.purchaseId, tenantId: ids.workspaceId, status: 'pending' },
      data: approved ? { status: 'approved', stripeSessionId: null } : { status: 'abandoned', stripeSessionId: session.id },
    });
    if (updated.count && !approved) {
      await adminDb.auditLog
        .create({ data: { tenantId: ids.workspaceId, actorUserId: null, action: 'purchase.abandoned', targetType: 'purchase', targetId: ids.purchaseId, metaJson: { session_status: session.status } as Prisma.InputJsonValue } })
        .catch((e) => this.log.warn(`purchase ${ids.purchaseId}: abandon not audited: ${String(e)}`));
    }
    return updated.count ? { outcome: 'unpaid', purchaseId: ids.purchaseId } : { outcome: 'ignored', reason: 'purchase not pending' };
  }

  /**
   * True when crediting this purchase would skip the §17 review: it is the workspace's
   * first paid purchase, over the limit, and no approved review names it.
   */
  private async unreviewedFirstPurchase(
    tx: Prisma.TransactionClient,
    purchase: { id: string; tenantId: string; amountCents: number; isAutoTopup: boolean },
    limitCents: number,
  ): Promise<boolean> {
    if (purchase.isAutoTopup) return false;
    const hasPaidBefore = (await tx.purchase.count({ where: { tenantId: purchase.tenantId, id: { not: purchase.id }, status: { in: ['paid', 'refunded'] } } })) > 0;
    if (!purchaseNeedsReview({ hasPaidBefore, amountCents: purchase.amountCents, limitCents })) return false;
    const review = await tx.fraudReview.findUnique({ where: { purchaseId: purchase.id }, select: { status: true } });
    return review?.status !== 'approved';
  }

  // ------------------------------------------------------------------ helpers

  private identify(session: CheckoutSessionFacts): { purchaseId: string; workspaceId: string } | { reason: string } {
    const purchaseId = session.client_reference_id ?? session.metadata.purchase_id;
    const workspaceId = session.metadata.workspace_id;
    if (!purchaseId || !workspaceId) return { reason: `session ${session.id} carries no purchase/workspace ids (not ours?)` };
    // Anyone with the test key can create a session with any client_reference_id; a value
    // that is not one of our uuids must be ignored, not turned into a Prisma error that
    // makes Stripe retry it for three days.
    if (!UUID_RE.test(purchaseId) || !UUID_RE.test(workspaceId)) {
      return { reason: `session ${session.id} carries malformed ids (purchase "${purchaseId.slice(0, 40)}")` };
    }
    if (session.metadata.env && session.metadata.env !== this.stripe.config.env) {
      return { reason: `session ${session.id} was created in env ${session.metadata.env}` };
    }
    return { purchaseId, workspaceId };
  }

  /**
   * §5.2: plan tier = the largest pack bought in the last 12 months, and the tenant row
   * copies that pack's caps (that copy is what grandfathers an existing customer through
   * a later pricing change, admin §5.2 step 6).
   *
   * "Largest" is the pack's tier on the §5.2 ladder, not `purchases.credits`: that column
   * includes promotional bonus credits, so a Growth pack sold with a bonus could otherwise
   * outrank a Scale pack. Ties on tier go to the more credits.
   */
  private async applyPlanTier(tx: Prisma.TransactionClient, workspaceId: string, config: PricingConfig, stripeCustomerId: string | null): Promise<void> {
    const since = addMonths(new Date(), -12);
    const paid = await tx.purchase.findMany({
      where: { tenantId: workspaceId, status: 'paid', createdAt: { gte: since }, packId: { not: null } },
      select: { packId: true, credits: true },
    });

    // Resolve each purchase's pack from the current config, else the catalogue row the
    // pack left behind when a later version retired it.
    type Caps = { planTier: PlanTier; concurrencyCap: number; kbAllowance: number };
    const ranked: Array<{ caps: Caps; credits: number }> = [];
    for (const purchase of paid) {
      const fromConfig: PricingPack | undefined = config.packs.find((p) => p.id === purchase.packId);
      const caps: Caps | undefined = fromConfig
        ? { planTier: fromConfig.plan_tier as PlanTier, concurrencyCap: fromConfig.concurrency_cap, kbAllowance: fromConfig.kb_allowance }
        : ((await tx.pack.findUnique({ where: { id: purchase.packId! }, select: { planTier: true, concurrencyCap: true, kbAllowance: true } })) ?? undefined);
      if (caps) ranked.push({ caps, credits: purchase.credits });
    }
    const ladder = planTierEnum.options as readonly string[];
    const largest = ranked.sort(
      (a, b) => ladder.indexOf(b.caps.planTier) - ladder.indexOf(a.caps.planTier) || b.credits - a.credits,
    )[0];

    const data: Prisma.TenantUpdateInput = {};
    if (largest) {
      data.planTier = largest.caps.planTier;
      data.concurrencyCap = largest.caps.concurrencyCap;
      data.kbAllowance = largest.caps.kbAllowance;
    }
    if (stripeCustomerId) {
      const current = await tx.tenant.findUnique({ where: { id: workspaceId }, select: { stripeCustomerId: true } });
      if (!current?.stripeCustomerId) data.stripeCustomerId = stripeCustomerId;
    }
    if (Object.keys(data).length) await tx.tenant.update({ where: { id: workspaceId }, data });
  }

  /** Saves the card Stripe kept for off-session use, when the customer opted in (§5.4). */
  private async recordAutoTopup(workspaceId: string, session: CheckoutSessionFacts, config: PricingConfig): Promise<void> {
    if (session.metadata.auto_topup !== 'true' || !session.payment_intent) return;
    const saved = await this.stripe.savedPaymentMethod(session.payment_intent);
    if (!saved) return;
    const pack = config.packs.find((p) => p.id === session.metadata.pack_id);
    const threshold = Number(session.metadata.auto_topup_threshold);
    const value: AutoTopup = {
      enabled: true,
      pack_id: pack?.id ?? null,
      threshold: Number.isFinite(threshold) && threshold > 0
        ? threshold
        : pack
          ? Math.round((pack.credits * config.wallet_policy.auto_topup_threshold_pct) / 100)
          : null,
      payment_method_id: saved.payment_method_id,
      card_last4: saved.card_last4,
    };
    await adminDb.tenant.update({ where: { id: workspaceId }, data: { autoTopupJson: value } });
  }

  private async recordInvoice(purchaseId: string, session: CheckoutSessionFacts): Promise<void> {
    if (!session.invoice) return;
    const url = await this.stripe.invoiceUrl(session.invoice);
    if (url) await adminDb.purchase.update({ where: { id: purchaseId }, data: { invoiceUrl: url } });
  }
}

/**
 * What Stripe actually took has to be what the purchase says it is before we grant its
 * credits. The two can drift without anyone editing this code: a `stripe_price_map` row
 * left behind by an older config version, or a Price edited in the Stripe dashboard,
 * charges one amount while the pending purchase still promises the pack's credits. The
 * session is the record of the money; the purchase is the record of the goods.
 *
 * Returns the reason they disagree, or null when they match.
 */
export function amountMismatch(session: CheckoutSessionFacts, purchase: { amountCents: number; currency: string }): string | null {
  const currency = purchase.currency.trim().toUpperCase();
  if (session.amount_total === null) {
    // Only a zero-amount session omits it, and we never create one. Nothing to compare.
    return null;
  }
  if (session.amount_total !== purchase.amountCents) {
    return `Stripe collected ${session.amount_total} but purchase ${purchase.amountCents} was expected`;
  }
  if (session.currency && session.currency.toUpperCase() !== currency) {
    return `Stripe collected ${session.currency.toUpperCase()} but purchase is in ${currency}`;
  }
  return null;
}

/** Stripe's own "this object does not exist" (404 `resource_missing`), as opposed to not reaching Stripe at all. */
export function isStripeNotFound(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string; raw?: { code?: string } } | null;
  return Boolean(e) && (e!.code === 'resource_missing' || e!.raw?.code === 'resource_missing' || e!.statusCode === 404);
}
