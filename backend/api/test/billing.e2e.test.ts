import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { adminDb } from '@portal/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from '../src/common/errors/all-exceptions.filter';
import { AuthModule } from '../src/modules/auth';
import { BillingModule, BillingService, StripeGateway } from '../src/modules/billing';
import { PlatformConfigModule, PlatformConfigService } from '../src/modules/config';
import { EventsModule } from '../src/modules/events';
import { JobsModule, WorkerRuntime } from '../src/modules/jobs';
import { RedisModule, RedisCache, redisKeys } from '../src/modules/redis';
import { WalletModule } from '../src/modules/wallet';
import { WebhooksModule, registerWebhookRawBody } from '../src/modules/webhooks';
import { FakeAuth0Tenant } from './auth0-double';
import { createWorkspace, ledgerSum } from './money-fixtures';

/*
 * Money in, end to end through the HTTP layer (§13.7, §13.10, admin §5):
 *   - a signed checkout.session.completed credits the wallet exactly once
 *   - a replay is a 204 and creates nothing
 *   - a bad signature is a 401 and stores nothing
 *   - checkout.session.expired abandons the pending purchase
 *   - GET /pricing is public and served from Redis; GET /flags is per workspace
 *
 * The signature is real: the payload is signed with STRIPE_WEBHOOK_SECRET the way Stripe
 * signs it, and verified by the same constructEvent() call production uses. Nothing is
 * mocked between the wire and the ledger.
 */

process.env.STRIPE_SECRET_KEY ||= 'sk_test_e2e_placeholder_not_used_for_network';
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_e2e_placeholder';
process.env.APP_ENV ||= 'dev';
process.env.CAPTURE_FIXTURES = 'false';
process.env.RETELL_API_KEY ||= 'key_e2e_placeholder_0123456789abcdef';
process.env.API_PUBLIC_URL ||= 'http://localhost:4000';
// D4 moved Stripe processing behind BullMQ, so this suite runs a real worker on its own
// queue namespace and waits for each event to be processed before asserting on the ledger.
process.env.BULLMQ_PREFIX = `portal:e2e-billing-${randomUUID().slice(0, 8)}`;

const customerTenant = new FakeAuth0Tenant('customers', 'https://api.test');
const staffTenant = new FakeAuth0Tenant('staff', 'https://admin-api.test');

let app: NestFastifyApplication;
let stripe: StripeGateway;
let config: PlatformConfigService;
let cache: RedisCache;
let ws: { tenantId: string; userId: string; email: string; sub: string };

beforeAll(async () => {
  await customerTenant.start();
  await staffTenant.start();
  process.env.AUTH0_CUSTOMER_DOMAIN = customerTenant.domain;
  process.env.AUTH0_CUSTOMER_AUDIENCE = customerTenant.audience;
  process.env.AUTH0_STAFF_DOMAIN = staffTenant.domain;
  process.env.AUTH0_STAFF_AUDIENCE = staffTenant.audience;

  const created = await createWorkspace('billing');
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: created.userId } });
  ws = { ...created, sub: user.authProviderId };

  @Module({
    imports: [AuthModule, RedisModule, PlatformConfigModule, JobsModule, EventsModule, WalletModule, BillingModule, WebhooksModule],
    providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  registerWebhookRawBody(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(WorkerRuntime).start();

  stripe = app.get(StripeGateway);
  config = app.get(PlatformConfigService);
  cache = app.get(RedisCache);
});

afterAll(async () => {
  await app?.close();
  await customerTenant.stop();
  await staffTenant.stop();
  await adminDb.$disconnect();
});

// ---------------------------------------------------------------------------

/** A checkout.session.* event as Stripe would send it for one of our purchases. */
function sessionEvent(type: string, session: Record<string, unknown>) {
  return {
    id: `evt_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
    api_version: '2026-08-27',
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: `cs_test_${randomUUID().replace(/-/g, '')}`,
        object: 'checkout.session',
        mode: 'payment',
        status: 'complete',
        payment_status: 'paid',
        currency: 'usd',
        customer: `cus_${randomUUID().slice(0, 14)}`,
        payment_intent: `pi_${randomUUID().slice(0, 14)}`,
        invoice: null,
        ...session,
      },
    },
  };
}

/**
 * Posts a signed Stripe event and, when it was accepted for processing, waits until the
 * worker has finished it. Since D4 the HTTP handler only stores and enqueues (ADR 0010 §5
 * as amended), so an assertion made straight after the response would race the job.
 */
async function post(payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature ?? stripe.signForTest(body),
    },
    payload: body,
  });
  const eventId = (payload as { id?: string }).id;
  if (response.statusCode === 200 && eventId) await settle(eventId);
  return response;
}

/** Polls `webhook_events.processed_at` for one event id. */
async function settle(eventId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await adminDb.webhookEvent.findFirst({ where: { provider: 'stripe', externalId: eventId }, select: { processedAt: true, error: true } });
    if (row?.processedAt) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`stripe event ${eventId} was not processed within ${timeoutMs} ms`);
}

async function pendingPurchase(packId = 'starter') {
  const pack = (await config.purchasablePack(packId))!.pack;
  return adminDb.purchase.create({
    data: {
      tenantId: ws.tenantId,
      packId: pack.id,
      amountCents: pack.price_cents,
      currency: pack.currency,
      credits: pack.credits + pack.bonus_credits,
      status: 'pending',
    },
  });
}

/**
 * Our ids on the session, plus the money Stripe says it collected. Fulfilment compares
 * that against the pending purchase, so a session built from a real purchase row carries
 * the amount too; a bare id is for the "not ours" cases where there is nothing to match.
 */
function ours(purchase: { id: string; amountCents: number; currency: string } | string, extra: Record<string, string> = {}) {
  const purchaseId = typeof purchase === 'string' ? purchase : purchase.id;
  const money = typeof purchase === 'string' ? {} : { amount_total: purchase.amountCents, currency: purchase.currency.toLowerCase() };
  return {
    client_reference_id: purchaseId,
    ...money,
    metadata: { workspace_id: ws.tenantId, purchase_id: purchaseId, pack_id: 'starter', config_version: '1', auto_topup: 'false', auto_topup_threshold: '', agent_id: '', env: 'dev', ...extra },
  };
}

describe('POST /webhooks/stripe', () => {
  it('refuses a missing or forged signature with 401 and stores nothing', async () => {
    const event = sessionEvent('checkout.session.completed', ours(randomUUID()));
    const unsigned = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(event) });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().code).toBe('INVALID_SIGNATURE');

    const forged = await post(event, 't=1,v1=deadbeef');
    expect(forged.statusCode).toBe(401);

    // Signed by the right secret but for different bytes: the raw-body check catches it.
    const tampered = await post({ ...event, type: 'checkout.session.expired' }, stripe.signForTest(JSON.stringify(event)));
    expect(tampered.statusCode).toBe(401);

    expect(await adminDb.webhookEvent.count({ where: { provider: 'stripe', externalId: event.id } })).toBe(0);
  });

  it('a paid checkout.session.completed marks the purchase paid, creates a lot and a ledger row, sets the plan tier', async () => {
    const purchase = await pendingPurchase('starter');
    const before = await ledgerSum(ws.tenantId);
    const event = sessionEvent('checkout.session.completed', ours(purchase));

    const res = await post(event);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    const paid = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(paid.status).toBe('paid');
    expect(paid.stripeSessionId).toBe((event.data.object as { id: string }).id);
    expect(paid.stripePaymentIntent).toMatch(/^pi_/);

    const lots = await adminDb.creditLot.findMany({ where: { purchaseId: purchase.id } });
    expect(lots).toHaveLength(1);
    expect(lots[0]!.creditsTotal.toNumber()).toBe(150);
    expect(lots[0]!.creditsRemaining.toNumber()).toBe(150);
    expect(lots[0]!.policyVersion).toBe(1);
    const monthsOut = (lots[0]!.expiresAt.getTime() - Date.now()) / (30.4 * 86_400_000);
    expect(monthsOut).toBeGreaterThan(11.5);
    expect(monthsOut).toBeLessThan(12.5);

    const rows = await adminDb.creditLedger.findMany({ where: { reason: 'purchase', refId: purchase.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta.toNumber()).toBe(150);
    expect(await ledgerSum(ws.tenantId)).toBe(before + 150);
    expect(await cache.get(redisKeys.balance(ws.tenantId))).toBe((before + 150).toFixed(2));

    const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.tenantId } });
    expect(tenant.planTier).toBe('starter');
    expect(tenant.concurrencyCap).toBe(2);
    expect(tenant.kbAllowance).toBe(0);
    expect(tenant.stripeCustomerId).toMatch(/^cus_/);

    const stored = await adminDb.webhookEvent.findUniqueOrThrow({
      where: { provider_externalId_eventType: { provider: 'stripe', externalId: event.id, eventType: event.type } },
    });
    expect(stored.processedAt).not.toBeNull();
    expect(stored.error).toBeNull();
  });

  it('the same event again is a 204 and creates no second lot — the D3 exit check', async () => {
    const purchase = await pendingPurchase('growth');
    const event = sessionEvent('checkout.session.completed', ours(purchase, { pack_id: 'growth' }));
    const before = await ledgerSum(ws.tenantId);

    expect((await post(event)).statusCode).toBe(200);
    expect((await post(event)).statusCode).toBe(204);
    expect((await post(event)).statusCode).toBe(204);

    expect(await adminDb.creditLot.count({ where: { purchaseId: purchase.id } })).toBe(1);
    expect(await adminDb.creditLedger.count({ where: { reason: 'purchase', refId: purchase.id } })).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(before + 500);
  });

  it('a different Stripe event id for an already-paid purchase (Stripe re-sent under a new id) credits nothing', async () => {
    const purchase = await pendingPurchase('starter');
    const before = await ledgerSum(ws.tenantId);
    expect((await post(sessionEvent('checkout.session.completed', ours(purchase)))).statusCode).toBe(200);
    // async_payment_succeeded for the same session arrives with a new event id.
    expect((await post(sessionEvent('checkout.session.async_payment_succeeded', ours(purchase)))).statusCode).toBe(200);
    expect(await adminDb.creditLot.count({ where: { purchaseId: purchase.id } })).toBe(1);
    expect(await ledgerSum(ws.tenantId)).toBe(before + 150);
  });

  it('plan tier follows the largest pack bought in 12 months, and never drops on a smaller top-up', async () => {
    const tenantBefore = await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.tenantId } });
    expect(tenantBefore.planTier).toBe('growth'); // from the earlier growth purchase
    const small = await pendingPurchase('starter');
    expect((await post(sessionEvent('checkout.session.completed', ours(small)))).statusCode).toBe(200);
    const after = await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.tenantId } });
    expect(after.planTier).toBe('growth');
    expect(after.concurrencyCap).toBe(3);
    expect(after.kbAllowance).toBe(1);
    // caps:{ws} was refreshed post-commit.
    const caps = await config.capsFor(ws.tenantId);
    expect(caps).toMatchObject({ plan_tier: 'growth', concurrency_cap: 3, kb_allowance: 1, max_agents: 3, max_numbers: 3 });
  });

  it('checkout.session.completed with payment_status=unpaid (delayed method) credits nothing yet', async () => {
    const purchase = await pendingPurchase('starter');
    const before = await ledgerSum(ws.tenantId);
    const event = sessionEvent('checkout.session.completed', { ...ours(purchase), payment_status: 'unpaid' });
    expect((await post(event)).statusCode).toBe(200);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe('pending');
    expect(await ledgerSum(ws.tenantId)).toBe(before);

    // …until async_payment_succeeded.
    expect((await post(sessionEvent('checkout.session.async_payment_succeeded', ours(purchase)))).statusCode).toBe(200);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe('paid');
    expect(await ledgerSum(ws.tenantId)).toBe(before + 150);
  });

  it('checkout.session.expired abandons a pending purchase and leaves a paid one alone', async () => {
    const pending = await pendingPurchase('starter');
    expect((await post(sessionEvent('checkout.session.expired', { ...ours(pending), status: 'expired', payment_status: 'unpaid' }))).statusCode).toBe(200);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('abandoned');

    const paid = await pendingPurchase('starter');
    await post(sessionEvent('checkout.session.completed', ours(paid)));
    await post(sessionEvent('checkout.session.expired', { ...ours(paid), status: 'expired' }));
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe('paid');
  });

  it('refuses to credit a purchase whose metadata names another workspace', async () => {
    const other = await createWorkspace('victim');
    const purchase = await pendingPurchase('starter');
    const before = await ledgerSum(other.tenantId);
    const event = sessionEvent('checkout.session.completed', { ...ours(purchase), metadata: { ...ours(purchase).metadata, workspace_id: other.tenantId } });
    expect((await post(event)).statusCode).toBe(200);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe('pending');
    expect(await ledgerSum(other.tenantId)).toBe(before);
  });

  it('refuses to credit when Stripe collected an amount the purchase does not agree with', async () => {
    // A stripe_price_map row left behind by an older config version, or a Price edited in
    // the dashboard: the session says one thing and the pending purchase another.
    const purchase = await pendingPurchase('scale');
    const before = await ledgerSum(ws.tenantId);
    const short = sessionEvent('checkout.session.completed', { ...ours(purchase), amount_total: purchase.amountCents - 30_000 });
    expect((await post(short)).statusCode).toBe(200);

    const after = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(after.status).toBe('pending');
    expect(after.stripeSessionId).toBe((short.data.object as { id: string }).id); // the trail SA9 needs
    expect(await ledgerSum(ws.tenantId)).toBe(before);
    expect(await adminDb.creditLot.count({ where: { purchaseId: purchase.id } })).toBe(0);
    // Stored and processed: nothing here is worth three days of Stripe retries.
    expect((await adminDb.webhookEvent.findFirstOrThrow({ where: { provider: 'stripe', externalId: short.id } })).processedAt).not.toBeNull();

    // Same for the currency, even when the number matches.
    const wrongCurrency = await pendingPurchase('scale');
    const swapped = sessionEvent('checkout.session.completed', { ...ours(wrongCurrency), currency: 'cad' });
    expect((await post(swapped)).statusCode).toBe(200);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: wrongCurrency.id } })).status).toBe('pending');
    expect(await ledgerSum(ws.tenantId)).toBe(before);
  });

  it('an event that is not ours (no purchase in it) is stored, processed and ignored', async () => {
    const event = sessionEvent('checkout.session.completed', { client_reference_id: null, metadata: {} });
    expect((await post(event)).statusCode).toBe(200);
    const stored = await adminDb.webhookEvent.findFirstOrThrow({ where: { provider: 'stripe', externalId: event.id } });
    expect(stored.processedAt).not.toBeNull();
  });

  it('malformed ids (found with a real `stripe trigger` on D3) are ignored, not a 500 that Stripe retries', async () => {
    const purchase = await pendingPurchase('starter');
    const event = sessionEvent('checkout.session.expired', {
      client_reference_id: `${purchase.id}\nINSERT 0 1`,
      metadata: { workspace_id: ws.tenantId, purchase_id: purchase.id, env: 'dev' },
      status: 'expired',
      payment_status: 'unpaid',
    });
    expect((await post(event)).statusCode).toBe(200);
    const stored = await adminDb.webhookEvent.findFirstOrThrow({ where: { provider: 'stripe', externalId: event.id } });
    expect(stored.processedAt).not.toBeNull();
    expect(stored.error).toBeNull();
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe('pending');
  });

  it('a session created in another environment is ignored', async () => {
    const purchase = await pendingPurchase('starter');
    const event = sessionEvent('checkout.session.completed', ours(purchase, { env: 'staging' }));
    expect((await post(event)).statusCode).toBe(200);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe('pending');
  });
});

describe('GET /pricing and GET /flags', () => {
  it('serves the public pricing without a token, from Redis on the second read', async () => {
    await cache.del(redisKeys.pricingCurrent);
    const first = await app.inject({ method: 'GET', url: '/pricing' });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.version).toBeGreaterThanOrEqual(1);
    expect(body.packs.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['starter', 'growth', 'scale', 'pro']));
    expect(body.rates.standard_per_min).toBe(1);
    expect(body.rates.premium_per_min).toBe(1.5);
    expect(body.wallet_policy).not.toHaveProperty('mfa_required_above_balance');
    expect(body.packs[0]).not.toHaveProperty('visibility');

    expect(await cache.get(redisKeys.pricingCurrent)).not.toBeNull();
    const second = await app.inject({ method: 'GET', url: '/pricing?region=CA' });
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe(body.version);
  });

  it('serves per-workspace flags to a member and refuses without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/flags' })).statusCode).toBe(401);

    const token = await customerTenant.mint(ws.sub);
    const res = await app.inject({ method: 'GET', url: '/flags', headers: { authorization: `Bearer ${token}`, 'x-workspace-id': ws.tenantId } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan_tier).toBe('growth');
    expect(body.gates.knowledge_base).toBe(true);
    expect(body.gates.premium_voices).toBe(false);
    expect(body.kill_switches).toEqual({ reject_inbound: false, pause_web_tests: false, pause_purchases: false, pause_generation: false });
    expect(body.caps).toEqual({ concurrency_cap: 3, kb_allowance: 1, max_agents: 3, max_numbers: 3 });
    expect(await cache.get(redisKeys.flagsWorkspace(ws.tenantId))).not.toBeNull();
  });

  it('a kill switch flips within one read after being set, and publish invalidates everything', async () => {
    await config.setKillSwitch('pause_purchases', { on: true, reason: 'e2e' });
    expect(await config.killSwitch('pause_purchases')).toBe(true);
    const token = await customerTenant.mint(ws.sub);
    const res = await app.inject({ method: 'GET', url: '/flags', headers: { authorization: `Bearer ${token}`, 'x-workspace-id': ws.tenantId } });
    expect(res.json().kill_switches.pause_purchases).toBe(true);

    // Checkout is refused while the switch is on — the customer-facing effect.
    const checkout = await app.inject({
      method: 'POST',
      url: '/wallet/checkout',
      headers: { authorization: `Bearer ${token}`, 'x-workspace-id': ws.tenantId, 'content-type': 'application/json' },
      payload: JSON.stringify({ pack_id: 'starter' }),
    });
    expect(checkout.statusCode).toBe(409);
    expect(checkout.json().code).toBe('PURCHASES_PAUSED');

    await config.setKillSwitch('pause_purchases', { on: false });
    expect(await config.killSwitch('pause_purchases')).toBe(false);

    await cache.set(redisKeys.pricingCurrent, '{"stale":true}');
    await cache.set(redisKeys.caps(ws.tenantId), '{"stale":true}');
    await config.invalidateAll();
    expect(await cache.get(redisKeys.pricingCurrent)).toBeNull();
    expect(await cache.get(redisKeys.caps(ws.tenantId))).toBeNull();
    expect(await cache.get(redisKeys.flagsWorkspace(ws.tenantId))).toBeNull();
  });

  it('GET /wallet reflects the purchases above', async () => {
    const token = await customerTenant.mint(ws.sub);
    const res = await app.inject({ method: 'GET', url: '/wallet', headers: { authorization: `Bearer ${token}`, 'x-workspace-id': ws.tenantId } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.balance).toBe(await ledgerSum(ws.tenantId));
    expect(body.plan_tier).toBe('growth');
    expect(body.last_pack_credits).toBe(150);
    expect(body.expiring_next.credits).toBeGreaterThan(0);

    const lots = await app.inject({ method: 'GET', url: '/wallet/lots', headers: { authorization: `Bearer ${token}`, 'x-workspace-id': ws.tenantId } });
    expect(lots.json().length).toBeGreaterThanOrEqual(4);

    const ledger = await app.inject({ method: 'GET', url: '/wallet/ledger?limit=2&reason=purchase', headers: { authorization: `Bearer ${token}`, 'x-workspace-id': ws.tenantId } });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().items).toHaveLength(2);
    expect(ledger.json().next_cursor).toBeTruthy();
  });
});

describe('POST /wallet/checkout, the half before Stripe', () => {
  it('refuses a promo code with PROMO_INVALID rather than charging full price under a promo', async () => {
    const billing = app.get(BillingService);
    const spy = vi.spyOn(stripe, 'createCheckoutSession');
    const ctx = { userId: ws.userId, workspaceId: ws.tenantId, role: 'owner' as const };
    await expect(billing.createCheckout(ctx, { pack_id: 'starter', promo_code: 'SAVE10' })).rejects.toMatchObject({ code: 'PROMO_INVALID' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a Stripe failure abandons the pending purchase instead of leaving a ghost for SA9', async () => {
    const billing = app.get(BillingService);
    const spy = vi.spyOn(stripe, 'createCheckoutSession').mockRejectedValueOnce(new Error('stripe is down'));
    const ctx = { userId: ws.userId, workspaceId: ws.tenantId, role: 'owner' as const };
    await expect(billing.createCheckout(ctx, { pack_id: 'starter' })).rejects.toThrow('stripe is down');
    spy.mockRestore();

    const newest = await adminDb.purchase.findFirstOrThrow({ where: { tenantId: ws.tenantId }, orderBy: { createdAt: 'desc' } });
    expect(newest).toMatchObject({ packId: 'starter', status: 'abandoned', stripeSessionId: null });
  });
});
