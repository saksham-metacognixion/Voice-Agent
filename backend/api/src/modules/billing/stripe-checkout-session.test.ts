import { describe, expect, it, vi } from 'vitest';
import { PRICING_V1 } from '../../../../db/prisma/seed-data/pricing-v1';
import { StripeConfig } from './stripe.config';
import { StripeGateway } from './stripe.gateway';

/*
 * What we ask Stripe for when a checkout begins (§13.7, ADR 0049). The SDK is replaced at
 * the one field the gateway keeps it in; the arguments are what is asserted.
 */

const starter = PRICING_V1.packs.find((p) => p.id === 'starter')!;
const PURCHASE = '5b0d5a1e-6a3e-4f0e-9a43-0d6f3c2b1a90';
const WORKSPACE = '0c1f4f4e-9f0b-4f58-8b3a-7d2e5b6a1c11';

function gateway() {
  const g = new StripeGateway(new StripeConfig({ STRIPE_SECRET_KEY: 'sk_test_unit', STRIPE_WEBHOOK_SECRET: 'whsec_unit', APP_ENV: 'dev', PORTAL_URL: 'http://localhost:3000' }));
  const create = vi.fn(async (_args: Record<string, unknown>) => ({ id: 'cs_test_unit', url: 'https://checkout.stripe.test/unit' }));
  (g as unknown as { sdk: unknown }).sdk = { checkout: { sessions: { create } } };
  return { g, create };
}
const base = { purchaseId: PURCHASE, workspaceId: WORKSPACE, pack: starter, configVersion: 3 };
type Args = {
  adaptive_pricing: { enabled: boolean };
  line_items: Array<{ price?: string; price_data?: { currency: string; unit_amount: number } }>;
  invoice_creation: { enabled: boolean; invoice_data: { metadata: Record<string, string> } };
  payment_intent_data: { metadata: Record<string, string>; setup_future_usage?: string };
  client_reference_id: string;
};

describe('StripeGateway.createCheckoutSession', () => {
  it('a converted CAD price is charged as inline price data: the purchase amount, in CAD', async () => {
    const { g, create } = gateway();
    await g.createCheckoutSession({ ...base, amountCents: 7_000, currency: 'CAD' });
    const args = create.mock.calls[0]![0] as unknown as Args;
    expect(args.line_items[0]!.price).toBeUndefined();
    expect(args.line_items[0]!.price_data).toMatchObject({ currency: 'cad', unit_amount: 7_000 });
    // Never the pack's own USD figure.
    expect(args.line_items[0]!.price_data!.unit_amount).not.toBe(starter.price_cents);
  });

  it('a USD price with a synced Stripe Price uses that Price', async () => {
    const { g, create } = gateway();
    await g.createCheckoutSession({ ...base, amountCents: 4_900, currency: 'USD', stripePriceId: 'price_unit' });
    const args = create.mock.calls[0]![0] as unknown as Args;
    expect(args.line_items[0]).toEqual({ price: 'price_unit', quantity: 1 });
  });

  it('the invoice Stripe creates carries the purchase and workspace ids, so its events can be linked to the purchase', async () => {
    const { g, create } = gateway();
    await g.createCheckoutSession({ ...base, amountCents: 7_000, currency: 'CAD' });
    const args = create.mock.calls[0]![0] as unknown as Args;
    expect(args.invoice_creation.enabled).toBe(true);
    expect(args.invoice_creation.invoice_data.metadata).toMatchObject({ purchase_id: PURCHASE, workspace_id: WORKSPACE, pack_id: 'starter', env: 'dev' });
    expect(args.payment_intent_data.metadata).toMatchObject({ purchase_id: PURCHASE, workspace_id: WORKSPACE });
    expect(args.client_reference_id).toBe(PURCHASE);
  });

  it('switches Stripe’s own currency conversion off, in both currencies: the buyer pays what our screen showed', async () => {
    for (const money of [{ amountCents: 4_900, currency: 'USD' as const, stripePriceId: 'price_unit' }, { amountCents: 7_000, currency: 'CAD' as const }]) {
      const { g, create } = gateway();
      await g.createCheckoutSession({ ...base, ...money });
      expect((create.mock.calls[0]![0] as unknown as Args).adaptive_pricing).toEqual({ enabled: false });
    }
  });

  it('keeps a card only when the customer opted in to auto top-up', async () => {
    const off = gateway();
    await off.g.createCheckoutSession({ ...base, amountCents: 7_000, currency: 'CAD', autoTopup: { enabled: false } });
    expect((off.create.mock.calls[0]![0] as unknown as Args).payment_intent_data.setup_future_usage).toBeUndefined();
    const on = gateway();
    await on.g.createCheckoutSession({ ...base, amountCents: 7_000, currency: 'CAD', autoTopup: { enabled: true, threshold: 15 } });
    expect((on.create.mock.calls[0]![0] as unknown as Args).payment_intent_data.setup_future_usage).toBe('off_session');
  });
});
