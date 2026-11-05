import { describe, expect, it, vi } from 'vitest';
import { StripeEventHandler } from './stripe-events.handler';

/*
 * §13.7 / §14.2: which billing path each stored Stripe event takes. Billing, auto top-up
 * and invoices are replaced; the routing and the facts handed to them are asserted.
 */

function handler() {
  const billing = { fulfil: vi.fn().mockResolvedValue({ outcome: 'credited' }), abandon: vi.fn().mockResolvedValue({ outcome: 'abandoned' }) };
  const topups = {
    fulfilPaymentIntent: vi.fn().mockResolvedValue({ outcome: 'credited' }),
    failPaymentIntent: vi.fn().mockResolvedValue({ outcome: 'failed' }),
  };
  const invoices = { applyEvent: vi.fn().mockResolvedValue({ outcome: 'stored' }) };
  return { h: new StripeEventHandler(billing as never, topups as never, invoices as never), billing, topups, invoices };
}

const session = { id: 'cs_1', payment_status: 'paid', status: 'complete', amount_total: 4_900, currency: 'usd', metadata: { purchase_id: 'p-1' }, customer: 'cus_1' };
const intent = { id: 'pi_1', status: 'succeeded', amount: 4_900, currency: 'usd', customer: { id: 'cus_1' }, metadata: { kind: 'auto_topup' } };
const invoice = { id: 'in_1', customer: 'cus_1', status: 'paid', amount_due: 4_900, amount_paid: 4_900, currency: 'usd', created: 1_700_000_000 };

describe('StripeEventHandler.handle', () => {
  it.each(['checkout.session.completed', 'checkout.session.async_payment_succeeded'])('%s → fulfil with the session facts', async (type) => {
    const { h, billing } = handler();
    await expect(h.handle({ id: 'evt_1', type, data: { object: session } } as never)).resolves.toEqual({ outcome: 'credited' });
    expect(billing.fulfil).toHaveBeenCalledWith(expect.objectContaining({ id: 'cs_1', payment_status: 'paid', amount_total: 4_900, customer: 'cus_1' }));
    expect(billing.abandon).not.toHaveBeenCalled();
  });

  it.each(['checkout.session.expired', 'checkout.session.async_payment_failed'])('%s → abandon, never fulfil', async (type) => {
    const { h, billing } = handler();
    await h.handle({ id: 'evt_1', type, data: { object: session } } as never);
    expect(billing.abandon).toHaveBeenCalledWith(expect.objectContaining({ id: 'cs_1' }));
    expect(billing.fulfil).not.toHaveBeenCalled();
  });

  it('payment_intent.succeeded → the auto top-up fulfilment, with an expanded customer read as its id', async () => {
    const { h, topups } = handler();
    await h.handle({ id: 'evt_2', type: 'payment_intent.succeeded', data: { object: intent } } as never);
    expect(topups.fulfilPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi_1', amount: 4_900, customer: 'cus_1' }));
  });

  it.each([
    ['payment_intent.payment_failed', 'failed'],
    ['payment_intent.canceled', 'canceled'],
  ])('%s → failPaymentIntent(…, %s)', async (type, how) => {
    const { h, topups } = handler();
    await h.handle({ id: 'evt_3', type, data: { object: intent } } as never);
    expect(topups.failPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi_1' }), how);
    expect(topups.fulfilPaymentIntent).not.toHaveBeenCalled();
  });

  it.each(['invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.voided', 'invoice.marked_uncollectible'])(
    '%s → invoices.applyEvent with the event id, type and created time',
    async (type) => {
      const { h, invoices } = handler();
      await h.handle({ id: 'evt_4', type, created: 1_700_000_123, data: { object: invoice } } as never);
      expect(invoices.applyEvent).toHaveBeenCalledWith({ id: 'evt_4', type, created: 1_700_000_123 }, expect.objectContaining({ id: 'in_1', amount_paid: 4_900 }));
    },
  );

  it('an invoice event without `created` is stamped with the current time', async () => {
    const { h, invoices } = handler();
    const before = Math.floor(Date.now() / 1000);
    await h.handle({ id: 'evt_5', type: 'invoice.paid', data: { object: invoice } } as never);
    const created = invoices.applyEvent.mock.calls[0]![0].created as number;
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(before + 2);
  });

  it('a dispute is noted (stored and logged), moving no money', async () => {
    const { h, billing, topups } = handler();
    const dispute = { id: 'dp_1', charge: 'ch_1', amount: 4_900, currency: 'usd', reason: 'fraudulent' };
    await expect(h.handle({ id: 'evt_6', type: 'charge.dispute.created', data: { object: dispute } } as never)).resolves.toEqual({ outcome: 'noted' });
    expect(billing.fulfil).not.toHaveBeenCalled();
    expect(topups.fulfilPaymentIntent).not.toHaveBeenCalled();
  });

  it('an unknown type is ignored with a reason, never thrown', async () => {
    const { h } = handler();
    await expect(h.handle({ id: 'evt_7', type: 'customer.created', data: { object: {} } } as never)).resolves.toEqual({
      outcome: 'ignored',
      reason: 'unhandled event type customer.created',
    });
  });

  it('HANDLED lists exactly the routed types (the dashboard subscription list)', () => {
    expect([...StripeEventHandler.HANDLED].sort()).toEqual(
      [
        'charge.dispute.created',
        'checkout.session.async_payment_failed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.completed',
        'checkout.session.expired',
        'invoice.created',
        'invoice.finalized',
        'invoice.marked_uncollectible',
        'invoice.paid',
        'invoice.payment_failed',
        'invoice.voided',
        'payment_intent.canceled',
        'payment_intent.payment_failed',
        'payment_intent.succeeded',
      ].sort(),
    );
  });

  it('every HANDLED type reaches a handler (none falls through to "ignored")', async () => {
    for (const type of StripeEventHandler.HANDLED) {
      const { h } = handler();
      const object = type.startsWith('checkout') ? session : type.startsWith('payment_intent') ? intent : type.startsWith('invoice') ? invoice : { id: 'dp' };
      const out = (await h.handle({ id: 'e', type, created: 1, data: { object } } as never)) as { outcome: string };
      expect(out.outcome, type).not.toBe('ignored');
    }
  });
});
