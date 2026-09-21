import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AutoTopupService, StripeGateway, type PaymentIntentFacts } from '../src/modules/billing';
import { WalletService } from '../src/modules/wallet';
import { type CapturingAlerts, startD5Harness, waitFor } from './d5-fixtures';
import { authFor, caller, paidWorkspace } from './d6-fixtures';

/*
 * D6 billing: auto top-up end to end with Stripe substituted at the gateway boundary
 * (the one place the SDK is imported), the payment_intent.* and invoice.* webhooks
 * through the real signed route and the real worker, and the Customer Portal session.
 */

let app: NestFastifyApplication;
let alerts: CapturingAlerts;
let stop: () => Promise<void>;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;
let stripe: StripeGateway;
let wallet: WalletService;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  alerts = harness.alerts;
  stop = harness.stop;
  auth = authFor(harness.customerTenant);
  call = caller(app);
  stripe = app.get(StripeGateway);
  wallet = app.get(WalletService);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await stop?.();
  await adminDb.$disconnect();
});

function event(type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)) {
  return { id: `evt_${randomUUID().replace(/-/g, '')}`, object: 'event', created, type, livemode: false, data: { object } };
}

async function post(payload: { id: string }) {
  const body = JSON.stringify(payload);
  const res = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signForTest(body) }, payload: body });
  if (res.statusCode === 200) {
    await waitFor(`stripe event ${payload.id} processed`, async () => {
      const row = await adminDb.webhookEvent.findFirst({ where: { provider: 'stripe', externalId: payload.id }, select: { processedAt: true } });
      return row?.processedAt ? row : null;
    });
  }
  return res;
}

function intentObject(pi: Partial<PaymentIntentFacts> & { id: string; metadata: Record<string, string> }, extra: Record<string, unknown> = {}) {
  return {
    id: pi.id,
    object: 'payment_intent',
    status: pi.status ?? 'succeeded',
    amount: pi.amount ?? 14_900,
    currency: pi.currency ?? 'usd',
    customer: pi.customer ?? null,
    payment_method: pi.payment_method ?? 'pm_x',
    metadata: pi.metadata,
    last_payment_error: null,
    ...extra,
  };
}

describe('auto top-up', () => {
  it('PUT /wallet/auto-topup needs a saved card, then stores pack and threshold', async () => {
    const noCard = await paidWorkspace(app, 'topup-nocard', 'growth');
    const noCardAuth = await auth(noCard.sub, noCard.workspaceId);
    const refused = await call('PUT', '/wallet/auto-topup', noCardAuth, { enabled: true, pack_id: 'growth', threshold: 50 });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('NO_PAYMENT_METHOD');

    const ws = await paidWorkspace(app, 'topup-card', 'growth', { savedCard: true });
    const headers = await auth(ws.sub, ws.workspaceId);
    const enabled = await call('PUT', '/wallet/auto-topup', headers, { enabled: true, pack_id: 'growth', threshold: 50 });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ enabled: true, pack_id: 'growth', threshold: 50, card_last4: '4242' });
    expect((await call('GET', '/wallet', headers)).body.auto_topup).toMatchObject({ enabled: true, threshold: 50 });
    const disabled = await call('PUT', '/wallet/auto-topup', headers, { enabled: false });
    expect(disabled.body.enabled).toBe(false);
  });

  it('a debit below the threshold charges once, credits nothing until Stripe confirms, and a replayed webhook credits nothing more', async () => {
    const ws = await paidWorkspace(app, 'topup-flow', 'growth', { savedCard: true });
    const headers = await auth(ws.sub, ws.workspaceId);
    await call('PUT', '/wallet/auto-topup', headers, { enabled: true, pack_id: 'growth', threshold: 100 });

    const created: PaymentIntentFacts[] = [];
    const spy = vi.spyOn(stripe, 'createOffSessionPaymentIntent').mockImplementation(async (input) => {
      const facts: PaymentIntentFacts = {
        id: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        status: 'succeeded',
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        metadata: { kind: 'auto_topup', workspace_id: input.workspaceId, purchase_id: input.purchaseId, pack_id: input.packId, env: 'dev' },
        failure_code: null,
        failure_message: null,
      };
      created.push(facts);
      return facts;
    });

    try {
      // 500 → 90: below 100. Two debits in a row must produce one charge.
      await wallet.debit(ws.workspaceId, { credits: 410, reason: 'call', refType: 'call', refId: `call_${randomUUID()}` });
      await wallet.debit(ws.workspaceId, { credits: 5, reason: 'call', refType: 'call', refId: `call_${randomUUID()}` });
      await waitFor('the top-up attempt', async () => (created.length ? created : null));
      await new Promise((r) => setTimeout(r, 300));
      expect(spy).toHaveBeenCalledTimes(1);

      const pending = await adminDb.purchase.findFirstOrThrow({ where: { tenantId: ws.workspaceId, isAutoTopup: true } });
      expect(pending.status).toBe('pending'); // Stripe said succeeded; we still wait for the webhook
      expect(pending.stripePaymentIntent).toBe(created[0]!.id);
      expect(await wallet.balance(ws.workspaceId)).toBe(85);

      // The webhook credits exactly once.
      const pi = created[0]!;
      const res = await post(event('payment_intent.succeeded', intentObject(pi)));
      expect(res.statusCode).toBe(200);
      expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('paid');
      expect(await wallet.balance(ws.workspaceId)).toBe(585);
      const topups = await adminDb.creditLedger.findMany({ where: { tenantId: ws.workspaceId, reason: 'topup' } });
      expect(topups).toHaveLength(1);

      // Same event again → 204, nothing moves; a new event id for the same intent → nothing moves either.
      const replay = event('payment_intent.succeeded', intentObject(pi));
      await post(replay);
      expect((await post(replay)).statusCode).toBe(204);
      await post(event('payment_intent.succeeded', intentObject(pi)));
      expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'topup' } })).toBe(1);
      expect(await wallet.balance(ws.workspaceId)).toBe(585);

      // The wallet stream carried it.
      const ledger = await call('GET', '/wallet/ledger?reason=topup', headers);
      expect((ledger.body.items as unknown[]).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('a Checkout payment_intent.succeeded is ignored here — checkout.session.completed owns it', async () => {
    const ws = await paidWorkspace(app, 'topup-checkout-pi', 'growth');
    const before = await wallet.balance(ws.workspaceId);
    await post(event('payment_intent.succeeded', intentObject({ id: `pi_${randomUUID().slice(0, 14)}`, metadata: { workspace_id: ws.workspaceId, purchase_id: ws.purchaseId } })));
    expect(await wallet.balance(ws.workspaceId)).toBe(before);
  });

  it('a declined card abandons the pending top-up with the reason, alerts once, and is not retried during the cooldown', async () => {
    const ws = await paidWorkspace(app, 'topup-declined', 'growth', { savedCard: true });
    const headers = await auth(ws.sub, ws.workspaceId);
    await call('PUT', '/wallet/auto-topup', headers, { enabled: true, pack_id: 'growth', threshold: 100 });
    const spy = vi.spyOn(stripe, 'createOffSessionPaymentIntent').mockImplementation(async (input) => ({
      id: `pi_${randomUUID().slice(0, 14)}`,
      status: 'requires_payment_method',
      amount: input.amountCents,
      currency: 'usd',
      customer: input.customerId,
      payment_method: input.paymentMethodId,
      metadata: { kind: 'auto_topup', workspace_id: input.workspaceId, purchase_id: input.purchaseId, pack_id: input.packId, env: 'dev' },
      failure_code: 'card_declined',
      failure_message: 'Your card was declined.',
    }));
    try {
      await wallet.debit(ws.workspaceId, { credits: 450, reason: 'call', refType: 'call', refId: `call_${randomUUID()}` });
      const purchase = await waitFor('abandoned top-up', async () => adminDb.purchase.findFirst({ where: { tenantId: ws.workspaceId, isAutoTopup: true, status: 'abandoned' } }));
      expect(purchase.failureReason).toBe('card_declined');
      expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'auto_topup_failed' } })).toBe(1);
      expect(alerts.alerts.filter((a) => a.kind === 'auto_topup_failed' && a.fields.workspace_id === ws.workspaceId)).toHaveLength(1);

      await wallet.debit(ws.workspaceId, { credits: 5, reason: 'call', refType: 'call', refId: `call_${randomUUID()}` });
      await new Promise((r) => setTimeout(r, 300));
      expect(spy).toHaveBeenCalledTimes(1); // cooldown
      expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'topup' } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('payment_intent.payment_failed after a created intent abandons it; the sweep reconciles a lost webhook from Stripe', async () => {
    const ws = await paidWorkspace(app, 'topup-sweep', 'growth', { savedCard: true });
    const headers = await auth(ws.sub, ws.workspaceId);
    await call('PUT', '/wallet/auto-topup', headers, { enabled: true, pack_id: 'growth', threshold: 100 });
    const created: PaymentIntentFacts[] = [];
    const spy = vi.spyOn(stripe, 'createOffSessionPaymentIntent').mockImplementation(async (input) => {
      const facts: PaymentIntentFacts = {
        id: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        status: 'processing',
        amount: input.amountCents,
        currency: 'usd',
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        metadata: { kind: 'auto_topup', workspace_id: input.workspaceId, purchase_id: input.purchaseId, pack_id: input.packId, env: 'dev' },
        failure_code: null,
        failure_message: null,
      };
      created.push(facts);
      return facts;
    });
    const retrieve = vi.spyOn(stripe, 'retrievePaymentIntent').mockImplementation(async (id) => ({ ...created.find((c) => c.id === id)!, status: 'succeeded' }));
    try {
      await wallet.debit(ws.workspaceId, { credits: 450, reason: 'call', refType: 'call', refId: `call_${randomUUID()}` });
      await waitFor('the intent', async () => (created.length ? created : null));
      const pending = await waitFor('pending with intent', async () => adminDb.purchase.findFirst({ where: { tenantId: ws.workspaceId, isAutoTopup: true, stripePaymentIntent: { not: null } } }));
      // Pretend five minutes passed with no webhook; the sweep asks Stripe and credits.
      await adminDb.purchase.update({ where: { id: pending.id }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
      const result = await app.get(AutoTopupService).sweep();
      expect(result.reconciled).toBeGreaterThanOrEqual(1);
      expect(retrieve).toHaveBeenCalled();
      expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('paid');
      expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'topup' } })).toBe(1);
      // A late payment_failed for an already-paid intent changes nothing.
      await post(event('payment_intent.payment_failed', intentObject({ ...created[0]!, status: 'requires_payment_method' })));
      expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('paid');
    } finally {
      spy.mockRestore();
      retrieve.mockRestore();
    }
  }, 30_000);
});

describe('invoices', () => {
  function invoiceObject(ws: { stripeCustomerId: string; workspaceId: string; purchaseId: string }, id: string, over: Record<string, unknown>) {
    return {
      id,
      object: 'invoice',
      customer: ws.stripeCustomerId,
      status: 'draft',
      number: null,
      amount_due: 14_900,
      amount_paid: 0,
      currency: 'usd',
      hosted_invoice_url: null,
      invoice_pdf: null,
      metadata: { workspace_id: ws.workspaceId, purchase_id: ws.purchaseId },
      created: Math.floor(Date.now() / 1000) - 60,
      status_transitions: {},
      ...over,
    };
  }

  it('mirrors the lifecycle idempotently, in any delivery order, and lists it only to its workspace', async () => {
    const ws = await paidWorkspace(app, 'inv', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const id = `in_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const t0 = Math.floor(Date.now() / 1000) - 30;

    // paid arrives first (newer), then finalized (older): the invoice must stay paid.
    await post(event('invoice.paid', invoiceObject(ws, id, { status: 'paid', number: 'INV-0001', amount_paid: 14_900, hosted_invoice_url: 'https://invoice.stripe.com/i/x', invoice_pdf: 'https://pay.stripe.com/x.pdf', status_transitions: { finalized_at: t0 + 1, paid_at: t0 + 2 } }), t0 + 2));
    await post(event('invoice.finalized', invoiceObject(ws, id, { status: 'open', number: 'INV-0001', status_transitions: { finalized_at: t0 + 1 } }), t0 + 1));
    await post(event('invoice.created', invoiceObject(ws, id, {}), t0));

    const row = await adminDb.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: id } });
    expect(row).toMatchObject({ tenantId: ws.workspaceId, purchaseId: ws.purchaseId, status: 'paid', number: 'INV-0001', amountPaidCents: 14_900, currency: 'USD' });
    expect(row.paidAt).toBeTruthy();
    expect(await adminDb.invoice.count({ where: { stripeInvoiceId: id } })).toBe(1);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: ws.purchaseId } })).invoiceUrl).toBe('https://invoice.stripe.com/i/x');

    // The same event twice: 204 the second time, one processing.
    const dup = event('invoice.paid', invoiceObject(ws, id, { status: 'paid' }));
    await post(dup);
    expect((await post(dup)).statusCode).toBe(204);

    // A payment_failed for another invoice of the same customer.
    const failedId = `in_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await post(event('invoice.payment_failed', invoiceObject(ws, failedId, { status: 'open', metadata: {} })));
    expect((await adminDb.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: failedId } })).status).toBe('payment_failed');

    const list = await call('GET', '/wallet/invoices', headers);
    expect(list.status).toBe(200);
    const items = list.body.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.status).sort()).toEqual(['paid', 'payment_failed']);
    expect(JSON.stringify(items)).not.toContain(ws.stripeCustomerId);

    const other = await paidWorkspace(app, 'inv-other', 'growth');
    expect(((await call('GET', '/wallet/invoices', await auth(other.sub, other.workspaceId))).body.items as unknown[]).length).toBe(0);
  }, 30_000);

  it('an invoice for a customer we do not know is stored with no workspace and shown to nobody', async () => {
    const id = `in_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await post(event('invoice.finalized', { id, object: 'invoice', customer: 'cus_unknown_xyz', status: 'open', amount_due: 100, amount_paid: 0, currency: 'usd', metadata: {}, created: Math.floor(Date.now() / 1000), status_transitions: {} }));
    expect((await adminDb.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: id } })).tenantId).toBeNull();
  });
});

describe('POST /wallet/portal-session', () => {
  it('needs a Stripe customer, resolves it from the workspace only, and returns the portal URL', async () => {
    const { createWorkspace } = await import('./d5-fixtures');
    const trial = await createWorkspace('portal-trial');
    const refused = await call('POST', '/wallet/portal-session', await auth(trial.sub, trial.workspaceId), {});
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('NO_PAYMENT_METHOD');

    const ws = await paidWorkspace(app, 'portal', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const spy = vi.spyOn(stripe, 'createPortalSession').mockResolvedValue('https://billing.stripe.com/session/test_123');
    try {
      const ok = await call('POST', '/wallet/portal-session', headers, { return_path: '/app/wallet?from=portal' });
      expect(ok.status).toBe(201);
      expect(ok.body).toEqual({ url: 'https://billing.stripe.com/session/test_123' });
      expect(spy).toHaveBeenCalledWith(ws.stripeCustomerId, expect.stringMatching(/\/app\/wallet\?from=portal$/));
      // No way to name a customer: an off-origin return path is refused by the schema.
      expect((await call('POST', '/wallet/portal-session', headers, { return_path: 'https://evil.example/x' })).status).toBe(422);
      // Editors cannot open the portal.
      const { addMember } = await import('./d5-fixtures');
      const editor = await addMember(ws.workspaceId, 'editor', 'editor');
      expect((await call('POST', '/wallet/portal-session', await auth(editor.sub, ws.workspaceId), {})).status).toBe(403);
    } finally {
      spy.mockRestore();
    }
  });
});
