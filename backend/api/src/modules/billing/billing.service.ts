import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Prisma, adminDb, withWorkspace, type PlanTier } from '@portal/db';
import { type AutoTopup, type CheckoutRequest, type CheckoutResponse, type PricingConfig, type PricingPack, planTier as planTierEnum } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { WalletService, addMonths } from '../wallet/wallet.service';
import { type CheckoutSessionFacts, StripeGateway } from './stripe.gateway';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const buyer = await adminDb.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });

    // 1. The pending purchase is the durable record; its id is the Stripe client_reference_id.
    const purchase = await withWorkspace(ctx, (db) =>
      db.purchase.create({
        data: {
          tenantId: ctx.workspaceId,
          packId: pack.id,
          amountCents: pack.price_cents,
          currency: pack.currency,
          credits: pack.credits + pack.bonus_credits,
          status: 'pending',
          promoCode: body.promo_code,
        },
        select: { id: true },
      }),
    );

    // 2. The Stripe Price from the SA5 sync when it exists; inline price data until then.
    const priceMap = await adminDb.stripePriceMap.findFirst({
      where: { packId: pack.id, currency: pack.currency, configVersion, active: true },
      select: { stripePriceId: true },
    });
    if (!priceMap) this.log.warn(`no stripe_price_map row for ${pack.id}/${pack.currency}/v${configVersion}; using inline price_data`);

    // 3. Stripe, with no transaction open. If Stripe refuses, the purchase must not stay
    //    `pending`: with no session there will never be a `checkout.session.expired` to
    //    abandon it, and SA9 would list a ghost forever.
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
      await withWorkspace(ctx, (db) => db.purchase.update({ where: { id: purchase.id }, data: { status: 'abandoned' } })).catch((e) =>
        this.log.error(`purchase ${purchase.id}: Stripe failed and the row could not be abandoned: ${String(e)}`),
      );
      throw error;
    }

    // 4. Remember the session so expiry and support can find the purchase from Stripe's side.
    await withWorkspace(ctx, (db) => db.purchase.update({ where: { id: purchase.id }, data: { stripeSessionId: session.id } }));

    return { checkout_url: session.url, purchase_id: purchase.id };
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
      db.auditLog.create({ data: { tenantId: ctx.workspaceId, actorUserId: ctx.userId, action: 'billing.portal_session', targetType: 'workspace', targetId: ctx.workspaceId } }),
    ).catch(() => undefined);
    return { url };
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
      return { outcome: 'credited' as const, purchaseId, credits: purchase.credits, balance: write.balance_after };
    });

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

  /** `checkout.session.expired` (and a failed delayed payment): a pending purchase is abandoned. */
  async abandon(session: CheckoutSessionFacts): Promise<FulfilmentOutcome> {
    const ids = this.identify(session);
    if ('reason' in ids) return { outcome: 'ignored', reason: ids.reason };
    const updated = await adminDb.purchase.updateMany({
      where: { id: ids.purchaseId, tenantId: ids.workspaceId, status: 'pending' },
      data: { status: 'abandoned', stripeSessionId: session.id },
    });
    return updated.count ? { outcome: 'unpaid', purchaseId: ids.purchaseId } : { outcome: 'ignored', reason: 'purchase not pending' };
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
function amountMismatch(session: CheckoutSessionFacts, purchase: { amountCents: number; currency: string }): string | null {
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
