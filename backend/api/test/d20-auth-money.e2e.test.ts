import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import { TERMS_VERSION } from '@portal/schemas';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountEventsService, Auth0ManagementService } from '../src/modules/auth';
import { JobQueues } from '../src/modules/jobs';
import { BillingService, StripeGateway } from '../src/modules/billing';
import type { CheckoutSessionFacts } from '../src/modules/billing/stripe.gateway';
import { PlatformConfigService } from '../src/modules/config';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { WalletService } from '../src/modules/wallet';
import { WebhookProcessingService } from '../src/modules/webhooks';
import { type D5Harness, type TestUser, addMember, createUser, createWorkspace, startD5Harness } from './d5-fixtures';
import { paidWorkspace } from './d6-fixtures';

/*
 * ADR 0036 — the §6.2, §6.3 and §17 sign-in and money-protection rules, against real
 * Postgres and Redis and the real guards, with only Stripe, the voice platform and the
 * Auth0 Management API stubbed at their gateways. No security decision is mocked: the
 * tokens are signed by a stand-in tenant and verified by the production verifier, the
 * MFA rule reads the real ledger and tenant row, the review lives in the real tables.
 *
 *   §6.2   MFA for owners/admins once auto top-up is on or the balance is over 1,000
 *   §6.2   a backend token lives at most 15 minutes
 *   §17    a first purchase over $1,000 waits for staff before anything is charged
 *   §6.2   sign-in and purchase events in the workspace audit log
 *   §6.3   Terms accepted per version, verification resend limits, the invitee's address
 *   §6.2   email verification before a test call or a purchase (audit A-10)
 */

let h: D5Harness;
let stripe: StripeGateway;
let config: PlatformConfigService;
let auth0: Auth0ManagementService;
let run = '';
let staff: Record<'finance' | 'support' | 'readOnly', { token: string; id: string }>;

const SECRET = process.env.AUTH0_CUSTOMER_ACTION_SECRET ?? 'e2e-auth0-shared-secret-long-enough';
const reason = { reason_code: 'fraud_suspected', note: 'd20 e2e' } as const;

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & { code?: string } }> {
  const res = await h.app.inject({
    method: method as 'GET',
    url: path,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown> & { code?: string }) : {} };
}

async function as(sub: string, workspaceId?: string, claims: Parameters<D5Harness['customerTenant']['mint']>[1] = {}): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await h.customerTenant.mint(sub, claims)}`, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) };
}

async function setAutoTopup(workspaceId: string, enabled: boolean) {
  await adminDb.tenant.update({
    where: { id: workspaceId },
    data: { autoTopupJson: { enabled, pack_id: 'growth', threshold: 50, payment_method_id: 'pm_d20', card_last4: '4242' } as Prisma.InputJsonValue },
  });
}

async function grant(workspaceId: string, credits: number) {
  await h.app.get(WalletService).grant(workspaceId, {
    credits,
    reason: 'adjustment',
    expiresAt: new Date(Date.now() + 365 * 86_400_000),
    refType: 'test',
    refId: randomUUID(),
  });
}

/** A pack as the published config would answer it, at a price the test chooses. */
async function packPricedAt(priceCents: number, id = 'pro') {
  const real = await config.purchasablePack(id);
  if (!real) throw new Error(`pack ${id} is not in the seeded config`);
  return { ...real, pack: { ...real.pack, price_cents: priceCents } };
}

function stubStripeSession() {
  return vi.spyOn(stripe, 'createCheckoutSession').mockImplementation(async (input) => ({ id: `cs_test_${randomUUID().replace(/-/g, '')}`, url: `https://checkout.stripe.test/${input.purchaseId}` }));
}

function paidSession(purchase: { id: string; tenantId: string; amountCents: number; currency: string }, sessionId: string): CheckoutSessionFacts {
  return {
    id: sessionId,
    payment_status: 'paid',
    status: 'complete',
    client_reference_id: purchase.id,
    metadata: { purchase_id: purchase.id, workspace_id: purchase.tenantId, env: stripe.config.env },
    customer: null,
    payment_intent: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    invoice: null,
    amount_total: purchase.amountCents,
    currency: purchase.currency.toLowerCase(),
  };
}

async function audits(tenantId: string, action: string) {
  return adminDb.auditLog.findMany({ where: { tenantId, action }, orderBy: { createdAt: 'asc' } });
}

beforeAll(async () => {
  h = await startD5Harness({ workers: false });
  stripe = h.app.get(StripeGateway);
  config = h.app.get(PlatformConfigService);
  auth0 = h.app.get(Auth0ManagementService);
  run = randomUUID().slice(0, 8);
  const make = async (label: string, role: 'finance' | 'support' | 'read_only') => {
    const row = await adminDb.staffUser.create({ data: { authProviderId: `google-oauth2|d20-${label}-${run}`, email: `d20-${label}-${run}@metacognixion.test`, name: label, role } });
    return { id: row.id, token: await h.staffTenant.mint(row.authProviderId, { mfa: true }) };
  };
  staff = { finance: await make('fin', 'finance'), support: await make('sup', 'support'), readOnly: await make('ro', 'read_only') };
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  // The checkouts here have stub sessions Stripe never saw. Left `pending`, they would sit in
  // front of the other suites' fixtures in the oldest-first reconcile sweep (billing.e2e).
  await adminDb.purchase.updateMany({ where: { status: 'pending', tenant: { name: { startsWith: 'd20-' } } }, data: { status: 'abandoned' } });
  await h?.stop();
  await adminDb.$disconnect();
});

// =========================================================================== §6.2 MFA rule

describe('§6.2 MFA for owners and admins once money is at risk', () => {
  const patch = (ws: string, headers: Record<string, string>) => call('PATCH', '/workspace', headers, { name: `Renamed ${randomUUID().slice(0, 6)}` });

  it('binds nobody while no money is at risk: the owner changes things without a second factor', async () => {
    const ws = await createWorkspace(`d20-calm-${run}`);
    const res = await patch(ws.workspaceId, await as(ws.sub, ws.workspaceId));
    expect(res.status).toBe(200);
    const workspace = await call('GET', '/workspace', await as(ws.sub, ws.workspaceId));
    expect(workspace.body.mfa).toEqual({ required: false, satisfied: false, reasons: [] });
  });

  it('auto top-up on: owner and admin refused on a change, editors unaffected, reads still open', async () => {
    const ws = await createWorkspace(`d20-topup-${run}`);
    const admin = await addMember(ws.workspaceId, `d20-admin-${run}`, 'admin');
    const editor = await addMember(ws.workspaceId, `d20-editor-${run}`, 'editor');
    const viewer = await addMember(ws.workspaceId, `d20-viewer-${run}`, 'viewer');
    await setAutoTopup(ws.workspaceId, true);

    const owner = await patch(ws.workspaceId, await as(ws.sub, ws.workspaceId));
    expect(owner.status).toBe(403);
    expect(owner.body.code).toBe('MFA_REQUIRED');
    expect((await patch(ws.workspaceId, await as(admin.sub, ws.workspaceId))).body.code).toBe('MFA_REQUIRED');

    // An editor is never asked; the onboarding pointer is an editor-and-up write.
    const editorWrite = await call('POST', '/workspace/onboarding-step', await as(editor.sub, ws.workspaceId), { step: 2 });
    expect(editorWrite.status).toBe(201);
    // A viewer is refused by the role matrix first, exactly as before.
    expect((await patch(ws.workspaceId, await as(viewer.sub, ws.workspaceId))).body.code).toBe('FORBIDDEN_ROLE');

    const read = await call('GET', '/workspace', await as(ws.sub, ws.workspaceId));
    expect(read.status).toBe(200);
    expect(read.body.mfa).toEqual({ required: true, satisfied: false, reasons: ['auto_topup'] });
    const editorRead = await call('GET', '/workspace', await as(editor.sub, ws.workspaceId));
    expect(editorRead.body.mfa).toEqual({ required: false, satisfied: false, reasons: [] });
  });

  it('a session that passed a second factor is let through, and says so', async () => {
    const ws = await createWorkspace(`d20-mfa-ok-${run}`);
    await setAutoTopup(ws.workspaceId, true);
    const headers = await as(ws.sub, ws.workspaceId, { mfa: true });
    expect((await patch(ws.workspaceId, headers)).status).toBe(200);
    expect((await call('GET', '/workspace', headers)).body.mfa).toEqual({ required: true, satisfied: true, reasons: ['auto_topup'] });
  });

  it('a balance over 1,000 alone binds; exactly 1,000 does not', async () => {
    const ws = await createWorkspace(`d20-balance-${run}`);
    await grant(ws.workspaceId, 1000);
    expect((await patch(ws.workspaceId, await as(ws.sub, ws.workspaceId))).status).toBe(200);
    await grant(ws.workspaceId, 1);
    const refused = await patch(ws.workspaceId, await as(ws.sub, ws.workspaceId));
    expect(refused.body.code).toBe('MFA_REQUIRED');
    expect((await call('GET', '/workspace', await as(ws.sub, ws.workspaceId))).body.mfa).toMatchObject({ required: true, reasons: ['balance'] });
  });

  it('both conditions give both reasons, and either one alone is enough', async () => {
    const ws = await createWorkspace(`d20-both-${run}`);
    await grant(ws.workspaceId, 2000);
    await setAutoTopup(ws.workspaceId, true);
    expect((await call('GET', '/workspace', await as(ws.sub, ws.workspaceId))).body.mfa).toMatchObject({ reasons: ['auto_topup', 'balance'] });
    await setAutoTopup(ws.workspaceId, false);
    expect((await patch(ws.workspaceId, await as(ws.sub, ws.workspaceId))).body.code).toBe('MFA_REQUIRED');
  });

  it('a session already open when money comes to be at risk is refused from that moment — no bypass by an old token', async () => {
    const ws = await createWorkspace(`d20-existing-${run}`);
    const headers = await as(ws.sub, ws.workspaceId);
    expect((await patch(ws.workspaceId, headers)).status).toBe(200);
    await grant(ws.workspaceId, 5000);
    expect((await patch(ws.workspaceId, headers)).body.code).toBe('MFA_REQUIRED');
  });

  it('auto top-up can always be turned off without a factor, but turning it on needs one', async () => {
    const ws = await paidWorkspace(h.app, `d20-switch-${run}`, 'growth', { savedCard: true });
    const off = await call('PUT', '/wallet/auto-topup', await as(ws.sub, ws.workspaceId), { enabled: false });
    expect(off.status).toBe(200);
    const on = await call('PUT', '/wallet/auto-topup', await as(ws.sub, ws.workspaceId), { enabled: true, pack_id: 'growth', threshold: 50 });
    expect(on.status).toBe(403);
    expect(on.body.code).toBe('MFA_REQUIRED');
    const onWithFactor = await call('PUT', '/wallet/auto-topup', await as(ws.sub, ws.workspaceId, { mfa: true }), { enabled: true, pack_id: 'growth', threshold: 50 });
    expect(onWithFactor.status).toBe(200);
    expect(onWithFactor.body.enabled).toBe(true);
    // Now on: the owner without the factor can still switch it off, and nothing else.
    expect((await call('PUT', '/wallet/auto-topup', await as(ws.sub, ws.workspaceId), { enabled: false })).status).toBe(200);
  });

  it('an owner held up by the rule can still write to support', async () => {
    const ws = await createWorkspace(`d20-support-${run}`);
    await setAutoTopup(ws.workspaceId, true);
    const res = await call('POST', '/support/tickets', await as(ws.sub, ws.workspaceId), { subject: 'Cannot set up two-step', body: 'My phone is lost.' });
    expect(res.status).toBe(201);
  });

  it('a checkout that would charge a stored card into money-at-risk needs the factor first', async () => {
    const ws = await paidWorkspace(h.app, `d20-prospective-${run}`, 'growth', { savedCard: true });
    const session = stubStripeSession();
    const refused = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId), { pack_id: 'scale' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('MFA_REQUIRED');
    expect(session).not.toHaveBeenCalled();
    const ok = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId, { mfa: true }), { pack_id: 'scale' });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('checkout');
  });
});

// =========================================================================== §6.2 token lifetime

describe('§6.2 a backend token lives at most 15 minutes', () => {
  it('accepts a 14-minute-old token and refuses a 16-minute-old one with TOKEN_EXPIRED, however long its exp', async () => {
    const ws = await createWorkspace(`d20-age-${run}`);
    expect((await call('GET', '/workspace', await as(ws.sub, ws.workspaceId, { issuedAgoS: 14 * 60 }))).status).toBe(200);
    const old = await call('GET', '/workspace', await as(ws.sub, ws.workspaceId, { issuedAgoS: 16 * 60 }));
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('TOKEN_EXPIRED');
  });

  it('still refuses a token past its exp, and the staff namespace is unchanged', async () => {
    const ws = await createWorkspace(`d20-exp-${run}`);
    expect((await call('GET', '/workspace', await as(ws.sub, ws.workspaceId, { expired: true }))).body.code).toBe('INVALID_TOKEN');
    const staffOld = await call('GET', '/admin/purchase-reviews', { authorization: `Bearer ${await h.staffTenant.mint(`google-oauth2|d20-ro-${run}`, { mfa: true, issuedAgoS: 30 * 60 })}` });
    expect(staffOld.status).toBe(200);
  });
});

// =========================================================================== §17 first-purchase review

describe('§17 a first purchase over $1,000 waits for staff', () => {
  it('exactly $1,000 is not reviewed: it goes straight to Stripe', async () => {
    const ws = await createWorkspace(`d20-at-limit-${run}`);
    vi.spyOn(config, 'purchasablePack').mockResolvedValue(await packPricedAt(100_000));
    const session = stubStripeSession();
    const res = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId), { pack_id: 'pro' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('checkout');
    expect(session).toHaveBeenCalledTimes(1);
    expect(await audits(ws.workspaceId, 'purchase.checkout_started')).toHaveLength(1);
  });

  it('$1,000.01 opens a review: no Stripe session, a purchase in_review, an audit row, an ops alert; a retry joins it', async () => {
    const ws = await createWorkspace(`d20-review-${run}`);
    vi.spyOn(config, 'purchasablePack').mockResolvedValue(await packPricedAt(100_001));
    const session = stubStripeSession();
    const headers = await as(ws.sub, ws.workspaceId);

    const [a, b] = await Promise.all([
      call('POST', '/wallet/checkout', headers, { pack_id: 'pro' }),
      call('POST', '/wallet/checkout', headers, { pack_id: 'pro' }),
    ]);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ status: 'in_review', checkout_url: null });
    expect(b.body.purchase_id).toBe(a.body.purchase_id);
    const again = await call('POST', '/wallet/checkout', headers, { pack_id: 'pro' });
    expect(again.body.purchase_id).toBe(a.body.purchase_id);
    expect(session).not.toHaveBeenCalled();

    const purchases = await adminDb.purchase.findMany({ where: { tenantId: ws.workspaceId } });
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ status: 'in_review', amountCents: 100_001, stripeSessionId: null });
    const reviews = await adminDb.fraudReview.findMany({ where: { tenantId: ws.workspaceId } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'open', trigger: 'first_purchase_over_limit', purchaseId: purchases[0]!.id, amountCents: 100_001 });
    expect(await audits(ws.workspaceId, 'purchase.review_requested')).toHaveLength(1);
    expect(h.alerts.alerts.some((x) => x.kind === 'purchase_review_requested' && x.fields.purchase_id === purchases[0]!.id)).toBe(true);
  });

  it('staff approve with a reason: support and read-only cannot, finance can, once; the customer then pays that purchase', async () => {
    const ws = await createWorkspace(`d20-approve-${run}`);
    vi.spyOn(config, 'purchasablePack').mockResolvedValue(await packPricedAt(150_000));
    const asked = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId), { pack_id: 'pro' });
    const purchaseId = asked.body.purchase_id as string;
    const review = await adminDb.fraudReview.findFirstOrThrow({ where: { purchaseId } });

    const list = await call('GET', `/admin/purchase-reviews?status=open&tenant_id=${ws.workspaceId}`, { authorization: `Bearer ${staff.readOnly.token}` });
    expect(list.status).toBe(200);
    expect((list.body.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: review.id, amount_cents: 150_000, status: 'open', requested_by_email: ws.email });

    const path = `/admin/purchase-reviews/${review.id}/approve`;
    expect((await call('POST', path, { authorization: `Bearer ${staff.support.token}` }, reason)).body.code).toBe('FORBIDDEN_ROLE');
    expect((await call('POST', path, { authorization: `Bearer ${staff.readOnly.token}` }, reason)).body.code).toBe('FORBIDDEN_ROLE');
    expect((await call('POST', path, { authorization: `Bearer ${staff.finance.token}` }, {})).status).toBe(422);

    const approved = await call('POST', path, { authorization: `Bearer ${staff.finance.token}` }, reason);
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ status: 'approved', purchase_status: 'approved', reviewer_email: `d20-fin-${run}@metacognixion.test` });
    expect((await call('POST', path, { authorization: `Bearer ${staff.finance.token}` }, reason)).body.code).toBe('CONFLICT');

    const staffRows = await adminDb.staffAuditLog.findMany({ where: { action: 'purchase.review_approved', targetId: purchaseId } });
    expect(staffRows).toHaveLength(1);
    expect(staffRows[0]).toMatchObject({ staffId: staff.finance.id, reasonCode: 'fraud_suspected', tenantId: ws.workspaceId });
    const wsRows = await audits(ws.workspaceId, 'purchase.review_approved');
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0]!.metaJson).toMatchObject({ by: 'staff', review_id: review.id });
    expect(await adminDb.notification.count({ where: { dedupeKey: `purchase_review:${review.id}:${ws.userId}` } })).toBe(1);

    // The customer's next checkout of that pack at that price pays the approved purchase.
    const session = stubStripeSession();
    const pay = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId), { pack_id: 'pro' });
    expect(pay.status).toBe(201);
    expect(pay.body).toMatchObject({ status: 'checkout', purchase_id: purchaseId });
    expect(session).toHaveBeenCalledWith(expect.objectContaining({ purchaseId }));

    // Stripe confirms: credited once, audited once; a replayed webhook changes nothing.
    const purchase = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
    const facts = paidSession(purchase, purchase.stripeSessionId!);
    const billing = h.app.get(BillingService);
    expect((await billing.fulfil(facts)).outcome).toBe('credited');
    expect((await billing.fulfil(facts)).outcome).toBe('already_paid');
    expect(await audits(ws.workspaceId, 'purchase.completed')).toHaveLength(1);
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'purchase' } })).toBe(1);

    // No longer a first purchase: the next big one goes straight to Stripe.
    const later = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId, { mfa: true }), { pack_id: 'pro' });
    expect(later.body.status).toBe('checkout');
  });

  it('a rejected review charges nothing, cannot be paid by a stray session, and the customer may ask again', async () => {
    const ws = await createWorkspace(`d20-reject-${run}`);
    vi.spyOn(config, 'purchasablePack').mockResolvedValue(await packPricedAt(250_000));
    const asked = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId), { pack_id: 'pro' });
    const purchaseId = asked.body.purchase_id as string;
    const review = await adminDb.fraudReview.findFirstOrThrow({ where: { purchaseId } });
    const rejected = await call('POST', `/admin/purchase-reviews/${review.id}/reject`, { authorization: `Bearer ${staff.finance.token}` }, reason);
    expect(rejected.body).toMatchObject({ status: 'rejected', purchase_status: 'rejected' });
    expect(await audits(ws.workspaceId, 'purchase.review_rejected')).toHaveLength(1);

    const purchase = await adminDb.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
    const outcome = await h.app.get(BillingService).fulfil(paidSession(purchase, `cs_test_stray_${randomUUID().replace(/-/g, '')}`));
    expect(outcome.outcome).toBe('ignored');
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'purchase' } })).toBe(0);

    const again = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId), { pack_id: 'pro' });
    expect(again.body.status).toBe('in_review');
    expect(again.body.purchase_id).not.toBe(purchaseId);
  });

  it('backstop: a paid first purchase over the limit with no approval is not credited, and ops is paged', async () => {
    const ws = await createWorkspace(`d20-bypass-${run}`);
    const purchase = await adminDb.purchase.create({
      data: { tenantId: ws.workspaceId, packId: 'pro', amountCents: 300_000, currency: 'USD', credits: 9000, status: 'pending', stripeSessionId: `cs_test_${randomUUID().replace(/-/g, '')}` },
    });
    const outcome = await h.app.get(BillingService).fulfil(paidSession(purchase, purchase.stripeSessionId!));
    expect(outcome).toEqual({ outcome: 'ignored', reason: 'first purchase needs review' });
    expect(await adminDb.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({ status: 'pending', failureReason: 'review_required' });
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
    expect(h.alerts.alerts.some((x) => x.kind === 'purchase_review_bypassed' && x.fields.purchase_id === purchase.id)).toBe(true);
  });
});

// =========================================================================== §6.2 audit log

describe('§6.2 sign-in and purchase events in the workspace audit log', () => {
  const logs = (headers: Record<string, string>, body: unknown) => call('POST', '/webhooks/auth/logs', headers, body);

  it('refuses a log stream without the shared secret', async () => {
    expect((await logs({}, [])).status).toBe(401);
    expect((await logs({ authorization: 'Bearer wrong' }, [])).status).toBe(401);
  });

  it('audits a sign-in, a failed one and a failed second factor once each, in every workspace of the person, and nothing else', async () => {
    const a = await createWorkspace(`d20-logs-${run}`);
    const second = await adminDb.tenant.create({ data: { name: `d20 second ${run}`, country: 'CA' } });
    await adminDb.membership.create({ data: { tenantId: second.id, userId: a.userId, role: 'viewer' } });
    const id = (type: string) => `${type}-${run}-${randomUUID().slice(0, 6)}`;
    const batch = [
      { log_id: id('s'), data: { type: 's', date: new Date().toISOString(), ip: '203.0.113.7', user_id: a.sub, connection: 'Username-Password-Authentication' } },
      { log_id: id('fp'), data: { type: 'fp', ip: '198.51.100.4', user_id: a.sub } },
      { log_id: id('gd'), data: { type: 'gd_auth_failed', ip: '198.51.100.4', user_id: a.sub } },
      { log_id: id('tok'), data: { type: 'sertft', user_id: a.sub } },
      { log_id: id('nobody'), data: { type: 'fp', ip: '198.51.100.9', user_id: `auth0|nobody-${run}` } },
      { not: 'a log entry' },
    ];
    const res = await logs({ authorization: `Bearer ${SECRET}` }, batch);
    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(4);

    const processing = h.app.get(WebhookProcessingService);
    const stored = await adminDb.webhookEvent.findMany({ where: { provider: 'auth', externalId: { in: batch.map((b) => (b as { log_id?: string }).log_id ?? '') } } });
    for (const row of stored) await processing.process(row.id);

    for (const tenantId of [a.workspaceId, second.id]) {
      expect((await audits(tenantId, 'auth.signed_in')).map((r) => r.ip)).toEqual(['203.0.113.7']);
      expect(await audits(tenantId, 'auth.sign_in_failed')).toHaveLength(1);
      expect(await audits(tenantId, 'auth.mfa_failed')).toHaveLength(1);
    }
    // A redelivered batch is all duplicates: no new rows.
    expect((await logs({ authorization: `Bearer ${SECRET}` }, batch)).body.stored).toBe(0);
    expect(await audits(a.workspaceId, 'auth.signed_in')).toHaveLength(1);
    // Nothing in the row is a secret.
    const row = (await audits(a.workspaceId, 'auth.signed_in'))[0]!;
    expect(Object.keys(row.metaJson as object).sort()).toEqual(['at', 'connection', 'event_id', 'log_type', 'strategy', 'user_agent']);
    expect(JSON.stringify(row.metaJson)).not.toContain(SECRET);
  });

  it('a brute-force block is lifted 15 minutes after it was set, once, and audited (ADR 0036 §8)', async () => {
    const ws = await createWorkspace(`d20-block-${run}`);
    const queues = h.app.get(JobQueues);
    const enqueue = vi.spyOn(queues, 'enqueueLiftSignInBlock').mockResolvedValue('queued');
    const blockedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const entry = { log_id: `limit_wc-${run}`, data: { type: 'limit_wc', date: blockedAt, ip: '198.51.100.4', user_id: ws.sub } };
    expect((await logs({ authorization: `Bearer ${SECRET}` }, [entry])).body.stored).toBe(1);
    const row = await adminDb.webhookEvent.findFirstOrThrow({ where: { provider: 'auth', externalId: entry.log_id } });
    await h.app.get(WebhookProcessingService).process(row.id);

    expect(await audits(ws.workspaceId, 'auth.sign_in_blocked')).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [job, delayMs] = enqueue.mock.calls[0]!;
    expect(job).toEqual({ logId: entry.log_id, sub: ws.sub, identifier: null });
    // Counted from the block: five of the fifteen minutes have already gone.
    expect(delayMs).toBeGreaterThan(9 * 60_000);
    expect(delayMs).toBeLessThanOrEqual(10 * 60_000);

    // The delayed half: lifted at the provider, audited once however often it runs.
    const lift = vi.spyOn(auth0, 'liftBruteForceBlocks').mockResolvedValue('applied');
    const events = h.app.get(AccountEventsService);
    expect(await events.liftSignInBlock(job)).toMatchObject({ outcome: 'unblocked' });
    await events.liftSignInBlock(job);
    expect(lift).toHaveBeenCalledWith(job);
    expect(await audits(ws.workspaceId, 'auth.sign_in_unblocked')).toHaveLength(1);
  });

  it('D6 Team shows each member’s last activity and whether two-factor is on', async () => {
    const ws = await createWorkspace(`d20-team-${run}`);
    const member = await addMember(ws.workspaceId, `d20-team-member-${run}`, 'editor');
    type Member = { user_id: string; last_active_at: string | null; mfa_enabled: boolean };
    const row = (members: unknown, id: string) => (members as Member[]).find((m) => m.user_id === id)!;
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 40 && !(await check()); i++) await new Promise((r) => setTimeout(r, 25));
    };

    // The owner's own request is activity; the member has never been seen. A token that
    // does not say whether a factor is enrolled changes nothing.
    await call('GET', '/members', await as(ws.sub, ws.workspaceId));
    await until(async () => (await adminDb.user.findUniqueOrThrow({ where: { id: ws.userId } })).lastActiveAt !== null);
    let list = (await call('GET', '/members', await as(ws.sub, ws.workspaceId))).body;
    expect(row(list, ws.userId).last_active_at).not.toBeNull();
    expect(row(list, ws.userId).mfa_enabled).toBe(false);
    expect(row(list, member.userId)).toMatchObject({ last_active_at: null, mfa_enabled: false });

    // The enrolled claim on the member's token is written through on their next request.
    await call('GET', '/workspace', await as(member.sub, ws.workspaceId, { mfaEnrolled: true }));
    await until(async () => (await adminDb.user.findUniqueOrThrow({ where: { id: member.userId } })).mfaEnabled);
    list = (await call('GET', '/members', await as(ws.sub, ws.workspaceId))).body;
    expect(row(list, member.userId).mfa_enabled).toBe(true);
    expect(row(list, member.userId).last_active_at).not.toBeNull();

    // A removal on the log stream lands before their next request.
    const entry = { log_id: `gd_unenroll-${run}`, data: { type: 'gd_unenroll', user_id: member.sub } };
    expect((await logs({ authorization: `Bearer ${SECRET}` }, [entry])).body.stored).toBe(1);
    const stored = await adminDb.webhookEvent.findFirstOrThrow({ where: { provider: 'auth', externalId: entry.log_id } });
    await h.app.get(WebhookProcessingService).process(stored.id);
    expect((await adminDb.user.findUniqueOrThrow({ where: { id: member.userId } })).mfaEnabled).toBe(false);
  });

  it('D6 turning two-factor off needs a fresh challenge and no workspace that still requires it', async () => {
    const ws = await createWorkspace(`d20-mfa-off-${run}`);
    await adminDb.user.update({ where: { id: ws.userId }, data: { mfaEnabled: true } });
    vi.spyOn(auth0, 'configured', 'get').mockReturnValue(true);
    const reset = vi.spyOn(auth0, 'resetMfa').mockResolvedValue('applied');
    const forget = vi.spyOn(auth0, 'forgetRememberedDevices').mockResolvedValue('applied');
    const now = Math.floor(Date.now() / 1000);
    const disable = async (claims: Parameters<D5Harness['customerTenant']['mint']>[1]) => call('POST', '/me/mfa/disable', await as(ws.sub, undefined, claims));

    // No factor, or one passed longer ago than the re-auth window: the portal asks for a challenge.
    expect((await disable({ mfa: false })).body.code).toBe('MFA_REQUIRED');
    expect((await disable({ mfa: true, mfaAt: now - 10 * 60 })).body.code).toBe('MFA_REQUIRED');
    expect((await disable({ mfa: true })).body.code).toBe('MFA_REQUIRED');

    // §6.2 still binds them in a workspace with auto top-up on.
    await setAutoTopup(ws.workspaceId, true);
    const still = await disable({ mfa: true, mfaAt: now });
    expect(still.status).toBe(409);
    expect(still.body.code).toBe('MFA_STILL_REQUIRED');
    expect(reset).not.toHaveBeenCalled();

    await setAutoTopup(ws.workspaceId, false);
    const off = await disable({ mfa: true, mfaAt: now });
    expect(off.status).toBe(201);
    expect(off.body).toEqual({ disabled: true });
    expect(reset).toHaveBeenCalledWith(ws.sub);
    expect(forget).toHaveBeenCalledWith(ws.sub);
    expect((await adminDb.user.findUniqueOrThrow({ where: { id: ws.userId } })).mfaEnabled).toBe(false);
    expect(await audits(ws.workspaceId, 'auth.mfa_disabled')).toHaveLength(1);
  });

  it('D6 lists the sign-in methods linked to the person, and says when it cannot ask', async () => {
    const ws = await createWorkspace(`d20-methods-${run}`);
    const unconfigured = await call('GET', '/me/sign-in-methods', await as(ws.sub));
    expect(unconfigured.status).toBe(200);
    expect(unconfigured.body).toEqual({ available: false, methods: [] });

    vi.spyOn(auth0, 'identities').mockResolvedValue([
      { provider: 'auth0', connection: 'Username-Password-Authentication' },
      { provider: 'google-oauth2', connection: 'google-oauth2' },
      { provider: 'windowslive', connection: 'windowslive' },
    ]);
    const listed = await call('GET', '/me/sign-in-methods', await as(ws.sub));
    expect(listed.body).toEqual({
      available: true,
      methods: [
        { method: 'password', connection: 'Username-Password-Authentication' },
        { method: 'google', connection: 'google-oauth2' },
        { method: 'microsoft', connection: 'windowslive' },
      ],
    });
  });

  it('a password change ends every older session, at the provider and here, and is audited', async () => {
    const ws = await createWorkspace(`d20-pwd-${run}`);
    const oldHeaders = await as(ws.sub, ws.workspaceId);
    expect((await call('GET', '/workspace', oldHeaders)).status).toBe(200);
    vi.spyOn(auth0, 'revokeSessions').mockResolvedValue('applied');
    const forget = vi.spyOn(auth0, 'forgetRememberedDevices').mockResolvedValue('applied');

    const occurredAt = new Date(Date.now() + 2_000).toISOString();
    const res = await call('POST', '/webhooks/auth', { 'x-action-secret': SECRET }, {
      event_type: 'user.password_changed',
      external_id: ws.sub,
      event_id: `password_changed|${ws.sub}|${occurredAt}`,
      occurred_at: occurredAt,
      email: ws.email,
      email_verified: true,
    });
    expect(res.status).toBe(200);
    const row = await adminDb.webhookEvent.findFirstOrThrow({ where: { provider: 'auth', externalId: `password_changed|${ws.sub}|${occurredAt}` } });
    await h.app.get(WebhookProcessingService).process(row.id);

    expect((await call('GET', '/workspace', oldHeaders)).body.code).toBe('INVALID_TOKEN');
    expect(forget).toHaveBeenCalledWith(ws.sub);
    expect(await audits(ws.workspaceId, 'auth.sessions_revoked')).toHaveLength(1);
  });

  it('forgetting remembered devices is the person’s own action, audited', async () => {
    const ws = await createWorkspace(`d20-devices-${run}`);
    vi.spyOn(auth0, 'configured', 'get').mockReturnValue(true);
    const forget = vi.spyOn(auth0, 'forgetRememberedDevices').mockResolvedValue('applied');
    const res = await call('POST', '/me/devices/forget', await as(ws.sub));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ forgotten: true });
    expect(forget).toHaveBeenCalledWith(ws.sub);
    expect(await audits(ws.workspaceId, 'auth.devices_forgotten')).toHaveLength(1);
  });
});

// =========================================================================== §6.3 A1 Terms

describe('§6.3 A1 the Terms are accepted explicitly, per version', () => {
  async function bare(label: string): Promise<TestUser> {
    const user = await createUser(label);
    await adminDb.user.update({ where: { id: user.userId }, data: { tosVersion: null, tosAcceptedAt: null } });
    return user;
  }

  it('no workspace, no join and no payment before the box is ticked; ticking it records who, which version and when', async () => {
    const user = await bare(`d20-terms-${run}`);
    const headers = await as(user.sub);
    const body = { name: `Terms ${run}`, country: 'CA', timezone: 'America/Toronto' };
    expect((await call('POST', '/workspaces', headers, body)).body.code).toBe('TERMS_NOT_ACCEPTED');

    const me = await call('GET', '/me', headers);
    expect(me.body.terms).toEqual({ current_version: TERMS_VERSION, accepted_version: null, accepted_at: null, required: true });
    expect((await call('POST', '/me/terms', headers, { version: '1999-01-01', accepted: true })).body.code).toBe('CONFLICT');
    expect((await call('POST', '/me/terms', headers, { version: TERMS_VERSION, accepted: false })).status).toBe(422);

    const accepted = await call('POST', '/me/terms', headers, { version: TERMS_VERSION, accepted: true });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ accepted_version: TERMS_VERSION, required: false });
    await call('POST', '/me/terms', headers, { version: TERMS_VERSION, accepted: true });
    expect(await adminDb.termsAcceptance.count({ where: { userId: user.userId } })).toBe(1);

    expect((await call('POST', '/workspaces', headers, body)).status).toBe(201);
  });

  it('a newer version asks again and keeps the record of the older one', async () => {
    const user = await bare(`d20-terms-v-${run}`);
    await adminDb.termsAcceptance.create({ data: { userId: user.userId, version: '2026-01-01', acceptedAt: new Date('2026-01-02') } });
    await adminDb.user.update({ where: { id: user.userId }, data: { tosVersion: '2026-01-01', tosAcceptedAt: new Date('2026-01-02') } });
    const headers = await as(user.sub);
    expect((await call('GET', '/me', headers)).body.terms).toMatchObject({ accepted_version: '2026-01-01', required: true });
    await call('POST', '/me/terms', headers, { version: TERMS_VERSION, accepted: true });
    const history = await adminDb.termsAcceptance.findMany({ where: { userId: user.userId }, orderBy: { acceptedAt: 'asc' } });
    expect(history.map((r) => r.version)).toEqual(['2026-01-01', TERMS_VERSION]);
  });

  it('checkout is refused to an owner who has not accepted the version in force', async () => {
    const ws = await createWorkspace(`d20-terms-pay-${run}`);
    await adminDb.user.update({ where: { id: ws.userId }, data: { tosVersion: '2026-01-01' } });
    const session = stubStripeSession();
    const res = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId), { pack_id: 'starter' });
    expect(res.body.code).toBe('TERMS_NOT_ACCEPTED');
    expect(session).not.toHaveBeenCalled();
    expect(await adminDb.purchase.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
  });
});

// =========================================================================== §6.3 A2 resend

describe('§6.3 A2 resend the verification email: 60-second cooldown, 5 an hour', () => {
  it('a verified session sends nothing', async () => {
    const user = await createUser(`d20-verified-${run}`);
    const send = vi.spyOn(auth0, 'sendVerificationEmail');
    const res = await call('POST', '/me/verification-email', await as(user.sub, undefined, { emailVerified: true }));
    expect(res.body).toEqual({ status: 'already_verified', retry_after_s: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('says so where there is no provider to send through, never a silent success', async () => {
    const user = await createUser(`d20-noprov-${run}`);
    const res = await call('POST', '/me/verification-email', await as(user.sub, undefined, { emailVerified: false }));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOT_CONFIGURED');
  });

  it('sends once per 60 seconds even to two tabs at once, at most 5 an hour, and asks the provider first', async () => {
    const user = await createUser(`d20-resend-${run}`);
    vi.spyOn(auth0, 'configured', 'get').mockReturnValue(true);
    const facts = vi.spyOn(auth0, 'getUser').mockResolvedValue({ email_verified: false, blocked: false });
    const send = vi.spyOn(auth0, 'sendVerificationEmail').mockResolvedValue('applied');
    const headers = await as(user.sub, undefined, { emailVerified: false });
    const cache = h.app.get(RedisCache);

    const [a, b] = await Promise.all([call('POST', '/me/verification-email', headers), call('POST', '/me/verification-email', headers)]);
    expect([a.status, b.status].sort()).toEqual([201, 429]);
    const refused = a.status === 429 ? a : b;
    expect(refused.body.code).toBe('RATE_LIMITED');
    expect(Number((refused.body.fields as Array<{ field: string; message: string }>)[0]!.message)).toBeGreaterThan(55);
    expect(send).toHaveBeenCalledTimes(1);

    for (let i = 2; i <= 5; i++) {
      await cache.del(redisKeys.verifyEmailCooldown(user.userId));
      expect((await call('POST', '/me/verification-email', headers)).status).toBe(201);
    }
    await cache.del(redisKeys.verifyEmailCooldown(user.userId));
    const sixth = await call('POST', '/me/verification-email', headers);
    expect(sixth.status).toBe(429);
    expect(send).toHaveBeenCalledTimes(5);

    facts.mockResolvedValue({ email_verified: true, blocked: false });
    expect((await call('POST', '/me/verification-email', headers)).body.status).toBe('already_verified');
  });
});

// =========================================================================== §6.3 A8 invite hint

describe('§6.3 A8 the invitee’s address is filled in before sign-in, and only theirs can accept', () => {
  async function inviteFor(workspaceId: string, invitedBy: string, email: string, over: Partial<{ expiresAt: Date; acceptedAt: Date }> = {}) {
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const { hashToken } = await import('../src/modules/workspaces/members.service');
    await adminDb.invite.create({
      data: { tenantId: workspaceId, email, role: 'editor', tokenHash: hashToken(token), invitedBy, expiresAt: over.expiresAt ?? new Date(Date.now() + 86_400_000), acceptedAt: over.acceptedAt ?? null },
    });
    return token;
  }

  it('answers the invited address to whoever holds the link, with no session, and one refusal for everything else', async () => {
    const ws = await createWorkspace(`d20-hint-${run}`);
    const email = `d20-invitee-${run}@example.test`;
    const token = await inviteFor(ws.workspaceId, ws.userId, email);
    expect(await call('GET', `/invites/${token}/hint`, {})).toEqual({ status: 200, body: { email } });

    const expired = await inviteFor(ws.workspaceId, ws.userId, `x-${email}`, { expiresAt: new Date(Date.now() - 1000) });
    const used = await inviteFor(ws.workspaceId, ws.userId, `y-${email}`, { acceptedAt: new Date() });
    for (const t of [expired, used, 'f'.repeat(64)]) {
      const res = await call('GET', `/invites/${t}/hint`, {});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVITE_INVALID');
    }
  });

  it('another signed-in address cannot accept it', async () => {
    const ws = await createWorkspace(`d20-hint-lock-${run}`);
    const token = await inviteFor(ws.workspaceId, ws.userId, `d20-locked-${run}@example.test`);
    const other = await createUser(`d20-other-${run}`);
    const res = await call('POST', `/invites/${token}/accept`, await as(other.sub));
    expect(res.body.code).toBe('INVITE_WRONG_EMAIL');
  });
});

// =========================================================================== §6.2 verified email (audit A-10)

describe('§6.2 email verification before a test call or a purchase (audit A-10)', () => {
  it('an unverified session cannot start a browser test call, and nothing is minted', async () => {
    const ws = await createWorkspace(`d20-unv-test-${run}`);
    const before = h.retell.calls.filter((c) => c.method === 'createWebCall').length;
    const agentId = randomUUID();
    const res = await call('POST', `/agents/${agentId}/test/web`, await as(ws.sub, ws.workspaceId, { emailVerified: false }), {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_UNVERIFIED');
    expect(h.retell.calls.filter((c) => c.method === 'createWebCall').length).toBe(before);
    // The same request verified gets past the gate to the agent lookup — the gate was the email.
    expect((await call('POST', `/agents/${agentId}/test/web`, await as(ws.sub, ws.workspaceId), {})).body.code).toBe('NOT_FOUND');
  });

  it('an unverified session cannot start a checkout: no purchase row, no Stripe call', async () => {
    const ws = await createWorkspace(`d20-unv-pay-${run}`);
    const session = stubStripeSession();
    const res = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId, { emailVerified: false }), { pack_id: 'starter' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_UNVERIFIED');
    expect(session).not.toHaveBeenCalled();
    expect(await adminDb.purchase.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
    const verified = await call('POST', '/wallet/checkout', await as(ws.sub, ws.workspaceId), { pack_id: 'starter' });
    expect(verified.status).toBe(201);
    expect(session).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================== §6.3 A7 switcher

describe('§6.3 A7 the switcher shows each workspace’s own balance', () => {
  it('lists every membership with that workspace’s balance, not the active one’s', async () => {
    const ws = await createWorkspace(`d20-switch-a-${run}`);
    const other = await adminDb.tenant.create({ data: { name: `d20 switch b ${run}`, country: 'US' } });
    await adminDb.membership.create({ data: { tenantId: other.id, userId: ws.userId, role: 'viewer' } });
    await grant(ws.workspaceId, 42);
    await grant(other.id, 1234.5);
    const res = await h.app.inject({ method: 'GET', url: '/workspaces', headers: await as(ws.sub) });
    const rows = res.json() as Array<{ id: string; role: string; balance: number | null }>;
    expect(rows.find((r) => r.id === ws.workspaceId)).toMatchObject({ role: 'owner', balance: 42 });
    expect(rows.find((r) => r.id === other.id)).toMatchObject({ role: 'viewer', balance: 1234.5 });
  });
});
