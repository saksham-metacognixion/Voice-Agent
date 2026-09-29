import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import type { CurrencyCode, PricingPack } from '@portal/schemas';
import { StripeConfig } from './stripe.config';

/**
 * How long a Checkout Session stays open. Stripe's floor is *exactly* 30 minutes from
 * now and it rejects anything under it, so the extra minute absorbs `Math.floor()`, the
 * round trip and any clock skew between this box and Stripe — a failure that would
 * otherwise be intermittent and never reproduce on a fast run.
 */
const CHECKOUT_TTL_S = 31 * 60;

/** Everything we pin to a session so the webhook can act without a lookup by guesswork. */
export interface CheckoutMetadata extends Record<string, string> {
  workspace_id: string;
  purchase_id: string;
  pack_id: string;
  config_version: string;
  /** 'true' | 'false' — Stripe metadata is strings only. */
  auto_topup: string;
  auto_topup_threshold: string;
  agent_id: string;
  env: string;
}

export interface CreateCheckoutInput {
  purchaseId: string;
  workspaceId: string;
  pack: PricingPack;
  configVersion: number;
  /** The Stripe Price from stripe_price_map when the SA5 sync has run; inline price data otherwise. */
  stripePriceId?: string;
  customerId?: string | null;
  customerEmail?: string;
  autoTopup?: { enabled: boolean; threshold?: number };
  agentId?: string;
}

/** The only fields of a checkout.session the rest of billing reads. */
export interface CheckoutSessionFacts {
  id: string;
  payment_status: string;
  status: string | null;
  client_reference_id: string | null;
  metadata: Partial<CheckoutMetadata>;
  customer: string | null;
  payment_intent: string | null;
  invoice: string | null;
  amount_total: number | null;
  currency: string | null;
}

/** Metadata on an auto top-up PaymentIntent (§5.4). `kind` is what tells it apart from a Checkout PI. */
export interface TopupMetadata extends Record<string, string> {
  kind: 'auto_topup';
  workspace_id: string;
  purchase_id: string;
  pack_id: string;
  env: string;
}

/** The fields of a payment_intent the wallet reads, from a webhook or a retrieve. */
export interface PaymentIntentFacts {
  id: string;
  status: string;
  amount: number;
  currency: string;
  customer: string | null;
  payment_method: string | null;
  metadata: Partial<TopupMetadata> & Record<string, string>;
  /** Stripe's decline / failure code when the last attempt failed. */
  failure_code: string | null;
  failure_message: string | null;
}

/** The fields of an invoice we mirror (D5 "Invoices", SA9). */
export interface InvoiceFacts {
  id: string;
  customer: string | null;
  status: string | null;
  number: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  payment_intent: string | null;
  metadata: Record<string, string>;
  created: number;
  finalized_at: number | null;
  paid_at: number | null;
  voided_at: number | null;
}

/**
 * The only file that imports the Stripe SDK. Owns the Checkout Session shape (§13.7),
 * webhook signature verification over the raw body, and the two reads fulfilment needs.
 */
@Injectable()
export class StripeGateway {
  private readonly log = new Logger(StripeGateway.name);
  private sdk?: Stripe;

  constructor(readonly config: StripeConfig) {}

  get client(): Stripe {
    this.config.assertConfigured();
    return (this.sdk ??= new Stripe(this.config.secretKey, {
      typescript: true,
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: 'voice-agent-portal', version: '0.0.1' },
    }));
  }

  /**
   * §13.7 step 1: one-off payment, `client_reference_id = purchase_id`, our ids in
   * metadata, `setup_future_usage=off_session` only when the customer asked for auto
   * top-up (so we never store a card nobody agreed to reuse), invoice on so D5 has a
   * receipt link. The session expires just past Stripe's 30-minute minimum, so an
   * abandoned tab turns into `checkout.session.expired` quickly.
   */
  async createCheckoutSession(input: CreateCheckoutInput): Promise<{ id: string; url: string }> {
    const autoTopup = input.autoTopup?.enabled === true;
    const metadata: CheckoutMetadata = {
      workspace_id: input.workspaceId,
      purchase_id: input.purchaseId,
      pack_id: input.pack.id,
      config_version: String(input.configVersion),
      auto_topup: autoTopup ? 'true' : 'false',
      auto_topup_threshold: input.autoTopup?.threshold === undefined ? '' : String(input.autoTopup.threshold),
      agent_id: input.agentId ?? '',
      env: this.config.env,
    };
    const totalCredits = input.pack.credits + input.pack.bonus_credits;

    const session = await this.client.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: input.purchaseId,
      metadata,
      line_items: [
        input.stripePriceId
          ? { price: input.stripePriceId, quantity: 1 }
          : {
              quantity: 1,
              price_data: {
                currency: input.pack.currency.toLowerCase(),
                unit_amount: input.pack.price_cents,
                product_data: {
                  name: `${input.pack.name} pack`,
                  description: `${totalCredits.toLocaleString('en-US')} credits · 1 credit = 1 minute of a Standard agent`,
                  metadata: { pack_id: input.pack.id },
                },
              },
            },
      ],
      ...(input.customerId
        ? { customer: input.customerId }
        : { customer_creation: 'always', ...(input.customerEmail ? { customer_email: input.customerEmail } : {}) }),
      payment_intent_data: {
        metadata,
        ...(autoTopup ? { setup_future_usage: 'off_session' } : {}),
      },
      ...(autoTopup ? { saved_payment_method_options: { payment_method_save: 'enabled' } } : {}),
      invoice_creation: { enabled: true },
      success_url: this.config.successUrl(Boolean(input.agentId)),
      cancel_url: this.config.cancelUrl(Boolean(input.agentId)),
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_S,
    });

    if (!session.url) throw new Error(`Stripe returned checkout session ${session.id} without a URL`);
    this.log.log(`checkout ${session.id} for purchase ${input.purchaseId} (${input.pack.id}, ${input.pack.price_cents} ${input.pack.currency})`);
    return { id: session.id, url: session.url };
  }

  // ---------------------------------------------------------------- SA5 price sync (admin §5.2 step 3, D12)

  /**
   * The Stripe Product for a pack, found by the `pack_id` we stamp in its metadata, else
   * created. Products outlive prices: a re-priced pack keeps its Product and gets a new
   * Price (Stripe prices are immutable).
   */
  async ensureProduct(pack: PricingPack): Promise<string> {
    // Scoped to this environment for the same reason as the lookup keys: one test account, several environments.
    const found = await this.client.products.search({ query: `metadata['pack_id']:'${pack.id}' AND metadata['env']:'${this.config.env}' AND active:'true'`, limit: 1 });
    if (found.data[0]) return found.data[0].id;
    const product = await this.client.products.create({
      name: `${pack.name} pack`,
      description: `${(pack.credits + pack.bonus_credits).toLocaleString('en-US')} credits · 1 credit = 1 minute of a Standard agent`,
      metadata: { pack_id: pack.id, env: this.config.env },
    });
    this.log.log(`stripe product ${product.id} created for pack ${pack.id}`);
    return product.id;
  }

  /** Look before you buy: a Price already created under this key, or null. */
  async findPriceByLookupKey(key: string): Promise<{ id: string; unitAmount: number | null; currency: string; productId: string } | null> {
    const found = await this.client.prices.list({ lookup_keys: [key], limit: 1 });
    const price = found.data[0];
    if (!price) return null;
    return { id: price.id, unitAmount: price.unit_amount, currency: price.currency, productId: typeof price.product === 'string' ? price.product : price.product.id };
  }

  async createPrice(input: { productId: string; pack: PricingPack; lookupKey: string; transferLookupKey?: boolean }): Promise<string> {
    const price = await this.client.prices.create({
      product: input.productId,
      currency: input.pack.currency.toLowerCase(),
      unit_amount: input.pack.price_cents,
      lookup_key: input.lookupKey,
      ...(input.transferLookupKey ? { transfer_lookup_key: true } : {}),
      metadata: { pack_id: input.pack.id, credits: String(input.pack.credits + input.pack.bonus_credits), env: this.config.env },
    });
    this.log.log(`stripe price ${price.id} created: ${input.pack.id} ${input.pack.price_cents} ${input.pack.currency} (${input.lookupKey})`);
    return price.id;
  }

  /** A Price that is no longer sold. Idempotent: archiving an archived Price is a no-op on Stripe's side. */
  async archivePrice(priceId: string): Promise<void> {
    await this.client.prices.update(priceId, { active: false });
    this.log.log(`stripe price ${priceId} archived`);
  }

  /** Health strip (admin §3): one cheap authenticated call. Throws when Stripe or the key is wrong. */
  async ping(): Promise<void> {
    await this.client.balance.retrieve();
  }

  /**
   * Verifies `stripe-signature` over the exact request bytes and parses the event. Throws
   * on a bad or stale signature; the controller turns that into 401. The default tolerance
   * (5 min) stands — a replayed old event is exactly what the timestamp check is for.
   */
  constructEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
    this.config.assertConfigured();
    return this.client.webhooks.constructEvent(rawBody, signature, this.config.webhookSecret);
  }

  /** Test helper and fixture generator: a `stripe-signature` header Stripe would have sent. */
  signForTest(payload: string, timestampSeconds?: number): string {
    this.config.assertConfigured();
    return this.client.webhooks.generateTestHeaderString({
      payload,
      secret: this.config.webhookSecret,
      ...(timestampSeconds === undefined ? {} : { timestamp: timestampSeconds }),
    });
  }

  /** The `data.object` of a checkout.session.* event, reduced to what billing reads. */
  static sessionFacts(object: unknown): CheckoutSessionFacts {
    const s = object as Stripe.Checkout.Session;
    return {
      id: s.id,
      payment_status: s.payment_status,
      status: s.status ?? null,
      client_reference_id: s.client_reference_id ?? null,
      metadata: (s.metadata ?? {}) as Partial<CheckoutMetadata>,
      customer: typeof s.customer === 'string' ? s.customer : (s.customer?.id ?? null),
      payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null),
      invoice: typeof s.invoice === 'string' ? s.invoice : (s.invoice?.id ?? null),
      amount_total: s.amount_total ?? null,
      currency: s.currency ?? null,
    };
  }

  /** The card saved by `setup_future_usage`, for auto top-up (§5.4). */
  async savedPaymentMethod(paymentIntentId: string): Promise<{ payment_method_id: string; card_last4: string | null } | null> {
    const intent = await this.client.paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] });
    const method = intent.payment_method;
    if (!method || typeof method === 'string') return method ? { payment_method_id: method, card_last4: null } : null;
    return { payment_method_id: method.id, card_last4: method.card?.last4 ?? null };
  }

  /** Stripe-hosted invoice page, for D5 "Invoices". */
  async invoiceUrl(invoiceId: string): Promise<string | null> {
    const invoice = await this.client.invoices.retrieve(invoiceId);
    return invoice.hosted_invoice_url ?? null;
  }

  /** Customer Portal session (D5 "Payment methods"). */
  async createPortalSession(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.client.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return session.url;
  }

  /**
   * §5.4 auto top-up: an off-session PaymentIntent against the saved card, confirmed
   * immediately. The idempotency key is the purchase id, so a retry after a timeout
   * returns the same PaymentIntent rather than charging twice.
   *
   * A card that needs authentication or is declined does not throw out of here: Stripe
   * raises a `StripeCardError` carrying the PaymentIntent, and that intent's status
   * (`requires_action`, `requires_payment_method`) is the answer the caller needs.
   */
  async createOffSessionPaymentIntent(input: {
    purchaseId: string;
    workspaceId: string;
    packId: string;
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    currency: string;
    description: string;
  }): Promise<PaymentIntentFacts> {
    const metadata: TopupMetadata = { kind: 'auto_topup', workspace_id: input.workspaceId, purchase_id: input.purchaseId, pack_id: input.packId, env: this.config.env };
    try {
      const intent = await this.client.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: input.currency.toLowerCase(),
          customer: input.customerId,
          payment_method: input.paymentMethodId,
          off_session: true,
          confirm: true,
          description: input.description,
          metadata,
        },
        { idempotencyKey: `topup-${input.purchaseId}` },
      );
      return StripeGateway.paymentIntentFacts(intent);
    } catch (error) {
      const intent = (error as { payment_intent?: Stripe.PaymentIntent; raw?: { payment_intent?: Stripe.PaymentIntent } }).payment_intent
        ?? (error as { raw?: { payment_intent?: Stripe.PaymentIntent } }).raw?.payment_intent;
      if (intent && typeof intent === 'object' && typeof intent.id === 'string') {
        const facts = StripeGateway.paymentIntentFacts(intent);
        const code = (error as { code?: string; decline_code?: string }).decline_code ?? (error as { code?: string }).code ?? facts.failure_code;
        return { ...facts, failure_code: code ?? null, failure_message: (error as Error).message ?? facts.failure_message };
      }
      throw error;
    }
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentFacts> {
    return StripeGateway.paymentIntentFacts(await this.client.paymentIntents.retrieve(id));
  }

  /**
   * SA9 (D13): refund part or all of a PaymentIntent. The idempotency key is the refund
   * row's (`refund-<id>`, `-r<n>` on a retry after a failure), so a second staff member
   * clicking the same dialog answers the same Stripe refund rather than refunding twice. Only
   * the id and the status come back; the caller never sees the Stripe object.
   */
  async refundPaymentIntent(input: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    metadata?: Record<string, string>;
  }): Promise<{ id: string; status: string }> {
    const refund = await this.client.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountCents,
        ...(input.reason ? { reason: input.reason } : {}),
        metadata: { ...(input.metadata ?? {}), env: this.config.env },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    this.log.log(`stripe refund ${refund.id} (${refund.status ?? 'unknown'}) of ${input.amountCents} on ${input.paymentIntentId}`);
    return { id: refund.id, status: refund.status ?? 'pending' };
  }

  /**
   * Look before you refund again (ADR 0013 §2): a refund on this PaymentIntent that carries
   * our row's id and did not fail. A retry after a failure takes a new idempotency key —
   * Stripe replays a stored error under the old one for 24 h — so this is what stops a
   * timeout that did reach Stripe from becoming a second refund.
   */
  async findRefund(paymentIntentId: string, refundId: string): Promise<{ id: string; status: string } | null> {
    for await (const refund of this.client.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) {
      if (refund.metadata?.refund_id !== refundId) continue;
      if (refund.status === 'failed' || refund.status === 'canceled') continue;
      return { id: refund.id, status: refund.status ?? 'pending' };
    }
    return null;
  }

  /**
   * A Checkout Session by id, for the return path (`POST /wallet/checkout/confirm`) and the
   * pending-purchase sweep: what Stripe says happened, never what the URL says.
   */
  async retrieveCheckoutSession(id: string): Promise<CheckoutSessionFacts> {
    return StripeGateway.sessionFacts(await this.client.checkout.sessions.retrieve(id));
  }

  static paymentIntentFacts(object: unknown): PaymentIntentFacts {
    const pi = object as Stripe.PaymentIntent;
    return {
      id: pi.id,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      customer: typeof pi.customer === 'string' ? pi.customer : (pi.customer?.id ?? null),
      payment_method: typeof pi.payment_method === 'string' ? pi.payment_method : (pi.payment_method?.id ?? null),
      metadata: (pi.metadata ?? {}) as PaymentIntentFacts['metadata'],
      failure_code: pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code ?? null,
      failure_message: pi.last_payment_error?.message ?? null,
    };
  }

  static invoiceFacts(object: unknown): InvoiceFacts {
    const inv = object as Stripe.Invoice & { payment_intent?: string | { id: string } | null };
    const transitions = inv.status_transitions ?? {};
    return {
      id: inv.id,
      customer: typeof inv.customer === 'string' ? inv.customer : (inv.customer?.id ?? null),
      status: inv.status ?? null,
      number: inv.number ?? null,
      amount_due: inv.amount_due ?? 0,
      amount_paid: inv.amount_paid ?? 0,
      currency: inv.currency,
      hosted_invoice_url: inv.hosted_invoice_url ?? null,
      invoice_pdf: inv.invoice_pdf ?? null,
      payment_intent: typeof inv.payment_intent === 'string' ? inv.payment_intent : (inv.payment_intent?.id ?? null),
      metadata: (inv.metadata ?? {}) as Record<string, string>,
      created: inv.created,
      finalized_at: transitions.finalized_at ?? null,
      paid_at: transitions.paid_at ?? null,
      voided_at: transitions.voided_at ?? null,
    };
  }

  static isCurrency(value: string | null): value is CurrencyCode {
    return value === 'USD' || value === 'CAD';
  }
}
