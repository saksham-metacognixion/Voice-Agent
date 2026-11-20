import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripeGateway } from '../src/modules/billing';
import { PlatformConfigService } from '../src/modules/config';
import { RetellGateway } from '../src/modules/retell';
import { RuntimeCacheService } from '../src/modules/runtime-cache';
import { WalletService } from '../src/modules/wallet';
import { type CallWorkspace, callId, createCallWorkspace, ledgerSum, lifecycleEvent, startHarness, waitFor, waitForBilled } from './calls-fixtures';

/*
 * D7 webhook integration: ordering (A→B and B→A leave the same state), replay (A A A is
 * processed once) and decline (a failed payment grants nothing) — for both providers,
 * through the signed routes and the real worker. Everything asserted here is a money
 * invariant: no duplicate credits, no duplicate billing, no entitlement from a decline.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let retell: RetellGateway;
let stripe: StripeGateway;
let wallet: WalletService;
let runtimeCache: RuntimeCacheService;
let config: PlatformConfigService;

beforeAll(async () => {
  const harness = await startHarness();
  app = harness.app;
  stop = harness.stop;
  retell = app.get(RetellGateway);
  stripe = app.get(StripeGateway);
  wallet = app.get(WalletService);
  runtimeCache = app.get(RuntimeCacheService);
  config = app.get(PlatformConfigService);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

async function postRetell(body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({ method: 'POST', url: '/webhooks/retell', headers: { 'content-type': 'application/json', 'x-retell-signature': await retell.signWebhookBody(payload) }, payload });
}

async function postStripe(payload: { id: string }) {
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

function stripeEvent(type: string, object: Record<string, unknown>) {
  return { id: `evt_${randomUUID().replace(/-/g, '')}`, object: 'event', created: Math.floor(Date.now() / 1000), type, livemode: false, data: { object } };
}

async function readyWorkspace(label: string, credits = 200): Promise<CallWorkspace> {
  const ws = await createCallWorkspace(label);
  if (credits > 0) await wallet.grant(ws.tenantId, { credits, reason: 'purchase', expiresAt: new Date(Date.now() + 365 * 86_400_000) });
  await runtimeCache.refresh(ws.tenantId);
  return ws;
}

const callRow = (id: string) => adminDb.call.findUnique({ where: { id } });
const callDebits = (ws: string, id: string) => adminDb.creditLedger.count({ where: { tenantId: ws, reason: 'call', refId: id } });

// ---------------------------------------------------------------------------

describe('Retell lifecycle ordering (§13.10, §14.2)', () => {
  const facts = (ws: CallWorkspace, id: string, start: number, end: number) => ({
    call_id: id,
    start_timestamp: start,
    end_timestamp: end,
    disconnection_reason: 'user_hangup',
    call_status: 'ended',
    agent_id: ws.retellAgentId,
    to_number: ws.e164,
    metadata: { tenant_id: ws.tenantId, number_id: ws.numberId, tier: 'standard' },
  });

  it('A→B: started then ended bills once and leaves the row ended', async () => {
    const ws = await readyWorkspace('order-ab');
    const id = callId();
    const start = Date.now() - 120_000;
    await postRetell(lifecycleEvent('call_started', { call_id: id, start_timestamp: start, agent_id: ws.retellAgentId, to_number: ws.e164, metadata: { tenant_id: ws.tenantId } }));
    await waitFor('in_progress', async () => ((await callRow(id))?.status === 'in_progress' ? true : null));
    await postRetell(lifecycleEvent('call_ended', facts(ws, id, start, start + 120_000)));
    const row = await waitForBilled(id);
    expect(row.status).toBe('ended');
    expect(row.creditsCharged!.toNumber()).toBe(2);
    expect(await callDebits(ws.tenantId, id)).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(198);
  });

  it('B→A: ended then a late started bills once and does not reopen the row', async () => {
    const ws = await readyWorkspace('order-ba');
    const id = callId();
    const start = Date.now() - 120_000;
    await postRetell(lifecycleEvent('call_ended', facts(ws, id, start, start + 120_000)));
    const ended = await waitForBilled(id);
    expect(ended.status).toBe('ended');
    expect(ended.rate.toNumber()).toBe(1); // the rate was captured by whichever event created the row

    const late = await postRetell(lifecycleEvent('call_started', { call_id: id, start_timestamp: start, agent_id: ws.retellAgentId, to_number: ws.e164, metadata: { tenant_id: ws.tenantId } }));
    expect(late.statusCode).toBe(200);
    await waitFor('the late started to be processed', async () => {
      const row = await adminDb.webhookEvent.findFirst({ where: { provider: 'retell', externalId: id, eventType: 'call_started' } });
      return row?.processedAt ? true : null;
    });
    const after = (await callRow(id))!;
    expect(after.status).toBe('ended');
    expect(after.creditsCharged!.toNumber()).toBe(2);
    expect(await callDebits(ws.tenantId, id)).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(198);
  });

  it('C→B: analyzed before ended creates an unbilled row, and ended then bills once with the analysis kept', async () => {
    const ws = await readyWorkspace('order-cb');
    const id = callId();
    const start = Date.now() - 60_000;
    await postRetell(lifecycleEvent('call_analyzed', { ...facts(ws, id, start, start + 60_000), call_cost: { combined_cost: 9.4 }, call_analysis: { call_successful: true, custom_analysis_data: { call_reason: 'hours' } } }));
    const analyzed = await waitFor('analyzed row', async () => {
      const row = await callRow(id);
      return row?.status === 'analyzed' ? row : null;
    });
    expect(analyzed.creditsCharged).toBeNull(); // never billed by call_analyzed (§14.2)
    expect(analyzed.retellCostCents).toBe(9);
    expect(await ledgerSum(ws.tenantId)).toBe(200);

    await postRetell(lifecycleEvent('call_ended', facts(ws, id, start, start + 60_000)));
    const billed = await waitForBilled(id);
    expect(billed.status).toBe('analyzed'); // the later state wins
    expect(billed.creditsCharged!.toNumber()).toBe(1);
    expect(billed.outcome).toBe('hours');
    expect(await callDebits(ws.tenantId, id)).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(199);
  });

  it('A A A: the same call_ended three times is one row, one debit, two 204s', async () => {
    const ws = await readyWorkspace('replay-retell');
    const id = callId();
    const start = Date.now() - 90_000;
    const event = lifecycleEvent('call_ended', facts(ws, id, start, start + 90_000));
    const statuses = [(await postRetell(event)).statusCode];
    await waitForBilled(id);
    statuses.push((await postRetell(event)).statusCode, (await postRetell(event)).statusCode);
    expect(statuses).toEqual([200, 204, 204]);
    expect(await adminDb.webhookEvent.count({ where: { provider: 'retell', externalId: id, eventType: 'call_ended' } })).toBe(1);
    expect(await callDebits(ws.tenantId, id)).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(198.5);
  });
});

// ---------------------------------------------------------------------------

describe('Stripe checkout ordering, replay and decline (§13.7, §13.10)', () => {
  async function pendingPurchase(ws: CallWorkspace, packId = 'starter') {
    const pack = (await config.purchasablePack(packId))!.pack;
    return adminDb.purchase.create({ data: { tenantId: ws.tenantId, packId: pack.id, amountCents: pack.price_cents, currency: pack.currency, credits: pack.credits + pack.bonus_credits, status: 'pending' } });
  }
  function session(purchase: { id: string; amountCents: number; currency: string; tenantId: string }, over: Record<string, unknown> = {}) {
    return {
      id: `cs_test_${randomUUID().replace(/-/g, '')}`,
      object: 'checkout.session',
      mode: 'payment',
      status: 'complete',
      payment_status: 'paid',
      currency: purchase.currency.toLowerCase(),
      amount_total: purchase.amountCents,
      customer: `cus_${randomUUID().slice(0, 14)}`,
      payment_intent: `pi_${randomUUID().slice(0, 14)}`,
      client_reference_id: purchase.id,
      metadata: { purchase_id: purchase.id, workspace_id: purchase.tenantId, env: 'dev' },
      ...over,
    };
  }
  const purchases = (ws: string) => adminDb.creditLedger.count({ where: { tenantId: ws, reason: 'purchase' } });

  it('A A A: the same checkout.session.completed three times credits once and answers 204 twice', async () => {
    const ws = await readyWorkspace('replay-stripe', 0);
    const purchase = await pendingPurchase(ws);
    const event = stripeEvent('checkout.session.completed', session(purchase));
    const first = await postStripe(event);
    expect(first.statusCode).toBe(200);
    expect((await postStripe(event)).statusCode).toBe(204);
    expect((await postStripe(event)).statusCode).toBe(204);
    expect(await purchases(ws.tenantId)).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(150);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe('paid');
    // Same session, a *new* event id (Stripe re-sent it): still one grant.
    await postStripe(stripeEvent('checkout.session.completed', session(purchase, { id: (event.data.object as { id: string }).id })));
    expect(await purchases(ws.tenantId)).toBe(1);
  });

  it('A→B and B→A: completed (unpaid) then async_payment_succeeded credits once, in either order', async () => {
    const ws = await readyWorkspace('order-stripe', 0);
    const purchase = await pendingPurchase(ws);
    const s = session(purchase, { payment_status: 'unpaid' });
    await postStripe(stripeEvent('checkout.session.completed', s));
    expect(await purchases(ws.tenantId)).toBe(0);
    await postStripe(stripeEvent('checkout.session.async_payment_succeeded', { ...s, payment_status: 'paid' }));
    expect(await purchases(ws.tenantId)).toBe(1);
    // The unpaid `completed` arriving late changes nothing.
    await postStripe(stripeEvent('checkout.session.completed', s));
    expect(await purchases(ws.tenantId)).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(150);

    const ws2 = await readyWorkspace('order-stripe-2', 0);
    const purchase2 = await pendingPurchase(ws2);
    const s2 = session(purchase2);
    await postStripe(stripeEvent('checkout.session.async_payment_succeeded', s2));
    await postStripe(stripeEvent('checkout.session.completed', { ...s2, payment_status: 'unpaid' }));
    expect(await purchases(ws2.tenantId)).toBe(1);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase2.id } })).status).toBe('paid');
  });

  it('decline: async_payment_failed abandons the purchase — no credits, no plan tier, and a later replay stays that way', async () => {
    const ws = await readyWorkspace('decline-stripe', 0);
    const purchase = await pendingPurchase(ws, 'growth');
    const s = session(purchase, { payment_status: 'unpaid' });
    await postStripe(stripeEvent('checkout.session.completed', s));
    const failed = stripeEvent('checkout.session.async_payment_failed', s);
    expect((await postStripe(failed)).statusCode).toBe(200);
    expect((await postStripe(failed)).statusCode).toBe(204);

    const row = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(row.status).toBe('abandoned');
    expect(await purchases(ws.tenantId)).toBe(0);
    expect(await ledgerSum(ws.tenantId)).toBe(0);
    expect((await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.tenantId } })).planTier).toBe('trial');
    expect(await adminDb.creditLot.count({ where: { tenantId: ws.tenantId, purchaseId: purchase.id } })).toBe(0);
  });

  it('an expiry that arrives before the paid completion does not lose the customer’s money', async () => {
    const ws = await readyWorkspace('expire-then-pay', 0);
    const purchase = await pendingPurchase(ws);
    const s = session(purchase);
    await postStripe(stripeEvent('checkout.session.expired', { ...s, payment_status: 'unpaid', status: 'expired' }));
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe('abandoned');
    await postStripe(stripeEvent('checkout.session.completed', s));
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe('paid');
    expect(await purchases(ws.tenantId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('Stripe auto top-up decline and ordering (§5.4)', () => {
  async function topupPurchase(ws: CallWorkspace) {
    const pack = (await config.purchasablePack('growth'))!.pack;
    return adminDb.purchase.create({
      data: { tenantId: ws.tenantId, packId: pack.id, amountCents: pack.price_cents, currency: pack.currency, credits: pack.credits + pack.bonus_credits, status: 'pending', isAutoTopup: true, stripePaymentIntent: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}` },
    });
  }
  function intent(purchase: { id: string; tenantId: string; stripePaymentIntent: string | null; amountCents: number; currency: string }, status: string, over: Record<string, unknown> = {}) {
    return {
      id: purchase.stripePaymentIntent,
      object: 'payment_intent',
      status,
      amount: purchase.amountCents,
      currency: purchase.currency.toLowerCase(),
      customer: 'cus_x',
      payment_method: 'pm_x',
      metadata: { kind: 'auto_topup', workspace_id: purchase.tenantId, purchase_id: purchase.id, pack_id: 'growth', env: 'dev' },
      last_payment_error: null,
      ...over,
    };
  }
  const topups = (ws: string) => adminDb.creditLedger.count({ where: { tenantId: ws, reason: 'topup' } });

  it('payment_failed grants nothing and records why; a replay is a 204', async () => {
    const ws = await readyWorkspace('topup-decline', 10);
    const purchase = await topupPurchase(ws);
    const failed = stripeEvent('payment_intent.payment_failed', intent(purchase, 'requires_payment_method', { last_payment_error: { code: 'card_declined', message: 'Your card was declined.' } }));
    expect((await postStripe(failed)).statusCode).toBe(200);
    expect((await postStripe(failed)).statusCode).toBe(204);
    const row = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(row.status).toBe('abandoned');
    expect(row.failureReason).toBe('card_declined');
    expect(await topups(ws.tenantId)).toBe(0);
    expect(await ledgerSum(ws.tenantId)).toBe(10);
    expect(await adminDb.alert.count({ where: { tenantId: ws.tenantId, type: 'auto_topup_failed' } })).toBe(1);
  });

  it('succeeded then a stale payment_failed keeps the credits; payment_failed then succeeded still credits — Stripe has the money either way', async () => {
    const a = await readyWorkspace('topup-order-a', 10);
    const pa = await topupPurchase(a);
    await postStripe(stripeEvent('payment_intent.succeeded', intent(pa, 'succeeded')));
    expect(await topups(a.tenantId)).toBe(1);
    await postStripe(stripeEvent('payment_intent.payment_failed', intent(pa, 'requires_payment_method')));
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: pa.id } })).status).toBe('paid');
    expect(await topups(a.tenantId)).toBe(1);
    expect(await ledgerSum(a.tenantId)).toBe(510);

    const b = await readyWorkspace('topup-order-b', 10);
    const pb = await topupPurchase(b);
    await postStripe(stripeEvent('payment_intent.payment_failed', intent(pb, 'requires_payment_method')));
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: pb.id } })).status).toBe('abandoned');
    await postStripe(stripeEvent('payment_intent.succeeded', intent(pb, 'succeeded')));
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: pb.id } })).status).toBe('paid');
    expect(await topups(b.tenantId)).toBe(1);
    // And a replay of the success credits nothing more.
    await postStripe(stripeEvent('payment_intent.succeeded', intent(pb, 'succeeded')));
    expect(await topups(b.tenantId)).toBe(1);
    expect(await ledgerSum(b.tenantId)).toBe(510);
  });
});
