import { describe, expect, it } from 'vitest';
import { STATUS_RANK, invoiceStatusOf } from './invoices.service';

describe('invoiceStatusOf', () => {
  it('follows Stripe\'s status for the ordinary events', () => {
    expect(invoiceStatusOf('invoice.created', 'draft')).toBe('draft');
    expect(invoiceStatusOf('invoice.finalized', 'open')).toBe('open');
    expect(invoiceStatusOf('invoice.paid', 'paid')).toBe('paid');
    expect(invoiceStatusOf('invoice.voided', 'void')).toBe('void');
    expect(invoiceStatusOf('invoice.marked_uncollectible', 'uncollectible')).toBe('uncollectible');
  });

  it('payment_failed is what the event means, not the object status (which stays open)', () => {
    expect(invoiceStatusOf('invoice.payment_failed', 'open')).toBe('payment_failed');
  });

  it('falls back to the event type when the object carries no status', () => {
    expect(invoiceStatusOf('invoice.paid', null)).toBe('paid');
    expect(invoiceStatusOf('invoice.finalized', null)).toBe('open');
    expect(invoiceStatusOf('invoice.created', null)).toBe('draft');
  });
});

describe('STATUS_RANK — out-of-order delivery', () => {
  it('terminal states outrank open, and open outranks draft', () => {
    expect(STATUS_RANK.paid).toBeGreaterThan(STATUS_RANK.open);
    expect(STATUS_RANK.void).toBeGreaterThan(STATUS_RANK.open);
    expect(STATUS_RANK.open).toBeGreaterThan(STATUS_RANK.draft);
    expect(STATUS_RANK.payment_failed).toBe(STATUS_RANK.open);
  });
});
