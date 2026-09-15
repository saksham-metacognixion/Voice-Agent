import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { BillingService, type FulfilmentOutcome } from './billing.service';
import { StripeGateway } from './stripe.gateway';

/**
 * Routes a verified, stored Stripe event to billing (§13.7). Idempotent by construction:
 * every branch re-reads state before it writes, so a replay — from Stripe, from the
 * SA12 "Replay" button, or from a D4 queue retry — is a no-op.
 */
@Injectable()
export class StripeEventHandler {
  private readonly log = new Logger(StripeEventHandler.name);

  constructor(private readonly billing: BillingService) {}

  /** The event types we subscribe to in the Stripe dashboard (CLAUDE.md, Stripe). */
  static readonly HANDLED: ReadonlySet<string> = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
    'charge.dispute.created',
  ]);

  async handle(event: Pick<Stripe.Event, 'id' | 'type' | 'data'>): Promise<FulfilmentOutcome | { outcome: 'noted' } | { outcome: 'ignored'; reason: string }> {
    switch (event.type) {
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
