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
      success_url: this.config.successUrl,
      cancel_url: this.config.cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_S,
    });

    if (!session.url) throw new Error(`Stripe returned checkout session ${session.id} without a URL`);
    this.log.log(`checkout ${session.id} for purchase ${input.purchaseId} (${input.pack.id}, ${input.pack.price_cents} ${input.pack.currency})`);
    return { id: session.id, url: session.url };
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

  static isCurrency(value: string | null): value is CurrencyCode {
    return value === 'USD' || value === 'CAD';
  }
}
