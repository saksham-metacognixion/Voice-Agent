import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StripeGateway } from '../src/modules/billing';
import { WalletService } from '../src/modules/wallet';
import { type D5Harness, startD5Harness } from './d5-fixtures';
import { paidWorkspace, type PaidWorkspace } from './d6-fixtures';

/*
 * D13 — SA9 Billing & finance (admin spec §4 SA9, §5.4, §11 P1).
 *
 * Against real Postgres and Redis, with only Stripe stubbed at the gateway:
 *   - the purchases list crosses workspaces, searches, filters and counts;
 *   - a refund goes to Stripe once, draws the credits back through the wallet as one
 *     `refund` ledger row, flips the purchase to `refunded` only when nothing is left,
 *     and lands two `staff_audit_log` rows plus the workspace's own audit row;
 *   - the console's idempotency key makes a repeat answer the same refund with no second
 *     Stripe call, and lets a failed attempt be retried on the same row;
 *   - amounts, states and `refund_max_cents` are enforced server-side, naming who could;
 *   - failed auto top-ups are listed, retried past the cooldown (credits still only from
 *     Stripe's confirmation) and switched off, all audited;
 *   - the revenue summary sums what the fixtures sold and refunded.
 */

let h: D5Harness;
let ws: PaidWorkspace;
let ws2: PaidWorkspace;
let staff: Record<
  'superAdmin' | 'ops' | 'finance' | 'support' | 'readOnly',
  { sub: string; id: string; token: string }
>;
let stripe: StripeGateway;
let supportLimitsBefore: { refundMaxCents: number | null } | null = null;
/** Stripe refund ids are unique per refund; the stubs must be too, or a second run collides on `refunds.stripe_refund_id`. */
let run = '';

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{
  status: number;
  body: Record<string, unknown> & { code?: string; message?: string };
}> {
  const res = await h.app.inject({
    method: method as 'GET',
    url: path,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

const reason = { reason_code: 'customer_request', note: 'd13 e2e' } as const;

async function audits(action: string, targetId: string) {
  return adminDb.staffAuditLog.findMany({
    where: { action, targetId },
    orderBy: { createdAt: 'asc' },
  });
}

async function balance(workspaceId: string): Promise<number> {
  return h.app.get(WalletService).rebuildBalance(workspaceId);
}

beforeAll(async () => {
  h = await startD5Harness({ workers: false });
  stripe = h.app.get(StripeGateway);
  run = randomUUID().slice(0, 8);
  const make = async (
    label: string,
    role: 'super_admin' | 'ops' | 'finance' | 'support' | 'read_only',
  ) => {
    const row = await adminDb.staffUser.create({
      data: {
        authProviderId: `google-oauth2|${label}-${run}`,
        email: `${label}-${run}@metacognixion.test`,
        name: `${label} ${run}`,
        role,
      },
    });
    return {
      sub: row.authProviderId,
      id: row.id,
      token: await h.staffTenant.mint(row.authProviderId, { mfa: true }),
    };
  };
  staff = {
    superAdmin: await make('sa', 'super_admin'),
    ops: await make('ops', 'ops'),
    finance: await make('fin', 'finance'),
    support: await make('sup', 'support'),
    readOnly: await make('ro', 'read_only'),
  };
  // Growth: $149.00 → 500 credits, with a card kept for auto top-up. Starter: $49.00 → 150 credits.
  ws = await paidWorkspace(h.app, `d13-${run}`, 'growth', { savedCard: true });
  ws2 = await paidWorkspace(h.app, `d13b-${run}`, 'starter');
  await adminDb.tenant.update({
    where: { id: ws.workspaceId },
    data: { name: `D13 Bakery ${run}`, onboardingCompletedAt: new Date(), onboardingStep: 7 },
  });
  supportLimitsBefore = await adminDb.staffRoleLimit.findUnique({
    where: { role: 'support' },
    select: { refundMaxCents: true },
  });
}, 60_000);

afterAll(async () => {
  if (supportLimitsBefore)
    await adminDb.staffRoleLimit.update({
      where: { role: 'support' },
      data: { refundMaxCents: supportLimitsBefore.refundMaxCents },
    });
  vi.restoreAllMocks();
  await h?.stop();
  await adminDb.$disconnect();
});

// --------------------------------------------------------------------------- list + detail

describe('GET /admin/purchases', () => {
  it('lists purchases across workspaces, newest first, with tenant, pack and what is refundable', async () => {
    const res = await call(
      'GET',
      `/admin/purchases?tenant_id=${ws.workspaceId}`,
      staff.readOnly.token,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const [row] = res.body.items as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      id: ws.purchaseId,
      tenant_id: ws.workspaceId,
      pack_id: 'growth',
      pack_name: 'Growth',
      amount_cents: 14_900,
      credits: 500,
      status: 'paid',
      refunded_cents: 0,
      refundable_cents: 14_900,
    });
    expect(row!.tenant_name).toMatch(/^D13 Bakery/);
  });

  it('searches by tenant name, purchase id and PaymentIntent id, and filters by status and dates', async () => {
    const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } });
    const purchase = await adminDb.purchase.findUniqueOrThrow({ where: { id: ws.purchaseId } });
    const ids = (res: { body: Record<string, unknown> }) =>
      (res.body.items as Array<{ id: string }>).map((p) => p.id);
    expect(
      ids(
        await call(
          'GET',
          `/admin/purchases?q=${encodeURIComponent(tenant.name)}`,
          staff.support.token,
        ),
      ),
    ).toEqual([ws.purchaseId]);
    expect(
      ids(await call('GET', `/admin/purchases?q=${ws.purchaseId}`, staff.support.token)),
    ).toEqual([ws.purchaseId]);
    expect(
      ids(
        await call(
          'GET',
          `/admin/purchases?q=${purchase.stripePaymentIntent}`,
          staff.support.token,
        ),
      ),
    ).toEqual([ws.purchaseId]);
    expect(
      ids(await call('GET', `/admin/purchases?q=${purchase.stripeSessionId}`, staff.support.token)),
    ).toEqual([ws.purchaseId]);
    const abandoned = await call(
      'GET',
      `/admin/purchases?tenant_id=${ws.workspaceId}&status=abandoned`,
      staff.support.token,
    );
    expect(abandoned.body.total).toBe(0);
    const topups = await call(
      'GET',
      `/admin/purchases?tenant_id=${ws.workspaceId}&is_auto_topup=true`,
      staff.support.token,
    );
    expect(topups.body.total).toBe(0);
    const future = await call(
      'GET',
      `/admin/purchases?tenant_id=${ws.workspaceId}&from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      staff.support.token,
    );
    expect(future.body.total).toBe(0);
    const recent = await call(
      'GET',
      `/admin/purchases?tenant_id=${ws.workspaceId}&from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`,
      staff.support.token,
    );
    expect(recent.body.total).toBe(1);
    const bad = await call('GET', '/admin/purchases?status=nope', staff.support.token);
    expect(bad.status).toBe(422);
  });

  it('answers the detail with the grant ledger row and the lot, and 404 for an unknown id', async () => {
    const res = await call('GET', `/admin/purchases/${ws.purchaseId}`, staff.readOnly.token);
    expect(res.status).toBe(200);
    expect(res.body.refunds).toEqual([]);
    const ledger = res.body.ledger as Array<Record<string, unknown>>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      reason: 'purchase',
      ref_type: 'purchase',
      ref_id: ws.purchaseId,
      delta: 500,
    });
    expect(res.body.lots as unknown[]).toHaveLength(1);
    expect(res.body.invoice).toBeNull();
    expect(
      (await call('GET', `/admin/purchases/${randomUUID()}`, staff.readOnly.token)).status,
    ).toBe(404);
    expect((await call('GET', '/admin/purchases/not-a-uuid', staff.readOnly.token)).status).toBe(
      404,
    );
  });
});

// --------------------------------------------------------------------------- refunds

describe('POST /admin/purchases/:id/refund', () => {
  it('refunds part of a purchase: one Stripe call, a proportional refund ledger row, the purchase stays paid, two audit rows', async () => {
    const before = await balance(ws.workspaceId);
    expect(before).toBe(500);
    const spy = vi
      .spyOn(stripe, 'refundPaymentIntent')
      .mockResolvedValue({ id: `re_partial_${run}`, status: 'succeeded' });
    const key = randomUUID();
    const res = await call(
      'POST',
      `/admin/purchases/${ws.purchaseId}/refund`,
      staff.finance.token,
      { ...reason, amount_cents: 4_900, idempotency_key: key },
    );
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      amountCents: 4_900,
      idempotencyKey: `refund-${key}`,
      reason: 'requested_by_customer',
    });
    expect(spy.mock.calls[0]![0].paymentIntentId).toMatch(/^pi_/);

    expect(res.body).toMatchObject({
      status: 'paid',
      refunded_cents: 4_900,
      refundable_cents: 10_000,
    });
    const refunds = res.body.refunds as Array<Record<string, unknown>>;
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      id: key,
      amount_cents: 4_900,
      credits_reversed: 164.43,
      status: 'succeeded',
      reason_code: 'customer_request',
      stripe_refund_id: `re_partial_${run}`,
    });
    expect((refunds[0]!.staff as Record<string, unknown>).email).toMatch(/^fin-/);

    // 500 × 4900 / 14900 = 164.43 credits drawn back, as one ledger row.
    const rows = await adminDb.creditLedger.findMany({
      where: { tenantId: ws.workspaceId, reason: 'refund' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refType: 'refund', refId: key });
    expect(rows[0]!.delta.toNumber()).toBe(-164.43);
    expect(await balance(ws.workspaceId)).toBe(335.57);
    expect((res.body.ledger as unknown[]).length).toBe(2);

    expect(await audits('purchase.refund_requested', key)).toHaveLength(1);
    const done = await audits('purchase.refunded', key);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      staffId: staff.finance.id,
      tenantId: ws.workspaceId,
      reasonCode: 'customer_request',
      note: 'd13 e2e',
    });
    expect(done[0]!.afterJson).toMatchObject({
      amount_cents: 4_900,
      credits_reversed: 164.43,
      stripe_refund_id: `re_partial_${run}`,
      purchase_status: 'paid',
    });
    const customerRow = await adminDb.auditLog.findFirst({
      where: { tenantId: ws.workspaceId, action: 'purchase.refunded' },
      orderBy: { createdAt: 'desc' },
    });
    expect(customerRow?.actorUserId).toBeNull();
    expect(customerRow?.metaJson).toMatchObject({
      by: 'staff',
      amount_cents: 4_900,
      credits_reversed: 164.43,
      full: false,
    });
    spy.mockRestore();
  });

  it('answers a repeat of the same idempotency key with the same refund and no second Stripe call', async () => {
    const spy = vi
      .spyOn(stripe, 'refundPaymentIntent')
      .mockResolvedValue({ id: `re_never_${run}_${randomUUID().slice(0, 8)}`, status: 'succeeded' });
    const existing = await adminDb.refund.findFirstOrThrow({
      where: { purchaseId: ws.purchaseId, status: 'succeeded' },
    });
    const res = await call(
      'POST',
      `/admin/purchases/${ws.purchaseId}/refund`,
      staff.finance.token,
      { ...reason, amount_cents: 4_900, idempotency_key: existing.id },
    );
    expect(res.status).toBe(201);
    expect(spy).not.toHaveBeenCalled();
    expect((res.body.refunds as unknown[]).length).toBe(1);
    expect(res.body.refunded_cents).toBe(4_900);
    expect(
      await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'refund' } }),
    ).toBe(1);
    // The same key on another purchase is refused.
    const other = await call(
      'POST',
      `/admin/purchases/${ws2.purchaseId}/refund`,
      staff.superAdmin.token,
      { ...reason, idempotency_key: existing.id },
    );
    expect(other.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('marks the row failed on a Stripe error (503, nothing reversed) and retries the same row with the same key', async () => {
    const key = randomUUID();
    const failing = vi
      .spyOn(stripe, 'refundPaymentIntent')
      .mockRejectedValueOnce(new Error('stripe is down'));
    const res = await call(
      'POST',
      `/admin/purchases/${ws.purchaseId}/refund`,
      staff.superAdmin.token,
      { reason_code: 'billing_error', amount_cents: 1_000, idempotency_key: key },
    );
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');
    const row = await adminDb.refund.findUniqueOrThrow({ where: { id: key } });
    expect(row.status).toBe('failed');
    expect(
      await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'refund' } }),
    ).toBe(1);
    expect(await balance(ws.workspaceId)).toBe(335.57);
    expect(await audits('purchase.refund_failed', key)).toHaveLength(1);
    expect(
      await adminDb.purchase.findUniqueOrThrow({ where: { id: ws.purchaseId } }),
    ).toMatchObject({ status: 'paid' });

    // Nothing reached Stripe the first time, so the lookup finds nothing to adopt.
    const lookup = vi.spyOn(stripe, 'findRefund').mockResolvedValue(null);
    failing.mockResolvedValueOnce({ id: `re_retry_${run}`, status: 'pending' });
    const retry = await call(
      'POST',
      `/admin/purchases/${ws.purchaseId}/refund`,
      staff.superAdmin.token,
      { reason_code: 'billing_error', amount_cents: 1_000, idempotency_key: key },
    );
    expect(retry.status).toBe(201);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(failing.mock.calls[1]![0]).toMatchObject({
      amountCents: 1_000,
      // review 28 Sep: a fresh key — Stripe would replay the stored failure under the old one.
      idempotencyKey: `refund-${key}-r1`,
      reason: 'duplicate',
    });
    expect(lookup).toHaveBeenCalledWith(expect.any(String), key);
    const after = await adminDb.refund.findUniqueOrThrow({ where: { id: key } });
    expect(after).toMatchObject({ status: 'succeeded', stripeRefundId: `re_retry_${run}` });
    // 500 × 1000 / 14900 = 33.56
    expect(after.creditsReversed.toNumber()).toBe(33.56);
    expect(
      await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'refund' } }),
    ).toBe(2);
    expect(await balance(ws.workspaceId)).toBe(302.01);
    expect(retry.body).toMatchObject({
      status: 'paid',
      refunded_cents: 5_900,
      refundable_cents: 9_000,
    });
    expect(await audits('purchase.refund_requested', key)).toHaveLength(2);
    expect(after.attempts).toBe(1);
    failing.mockRestore();
    lookup.mockRestore();
  });

  it('refuses an amount over what is left, a purchase that was never paid, and one with nothing to refund', async () => {
    const spy = vi
      .spyOn(stripe, 'refundPaymentIntent')
      .mockResolvedValue({ id: `re_never_${run}_${randomUUID().slice(0, 8)}`, status: 'succeeded' });
    const over = await call(
      'POST',
      `/admin/purchases/${ws.purchaseId}/refund`,
      staff.superAdmin.token,
      { ...reason, amount_cents: 9_001, idempotency_key: randomUUID() },
    );
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('VALIDATION_FAILED');
    expect((over.body.fields as Array<{ field: string }>)[0]!.field).toBe('amount_cents');

    const abandoned = await adminDb.purchase.create({
      data: {
        tenantId: ws.workspaceId,
        packId: 'growth',
        amountCents: 14_900,
        currency: 'USD',
        credits: 500,
        status: 'abandoned',
      },
    });
    const notPaid = await call(
      'POST',
      `/admin/purchases/${abandoned.id}/refund`,
      staff.superAdmin.token,
      { ...reason, idempotency_key: randomUUID() },
    );
    expect(notPaid.status).toBe(409);
    expect(notPaid.body.code).toBe('CONFLICT');

    const pending = await adminDb.purchase.create({
      data: {
        tenantId: ws.workspaceId,
        packId: 'growth',
        amountCents: 14_900,
        currency: 'USD',
        credits: 500,
        status: 'pending',
        stripeSessionId: `cs_test_${randomUUID().replace(/-/g, '')}`,
      },
    });
    expect(
      (
        await call('POST', `/admin/purchases/${pending.id}/refund`, staff.superAdmin.token, {
          ...reason,
          idempotency_key: randomUUID(),
        })
      ).status,
    ).toBe(409);

    const noPayment = await adminDb.purchase.create({
      data: {
        tenantId: ws.workspaceId,
        packId: 'growth',
        amountCents: 14_900,
        currency: 'USD',
        credits: 500,
        status: 'paid',
      },
    });
    const nothing = await call(
      'POST',
      `/admin/purchases/${noPayment.id}/refund`,
      staff.superAdmin.token,
      { ...reason, idempotency_key: randomUUID() },
    );
    expect(nothing.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    await adminDb.purchase.deleteMany({
      where: { id: { in: [abandoned.id, pending.id, noPayment.id] } },
    });
    spy.mockRestore();
  });

  it('enforces the route matrix and refund_max_cents, naming who could', async () => {
    const spy = vi
      .spyOn(stripe, 'refundPaymentIntent')
      .mockResolvedValue({ id: `re_never_${run}_${randomUUID().slice(0, 8)}`, status: 'succeeded' });
    const ro = await call(
      'POST',
      `/admin/purchases/${ws.purchaseId}/refund`,
      staff.readOnly.token,
      { ...reason, amount_cents: 100, idempotency_key: randomUUID() },
    );
    expect(ro.status).toBe(403);
    expect(ro.body.code).toBe('FORBIDDEN_ROLE');
    // Support's seed row says 0 = cannot refund at all.
    const cannot = await call(
      'POST',
      `/admin/purchases/${ws.purchaseId}/refund`,
      staff.support.token,
      { ...reason, amount_cents: 100, idempotency_key: randomUUID() },
    );
    expect(cannot.status).toBe(403);
    expect(cannot.body.code).toBe('STAFF_LIMIT_EXCEEDED');
    expect(cannot.body.message).toMatch(/cannot issue refunds/);

    // The cap is per purchase (review, 28 Sep): 59.00 is already refunded, so 20.00 more
    // is refused under a 70.00 cap even though it is well under it on its own.
    await adminDb.staffRoleLimit.update({
      where: { role: 'support' },
      data: { refundMaxCents: 7_000 },
    });
    const tooMuch = await call(
      'POST',
      `/admin/purchases/${ws.purchaseId}/refund`,
      staff.support.token,
      { ...reason, amount_cents: 2_000, idempotency_key: randomUUID() },
    );
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.code).toBe('STAFF_LIMIT_EXCEEDED');
    expect(tooMuch.body.message).toMatch(/up to 70\.00 per purchase/);
    expect(tooMuch.body.message).toMatch(/59\.00 already refunded/);
    expect(tooMuch.body.message).toMatch(/super admin|finance/);
    expect(spy).not.toHaveBeenCalled();
    // No row was claimed for a refused attempt.
    expect(await adminDb.refund.count({ where: { purchaseId: ws.purchaseId } })).toBe(2);

    const allowed = await call(
      'POST',
      `/admin/purchases/${ws.purchaseId}/refund`,
      staff.support.token,
      { ...reason, amount_cents: 500, idempotency_key: randomUUID() },
    );
    expect(allowed.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(allowed.body.refunded_cents).toBe(6_400);
    spy.mockRestore();
  });

  it('refunds a purchase in full by default: the purchase becomes refunded and every credit it granted is drawn back', async () => {
    const spy = vi
      .spyOn(stripe, 'refundPaymentIntent')
      .mockResolvedValue({ id: `re_full_${run}`, status: 'succeeded' });
    expect(await balance(ws2.workspaceId)).toBe(150);
    const key = randomUUID();
    const res = await call(
      'POST',
      `/admin/purchases/${ws2.purchaseId}/refund`,
      staff.superAdmin.token,
      { reason_code: 'fraud_suspected', note: 'chargeback risk', idempotency_key: key },
    );
    expect(res.status).toBe(201);
    expect(spy.mock.calls[0]![0]).toMatchObject({ amountCents: 4_900, reason: 'fraudulent' });
    expect(res.body).toMatchObject({
      status: 'refunded',
      refunded_cents: 4_900,
      refundable_cents: 0,
    });
    expect((res.body.refunds as Array<Record<string, unknown>>)[0]).toMatchObject({
      amount_cents: 4_900,
      credits_reversed: 150,
      status: 'succeeded',
    });
    expect(await balance(ws2.workspaceId)).toBe(0);
    expect(
      await adminDb.purchase.findUniqueOrThrow({ where: { id: ws2.purchaseId } }),
    ).toMatchObject({ status: 'refunded' });
    // Money is gone; the console types the amount and the API refuses a second one.
    const again = await call(
      'POST',
      `/admin/purchases/${ws2.purchaseId}/refund`,
      staff.superAdmin.token,
      { ...reason, idempotency_key: randomUUID() },
    );
    expect(again.status).toBe(409);
    expect(spy).toHaveBeenCalledTimes(1);
    // The refund is visible on the cross-workspace list and to the SA2 tab.
    const listed = await call(
      'GET',
      `/admin/purchases?tenant_id=${ws2.workspaceId}&status=refunded`,
      staff.readOnly.token,
    );
    expect(listed.body.total).toBe(1);
    spy.mockRestore();
  });
});

// --------------------------------------------------------------------------- auto top-ups

describe('failed auto top-ups', () => {
  let failedTopupId: string;

  it('lists an abandoned top-up with the tenant, the decline, the cooldown and the setting', async () => {
    await adminDb.tenant.update({
      where: { id: ws.workspaceId },
      data: {
        autoTopupJson: {
          enabled: true,
          pack_id: 'growth',
          threshold: 1_000,
          payment_method_id: 'pm_d13',
          card_last4: '4242',
        } as Prisma.InputJsonValue,
      },
    });
    const failed = await adminDb.purchase.create({
      data: {
        tenantId: ws.workspaceId,
        packId: 'growth',
        amountCents: 14_900,
        currency: 'USD',
        credits: 500,
        status: 'abandoned',
        isAutoTopup: true,
        failureReason: 'card_declined',
        stripePaymentIntent: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      },
    });
    failedTopupId = failed.id;
    await adminDb.alert.create({
      data: {
        tenantId: ws.workspaceId,
        type: 'auto_topup_failed',
        key: 'auto_topup_failed',
        sentAt: new Date(),
      },
    });

    const res = await call(
      'GET',
      `/admin/topups/failed?tenant_id=${ws.workspaceId}`,
      staff.readOnly.token,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const [row] = res.body.items as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      id: failed.id,
      status: 'abandoned',
      is_auto_topup: true,
      failure_reason: 'card_declined',
      auto_topup_enabled: true,
      card_last4: '4242',
      alert_open: true,
    });
    expect(row!.tenant_name).toMatch(/^D13 Bakery/);
    expect(new Date(row!.cooldown_until as string).getTime()).toBeGreaterThan(
      Date.now() + 5 * 3_600_000,
    );
    expect(row!.last_notified).not.toBeNull();
    // Cross-workspace, any role, and ordinary purchases are not in it.
    const all = await call('GET', '/admin/topups/failed', staff.support.token);
    expect((all.body.items as Array<{ id: string }>).some((r) => r.id === failed.id)).toBe(true);
    expect((all.body.items as Array<{ id: string }>).some((r) => r.id === ws.purchaseId)).toBe(
      false,
    );
  });

  it('retries the top-up now, past the cooldown, without granting credits before Stripe confirms; a second retry is in flight', async () => {
    const before = await balance(ws.workspaceId);
    const charge = vi
      .spyOn(stripe, 'createOffSessionPaymentIntent')
      .mockImplementation(async (input) => ({
        id: `pi_retry_${input.purchaseId.slice(0, 8)}`,
        status: 'succeeded',
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        metadata: {
          kind: 'auto_topup',
          workspace_id: input.workspaceId,
          purchase_id: input.purchaseId,
          pack_id: input.packId,
          env: 'test',
        },
        failure_code: null,
        failure_message: null,
      }));
    const ro = await call(
      'POST',
      `/admin/topups/${failedTopupId}/retry`,
      staff.readOnly.token,
      reason,
    );
    expect(ro.status).toBe(403);

    const res = await call('POST', `/admin/topups/${failedTopupId}/retry`, staff.ops.token, reason);
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('charged');
    expect(res.body.purchase_id).not.toBe(failedTopupId);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge.mock.calls[0]![0]).toMatchObject({
      workspaceId: ws.workspaceId,
      packId: 'growth',
      amountCents: 14_900,
      paymentMethodId: 'pm_d13',
    });
    const created = await adminDb.purchase.findUniqueOrThrow({
      where: { id: res.body.purchase_id as string },
    });
    expect(created).toMatchObject({ status: 'pending', isAutoTopup: true });
    expect(created.stripePaymentIntent).toMatch(/^pi_retry_/);
    // Credits come from `payment_intent.succeeded`, never from the create call.
    expect(await balance(ws.workspaceId)).toBe(before);
    expect(await audits('topup.retry_requested', failedTopupId)).toHaveLength(1);
    const retried = await audits('topup.retried', failedTopupId);
    expect(retried).toHaveLength(1);
    expect(retried[0]!.afterJson).toMatchObject({
      outcome: 'charged',
      purchase_id: res.body.purchase_id,
    });

    const again = await call(
      'POST',
      `/admin/topups/${failedTopupId}/retry`,
      staff.ops.token,
      reason,
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('CONFLICT');
    expect(charge).toHaveBeenCalledTimes(1);
    expect(
      (await call('POST', `/admin/topups/${ws.purchaseId}/retry`, staff.ops.token, reason)).status,
    ).toBe(404);
    charge.mockRestore();
    await adminDb.purchase.delete({ where: { id: created.id } });
  });

  it('disables auto top-up for the workspace through the customer path, keeping the card, and audits it twice', async () => {
    const res = await call(
      'POST',
      `/admin/customers/${ws.workspaceId}/auto-topup/disable`,
      staff.support.token,
      { reason_code: 'fraud_suspected' },
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tenant_id: ws.workspaceId,
      enabled: false,
      pack_id: 'growth',
      card_last4: '4242',
    });
    const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId } });
    expect(tenant.autoTopupJson).toMatchObject({
      enabled: false,
      payment_method_id: 'pm_d13',
      card_last4: '4242',
    });
    const staffRow = await audits('topup.disabled', ws.workspaceId);
    expect(staffRow).toHaveLength(1);
    expect(staffRow[0]).toMatchObject({ staffId: staff.support.id, reasonCode: 'fraud_suspected' });
    const customerRow = await adminDb.auditLog.findFirst({
      where: { tenantId: ws.workspaceId, action: 'auto_topup.disabled' },
      orderBy: { createdAt: 'desc' },
    });
    expect(customerRow?.actorUserId).toBeNull();
    expect(customerRow?.metaJson).toMatchObject({ by: 'staff', reason_code: 'fraud_suspected' });
    // Already off: idempotent, no second audit row.
    expect(
      (
        await call(
          'POST',
          `/admin/customers/${ws.workspaceId}/auto-topup/disable`,
          staff.support.token,
          reason,
        )
      ).status,
    ).toBe(201);
    expect(await audits('topup.disabled', ws.workspaceId)).toHaveLength(1);
    expect(
      (
        await call(
          'POST',
          `/admin/customers/${ws.workspaceId}/auto-topup/disable`,
          staff.readOnly.token,
          reason,
        )
      ).status,
    ).toBe(403);
    // The list now says the setting is off.
    const list = await call(
      'GET',
      `/admin/topups/failed?tenant_id=${ws.workspaceId}`,
      staff.readOnly.token,
    );
    expect((list.body.items as Array<Record<string, unknown>>)[0]!.auto_topup_enabled).toBe(false);
  });
});

// --------------------------------------------------------------------------- revenue

describe('GET /admin/billing/summary', () => {
  it('sums the sales, refunds, failed top-ups and packs the fixtures produced', async () => {
    const res = await call('GET', '/admin/billing/summary?range=7d', staff.readOnly.token);
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('7d');
    const usd = (res.body.sales as Array<Record<string, number | string>>).find(
      (s) => s.currency === 'USD',
    )!;
    // At least the two fixture purchases (one refunded since, still a sale).
    expect(usd.purchases).toBeGreaterThanOrEqual(2);
    expect(usd.amount_cents).toBeGreaterThanOrEqual(14_900 + 4_900);
    expect(usd.credits).toBeGreaterThanOrEqual(650);
    const refunds = (res.body.refunds as Array<Record<string, number | string>>).find(
      (r) => r.currency === 'USD',
    )!;
    expect(refunds.count).toBeGreaterThanOrEqual(4);
    expect(refunds.amount_cents).toBeGreaterThanOrEqual(4_900 + 1_000 + 500 + 4_900);
    expect(refunds.credits_reversed).toBeGreaterThanOrEqual(164.43 + 33.56 + 16.78 + 150 - 0.01);
    expect(res.body.failed_topups).toBeGreaterThanOrEqual(1);
    const packs = res.body.packs as Array<Record<string, unknown>>;
    expect(packs.find((p) => p.pack_id === 'growth')).toMatchObject({ pack_name: 'Growth' });
    expect(packs.find((p) => p.pack_id === 'starter')).toMatchObject({ pack_name: 'Starter' });
    const series = res.body.series as Array<Record<string, number | string>>;
    expect(series).toHaveLength(8);
    const sum = (key: 'sales_cents' | 'refunds_cents' | 'purchases') => series.reduce((n, d) => n + Number(d[key]), 0);
    expect(sum('sales_cents')).toBe(usd.amount_cents);
    expect(sum('refunds_cents')).toBe(refunds.amount_cents);
    expect(sum('purchases')).toBe(usd.purchases);
    expect(
      (await call('GET', '/admin/billing/summary?range=1d', staff.readOnly.token)).status,
    ).toBe(422);
    expect((await call('GET', '/admin/billing/summary', null)).status).toBe(401);
  });
});

// Last, because it refunds the fixture purchase once more.
describe('POST /admin/purchases/:id/refund after a lost answer', () => {
  it('review 28 Sep: a retry adopts the refund a failed-looking attempt did make, instead of refunding twice', async () => {
    const key = randomUUID();
    const create = vi
      .spyOn(stripe, 'refundPaymentIntent')
      .mockRejectedValueOnce(new Error('socket hang up'));
    const first = await call('POST', `/admin/purchases/${ws.purchaseId}/refund`, staff.superAdmin.token, {
      reason_code: 'billing_error',
      amount_cents: 100,
      idempotency_key: key,
    });
    expect(first.status).toBe(503);
    const lookup = vi
      .spyOn(stripe, 'findRefund')
      .mockResolvedValue({ id: `re_adopted_${run}`, status: 'succeeded' });
    const retry = await call('POST', `/admin/purchases/${ws.purchaseId}/refund`, staff.superAdmin.token, {
      reason_code: 'billing_error',
      amount_cents: 100,
      idempotency_key: key,
    });
    expect(retry.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await adminDb.refund.findUniqueOrThrow({ where: { id: key } })).toMatchObject({
      status: 'succeeded',
      stripeRefundId: `re_adopted_${run}`,
    });
    create.mockRestore();
    lookup.mockRestore();
  });
});
