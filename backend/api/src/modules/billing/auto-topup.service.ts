import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Prisma, adminDb, withWorkspace } from '@portal/db';
import { type AutoTopup, type AutoTopupRequest, type PricingConfig, autoTopup as autoTopupSchema } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { OpsAlertService } from '../alerts';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { WalletService, addMonths } from '../wallet/wallet.service';
import { BillingService } from './billing.service';
import { type PaymentIntentFacts, StripeGateway } from './stripe.gateway';

/** A pending auto top-up younger than this is "in flight": no second charge for the same threshold. */
export const TOPUP_IN_FLIGHT_MS = 30 * 60_000;
/** After a declined or authentication-required attempt, wait this long before trying again. */
export const TOPUP_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000;
/** A pending top-up with a PaymentIntent older than this is asked about directly (webhook lost). */
export const TOPUP_RECONCILE_AFTER_MS = 5 * 60_000;

export type TopupSkipReason = 'disabled' | 'no_card' | 'no_pack' | 'above_threshold' | 'in_flight' | 'cooldown' | 'paused';

export type TopupDecision =
  | { action: 'charge'; reason: 'below_threshold' }
  | { action: 'skip'; reason: TopupSkipReason };

/** Announced when a pending top-up is given up on; the notifications module opens the customer's `auto_topup_failed` alert from it. */
export type TopupAbandonedListener = (event: { workspaceId: string; purchaseId: string; reason: string }) => Promise<void> | void;
/** Announced when Stripe's confirmation credited a top-up; the same module resolves that alert from it. */
export type TopupCreditedListener = (event: { workspaceId: string; purchaseId: string; credits: number }) => Promise<void> | void;

export type TopupAttemptOutcome =
  | { outcome: 'charged'; purchaseId: string; paymentIntentId: string; status: string }
  | { outcome: 'declined'; purchaseId: string; paymentIntentId: string | null; reason: string }
  | { outcome: 'skipped'; reason: TopupSkipReason };

/**
 * The pure decision: charge or not, and why. `now` is a parameter so the cooldown and
 * in-flight windows can be tested without a clock.
 */
export function decideTopup(input: {
  settings: AutoTopup | null;
  balance: number;
  pendingSince: Date | null;
  lastFailureAt: Date | null;
  workspacePaused: boolean;
  now?: Date;
}): TopupDecision {
  const now = input.now ?? new Date();
  const s = input.settings;
  if (!s?.enabled) return { action: 'skip', reason: 'disabled' };
  if (input.workspacePaused) return { action: 'skip', reason: 'paused' };
  if (!s.payment_method_id) return { action: 'skip', reason: 'no_card' };
  if (!s.pack_id || s.threshold === null) return { action: 'skip', reason: 'no_pack' };
  if (input.balance >= s.threshold) return { action: 'skip', reason: 'above_threshold' };
  if (input.pendingSince && now.getTime() - input.pendingSince.getTime() < TOPUP_IN_FLIGHT_MS) return { action: 'skip', reason: 'in_flight' };
  if (input.lastFailureAt && now.getTime() - input.lastFailureAt.getTime() < TOPUP_FAILURE_COOLDOWN_MS) return { action: 'skip', reason: 'cooldown' };
  return { action: 'charge', reason: 'below_threshold' };
}

/**
 * §5.4 auto top-up (D5 "Auto top-up", §13.11 `auto-topup`).
 *
 *     balance drops below threshold ──▶ evaluate() ──▶ pending purchase (under the wallet lock)
 *       ──▶ off-session PaymentIntent (idempotency key = purchase id)
 *       ──▶ payment_intent.succeeded webhook ──▶ fulfilPaymentIntent(): paid + grant (under the lock)
 *
 * Credits are granted in exactly one place, and it is not the create call: a PaymentIntent
 * that *says* `succeeded` in the create response is still credited by the webhook (or by
 * the reconcile sweep retrieving it from Stripe), so there is one path from "Stripe
 * confirmed the money" to the ledger and it is idempotent on the purchase row.
 *
 * Concurrency: two ledger writes in quick succession both fire the listener, and the
 * 15-minute schedule may run at the same time. The pending-purchase check and the
 * pending-purchase insert happen inside `withWallet()` — the per-workspace advisory lock
 * — so only one of them can create the purchase; the others see it and skip. The Stripe
 * idempotency key guards the one remaining gap (the process dies after the insert and
 * before the create returns): the reconcile sweep retries the create with the same key
 * and gets the same intent back.
 *
 * This service writes no `alerts` row. A declined or given-up top-up is *announced*
 * (`onAbandoned`, the same shape as `BillingService.onPurchaseCredited`) and the
 * notifications module — the only writer of `alerts` — opens the keyed customer alert and
 * resolves it on `onCredited`. Billing therefore does not import notifications, and the
 * arrows stay one-way.
 */
@Injectable()
export class AutoTopupService {
  private readonly log = new Logger(AutoTopupService.name);
  private readonly abandonedListeners: TopupAbandonedListener[] = [];
  private readonly creditedListeners: TopupCreditedListener[] = [];

  constructor(
    private readonly stripe: StripeGateway,
    private readonly config: PlatformConfigService,
    @Inject(forwardRef(() => WalletService)) private readonly wallet: WalletService,
    @Inject(forwardRef(() => BillingService)) private readonly billing: BillingService,
    private readonly alerts: OpsAlertService,
  ) {}

  onAbandoned(listener: TopupAbandonedListener): void {
    this.abandonedListeners.push(listener);
  }

  onCredited(listener: TopupCreditedListener): void {
    this.creditedListeners.push(listener);
  }

  private async announce<E>(listeners: Array<(event: E) => Promise<void> | void>, what: string, event: E): Promise<void> {
    for (const listener of listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.log.error(`${what} listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ------------------------------------------------------------------ settings (PUT /wallet/auto-topup)

  async update(ctx: WorkspaceContext, input: AutoTopupRequest): Promise<AutoTopup> {
    const tenant = await withWorkspace(ctx, (db) => db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { autoTopupJson: true, stripeCustomerId: true } }));
    const current = parseSettings(tenant.autoTopupJson);
    const { config } = await this.config.currentPricing();

    if (input.enabled) {
      const flags = await this.config.flagsFor(ctx.workspaceId);
      if (!flags.gates.auto_topup) throw new AppError('PLAN_LIMIT', 'Auto top-up is available once you have bought a pack.');
      if (!current?.payment_method_id || !tenant.stripeCustomerId) {
        throw new AppError('NO_PAYMENT_METHOD', 'Save a card first: buy a pack with "keep my card for auto top-up" ticked.');
      }
      const packId = input.pack_id ?? current.pack_id;
      const pack = packId ? config.packs.find((p) => p.id === packId && p.active) : undefined;
      if (!pack) throw new AppError('PACK_UNAVAILABLE', 'Pick a pack to top up with.', [{ field: 'pack_id', message: 'Unknown or inactive pack' }]);
      const threshold = input.threshold ?? current.threshold ?? Math.round((pack.credits * config.wallet_policy.auto_topup_threshold_pct) / 100);
      const next: AutoTopup = { ...current, enabled: true, pack_id: pack.id, threshold };
      await this.saveSettings(ctx, next, 'enabled');
      return next;
    }
    const next: AutoTopup = { ...(current ?? { payment_method_id: null, card_last4: null, pack_id: null, threshold: null }), enabled: false };
    await this.saveSettings(ctx, next, 'disabled');
    return next;
  }

  private async saveSettings(ctx: WorkspaceContext, value: AutoTopup, action: string): Promise<void> {
    await withWorkspace(ctx, async (db) => {
      await db.tenant.update({ where: { id: ctx.workspaceId }, data: { autoTopupJson: value as unknown as Prisma.InputJsonValue } });
      await db.auditLog.create({
        data: { tenantId: ctx.workspaceId, actorUserId: ctx.userId, action: `auto_topup.${action}`, targetType: 'workspace', targetId: ctx.workspaceId, metaJson: { pack_id: value.pack_id, threshold: value.threshold, card_last4: value.card_last4 } as Prisma.InputJsonValue },
      });
    });
  }

  // ------------------------------------------------------------------ trigger

  /**
   * Called from the ledger listener on every debit and from the 15-minute sweep. Cheap
   * when nothing is due: one tenant read and one balance read before any lock is taken.
   */
  async evaluate(workspaceId: string, trigger: 'ledger' | 'schedule'): Promise<TopupAttemptOutcome> {
    const tenant = await adminDb.tenant.findUnique({ where: { id: workspaceId }, select: { autoTopupJson: true, stripeCustomerId: true, pausedAt: true, name: true } });
    const settings = parseSettings(tenant?.autoTopupJson);
    if (!tenant || !settings?.enabled) return { outcome: 'skipped', reason: 'disabled' };
    if (!tenant.stripeCustomerId) return { outcome: 'skipped', reason: 'no_card' };

    const [{ config }, balance] = await Promise.all([this.config.currentPricing(), this.wallet.balance(workspaceId)]);
    const pack = settings.pack_id ? config.packs.find((p) => p.id === settings.pack_id) : undefined;
    if (!pack) return { outcome: 'skipped', reason: 'no_pack' };

    const quick = decideTopup({ settings, balance, pendingSince: null, lastFailureAt: null, workspacePaused: tenant.pausedAt !== null });
    if (quick.action === 'skip') return { outcome: 'skipped', reason: quick.reason };

    // Under the wallet lock: the balance is re-read, the in-flight and cooldown checks
    // happen, and the pending purchase is created — all before any other writer can move.
    const created = await this.wallet.withWallet(workspaceId, async (tx) => {
      const [sum, pending, lastFailed] = await Promise.all([
        tx.creditLedger.aggregate({ where: { tenantId: workspaceId }, _sum: { delta: true } }),
        tx.purchase.findFirst({ where: { tenantId: workspaceId, isAutoTopup: true, status: 'pending' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
        tx.purchase.findFirst({ where: { tenantId: workspaceId, isAutoTopup: true, status: 'abandoned', failureReason: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      ]);
      const decision = decideTopup({
        settings,
        balance: sum._sum.delta?.toNumber() ?? 0,
        pendingSince: pending?.createdAt ?? null,
        lastFailureAt: lastFailed?.updatedAt ?? null,
        workspacePaused: tenant.pausedAt !== null,
      });
      if (decision.action === 'skip') return { skipped: decision.reason as TopupSkipReason };
      const purchase = await tx.purchase.create({
        data: {
          tenantId: workspaceId,
          packId: pack.id,
          amountCents: pack.price_cents,
          currency: pack.currency,
          credits: pack.credits + pack.bonus_credits,
          status: 'pending',
          isAutoTopup: true,
        },
        select: { id: true },
      });
      return { purchaseId: purchase.id };
    });
    if ('skipped' in created) return { outcome: 'skipped', reason: created.skipped! };

    this.log.log(`auto top-up for ${workspaceId} (${trigger}): balance ${balance} < ${settings.threshold}, charging ${pack.id} as purchase ${created.purchaseId}`);
    return this.charge(workspaceId, created.purchaseId, { settings, pack, customerId: tenant.stripeCustomerId });
  }

  /** The Stripe half, outside every transaction. Reused by the reconcile sweep for a purchase that never got its intent. */
  private async charge(
    workspaceId: string,
    purchaseId: string,
    input: { settings: AutoTopup; pack: PricingConfig['packs'][number]; customerId: string },
  ): Promise<TopupAttemptOutcome> {
    let intent: PaymentIntentFacts;
    try {
      intent = await this.stripe.createOffSessionPaymentIntent({
        purchaseId,
        workspaceId,
        packId: input.pack.id,
        customerId: input.customerId,
        paymentMethodId: input.settings.payment_method_id!,
        amountCents: input.pack.price_cents,
        currency: input.pack.currency,
        description: `Auto top-up: ${input.pack.name} pack`,
      });
    } catch (error) {
      // Stripe unreachable: the purchase stays pending and the sweep retries the create
      // with the same idempotency key. Nothing was charged that we do not know about.
      this.log.error(`auto top-up purchase ${purchaseId}: Stripe call failed (${error instanceof Error ? error.message : String(error)}); the sweep will retry`);
      throw error;
    }

    await adminDb.purchase.updateMany({ where: { id: purchaseId, stripePaymentIntent: null }, data: { stripePaymentIntent: intent.id } });

    if (intent.status === 'succeeded' || intent.status === 'processing') {
      // Credited by `payment_intent.succeeded`, never here (see the class comment).
      this.log.log(`auto top-up purchase ${purchaseId}: intent ${intent.id} is ${intent.status}; credits follow the webhook`);
      return { outcome: 'charged', purchaseId, paymentIntentId: intent.id, status: intent.status };
    }
    const reason = intent.status === 'requires_action' ? 'requires_action' : (intent.failure_code ?? intent.status);
    await this.abandon(purchaseId, workspaceId, reason, intent.failure_message);
    return { outcome: 'declined', purchaseId, paymentIntentId: intent.id, reason };
  }

  // ------------------------------------------------------------------ webhooks

  /**
   * `payment_intent.succeeded` for an auto top-up. Idempotent on the purchase row: a
   * replay finds `paid` and stops; a Checkout PaymentIntent (no `kind`) is ignored here
   * because `checkout.session.completed` owns it.
   */
  async fulfilPaymentIntent(intent: PaymentIntentFacts): Promise<{ outcome: string; purchaseId?: string; reason?: string }> {
    if (intent.metadata.kind !== 'auto_topup') return { outcome: 'ignored', reason: 'not an auto top-up intent' };
    if (intent.metadata.env && intent.metadata.env !== this.stripe.config.env) return { outcome: 'ignored', reason: `intent from env ${intent.metadata.env}` };
    const purchase = await this.findPurchase(intent);
    if (!purchase) return { outcome: 'ignored', reason: `no purchase for intent ${intent.id}` };
    if (intent.status !== 'succeeded') return { outcome: 'ignored', reason: `intent is ${intent.status}` };

    const [{ policy, configVersion }] = await Promise.all([this.config.walletPolicy()]);
    const result = await this.wallet.withWallet(purchase.tenantId, async (tx, wallet) => {
      const fresh = await tx.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
      if (fresh.status === 'paid' || fresh.status === 'refunded') return { outcome: 'already_paid' as const };
      // `abandoned` is accepted too (D7 webhook-ordering review): Stripe may deliver a
      // `payment_failed` for an earlier attempt after the `succeeded` for a later one, or
      // the reconcile sweep may have given up moments before the webhook arrived. Stripe
      // has the money either way, so the credits follow — the amount check below still
      // holds, and a purchase that is `paid` stays idempotent.
      if (fresh.status !== 'pending' && fresh.status !== 'abandoned') return { outcome: 'ignored' as const, reason: `purchase is ${fresh.status}` };
      if (intent.amount !== fresh.amountCents || intent.currency.toUpperCase() !== fresh.currency.toUpperCase()) {
        this.log.error(`auto top-up purchase ${fresh.id}: Stripe took ${intent.amount} ${intent.currency} but the purchase is ${fresh.amountCents} ${fresh.currency}; refusing to credit`);
        await tx.purchase.update({ where: { id: fresh.id }, data: { stripePaymentIntent: intent.id, failureReason: 'mismatch' } });
        return { outcome: 'ignored' as const, reason: 'amount mismatch' };
      }
      await tx.purchase.update({ where: { id: fresh.id }, data: { status: 'paid', stripePaymentIntent: intent.id, failureReason: null } });
      const write = await wallet.grant({
        credits: fresh.credits,
        reason: 'topup',
        expiresAt: addMonths(new Date(), policy.credit_expiry_months),
        purchaseId: fresh.id,
        refType: 'purchase',
        refId: fresh.id,
        policyVersion: configVersion,
      });
      return { outcome: 'credited' as const, credits: fresh.credits, balance: write.balance_after };
    });

    if (result.outcome === 'credited') {
      this.log.log(`auto top-up purchase ${purchase.id} credited ${result.credits} to ${purchase.tenantId} (balance ${result.balance})`);
      await this.config.refreshCaps(purchase.tenantId).catch(() => undefined);
      await this.announce(this.creditedListeners, 'topup-credited', { workspaceId: purchase.tenantId, purchaseId: purchase.id, credits: result.credits });
    }
    return { ...result, purchaseId: purchase.id };
  }

  /** `payment_intent.payment_failed` / `payment_intent.canceled` for an auto top-up. */
  async failPaymentIntent(intent: PaymentIntentFacts, kind: 'failed' | 'canceled'): Promise<{ outcome: string; purchaseId?: string; reason?: string }> {
    if (intent.metadata.kind !== 'auto_topup') return { outcome: 'ignored', reason: 'not an auto top-up intent' };
    const purchase = await this.findPurchase(intent);
    if (!purchase) return { outcome: 'ignored', reason: `no purchase for intent ${intent.id}` };
    const reason = kind === 'canceled' ? 'canceled' : (intent.failure_code ?? 'payment_failed');
    const changed = await this.abandon(purchase.id, purchase.tenantId, reason, intent.failure_message);
    return { outcome: changed ? 'abandoned' : 'ignored', purchaseId: purchase.id, reason };
  }

  private async findPurchase(intent: PaymentIntentFacts) {
    const byId = intent.metadata.purchase_id && /^[0-9a-f-]{36}$/i.test(intent.metadata.purchase_id)
      ? await adminDb.purchase.findUnique({ where: { id: intent.metadata.purchase_id }, select: { id: true, tenantId: true, isAutoTopup: true } })
      : null;
    const purchase = byId ?? (await adminDb.purchase.findUnique({ where: { stripePaymentIntent: intent.id }, select: { id: true, tenantId: true, isAutoTopup: true } }));
    if (!purchase || !purchase.isAutoTopup) return null;
    if (intent.metadata.workspace_id && intent.metadata.workspace_id !== purchase.tenantId) {
      this.log.error(`intent ${intent.id}: metadata names workspace ${intent.metadata.workspace_id} but purchase ${purchase.id} belongs to ${purchase.tenantId}`);
      return null;
    }
    return purchase;
  }

  /** Marks a pending top-up abandoned with why, announces it (the customer alert is the listener's), and tells ops once. Returns whether the row changed. */
  private async abandon(purchaseId: string, workspaceId: string, reason: string, detail: string | null): Promise<boolean> {
    const { count } = await adminDb.purchase.updateMany({ where: { id: purchaseId, status: 'pending' }, data: { status: 'abandoned', failureReason: reason.slice(0, 80) } });
    if (count === 0) return false;
    await this.announce(this.abandonedListeners, 'topup-abandoned', { workspaceId, purchaseId, reason });
    this.log.warn(`auto top-up purchase ${purchaseId} for ${workspaceId} abandoned: ${reason}${detail ? ` (${detail})` : ''}`);
    await this.alerts.send({
      kind: 'auto_topup_failed',
      severity: 'warning',
      title: reason === 'requires_action' ? 'Auto top-up needs the customer to authenticate' : 'Auto top-up card declined',
      fields: { workspace_id: workspaceId, purchase_id: purchaseId, reason, detail: detail ?? null },
    });
    return true;
  }

  // ------------------------------------------------------------------ schedule

  /**
   * §13.11 `auto-topup`, every 15 minutes. Two sweeps:
   *   1. pending top-ups older than five minutes: ask Stripe what became of the intent
   *      (or create it, if the process died before it existed) — the lost-webhook path;
   *   2. every workspace with auto top-up on: evaluate, for a ledger event the listener
   *      missed (a worker restart between the write and the listener).
   */
  async sweep(now = new Date()): Promise<{ reconciled: number; evaluated: number; charged: number }> {
    let reconciled = 0;
    const stale = await adminDb.purchase.findMany({
      where: { isAutoTopup: true, status: 'pending', createdAt: { lt: new Date(now.getTime() - TOPUP_RECONCILE_AFTER_MS) } },
      select: { id: true, tenantId: true, stripePaymentIntent: true, packId: true },
      take: 100,
    });
    for (const purchase of stale) {
      try {
        if (purchase.stripePaymentIntent) {
          const intent = await this.stripe.retrievePaymentIntent(purchase.stripePaymentIntent);
          if (intent.status === 'succeeded') await this.fulfilPaymentIntent({ ...intent, metadata: { ...intent.metadata, kind: 'auto_topup', purchase_id: purchase.id } });
          else if (intent.status === 'requires_payment_method' || intent.status === 'canceled' || intent.status === 'requires_action') {
            await this.abandon(purchase.id, purchase.tenantId, intent.status === 'requires_action' ? 'requires_action' : (intent.failure_code ?? intent.status), intent.failure_message);
          }
        } else {
          // Row created, intent never made (died before the Stripe call). Same key → same intent.
          const tenant = await adminDb.tenant.findUnique({ where: { id: purchase.tenantId }, select: { autoTopupJson: true, stripeCustomerId: true } });
          const settings = parseSettings(tenant?.autoTopupJson);
          const { config } = await this.config.currentPricing();
          const pack = config.packs.find((p) => p.id === purchase.packId);
          if (!settings?.payment_method_id || !tenant?.stripeCustomerId || !pack) {
            await this.abandon(purchase.id, purchase.tenantId, 'no_card', 'card or pack no longer available');
          } else {
            await this.charge(purchase.tenantId, purchase.id, { settings, pack, customerId: tenant.stripeCustomerId });
          }
        }
        reconciled += 1;
      } catch (error) {
        this.log.error(`auto top-up reconcile for purchase ${purchase.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const enabled = await adminDb.tenant.findMany({
      where: { autoTopupJson: { path: ['enabled'], equals: true }, pausedAt: null },
      select: { id: true },
      take: 500,
    });
    let charged = 0;
    for (const tenant of enabled) {
      try {
        const result = await this.evaluate(tenant.id, 'schedule');
        if (result.outcome === 'charged') charged += 1;
      } catch (error) {
        this.log.error(`auto top-up evaluate for ${tenant.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (stale.length || charged) this.log.log(`auto-topup sweep: ${reconciled}/${stale.length} pending reconciled, ${enabled.length} evaluated, ${charged} charged`);
    return { reconciled, evaluated: enabled.length, charged };
  }
}

function parseSettings(value: unknown): AutoTopup | null {
  if (!value) return null;
  const parsed = autoTopupSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Keeps the type import honest for the listener wiring in the module. */
export type { BillingService };
