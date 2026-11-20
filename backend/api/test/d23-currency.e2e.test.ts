import { randomUUID } from 'node:crypto';
import { Prisma, adminDb, withWorkspace } from '@portal/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AutoTopupService, type PaymentIntentFacts, StripeGateway } from '../src/modules/billing';
import { BankOfCanadaClient, ExchangeRatesService, type FxObservation, PlatformConfigService } from '../src/modules/config';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { WalletService } from '../src/modules/wallet';
import { type D5Harness, type TestWorkspace, addMember, createUser, createWorkspace, startD5Harness, waitFor } from './d5-fixtures';
import { authFor, caller } from './d6-fixtures';

/*
 * D23 — USD and CAD (spec §5, §5.5 #2; ADR 0049), against real Postgres and Redis through
 * the HTTP layer, the real signed Stripe webhook route and a real worker.
 *
 * Two things are substituted, both at the one boundary where the SDK or the network is
 * called: the Stripe gateway's outbound calls (the arguments are what is asserted — the
 * amount and currency we would have sent) and the Bank of Canada client's `recent()`.
 * Rates are stored under a source name of this run's own, so the suite never reads or
 * moves a developer box's real rate history.
 *
 * At 1.4291 the four packs are CA$70 / CA$213 / CA$570 / CA$1,428; at 1.3500 Starter is CA$66.
 */

const RATE = '1.4291';
const CAD_AT_RATE = { starter: 7_000, growth: 21_300, scale: 57_000, pro: 142_800 } as const;
const USD = { starter: 4_900, growth: 14_900, scale: 39_900, pro: 99_900 } as const;
const CREDITS = { starter: 150, growth: 500, scale: 1_500, pro: 4_500 } as const;
type PackId = keyof typeof USD;

let h: D5Harness;
let run = '';
let stripe: StripeGateway;
let fx: ExchangeRatesService;
let boc: BankOfCanadaClient;
let wallet: WalletService;
let topups: AutoTopupService;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;
let staff: Record<'superAdmin' | 'finance' | 'support' | 'ops', { id: string; token: Record<string, string> }>;
let financeCapBefore: number | null | undefined;
let day = 0;

const reason = { reason_code: 'customer_request', note: 'd23 e2e' } as const;

/** Publishes `rate` as the newest business day of this run's source and puts it in force. */
async function setRate(rate: string): Promise<void> {
  day += 1;
  const observations: FxObservation[] = [{ observedOn: new Date(Date.UTC(2026, 10, 1 + day)).toISOString().slice(0, 10), rate }];
  vi.spyOn(boc, 'recent').mockResolvedValueOnce(observations);
  const result = await fx.refresh();
  if (result.outcome !== 'stored') throw new Error(`rate ${rate} was not stored: ${JSON.stringify(result)}`);
}

async function workspace(label: string, currency: 'USD' | 'CAD', country = currency === 'CAD' ? 'CA' : 'US'): Promise<TestWorkspace & { headers: Record<string, string> }> {
  const ws = await createWorkspace(`d23-${label}-${run}`);
  await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { currency, country } });
  return { ...ws, headers: await auth(ws.sub, ws.workspaceId) };
}

function stubCheckout() {
  return vi.spyOn(stripe, 'createCheckoutSession').mockImplementation(async (input) => ({ id: `cs_test_${randomUUID().replace(/-/g, '')}`, url: `https://checkout.stripe.test/${input.purchaseId}` }));
}

async function shownPrice(currency: 'USD' | 'CAD', packId: PackId): Promise<{ amount: number; currency: string }> {
  const res = await h.app.inject({ method: 'GET', url: `/pricing?currency=${currency}` });
  const body = res.json() as { currency: string; packs: Array<{ id: string; price_cents: number; currency: string }> };
  const pack = body.packs.find((p) => p.id === packId)!;
  return { amount: pack.price_cents, currency: pack.currency };
}

/** The customer's path: read the price the page shows, then confirm exactly that. */
async function startCheckout(ws: { headers: Record<string, string> }, currency: 'USD' | 'CAD', packId: PackId, extra: Record<string, unknown> = {}) {
  const shown = await shownPrice(currency, packId);
  const res = await call('POST', '/wallet/checkout', ws.headers, { pack_id: packId, expected_amount_cents: shown.amount, expected_currency: shown.currency, ...extra });
  return { res, shown, purchaseId: res.body.purchase_id as string | undefined };
}

function stripeEvent(type: string, object: Record<string, unknown>) {
  return { id: `evt_${randomUUID().replace(/-/g, '')}`, object: 'event', created: Math.floor(Date.now() / 1000), type, livemode: false, data: { object } };
}

async function post(payload: { id: string; [key: string]: unknown }) {
  const body = JSON.stringify(payload);
  const res = await h.app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signForTest(body) }, payload: body });
  if (res.statusCode === 200) {
    await waitFor(`stripe event ${payload.id} processed`, async () => {
      const row = await adminDb.webhookEvent.findFirst({ where: { provider: 'stripe', externalId: payload.id }, select: { processedAt: true } });
      return row?.processedAt ? row : null;
    });
  }
  return res;
}

/** `checkout.session.completed` for one of our purchases, as Stripe would send it. Overrides say what Stripe "collected". */
async function sessionCompleted(purchaseId: string, over: Record<string, unknown> = {}, metadata: Record<string, string> = {}) {
  const purchase = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
  return stripeEvent('checkout.session.completed', {
    id: purchase.stripeSessionId ?? `cs_test_${randomUUID().replace(/-/g, '')}`,
    object: 'checkout.session',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    client_reference_id: purchase.id,
    amount_total: purchase.amountCents,
    currency: purchase.currency.trim().toLowerCase(),
    customer: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    payment_intent: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    invoice: null,
    metadata: { workspace_id: purchase.tenantId, purchase_id: purchase.id, pack_id: purchase.packId ?? '', auto_topup: 'false', auto_topup_threshold: '', agent_id: '', env: stripe.config.env, ...metadata },
    ...over,
  });
}

/** Buys `packId` in the workspace currency all the way to credits, through checkout and the signed webhook. */
async function buy(ws: { workspaceId: string; headers: Record<string, string> }, currency: 'USD' | 'CAD', packId: PackId, metadata: Record<string, string> = {}): Promise<string> {
  const { res, purchaseId } = await startCheckout(ws, currency, packId);
  if (res.status !== 201 || !purchaseId) throw new Error(`checkout refused: ${JSON.stringify(res.body)}`);
  await post(await sessionCompleted(purchaseId, {}, metadata));
  const paid = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
  if (paid.status !== 'paid') throw new Error(`purchase ${purchaseId} is ${paid.status}`);
  return purchaseId;
}

const balance = (workspaceId: string) => wallet.rebuildBalance(workspaceId);
const purchasesOf = (workspaceId: string) => adminDb.purchase.findMany({ where: { tenantId: workspaceId }, orderBy: { createdAt: 'asc' } });
const customerAudits = (workspaceId: string, action: string) => adminDb.auditLog.findMany({ where: { tenantId: workspaceId, action }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  h = await startD5Harness({ workers: true });
  run = randomUUID().slice(0, 8);
  stripe = h.app.get(StripeGateway);
  fx = h.app.get(ExchangeRatesService);
  boc = h.app.get(BankOfCanadaClient);
  wallet = h.app.get(WalletService);
  topups = h.app.get(AutoTopupService);
  auth = authFor(h.customerTenant, { mfa: true });
  call = caller(h.app);
  boc.source = `e2e-${run}`;

  const make = async (label: string, role: 'super_admin' | 'finance' | 'support' | 'ops') => {
    const row = await adminDb.staffUser.create({ data: { authProviderId: `google-oauth2|d23-${label}-${run}`, email: `d23-${label}-${run}@metacognixion.test`, name: `${label} ${run}`, role } });
    return { id: row.id, token: { authorization: `Bearer ${await h.staffTenant.mint(row.authProviderId, { mfa: true })}` } };
  };
  staff = { superAdmin: await make('sa', 'super_admin'), finance: await make('fin', 'finance'), support: await make('sup', 'support'), ops: await make('ops', 'ops') };
  financeCapBefore = (await adminDb.staffRoleLimit.findUnique({ where: { role: 'finance' }, select: { refundMaxCents: true } }))?.refundMaxCents;
  await setRate(RATE);
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (financeCapBefore !== undefined) await adminDb.staffRoleLimit.update({ where: { role: 'finance' }, data: { refundMaxCents: financeCapBefore } });
  await h?.app.get(RedisCache).del(redisKeys.fxCurrent(`e2e-${run}`), redisKeys.fxCurrent(`e2e-empty-${run}`));
  await h?.stop();
  await adminDb.$disconnect();
});

// =========================================================================== workspace currency

describe('workspace currency', () => {
  it('a new Canadian workspace starts in CAD and any other in USD, and the API says so everywhere', async () => {
    const make = async (country: string) => {
      const user = await createUser(`d23-new-${country}`);
      const created = await call('POST', '/workspaces', await auth(user.sub), { name: `D23 ${country} ${randomUUID().slice(0, 6)}`, country, timezone: country === 'CA' ? 'America/Toronto' : 'America/New_York' });
      expect(created.status).toBe(201);
      return { user, created };
    };
    const ca = await make('CA');
    const us = await make('US');
    expect(ca.created.body).toMatchObject({ currency: 'CAD', currency_locked: false, country: 'CA' });
    expect(us.created.body).toMatchObject({ currency: 'USD', currency_locked: false, country: 'US' });

    const caId = ca.created.body.id as string;
    expect((await call('GET', '/workspace', await auth(ca.user.sub, caId))).body).toMatchObject({ currency: 'CAD', currency_locked: false });
    expect((await call('GET', `/admin/customers/${caId}`, staff.finance.token)).body).toMatchObject({ currency: 'CAD', currency_locked: false });
    expect((await customerAudits(caId, 'workspace.created'))[0]?.metaJson).toMatchObject({ country: 'CA', currency: 'CAD' });
    // The trial is the same 20 credits in either currency, with no card and no purchase.
    expect(await balance(caId)).toBe(20);
    expect(await balance(us.created.body.id as string)).toBe(20);
  });

  it('owner and admin change it before the first purchase; editor and viewer cannot; an unknown currency is refused', async () => {
    const ws = await workspace('choose', 'CAD');
    const toUsd = await call('PATCH', '/workspace', ws.headers, { currency: 'USD' });
    expect(toUsd.status).toBe(200);
    expect(toUsd.body).toMatchObject({ currency: 'USD', currency_locked: false });

    const admin = await addMember(ws.workspaceId, `d23-admin-${run}`, 'admin');
    const back = await call('PATCH', '/workspace', await auth(admin.sub, ws.workspaceId), { currency: 'CAD' });
    expect(back.body).toMatchObject({ currency: 'CAD' });

    for (const role of ['editor', 'viewer'] as const) {
      const member = await addMember(ws.workspaceId, `d23-${role}-${run}`, role);
      const refused = await call('PATCH', '/workspace', await auth(member.sub, ws.workspaceId), { currency: 'USD' });
      expect(refused.status).toBe(403);
    }
    for (const currency of ['EUR', 'usd', '', 'CADX']) {
      expect((await call('PATCH', '/workspace', ws.headers, { currency })).status).toBe(422);
    }
    expect((await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } })).currency).toBe('CAD');
    const audit = await customerAudits(ws.workspaceId, 'workspace.updated');
    expect(audit.map((a) => (a.metaJson as { currency?: unknown }).currency)).toEqual([{ from: 'CAD', to: 'USD' }, { from: 'USD', to: 'CAD' }]);
  });

  it('the first successful purchase locks it: the customer gets 409 CURRENCY_LOCKED, and the database refuses the write too', async () => {
    const ws = await workspace('lock', 'CAD');
    stubCheckout();
    await buy(ws, 'CAD', 'starter');
    expect((await call('GET', '/workspace', ws.headers)).body).toMatchObject({ currency: 'CAD', currency_locked: true });

    const refused = await call('PATCH', '/workspace', ws.headers, { currency: 'USD' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CURRENCY_LOCKED');
    // Saving the currency it already has is not a change, and other settings still save.
    expect((await call('PATCH', '/workspace', ws.headers, { currency: 'CAD', name: `Locked ${run}` })).status).toBe(200);

    // Defence in depth: the customer's database role cannot do it whatever a service forgets.
    await expect(withWorkspace(ws.workspaceId, (db) => db.tenant.update({ where: { id: ws.workspaceId }, data: { currency: 'USD' } }))).rejects.toThrow(/locked after the first purchase/);
    expect((await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } })).currency).toBe('CAD');
    expect((await call('GET', `/admin/customers/${ws.workspaceId}`, staff.finance.token)).body).toMatchObject({ currency: 'CAD', currency_locked: true });
  });

  it('a pending, abandoned or unpaid checkout does not lock it', async () => {
    const ws = await workspace('pending', 'CAD');
    stubCheckout();
    const { purchaseId } = await startCheckout(ws, 'CAD', 'starter');
    expect((await call('GET', '/workspace', ws.headers)).body.currency_locked).toBe(false);
    await post(await sessionCompleted(purchaseId!, { payment_status: 'unpaid' }));
    expect((await call('PATCH', '/workspace', ws.headers, { currency: 'USD' })).status).toBe(200);
  });

  it('after the lock only staff change it: a reason is required, support cannot, finance can, and both audit logs record it', async () => {
    const ws = await workspace('staff', 'CAD');
    stubCheckout();
    await buy(ws, 'CAD', 'starter', { auto_topup: 'true', auto_topup_threshold: '15' });
    const path = `/admin/customers/${ws.workspaceId}/currency`;

    expect((await call('PUT', path, staff.finance.token, { currency: 'USD' })).status).toBe(422); // no reason code
    expect((await call('PUT', path, staff.finance.token, { currency: 'USD', reason_code: 'other' })).status).toBe(422); // "other" needs a note
    expect((await call('PUT', path, staff.finance.token, { ...reason, currency: 'EUR' })).status).toBe(422);
    expect((await call('PUT', path, staff.support.token, { ...reason, currency: 'USD' })).status).toBe(403);
    expect((await call('PUT', path, ws.headers, { ...reason, currency: 'USD' })).status).toBe(401); // a customer token is not a staff token
    expect((await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } })).currency).toBe('CAD');

    const changed = await call('PUT', path, staff.finance.token, { ...reason, currency: 'USD' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ currency: 'USD', currency_locked: true });

    const staffRows = await adminDb.staffAuditLog.findMany({ where: { action: 'customer.currency_changed', targetId: ws.workspaceId } });
    expect(staffRows).toHaveLength(1);
    expect(staffRows[0]).toMatchObject({ staffId: staff.finance.id, tenantId: ws.workspaceId, reasonCode: 'customer_request', note: 'd23 e2e' });
    expect(staffRows[0]!.beforeJson).toMatchObject({ currency: 'CAD' });
    expect(staffRows[0]!.afterJson).toMatchObject({ currency: 'USD' });
    const own = await customerAudits(ws.workspaceId, 'workspace.currency_changed');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ actorUserId: null });
    expect(own[0]!.metaJson).toMatchObject({ by: 'staff', from: 'CAD', to: 'USD', reason_code: 'customer_request' });

    // What was already charged keeps its currency.
    expect((await purchasesOf(ws.workspaceId)).map((p) => [p.currency, p.amountCents])).toEqual([['CAD', CAD_AT_RATE.starter]]);
    // The console shows what was sold in the currency it was sold in, not in the workspace's new one.
    const detail = (await call('GET', `/admin/customers/${ws.workspaceId}`, staff.finance.token)).body;
    expect(detail.currency).toBe('USD');
    expect(detail.lifetime_sales).toEqual([{ currency: 'CAD', amount_cents: CAD_AT_RATE.starter }]);
    expect(detail.lifetime_sales_cents).toBe(0);
    // Saying the same thing again changes nothing and audits nothing.
    expect((await call('PUT', path, staff.finance.token, { ...reason, currency: 'USD' })).status).toBe(200);
    expect(await adminDb.staffAuditLog.count({ where: { action: 'customer.currency_changed', targetId: ws.workspaceId } })).toBe(1);
  });

  it('CAD is not offered while no exchange rate is stored: 503 CURRENCY_UNAVAILABLE, for the customer and for staff', async () => {
    const ws = await workspace('norate', 'USD');
    boc.source = `e2e-empty-${run}`;
    try {
      const refused = await call('PATCH', '/workspace', ws.headers, { currency: 'CAD' });
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe('CURRENCY_UNAVAILABLE');
      const staffRefused = await call('PUT', `/admin/customers/${ws.workspaceId}/currency`, staff.finance.token, { ...reason, currency: 'CAD' });
      expect(staffRefused.body.code).toBe('CURRENCY_UNAVAILABLE');
      expect((await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } })).currency).toBe('USD');
    } finally {
      boc.source = `e2e-${run}`;
    }
  });
});

// =========================================================================== GET /pricing

describe('GET /pricing in the workspace currency', () => {
  const pricing = async (query = '') => (await h.app.inject({ method: 'GET', url: `/pricing${query}` })).json() as Record<string, unknown> & { packs: Array<{ id: string; price_cents: number; currency: string; credits: number }> };

  it('USD (or no currency) is the published price list', async () => {
    for (const query of ['', '?currency=USD', '?currency=usd']) {
      const body = await pricing(query);
      expect(body).toMatchObject({ currency: 'USD', base_currency: 'USD', fx: null, currency_unavailable: false });
      expect(Object.fromEntries(body.packs.map((p) => [p.id, p.price_cents]))).toMatchObject(USD);
    }
  });

  it('CAD is the USD list at the rate in force, each pack rounded to the nearest whole dollar, with the same credits', async () => {
    const [usd, cad] = [await pricing('?currency=USD'), await pricing('?currency=CAD')];
    expect(cad).toMatchObject({ currency: 'CAD', base_currency: 'USD', currency_unavailable: false, fx: { rate: RATE, source: `e2e-${run}` } });
    expect(Object.fromEntries(cad.packs.map((p) => [p.id, p.price_cents]))).toMatchObject(CAD_AT_RATE);
    expect(cad.packs.every((p) => p.currency === 'CAD' && p.price_cents % 100 === 0)).toBe(true);
    expect(cad.packs.map((p) => [p.id, p.credits])).toEqual(usd.packs.map((p) => [p.id, p.credits]));
    expect(Object.fromEntries(cad.packs.map((p) => [p.id, p.credits]))).toMatchObject(CREDITS);
    // Rates, rental, trial, expiry, grace and thresholds are credits: identical in both.
    for (const key of ['rates', 'recurring', 'wallet_policy'] as const) expect(cad[key]).toEqual(usd[key]);
  });

  it('an unsupported currency is a 422, not a silent USD', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/pricing?currency=EUR' })).statusCode).toBe(422);
  });

  it('with no rate stored CAD answers the USD list marked unavailable, never a USD figure labelled CAD', async () => {
    boc.source = `e2e-empty-${run}`;
    try {
      const body = await pricing('?currency=CAD');
      expect(body).toMatchObject({ currency: 'USD', fx: null, currency_unavailable: true });
      expect(body.packs.every((p) => p.currency === 'USD')).toBe(true);
    } finally {
      boc.source = `e2e-${run}`;
    }
  });

  it('the rounding rule is a setting: staff change the step in the console and the price follows, with no deploy', async () => {
    try {
      const saved = await call('PUT', '/admin/settings', staff.ops.token, { ...reason, cad_rounding_step_cents: 1 });
      expect(saved.status).toBe(200);
      expect((saved.body.source as Record<string, string>).cad_rounding_step_cents).toBe('console');
      expect((await pricing('?currency=CAD')).packs.find((p) => p.id === 'starter')?.price_cents).toBe(7_003); // 49 × 1.4291 = 70.0259
      await call('PUT', '/admin/settings', staff.ops.token, { ...reason, cad_rounding_step_cents: 100, cad_rounding_mode: 'up' });
      expect((await pricing('?currency=CAD')).packs.find((p) => p.id === 'starter')?.price_cents).toBe(7_100);
    } finally {
      const reset = await call('PUT', '/admin/settings', staff.ops.token, { ...reason, reset: ['cad_rounding_step_cents', 'cad_rounding_mode'] });
      expect(reset.status).toBe(200);
    }
    expect((await pricing('?currency=CAD')).packs.find((p) => p.id === 'starter')?.price_cents).toBe(CAD_AT_RATE.starter);
  });
});

// =========================================================================== checkout

describe('checkout charges the displayed price in the workspace currency', () => {
  it('USD: Stripe is asked for the published USD amount and the purchase row records it with no rate', async () => {
    const ws = await workspace('usd-checkout', 'USD');
    const session = stubCheckout();
    const { res, shown, purchaseId } = await startCheckout(ws, 'USD', 'growth');
    expect(res.status).toBe(201);
    expect(shown).toEqual({ amount: USD.growth, currency: 'USD' });
    expect(session).toHaveBeenCalledTimes(1);
    expect(session.mock.calls[0]![0]).toMatchObject({ purchaseId, amountCents: USD.growth, currency: 'USD', workspaceId: ws.workspaceId });
    const row = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId! } });
    expect(row).toMatchObject({ status: 'pending', amountCents: USD.growth, currency: 'USD', baseAmountCents: USD.growth, baseCurrency: 'USD', fxRate: null, fxRateId: null, fxRateDate: null, credits: CREDITS.growth });
  });

  it('CAD: Stripe is asked for the CAD amount in CAD, as inline price data, and the row records amount, currency and the rate used', async () => {
    const ws = await workspace('cad-checkout', 'CAD');
    const session = stubCheckout();
    const { res, shown, purchaseId } = await startCheckout(ws, 'CAD', 'growth');
    expect(res.status).toBe(201);
    expect(shown).toEqual({ amount: CAD_AT_RATE.growth, currency: 'CAD' });
    const input = session.mock.calls[0]![0];
    expect(input).toMatchObject({ purchaseId, amountCents: CAD_AT_RATE.growth, currency: 'CAD' });
    // Never a synced USD Price for a CAD charge: the amount would be the USD one.
    expect(input.stripePriceId).toBeUndefined();

    const row = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId! }, include: { fx: true } });
    expect(row).toMatchObject({ status: 'pending', amountCents: CAD_AT_RATE.growth, currency: 'CAD', baseAmountCents: USD.growth, baseCurrency: 'USD', credits: CREDITS.growth });
    expect(row.fxRate?.toFixed()).toBe(RATE);
    expect(row.fx).toMatchObject({ baseCurrency: 'USD', quoteCurrency: 'CAD', source: `e2e-${run}` });
    expect(row.fx?.rate.toFixed()).toBe(RATE);
    expect(row.fxRateDate?.toISOString().slice(0, 10)).toBe(row.fx?.observedOn.toISOString().slice(0, 10));
    expect((await customerAudits(ws.workspaceId, 'purchase.checkout_started'))[0]?.metaJson).toMatchObject({ amount_cents: CAD_AT_RATE.growth, currency: 'CAD', base_amount_cents: USD.growth, fx_rate: RATE });
  });

  it.each(['starter', 'growth', 'scale', 'pro'] as const)('%s: the amount sent to Stripe is exactly the amount GET /pricing displayed, in both currencies', async (packId) => {
    for (const currency of ['USD', 'CAD'] as const) {
      const ws = await workspace(`match-${packId}-${currency}`, currency);
      const session = stubCheckout();
      const { res, shown } = await startCheckout(ws, currency, packId);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('checkout'); // US$999 / CA$1,428 is under the US$1,000 review limit in both
      expect(shown.amount).toBe(currency === 'USD' ? USD[packId] : CAD_AT_RATE[packId]);
      expect(session.mock.calls[0]![0]).toMatchObject({ amountCents: shown.amount, currency: shown.currency });
      vi.restoreAllMocks();
    }
  });

  it('a paid CAD purchase grants the pack’s credits once; a replayed webhook grants nothing more', async () => {
    const ws = await workspace('cad-paid', 'CAD');
    stubCheckout();
    const { purchaseId } = await startCheckout(ws, 'CAD', 'growth');
    expect(await balance(ws.workspaceId)).toBe(0);
    const event = await sessionCompleted(purchaseId!);
    expect((await post(event)).statusCode).toBe(200);
    expect(await balance(ws.workspaceId)).toBe(CREDITS.growth);
    expect((await post(event)).statusCode).toBe(204); // the same event again
    // …and the same payment under a new event id (Stripe redelivers under one id, but a second event must not credit either).
    await post({ ...event, id: `evt_${randomUUID().replace(/-/g, '')}` });
    expect(await balance(ws.workspaceId)).toBe(CREDITS.growth);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'purchase' } })).toBe(1);
    expect(await adminDb.creditLot.count({ where: { tenantId: ws.workspaceId, purchaseId: purchaseId! } })).toBe(1);
    const row = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId! } });
    expect(row).toMatchObject({ status: 'paid', amountCents: CAD_AT_RATE.growth, currency: 'CAD' });
    expect((await customerAudits(ws.workspaceId, 'purchase.completed'))).toHaveLength(1);
    expect((await customerAudits(ws.workspaceId, 'purchase.completed'))[0]!.metaJson).toMatchObject({ amount_cents: CAD_AT_RATE.growth, currency: 'CAD', fx_rate: RATE, credits: CREDITS.growth });
  });

  it('the same pack grants the same credits, lot expiry and plan tier whether it was paid in USD or CAD', async () => {
    const usd = await workspace('same-usd', 'USD');
    const cad = await workspace('same-cad', 'CAD');
    stubCheckout();
    for (const packId of ['starter', 'scale'] as const) {
      await buy(usd, 'USD', packId);
      await buy(cad, 'CAD', packId);
    }
    expect(await balance(usd.workspaceId)).toBe(CREDITS.starter + CREDITS.scale);
    expect(await balance(cad.workspaceId)).toBe(await balance(usd.workspaceId));
    const lots = async (id: string) => (await adminDb.creditLot.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'asc' } })).map((l) => l.creditsTotal.toNumber());
    expect(await lots(cad.workspaceId)).toEqual(await lots(usd.workspaceId));
    const tenant = (id: string) => adminDb.tenant.findUniqueOrThrow({ where: { id }, select: { planTier: true, concurrencyCap: true, kbAllowance: true } });
    expect(await tenant(cad.workspaceId)).toEqual(await tenant(usd.workspaceId));
    expect(await tenant(cad.workspaceId)).toMatchObject({ planTier: 'scale', concurrencyCap: 5, kbAllowance: 3 });
    // 12 months, in either currency.
    const months = (lot: { createdAt: Date; expiresAt: Date }) => (lot.expiresAt.getUTCFullYear() - lot.createdAt.getUTCFullYear()) * 12 + lot.expiresAt.getUTCMonth() - lot.createdAt.getUTCMonth();
    for (const lot of await adminDb.creditLot.findMany({ where: { tenantId: { in: [usd.workspaceId, cad.workspaceId] } } })) expect(months(lot)).toBe(12);
  });

  it.each([
    ['the right amount in the wrong currency', { currency: 'usd' }],
    ['the USD amount in CAD', { amount_total: USD.starter }],
    ['one cent less', { amount_total: CAD_AT_RATE.starter - 1 }],
  ])('refuses to credit when Stripe collected %s', async (_name, over) => {
    const ws = await workspace('mismatch', 'CAD');
    stubCheckout();
    const { purchaseId } = await startCheckout(ws, 'CAD', 'starter');
    await post(await sessionCompleted(purchaseId!, over));
    expect(await balance(ws.workspaceId)).toBe(0);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId! } })).status).toBe('pending');
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
  });

  it('an unpaid or expired session grants nothing', async () => {
    const ws = await workspace('unpaid', 'CAD');
    stubCheckout();
    const { purchaseId } = await startCheckout(ws, 'CAD', 'starter');
    await post(await sessionCompleted(purchaseId!, { payment_status: 'unpaid' }));
    expect(await balance(ws.workspaceId)).toBe(0);
    const expired = await sessionCompleted(purchaseId!, { status: 'expired', payment_status: 'unpaid' });
    await post({ ...expired, type: 'checkout.session.expired' });
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId! } })).status).toBe('abandoned');
    expect(await balance(ws.workspaceId)).toBe(0);
  });

  it('refuses a CAD checkout with 503 CURRENCY_UNAVAILABLE when no rate is stored: no purchase, no Stripe call', async () => {
    const ws = await workspace('cad-norate', 'CAD');
    const session = stubCheckout();
    boc.source = `e2e-empty-${run}`;
    try {
      const res = await call('POST', '/wallet/checkout', ws.headers, { pack_id: 'starter', expected_amount_cents: CAD_AT_RATE.starter, expected_currency: 'CAD' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CURRENCY_UNAVAILABLE');
    } finally {
      boc.source = `e2e-${run}`;
    }
    expect(session).not.toHaveBeenCalled();
    expect(await purchasesOf(ws.workspaceId)).toHaveLength(0);
  });

  it('the first paid purchase decides the currency when it was changed while the Checkout tab was open', async () => {
    const ws = await workspace('race', 'CAD');
    stubCheckout();
    const { purchaseId } = await startCheckout(ws, 'CAD', 'starter');
    expect((await call('PATCH', '/workspace', ws.headers, { currency: 'USD' })).status).toBe(200); // still allowed: nothing is paid
    await post(await sessionCompleted(purchaseId!));
    expect(await balance(ws.workspaceId)).toBe(CREDITS.starter);
    expect((await call('GET', '/workspace', ws.headers)).body).toMatchObject({ currency: 'CAD', currency_locked: true });
    expect((await customerAudits(ws.workspaceId, 'workspace.currency_set_by_purchase'))[0]?.metaJson).toMatchObject({ from: 'USD', to: 'CAD', purchase_id: purchaseId });
  });
});

// =========================================================================== PRICE_CHANGED

describe('PRICE_CHANGED', () => {
  it('a new rate between the page and the click: 409 with the latest price, no Stripe call, no purchase, no credits; confirming the new price goes through', async () => {
    const ws = await workspace('changed', 'CAD');
    const session = stubCheckout();
    const before = await shownPrice('CAD', 'starter');
    expect(before.amount).toBe(CAD_AT_RATE.starter);
    await setRate('1.3500'); // CA$66.15 → CA$66
    try {
      const refused = await call('POST', '/wallet/checkout', ws.headers, { pack_id: 'starter', expected_amount_cents: before.amount, expected_currency: 'CAD' });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PRICE_CHANGED');
      expect(refused.body.fields).toEqual([
        { field: 'expected_amount_cents', message: '6600' },
        { field: 'expected_currency', message: 'CAD' },
      ]);
      expect(session).not.toHaveBeenCalled();
      expect(await purchasesOf(ws.workspaceId)).toHaveLength(0);
      expect(await balance(ws.workspaceId)).toBe(0);
      expect(await customerAudits(ws.workspaceId, 'purchase.checkout_started')).toHaveLength(0);

      // The customer reviews the new price and confirms it.
      const after = await shownPrice('CAD', 'starter');
      expect(after.amount).toBe(6_600);
      const ok = await call('POST', '/wallet/checkout', ws.headers, { pack_id: 'starter', expected_amount_cents: after.amount, expected_currency: 'CAD' });
      expect(ok.status).toBe(201);
      expect(session.mock.calls[0]![0]).toMatchObject({ amountCents: 6_600, currency: 'CAD' });
      const row = await adminDb.purchase.findUniqueOrThrow({ where: { id: ok.body.purchase_id as string } });
      expect(row.amountCents).toBe(6_600);
      expect(row.fxRate?.toFixed()).toBe('1.35');
    } finally {
      await setRate(RATE);
    }
  });

  it('once checkout has begun the amount is fixed: a rate that moves afterwards changes neither the charge nor the credits', async () => {
    const ws = await workspace('fixed', 'CAD');
    stubCheckout();
    const { purchaseId } = await startCheckout(ws, 'CAD', 'starter');
    await setRate('1.3500');
    try {
      const row = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId! } });
      expect(row.amountCents).toBe(CAD_AT_RATE.starter);
      expect(row.fxRate?.toFixed()).toBe(RATE);
      await post(await sessionCompleted(purchaseId!)); // Stripe collected the CA$70 the session was made for
      expect(await balance(ws.workspaceId)).toBe(CREDITS.starter);
      const paid = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId! } });
      expect(paid).toMatchObject({ status: 'paid', amountCents: CAD_AT_RATE.starter });
      expect(paid.fxRate?.toFixed()).toBe(RATE);
    } finally {
      await setRate(RATE);
    }
  });

  it('a CAD checkout that does not say what was shown is PRICE_CHANGED, never a blind charge', async () => {
    const ws = await workspace('blind', 'CAD');
    const session = stubCheckout();
    const res = await call('POST', '/wallet/checkout', ws.headers, { pack_id: 'starter' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRICE_CHANGED');
    expect(session).not.toHaveBeenCalled();
    expect(await purchasesOf(ws.workspaceId)).toHaveLength(0);
  });

  it('the wrong currency or a made-up amount is PRICE_CHANGED; a malformed one is a 422', async () => {
    const ws = await workspace('wrong', 'CAD');
    const session = stubCheckout();
    for (const body of [
      { expected_amount_cents: CAD_AT_RATE.starter, expected_currency: 'USD' },
      { expected_amount_cents: USD.starter, expected_currency: 'CAD' },
      { expected_amount_cents: 1, expected_currency: 'CAD' },
    ]) {
      const res = await call('POST', '/wallet/checkout', ws.headers, { pack_id: 'starter', ...body });
      expect(res.body.code).toBe('PRICE_CHANGED');
    }
    for (const body of [{ expected_amount_cents: 70.5 }, { expected_amount_cents: -7_000 }, { expected_amount_cents: 0 }, { expected_currency: 'EUR' }]) {
      expect((await call('POST', '/wallet/checkout', ws.headers, { pack_id: 'starter', ...body })).status).toBe(422);
    }
    expect(session).not.toHaveBeenCalled();
    expect(await purchasesOf(ws.workspaceId)).toHaveLength(0);
  });

  it('a USD checkout from a client that states no price still works, and a stated USD price is checked too', async () => {
    const ws = await workspace('usd-legacy', 'USD');
    const session = stubCheckout();
    expect((await call('POST', '/wallet/checkout', ws.headers, { pack_id: 'starter' })).status).toBe(201);
    expect(session.mock.calls[0]![0]).toMatchObject({ amountCents: USD.starter, currency: 'USD' });
    const stale = await call('POST', '/wallet/checkout', ws.headers, { pack_id: 'starter', expected_amount_cents: 3_900, expected_currency: 'USD' });
    expect(stale.body.code).toBe('PRICE_CHANGED');
    expect(stale.body.fields).toEqual([{ field: 'expected_amount_cents', message: '4900' }, { field: 'expected_currency', message: 'USD' }]);
  });
});

// =========================================================================== auto top-up

describe('auto top-up in the workspace currency', () => {
  /** A workspace that bought Starter with "keep my card" ticked, which switches auto top-up on at 60 credits. */
  async function withTopup(label: string, currency: 'USD' | 'CAD') {
    const ws = await workspace(label, currency);
    stubCheckout();
    vi.spyOn(stripe, 'savedPaymentMethod').mockResolvedValue({ payment_method_id: `pm_${label}_${run}`, card_last4: '4242' });
    await buy(ws, currency, 'starter', { auto_topup: 'true', auto_topup_threshold: '60' });
    return ws;
  }

  /** Stripe's answer to the off-session charge. Installed before any debit: a debit fires the top-up listener. */
  function chargeStub(status = 'succeeded', failure: { code?: string; message?: string; currency?: string } = {}) {
    const created: PaymentIntentFacts[] = [];
    const spy = vi.spyOn(stripe, 'createOffSessionPaymentIntent').mockImplementation(async (input) => {
      const facts: PaymentIntentFacts = {
        id: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        status,
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        metadata: { kind: 'auto_topup', workspace_id: input.workspaceId, purchase_id: input.purchaseId, pack_id: input.packId, env: stripe.config.env },
        failure_code: failure.code ?? null,
        failure_message: failure.message ?? null,
      };
      created.push(facts);
      return facts;
    });
    return { spy, created };
  }

  /** 150 → 50 credits: under the threshold of 60. */
  const drain = (workspaceId: string, credits = 100) => wallet.debit(workspaceId, { credits, reason: 'call', refType: 'call', refId: `call_${randomUUID()}` });
  /** Long enough for the ledger listener's own evaluation to have finished. */
  const listenerSettled = () => new Promise((resolve) => setTimeout(resolve, 500));
  const topupOf = async (workspaceId: string) => (await purchasesOf(workspaceId)).find((p) => p.isAutoTopup);

  const intentEvent = (type: string, intent: { id: string; amount: number; currency: string; metadata: Record<string, string> }, status = 'succeeded') =>
    stripeEvent(type, { ...intent, object: 'payment_intent', status, customer: null, payment_method: 'pm_x', last_payment_error: null });

  it.each([
    ['USD', USD.starter],
    ['CAD', CAD_AT_RATE.starter],
  ] as const)('%s: charges the saved card the pack’s price in that currency, credits only when Stripe confirms, and never twice', async (currency, amount) => {
    const ws = await withTopup(`topup-${currency}`, currency);
    const settings = AutoTopupService.parse((await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } })).autoTopupJson);
    // Opted in at checkout, in the currency that checkout was paid in.
    expect(settings).toMatchObject({ enabled: true, pack_id: 'starter', threshold: 60, currency, card_last4: '4242' });

    const { spy, created } = chargeStub();
    await drain(ws.workspaceId);
    await drain(ws.workspaceId, 1); // two debits in a row are one charge
    await waitFor('the top-up attempt', async () => (created.length ? created : null));
    await listenerSettled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ amountCents: amount, currency, paymentMethodId: settings!.payment_method_id, packId: 'starter' });

    const pending = (await topupOf(ws.workspaceId))!;
    expect(pending).toMatchObject({ status: 'pending', amountCents: amount, currency, baseAmountCents: USD.starter, baseCurrency: 'USD', credits: CREDITS.starter });
    expect(pending.fxRate?.toFixed() ?? null).toBe(currency === 'CAD' ? RATE : null);
    // The create call said "succeeded" and still granted nothing.
    expect(await balance(ws.workspaceId)).toBe(49);

    const intent = created[0]!;
    const succeeded = intentEvent('payment_intent.succeeded', { id: intent.id, amount: intent.amount, currency: intent.currency, metadata: intent.metadata as Record<string, string> });
    await post(succeeded);
    expect(await balance(ws.workspaceId)).toBe(49 + CREDITS.starter);
    await post(succeeded);
    await post({ ...succeeded, id: `evt_${randomUUID().replace(/-/g, '')}` });
    expect(await balance(ws.workspaceId)).toBe(49 + CREDITS.starter);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'topup' } })).toBe(1);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('paid');
  });

  it('refuses to credit a top-up Stripe took in another currency than the purchase', async () => {
    const ws = await withTopup('topup-mismatch', 'CAD');
    const { created } = chargeStub('processing');
    await drain(ws.workspaceId);
    await waitFor('the top-up attempt', async () => (created.length ? created : null));
    await listenerSettled();
    const pending = (await topupOf(ws.workspaceId))!;
    const intent = created[0]!;
    await post(intentEvent('payment_intent.succeeded', { id: intent.id, amount: CAD_AT_RATE.starter, currency: 'usd', metadata: intent.metadata as Record<string, string> }));
    expect(await balance(ws.workspaceId)).toBe(50);
    expect(await adminDb.purchase.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: 'pending', failureReason: 'mismatch' });
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'topup' } })).toBe(0);
  });

  it('a declined card grants nothing', async () => {
    const ws = await withTopup('topup-declined', 'CAD');
    const { created } = chargeStub('requires_payment_method', { code: 'insufficient_funds', message: 'Your card has insufficient funds.' });
    await drain(ws.workspaceId);
    await waitFor('the top-up attempt', async () => (created.length ? created : null));
    await waitFor('the declined top-up to be closed', async () => ((await topupOf(ws.workspaceId))?.status === 'abandoned' ? true : null));
    expect(await topupOf(ws.workspaceId)).toMatchObject({ status: 'abandoned', failureReason: 'insufficient_funds', currency: 'CAD', amountCents: CAD_AT_RATE.starter });
    expect(await balance(ws.workspaceId)).toBe(50);
  });

  it('is never charged in a currency the customer did not switch it on in: a staff currency change turns it off, and saving it on again agrees to the new one', async () => {
    const ws = await withTopup('topup-switch', 'CAD');
    const { spy } = chargeStub();

    // The mismatch alone is enough to stop a charge…
    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { currency: 'USD' } });
    await drain(ws.workspaceId);
    await listenerSettled();
    expect(await topups.evaluate(ws.workspaceId, 'schedule')).toEqual({ outcome: 'skipped', reason: 'currency_mismatch' });
    expect(spy).not.toHaveBeenCalled();
    // Back to CAD, with the threshold under the balance so nothing is due while staff act.
    await adminDb.tenant.update({
      where: { id: ws.workspaceId },
      data: { currency: 'CAD', autoTopupJson: { enabled: true, pack_id: 'starter', threshold: 10, payment_method_id: 'pm_switch', card_last4: '4242', currency: 'CAD' } as Prisma.InputJsonValue },
    });

    // …and the staff change switches it off, audited on the workspace.
    expect((await call('PUT', `/admin/customers/${ws.workspaceId}/currency`, staff.finance.token, { ...reason, currency: 'USD' })).status).toBe(200);
    const after = AutoTopupService.parse((await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } })).autoTopupJson);
    expect(after).toMatchObject({ enabled: false, currency: 'CAD' });
    expect((await customerAudits(ws.workspaceId, 'auto_topup.disabled'))[0]?.metaJson).toMatchObject({ by: 'staff', because: 'currency_changed' });
    expect(await topups.evaluate(ws.workspaceId, 'schedule')).toEqual({ outcome: 'skipped', reason: 'disabled' });
    expect(spy).not.toHaveBeenCalled();
    expect(await purchasesOf(ws.workspaceId)).toHaveLength(1);

    // The customer switches it back on: that is their agreement to USD.
    const on = await call('PUT', '/wallet/auto-topup', ws.headers, { enabled: true, pack_id: 'starter', threshold: 10 });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, currency: 'USD' });
  });

  it('stays opt-in: a workspace that never ticked "keep my card" is never charged, however low the balance', async () => {
    const ws = await workspace('topup-optout', 'CAD');
    stubCheckout();
    await buy(ws, 'CAD', 'starter');
    const { spy } = chargeStub();
    await drain(ws.workspaceId, 150);
    await listenerSettled();
    expect(await topups.evaluate(ws.workspaceId, 'schedule')).toEqual({ outcome: 'skipped', reason: 'disabled' });
    expect((await call('PUT', '/wallet/auto-topup', ws.headers, { enabled: true, pack_id: 'starter', threshold: 60 })).body.code).toBe('NO_PAYMENT_METHOD');
    expect(spy).not.toHaveBeenCalled();
    expect(await balance(ws.workspaceId)).toBe(0);
  });

  it('with no rate stored a CAD top-up is skipped, not charged at a guessed price', async () => {
    const ws = await withTopup('topup-norate', 'CAD');
    const { spy } = chargeStub();
    boc.source = `e2e-empty-${run}`;
    try {
      await drain(ws.workspaceId);
      await listenerSettled();
      expect(await topups.evaluate(ws.workspaceId, 'schedule')).toEqual({ outcome: 'skipped', reason: 'currency_unavailable' });
    } finally {
      boc.source = `e2e-${run}`;
    }
    expect(spy).not.toHaveBeenCalled();
    expect(await topupOf(ws.workspaceId)).toBeUndefined();
  });
});

// =========================================================================== refunds

describe('refunds', () => {
  /** Stripe refund ids are unique per refund, so the stub's are too (`refunds.stripe_refund_id` is unique). */
  const refundStub = (id: string) => vi.spyOn(stripe, 'refundPaymentIntent').mockImplementation(async () => ({ id: `${id}_${randomUUID().slice(0, 8)}`, status: 'succeeded' }));

  it('a CAD purchase is refunded in CAD: Stripe is asked for the CAD cents on the original payment, and the credits come back out', async () => {
    const ws = await workspace('refund-cad', 'CAD');
    stubCheckout();
    const purchaseId = await buy(ws, 'CAD', 'growth');
    const paid = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
    const spy = refundStub(`re_cad_${run}`);
    vi.spyOn(stripe, 'findRefund').mockResolvedValue(null);

    const res = await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.finance.token, { ...reason, idempotency_key: randomUUID() });
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    // The refund names the PaymentIntent, so Stripe returns the money in the currency it took it in.
    expect(spy.mock.calls[0]![0]).toMatchObject({ paymentIntentId: paid.stripePaymentIntent, amountCents: CAD_AT_RATE.growth });
    expect(res.body).toMatchObject({ status: 'refunded', currency: 'CAD', amount_cents: CAD_AT_RATE.growth, refunded_cents: CAD_AT_RATE.growth, refundable_cents: 0, base_amount_cents: USD.growth, fx_rate: RATE });
    expect(await balance(ws.workspaceId)).toBe(0);
    const after = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId }, include: { refunds: true } });
    // The purchase keeps what it was: amount, currency and rate are history.
    expect(after).toMatchObject({ status: 'refunded', amountCents: CAD_AT_RATE.growth, currency: 'CAD' });
    expect(after.fxRate?.toFixed()).toBe(RATE);
    expect(after.refunds).toHaveLength(1);
    expect(after.refunds[0]).toMatchObject({ amountCents: CAD_AT_RATE.growth, status: 'succeeded' });
    expect(after.refunds[0]!.creditsReversed.toNumber()).toBe(CREDITS.growth);
  });

  it('a USD purchase is refunded in USD, as before', async () => {
    const ws = await workspace('refund-usd', 'USD');
    stubCheckout();
    const purchaseId = await buy(ws, 'USD', 'growth');
    const spy = refundStub(`re_usd_${run}`);
    vi.spyOn(stripe, 'findRefund').mockResolvedValue(null);
    const res = await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.finance.token, { ...reason, amount_cents: 4_470, idempotency_key: randomUUID() });
    expect(res.status).toBe(201);
    expect(spy.mock.calls[0]![0]).toMatchObject({ amountCents: 4_470 });
    expect(res.body).toMatchObject({ status: 'paid', currency: 'USD', refunded_cents: 4_470, refundable_cents: USD.growth - 4_470, fx_rate: null });
    expect(await balance(ws.workspaceId)).toBe(CREDITS.growth - 150); // 500 × 4470 / 14900
  });

  it('cannot exceed what the purchase has left, in its own currency', async () => {
    const ws = await workspace('refund-over', 'CAD');
    stubCheckout();
    const purchaseId = await buy(ws, 'CAD', 'starter');
    const spy = refundStub(`re_over_${run}`);
    const over = await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.superAdmin.token, { ...reason, amount_cents: CAD_AT_RATE.starter + 1, idempotency_key: randomUUID() });
    expect(over.status).toBe(422);
    expect(spy).not.toHaveBeenCalled();
    expect(await balance(ws.workspaceId)).toBe(CREDITS.starter);
  });

  it('the role’s USD cap is converted at the purchase’s own rate: US$500 is CA$714.55 for a purchase made at 1.4291, even after the rate moves', async () => {
    await adminDb.staffRoleLimit.update({ where: { role: 'finance' }, data: { refundMaxCents: 50_000 } });
    const ws = await workspace('refund-cap', 'CAD');
    stubCheckout();
    const purchaseId = await buy(ws, 'CAD', 'pro'); // CA$1,428.00 at 1.4291
    const spy = refundStub(`re_cap_${run}`);
    vi.spyOn(stripe, 'findRefund').mockResolvedValue(null);
    await setRate('1.3000'); // today US$500 would be CA$650.00; this purchase is still judged at 1.4291
    try {
      const over = await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.finance.token, { ...reason, amount_cents: 71_456, idempotency_key: randomUUID() });
      expect(over.status).toBe(403);
      expect(over.body.code).toBe('STAFF_LIMIT_EXCEEDED');
      expect(over.body.message).toContain("714.55 CAD (500.00 USD at this purchase's rate)");
      expect(spy).not.toHaveBeenCalled();
      expect(await balance(ws.workspaceId)).toBe(CREDITS.pro);

      const atCap = await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.finance.token, { ...reason, amount_cents: 71_455, idempotency_key: randomUUID() });
      expect(atCap.status).toBe(201);
      expect(spy.mock.calls[0]![0]).toMatchObject({ amountCents: 71_455 });
      // The cap is per purchase: one more cent on the same purchase is past it.
      const more = await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.finance.token, { ...reason, amount_cents: 1, idempotency_key: randomUUID() });
      expect(more.body.code).toBe('STAFF_LIMIT_EXCEEDED');
      // A super admin has no cap in any currency.
      expect((await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.superAdmin.token, { ...reason, amount_cents: 1, idempotency_key: randomUUID() })).status).toBe(201);
    } finally {
      await setRate(RATE);
    }
  });

  it('a refund Stripe refuses moves no credits; the same key retried refunds once', async () => {
    const ws = await workspace('refund-fail', 'CAD');
    stubCheckout();
    const purchaseId = await buy(ws, 'CAD', 'starter');
    const key = randomUUID();
    vi.spyOn(stripe, 'findRefund').mockResolvedValue(null);
    const spy = vi.spyOn(stripe, 'refundPaymentIntent').mockRejectedValueOnce(new Error('stripe is down')).mockResolvedValue({ id: `re_retry_${run}`, status: 'succeeded' });

    const failed = await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.superAdmin.token, { ...reason, idempotency_key: key });
    expect(failed.status).toBe(503);
    expect(await balance(ws.workspaceId)).toBe(CREDITS.starter);
    expect((await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId } })).status).toBe('paid');
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'refund' } })).toBe(0);

    const retried = await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.superAdmin.token, { ...reason, idempotency_key: key });
    expect(retried.status).toBe(201);
    expect(await balance(ws.workspaceId)).toBe(0);
    // A duplicate of the succeeded request answers the same refund and asks Stripe nothing.
    const calls = spy.mock.calls.length;
    const again = await call('POST', `/admin/purchases/${purchaseId}/refund`, staff.superAdmin.token, { ...reason, idempotency_key: key });
    expect(again.status).toBe(201);
    expect(spy.mock.calls.length).toBe(calls);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'refund' } })).toBe(1);
    expect(await adminDb.refund.count({ where: { purchaseId } })).toBe(1);
  });
});

// =========================================================================== the exchange rate (admin)

describe('the exchange rate in the console', () => {
  it('GET /admin/pricing/fx shows the USD base and derived CAD price of every pack, the rate in force, the last refresh and the configuration', async () => {
    // Two more business days of this test's own, so the history asserted below does not lean on earlier cases.
    await setRate('1.4200');
    await setRate(RATE);
    const res = await call('GET', '/admin/pricing/fx', staff.support.token);
    expect(res.status).toBe(200);
    const body = res.body as { packs: Array<{ pack_id: string; base_price_cents: number; base_currency: string; derived_price_cents: number | null; credits: number }>; history: Array<{ rate: string }> } & Record<string, unknown>;
    expect(body).toMatchObject({
      base_currency: 'USD',
      quote_currency: 'CAD',
      in_force: { rate: RATE, source: `e2e-${run}`, series: 'FXUSDCAD' },
      settings: { fx_source: 'bank_of_canada', fx_refresh_interval_hours: 24, rounding: { step_cents: 100, mode: 'nearest' } },
    });
    expect(typeof body.last_refresh_at).toBe('string');
    expect(typeof body.next_refresh_due_at).toBe('string');
    for (const id of ['starter', 'growth', 'scale', 'pro'] as const) {
      expect(body.packs.find((p) => p.pack_id === id)).toMatchObject({ base_price_cents: USD[id], base_currency: 'USD', derived_price_cents: CAD_AT_RATE[id], credits: CREDITS[id] });
    }
    // Every rate this run published is still there: history, newest first.
    expect(body.history.length).toBeGreaterThanOrEqual(3);
    expect(body.history.slice(0, 2).map((r) => r.rate)).toEqual([RATE, '1.42']);
    // What the console shows as the CAD price is what GET /pricing shows the customer.
    for (const id of ['starter', 'growth', 'scale', 'pro'] as const) expect((await shownPrice('CAD', id)).amount).toBe(body.packs.find((p) => p.pack_id === id)!.derived_price_cents);
  });

  it('refresh now: needs a reason, is finance’s or a super admin’s, is audited, and a failure keeps the rate and alerts operations', async () => {
    expect((await call('POST', '/admin/pricing/fx/refresh', staff.finance.token, {})).status).toBe(422);
    expect((await call('POST', '/admin/pricing/fx/refresh', staff.support.token, reason)).status).toBe(403);
    expect((await call('POST', '/admin/pricing/fx/refresh', staff.ops.token, reason)).status).toBe(403);

    const current = (await fx.current())!;
    vi.spyOn(boc, 'recent').mockResolvedValueOnce([{ observedOn: current.observedOn, rate: current.rate }]);
    const same = await call('POST', '/admin/pricing/fx/refresh', staff.finance.token, reason);
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ outcome: 'unchanged', error: null, fx: { in_force: { rate: RATE } } });

    await h.app.get(RedisCache).del(redisKeys.fxAlert('refresh_failed'));
    const alertsBefore = h.alerts.alerts.filter((a) => a.kind === 'fx_refresh_failed').length;
    vi.spyOn(boc, 'recent').mockRejectedValueOnce(new Error('the exchange-rate source answered 503'));
    const failed = await call('POST', '/admin/pricing/fx/refresh', staff.finance.token, reason);
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ outcome: 'failed', error: 'the exchange-rate source answered 503', fx: { in_force: { rate: RATE } } });
    expect((await fx.current())?.rate).toBe(RATE);
    expect((await shownPrice('CAD', 'starter')).amount).toBe(CAD_AT_RATE.starter);
    expect(h.alerts.alerts.filter((a) => a.kind === 'fx_refresh_failed').length).toBe(alertsBefore + 1);

    // Each refresh is a request row written before the source is asked, then its outcome.
    const rows = await adminDb.staffAuditLog.findMany({ where: { action: { startsWith: 'fx.' }, staffId: staff.finance.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['fx.refresh_requested', 'fx.refreshed', 'fx.refresh_requested', 'fx.refresh_failed']);
    expect(rows.filter((r) => r.action !== 'fx.refresh_requested').map((r) => (r.afterJson as { outcome: string }).outcome)).toEqual(['unchanged', 'failed']);
    // The next good answer clears the incident.
    vi.spyOn(boc, 'recent').mockResolvedValueOnce([{ observedOn: current.observedOn, rate: current.rate }]);
    await fx.refresh();
  });

  it('the hourly tick refreshes once per configured interval and stores each business day once', async () => {
    const current = (await fx.current())!;
    const recent = vi.spyOn(boc, 'recent').mockResolvedValue([{ observedOn: current.observedOn, rate: current.rate }]);
    const rowsBefore = await adminDb.exchangeRate.count({ where: { source: `e2e-${run}` } });
    // Just refreshed: not due.
    expect((await fx.refreshIfDue()).outcome).toBe('not_due');
    expect(recent).not.toHaveBeenCalled();
    // A day later: due, and the same business day again is one row, not two.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000 + 60_000);
    expect((await fx.refreshIfDue(tomorrow)).outcome).toBe('unchanged');
    expect((await fx.refreshIfDue(tomorrow)).outcome).toBe('not_due');
    expect(recent).toHaveBeenCalledTimes(1);
    expect(await adminDb.exchangeRate.count({ where: { source: `e2e-${run}` } })).toBe(rowsBefore);
    // Put "last refreshed" back to now for whatever runs next.
    await adminDb.exchangeRate.updateMany({ where: { source: `e2e-${run}`, confirmedAt: { gt: new Date() } }, data: { confirmedAt: new Date() } });
  });

  it('exchange_rates is invisible to the customer database role', async () => {
    const ws = await workspace('rls', 'CAD');
    await expect(withWorkspace(ws.workspaceId, (db) => db.exchangeRate.findMany())).rejects.toThrow();
    expect(Prisma.Decimal).toBeDefined();
  });
});
