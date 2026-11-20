import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { AutoTopupService } from './auto-topup.service';
import { BillingService, type FulfilmentOutcome } from './billing.service';
import { InvoicesService } from './invoices.service';
import { StripeGateway } from './stripe.gateway';

/**
 * Routes a verified, stored Stripe event to billing (§13.7). Idempotent by construction:
 * every branch re-reads state before it writes, so a replay — from Stripe, from the
 * SA12 "Replay" button, or from a D4 queue retry — is a no-op.
 */
@Injectable()
export class StripeEventHandler {
  private readonly log = new Logger(StripeEventHandler.name);

  constructor(
    private readonly billing: BillingService,
    private readonly topups: AutoTopupService,
    private readonly invoices: InvoicesService,
  ) {}

  /** The event types we subscribe to in the Stripe dashboard (CLAUDE.md, Stripe). */
  static readonly HANDLED: ReadonlySet<string> = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
    'charge.dispute.created',
    // D6 §5.4 auto top-up
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'payment_intent.canceled',
    // D6 D5 "Invoices"
    'invoice.created',
    'invoice.finalized',
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.voided',
    'invoice.marked_uncollectible',
  ]);

  async handle(event: Pick<Stripe.Event, 'id' | 'type' | 'data'> & { created?: number }): Promise<FulfilmentOutcome | { outcome: string; reason?: string }> {
    switch (event.type) {
      case 'payment_intent.succeeded':
        return this.topups.fulfilPaymentIntent(StripeGateway.paymentIntentFacts(event.data.object));
      case 'payment_intent.payment_failed':
        return this.topups.failPaymentIntent(StripeGateway.paymentIntentFacts(event.data.object), 'failed');
      case 'payment_intent.canceled':
        return this.topups.failPaymentIntent(StripeGateway.paymentIntentFacts(event.data.object), 'canceled');
      case 'invoice.created':
      case 'invoice.finalized':
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
        return this.invoices.applyEvent(
          { id: event.id, type: event.type, created: typeof event.created === 'number' ? event.created : Math.floor(Date.now() / 1000) },
          StripeGateway.invoiceFacts(event.data.object),
        );
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return this.billing.fulfil(StripeGateway.sessionFacts(event.data.object));
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        return this.billing.abandon(StripeGateway.sessionFacts(event.data.object));
      case 'charge.dispute.created': {
        // SA9 disputes queue lands with the admin console; the event is stored and loud.
        const dispute = event.data.object as Stripe.Dispute;
        this.log.error(`dispute ${dispute.id} on charge ${String(dispute.charge)} for ${dispute.amount} ${dispute.currency} (${dispute.reason})`);
        return { outcome: 'noted' };
      }
      default:
        return { outcome: 'ignored', reason: `unhandled event type ${event.type}` };
    }
  }
}
