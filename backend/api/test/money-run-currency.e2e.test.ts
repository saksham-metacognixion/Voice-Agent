import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Prisma, adminDb } from '@portal/db';
import { rateForTier } from '@portal/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutoTopupService, StripeGateway } from '../src/modules/billing';
import { computeCharge } from '../src/modules/calls/metering';
import { BankOfCanadaClient, ExchangeRatesService, PlatformConfigService } from '../src/modules/config';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { WalletService } from '../src/modules/wallet';
import { type D5Harness, createWorkspace, startD5Harness } from './d5-fixtures';
import { authFor, caller } from './d6-fixtures';

/*
 * The money run in USD and in CAD against the **real Stripe test account** and the **real
 * Bank of Canada rate** (ADR 0049). Nothing is stubbed: the Checkout Sessions, the
 * customers, the off-session PaymentIntents and the refunds are created on Stripe with the
 * test key in `.env`, and every figure in the report is read back from Stripe, not from
 * what we asked for.
 *
 * Skipped unless `MONEY_RUN=1`, so the ordinary e2e run never calls Stripe:
 *
 *     MONEY_RUN=1 pnpm --filter @portal/api exec vitest run --config vitest.e2e.config.ts test/money-run-currency.e2e.test.ts
 *
 * What it cannot do: type a card into Stripe's hosted Checkout page. A Checkout Session is
 * therefore verified up to "Stripe holds a session for exactly the displayed amount in the
 * workspace currency"; the paid end of the path is exercised with an off-session
 * PaymentIntent on a saved test card (the auto top-up path), which Stripe really charges.
 * Stripe's webhooks for this account go to the staging endpoint, so the PaymentIntent is
 * read back from Stripe and handed to the handler the webhook calls.
 *
 * Rates are stored under a source name of this run's own, like the D23 suite.
 */

const RUN = process.env.MONEY_RUN === '1' && /^sk_test_/.test(process.env.STRIPE_SECRET_KEY ?? '');
const OUT = resolve(process.cwd(), '../../docs/evidence/2026-11-18-usd-cad/money-run-local.json');
const PACKS = ['starter', 'growth', 'scale', 'pro'] as const;

interface Row {
  scenario: string;
  currency: string;
  displayed: number | null;
  stripe: number | null;
  stripe_currency: string | null;
  credits: number | null;
  balance_after?: number;
  stripe_object?: string;
  result: 'pass' | 'fail' | 'partial';
  note?: string;
}

const rows: Row[] = [];
let h: D5Harness;
let stripe: StripeGateway;
let fx: ExchangeRatesService;
let boc: BankOfCanadaClient;
let wallet: WalletService;
let topups: AutoTopupService;
let config: PlatformConfigService;
let call: ReturnType<typeof caller>;
let auth: ReturnType<typeof authFor>;
let superAdmin: Record<string, string>;
let rateInForce = '';
let rateDay = '';
const run = randomUUID().slice(0, 8);

describe.skipIf(!RUN)('money run: USD and CAD against the Stripe test account', () => {
  beforeAll(async () => {
    h = await startD5Harness({ workers: false });
    stripe = h.app.get(StripeGateway);
    fx = h.app.get(ExchangeRatesService);
    boc = h.app.get(BankOfCanadaClient);
    wallet = h.app.get(WalletService);
    topups = h.app.get(AutoTopupService);
    config = h.app.get(PlatformConfigService);
    call = caller(h.app);
    auth = authFor(h.customerTenant, { mfa: true });
    boc.source = `moneyrun-${run}`;
    const staff = await adminDb.staffUser.create({ data: { authProviderId: `google-oauth2|moneyrun-${run}`, email: `moneyrun-${run}@metacognixion.test`, name: `money run ${run}`, role: 'super_admin' } });
    superAdmin = { authorization: `Bearer ${await h.staffTenant.mint(staff.authProviderId, { mfa: true })}` };

    // The real Bank of Canada answer, fetched now.
    const refreshed = await fx.refresh();
    if (refreshed.outcome !== 'stored') throw new Error(`the Bank of Canada rate was not stored: ${JSON.stringify(refreshed)}`);
    rateInForce = refreshed.rate.rate;
    rateDay = refreshed.rate.observedOn;
  }, 120_000);

  afterAll(async () => {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify({ run, at: new Date().toISOString(), stripe_mode: 'test', rate: { pair: 'USD/CAD', rate: rateInForce, observed_on: rateDay, source: 'Bank of Canada FXUSDCAD (live fetch)' }, rows }, null, 2)}\n`);
    await h?.app.get(RedisCache).del(redisKeys.fxCurrent(`moneyrun-${run}`));
    await h?.stop();
    await adminDb.$disconnect();
  });

  for (const currency of ['USD', 'CAD'] as const) {
    describe(currency, () => {
      let ws: Awaited<ReturnType<typeof createWorkspace>> & { headers: Record<string, string> };
      let topupPurchaseId = '';

      beforeAll(async () => {
        const created = await createWorkspace(`moneyrun-${currency}-${run}`);
        await adminDb.tenant.update({ where: { id: created.workspaceId }, data: { currency, country: currency === 'CAD' ? 'CA' : 'US' } });
        ws = { ...created, headers: await auth(created.sub, created.workspaceId) };
      });

      it('initial workspace currency', async () => {
        const res = await call('GET', '/workspace', ws.headers);
        expect(res.body).toMatchObject({ currency, currency_locked: false });
        rows.push({ scenario: 'Initial workspace currency', currency, displayed: null, stripe: null, stripe_currency: null, credits: null, result: 'pass', note: `GET /workspace → ${String(res.body.currency)}, not locked` });
      });

      it.each(PACKS)('%s: Stripe holds a Checkout Session for exactly the displayed amount', async (packId) => {
        const pricing = (await h.app.inject({ method: 'GET', url: `/pricing?currency=${currency}` })).json() as { currency: string; packs: Array<{ id: string; price_cents: number; currency: string; credits: number }> };
        const shown = pricing.packs.find((p) => p.id === packId)!;
        expect(shown.currency).toBe(currency);

        const res = await call('POST', '/wallet/checkout', ws.headers, { pack_id: packId, expected_amount_cents: shown.price_cents, expected_currency: shown.currency });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('checkout');
        expect(String(res.body.checkout_url)).toMatch(/^https:\/\/checkout\.stripe\.com\//);

        const purchase = await adminDb.purchase.findUniqueOrThrow({ where: { id: res.body.purchase_id as string } });
        // Read back from Stripe: what the customer would be charged on the hosted page.
        const session = await stripe.retrieveCheckoutSession(purchase.stripeSessionId!);
        expect(session.amount_total).toBe(shown.price_cents);
        expect(session.currency).toBe(currency.toLowerCase());
        expect(purchase).toMatchObject({ amountCents: shown.price_cents, currency, credits: shown.credits, status: 'pending' });
        expect(purchase.fxRate?.toFixed() ?? null).toBe(currency === 'CAD' ? new Prisma.Decimal(rateInForce).toFixed() : null);
        rows.push({
          scenario: `${packId[0]!.toUpperCase()}${packId.slice(1)} purchase (Checkout Session)`,
          currency,
          displayed: shown.price_cents,
          stripe: session.amount_total,
          stripe_currency: session.currency,
          credits: shown.credits,
          stripe_object: session.id,
          result: 'partial',
          note: 'Session created on Stripe at the displayed amount and currency; purchase row matches. Not paid: the hosted card page needs a browser.',
        });
      });

      it('saved card and auto top-up: Stripe really charges the pack price in the workspace currency; credits follow the confirmation, once', async () => {
        const customer = await stripe.client.customers.create({ name: `money run ${currency} ${run}`, metadata: { env: stripe.config.env, purpose: 'adr-0049-money-run' } });
        const method = await stripe.client.paymentMethods.attach('pm_card_visa', { customer: customer.id });
        await adminDb.tenant.update({
          where: { id: ws.workspaceId },
          data: {
            stripeCustomerId: customer.id,
            autoTopupJson: { enabled: true, pack_id: 'starter', threshold: 15, payment_method_id: method.id, card_last4: method.card?.last4 ?? null, currency } as Prisma.InputJsonValue,
          },
        });
        const pricing = (await h.app.inject({ method: 'GET', url: `/pricing?currency=${currency}` })).json() as { packs: Array<{ id: string; price_cents: number; credits: number }> };
        const shown = pricing.packs.find((p) => p.id === 'starter')!;
        expect(await wallet.rebuildBalance(ws.workspaceId)).toBe(0);

        const outcome = await topups.evaluate(ws.workspaceId, 'schedule');
        expect(outcome).toMatchObject({ outcome: 'charged' });
        if (outcome.outcome !== 'charged') return;
        topupPurchaseId = outcome.purchaseId;
        // The create call granted nothing.
        expect(await wallet.rebuildBalance(ws.workspaceId)).toBe(0);

        // What the webhook would carry, read from Stripe.
        const intent = await stripe.retrievePaymentIntent(outcome.paymentIntentId);
        expect(intent).toMatchObject({ status: 'succeeded', amount: shown.price_cents, currency: currency.toLowerCase(), customer: customer.id, payment_method: method.id });
        const first = await topups.fulfilPaymentIntent(intent);
        expect(first.outcome).toBe('credited');
        const again = await topups.fulfilPaymentIntent(intent);
        expect(again.outcome).toBe('already_paid');
        const balance = await wallet.rebuildBalance(ws.workspaceId);
        expect(balance).toBe(shown.credits);
        const purchase = await adminDb.purchase.findUniqueOrThrow({ where: { id: topupPurchaseId } });
        expect(purchase).toMatchObject({ status: 'paid', amountCents: shown.price_cents, currency, isAutoTopup: true });
        rows.push({ scenario: 'Saved card (pm_card_visa attached)', currency, displayed: null, stripe: null, stripe_currency: null, credits: null, stripe_object: method.id, result: 'pass', note: `Visa •••• ${method.card?.last4 ?? ''} on ${customer.id}` });
        rows.push({ scenario: 'Auto top-up (Starter, off-session)', currency, displayed: shown.price_cents, stripe: intent.amount, stripe_currency: intent.currency, credits: shown.credits, balance_after: balance, stripe_object: intent.id, result: 'pass', note: 'PaymentIntent succeeded on Stripe; credited once, a second confirmation credited nothing.' });
      });

      it('call, transfer and rental deductions are the same credits in either currency', async () => {
        const { config: pricing } = await config.currentPricing();
        const standard = rateForTier(pricing.rates, 'standard');
        const premium = rateForTier(pricing.rates, 'premium');
        const span = (seconds: number) => ({ call_status: 'ended', start_timestamp: 1_800_000_000_000, end_timestamp: 1_800_000_000_000 + seconds * 1000 });
        const steps: Array<{ scenario: string; credits: number; reason: 'call' | 'transfer' | 'rental'; note: string }> = [
          { scenario: 'Standard call (2 min 30 s)', credits: computeCharge(span(150), standard).credits, reason: 'call', note: `150 s × ${standard}/min` },
          { scenario: 'Premium call (2 min 30 s)', credits: computeCharge(span(150), premium).credits, reason: 'call', note: `150 s × ${premium}/min` },
          { scenario: 'Transfer (4 min bridged)', credits: computeCharge(span(240), pricing.rates.transferred_leg_per_min).credits, reason: 'transfer', note: `240 s × ${pricing.rates.transferred_leg_per_min}/min` },
          { scenario: 'Number rental (1 month)', credits: pricing.recurring.number_rental_credits, reason: 'rental', note: 'pricing.recurring.number_rental_credits' },
        ];
        expect(steps.map((s) => s.credits)).toEqual([2.5, 3.75, 1, 15]);
        for (const step of steps) {
          const id = randomUUID();
          const write =
            step.reason === 'call'
              ? await wallet.debitCall(ws.workspaceId, `call_moneyrun_${id}`, step.credits)
              : step.reason === 'transfer'
                ? await wallet.debitTransfer(ws.workspaceId, `call_moneyrun_${id}`, step.credits)
                : await wallet.debit(ws.workspaceId, { credits: step.credits, reason: 'rental', refType: 'number_rental', refId: `${id}:${new Date().toISOString()}` });
          rows.push({ scenario: step.scenario, currency: `credits (${currency} workspace)`, displayed: null, stripe: null, stripe_currency: null, credits: -step.credits, balance_after: write.balance_after, result: 'pass', note: step.note });
        }
        expect(await wallet.rebuildBalance(ws.workspaceId)).toBe(150 - 22.25);
      });

      it('refund: Stripe returns the money in the currency it took it in, and the credits come back out', async () => {
        const before = await adminDb.purchase.findUniqueOrThrow({ where: { id: topupPurchaseId } });
        // Off first: the refund takes the balance under the threshold, and this run must not charge the card again.
        const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId }, select: { autoTopupJson: true } });
        await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { autoTopupJson: { ...(tenant.autoTopupJson as object), enabled: false } as Prisma.InputJsonValue } });
        const res = await call('POST', `/admin/purchases/${topupPurchaseId}/refund`, superAdmin, { reason_code: 'customer_request', note: 'ADR 0049 money run', idempotency_key: randomUUID() });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ status: 'refunded', currency, refunded_cents: before.amountCents, refundable_cents: 0 });
        const refund = await adminDb.refund.findFirstOrThrow({ where: { purchaseId: topupPurchaseId } });
        const onStripe = await stripe.client.refunds.retrieve(refund.stripeRefundId!);
        expect(onStripe).toMatchObject({ amount: before.amountCents, currency: currency.toLowerCase(), payment_intent: before.stripePaymentIntent });
        expect(['succeeded', 'pending']).toContain(onStripe.status);
        const balance = await wallet.rebuildBalance(ws.workspaceId);
        // 150 granted, 22.25 used, 150 reversed: the overdraft the ledger allows (ADR 0010).
        expect(balance).toBe(-22.25);
        rows.push({ scenario: 'Refund (full, of the top-up)', currency, displayed: before.amountCents, stripe: onStripe.amount, stripe_currency: onStripe.currency, credits: -refund.creditsReversed.toNumber(), balance_after: balance, stripe_object: onStripe.id, result: 'pass', note: `Stripe refund ${onStripe.status}; purchase row unchanged at ${before.amountCents} ${currency}.` });
      });
    });
  }
});
