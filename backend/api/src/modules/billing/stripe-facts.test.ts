import { describe, expect, it } from 'vitest';
import { amountMismatch, isStripeNotFound } from './billing.service';
import { StripeGateway, type CheckoutSessionFacts } from './stripe.gateway';

/*
 * ADR 0010 §5 / ADR 0013 §9: what billing reads from a Stripe object, and the amount and
 * currency check a paid Checkout must pass before a single credit is granted.
 */

describe('StripeGateway.sessionFacts', () => {
  it('keeps what billing reads and reduces expanded objects to their ids', () => {
    const facts = StripeGateway.sessionFacts({
      id: 'cs_1',
      payment_status: 'paid',
      status: 'complete',
      client_reference_id: 'p-1',
      metadata: { purchase_id: 'p-1', workspace_id: 'ws-1' },
      customer: { id: 'cus_1' },
      payment_intent: { id: 'pi_1' },
      invoice: 'in_1',
      amount_total: 14_900,
      currency: 'usd',
      line_items: { data: [] },
    });
    expect(facts).toEqual({
      id: 'cs_1',
      payment_status: 'paid',
      status: 'complete',
      client_reference_id: 'p-1',
      metadata: { purchase_id: 'p-1', workspace_id: 'ws-1' },
      customer: 'cus_1',
      payment_intent: 'pi_1',
      invoice: 'in_1',
      amount_total: 14_900,
      currency: 'usd',
    });
  });

  it('missing optional fields become null, metadata an empty object', () => {
    expect(StripeGateway.sessionFacts({ id: 'cs_2', payment_status: 'unpaid' })).toEqual({
      id: 'cs_2',
      payment_status: 'unpaid',
      status: null,
      client_reference_id: null,
      metadata: {},
      customer: null,
      payment_intent: null,
      invoice: null,
      amount_total: null,
      currency: null,
    });
  });
});

describe('StripeGateway.paymentIntentFacts', () => {
  it('prefers the decline code over the error code for the failure', () => {
    const facts = StripeGateway.paymentIntentFacts({
      id: 'pi_1',
      status: 'requires_payment_method',
      amount: 4_900,
      currency: 'usd',
      customer: 'cus_1',
      payment_method: { id: 'pm_1' },
      metadata: { kind: 'auto_topup', purchase_id: 'p-1' },
      last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' },
    });
    expect(facts).toMatchObject({
      payment_method: 'pm_1',
      customer: 'cus_1',
      failure_code: 'insufficient_funds',
      failure_message: 'Your card has insufficient funds.',
      metadata: { kind: 'auto_topup', purchase_id: 'p-1' },
    });
  });

  it('a succeeded intent has no failure', () => {
    expect(StripeGateway.paymentIntentFacts({ id: 'pi_2', status: 'succeeded', amount: 1, currency: 'cad' })).toMatchObject({
      customer: null,
      payment_method: null,
      metadata: {},
      failure_code: null,
      failure_message: null,
    });
  });
});

describe('StripeGateway.invoiceFacts', () => {
  it('flattens the status transitions and the payment intent', () => {
    expect(
      StripeGateway.invoiceFacts({
        id: 'in_1',
        customer: { id: 'cus_1' },
        status: 'paid',
        number: 'ORALY-0001',
        amount_due: 4_900,
        amount_paid: 4_900,
        currency: 'usd',
        hosted_invoice_url: 'https://invoice.stripe.com/i/1',
        invoice_pdf: null,
        payment_intent: { id: 'pi_1' },
        created: 1_700_000_000,
        status_transitions: { finalized_at: 1_700_000_100, paid_at: 1_700_000_200 },
      }),
    ).toMatchObject({ customer: 'cus_1', payment_intent: 'pi_1', finalized_at: 1_700_000_100, paid_at: 1_700_000_200, voided_at: null });
  });

  it('defaults amounts to 0 and transitions to null', () => {
    expect(StripeGateway.invoiceFacts({ id: 'in_2', currency: 'usd', created: 1 })).toMatchObject({
      amount_due: 0,
      amount_paid: 0,
      status: null,
      number: null,
      payment_intent: null,
      finalized_at: null,
      paid_at: null,
      voided_at: null,
      metadata: {},
    });
  });
});

describe('StripeGateway.isCurrency', () => {
  it.each([
    ['USD', true],
    ['CAD', true],
    ['usd', false],
    ['EUR', false],
    [null, false],
  ])('%s → %s', (value, expected) => {
    expect(StripeGateway.isCurrency(value)).toBe(expected);
  });
});

describe('amountMismatch (ADR 0010 §5)', () => {
  const session = (amount_total: number | null, currency: string | null) => ({ amount_total, currency }) as CheckoutSessionFacts;
  const purchase = { amountCents: 14_900, currency: 'USD' };

  it('matches when the amount and currency agree, whatever the currency case or padding', () => {
    expect(amountMismatch(session(14_900, 'usd'), purchase)).toBeNull();
    expect(amountMismatch(session(14_900, 'USD'), { amountCents: 14_900, currency: ' usd ' })).toBeNull();
  });

  it('refuses one cent either way', () => {
    expect(amountMismatch(session(14_899, 'usd'), purchase)).toBe('Stripe collected 14899 but purchase 14900 was expected');
    expect(amountMismatch(session(14_901, 'usd'), purchase)).toBe('Stripe collected 14901 but purchase 14900 was expected');
  });

  it('refuses the same number in another currency', () => {
    expect(amountMismatch(session(14_900, 'cad'), purchase)).toBe('Stripe collected CAD but purchase is in USD');
  });

  it('has nothing to compare on a session without an amount, and no currency check without a currency', () => {
    expect(amountMismatch(session(null, 'cad'), purchase)).toBeNull();
    expect(amountMismatch(session(14_900, null), purchase)).toBeNull();
  });
});

describe('isStripeNotFound', () => {
  it.each([
    [{ code: 'resource_missing' }, true],
    [{ raw: { code: 'resource_missing' } }, true],
    [{ statusCode: 404 }, true],
    [{ statusCode: 500 }, false],
    [{ code: 'rate_limit' }, false],
    [new Error('ECONNRESET'), false],
    [null, false],
    [undefined, false],
  ])('%j → %s', (error, expected) => {
    expect(isStripeNotFound(error)).toBe(expected);
  });
});
