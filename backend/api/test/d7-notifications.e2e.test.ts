import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AutoTopupService, StripeGateway, type PaymentIntentFacts } from '../src/modules/billing';
import { DailyDigestService, EMAIL_SENDER, LowBalanceAlertsService, type LogEmailSender, NotificationsService } from '../src/modules/notifications';
import { WalletService } from '../src/modules/wallet';
import { addMember, startD5Harness, waitFor } from './d5-fixtures';
import { type PaidWorkspace, authFor, caller, paidWorkspace } from './d6-fixtures';

/*
 * D7 notifications: §5.4 low-balance alerts without spam, the timezone-aware daily
 * digest, the notifications outbox's exactly-once, the in-app alert routes, and the
 * auto top-up "runs twice" cases. Email is the log sender, captured in memory.
 */

delete process.env.RESEND_API_KEY;

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;
let wallet: WalletService;
let lowBalance: LowBalanceAlertsService;
let digest: DailyDigestService;
let notifications: NotificationsService;
let topups: AutoTopupService;
let stripe: StripeGateway;
let emails: LogEmailSender;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  stop = harness.stop;
  auth = authFor(harness.customerTenant);
  call = caller(app);
  wallet = app.get(WalletService);
  lowBalance = app.get(LowBalanceAlertsService);
  digest = app.get(DailyDigestService);
  notifications = app.get(NotificationsService);
  topups = app.get(AutoTopupService);
  stripe = app.get(StripeGateway);
  emails = app.get(EMAIL_SENDER) as LogEmailSender;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await stop?.();
  await adminDb.$disconnect();
});

const debit = (ws: string, credits: number) => wallet.debit(ws, { credits, reason: 'call', refType: 'call', refId: `call_${randomUUID()}` });
const openLowBalance = (ws: string) => adminDb.alert.findMany({ where: { tenantId: ws, type: 'low_balance', resolvedAt: null }, orderBy: { threshold: 'desc' } });
const emailsTo = (address: string) => emails.sent.filter((e) => e.to === address);

// ---------------------------------------------------------------------------

describe('low-balance alerts (§5.4, §13.11 low-balance-alerts)', () => {
  it('alerts when the balance crosses a threshold, once, resets on recovery, and alerts again on the next drop', async () => {
    const ws = await paidWorkspace(app, 'lowbal', 'growth'); // 500 credits → 20% = 100, 5% = 25, 0
    const admin = await addMember(ws.workspaceId, 'lowbal-admin', 'admin');
    const viewer = await addMember(ws.workspaceId, 'lowbal-viewer', 'viewer');

    // Well above: nothing.
    await debit(ws.workspaceId, 100); // 400
    await new Promise((r) => setTimeout(r, 200));
    expect(await openLowBalance(ws.workspaceId)).toHaveLength(0);

    // Crosses 20%: one alert, emails to owner and admin (not the viewer), from the ledger listener.
    await debit(ws.workspaceId, 305); // 95
    const opened = await waitFor('the 20% alert', async () => {
      const rows = await openLowBalance(ws.workspaceId);
      return rows.length ? rows : null;
    });
    expect(opened.map((a) => a.threshold!.toNumber())).toEqual([20]);
    expect(opened[0]!.metaJson).toMatchObject({ balance: 95, threshold_credits: 100, base_credits: 500 });
    await waitFor('the emails', async () => (emailsTo(ws.email).length && emailsTo(admin.email).length ? true : null));
    expect(emailsTo(ws.email)).toHaveLength(1);
    expect(emailsTo(admin.email)).toHaveLength(1);
    expect(emailsTo(viewer.email)).toHaveLength(0);
    expect(emailsTo(ws.email)[0]!.subject).toMatch(/running low \(20% left\)/);
    expect(emailsTo(ws.email)[0]!.text).not.toMatch(/sk_|key_|Bearer/);

    // The schedule runs, and runs again: no new alert, no new email.
    await lowBalance.sweep();
    await lowBalance.sweep();
    await debit(ws.workspaceId, 1); // 94, still between 5% and 20%
    await new Promise((r) => setTimeout(r, 200));
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'low_balance' } })).toBe(1);
    expect(emailsTo(ws.email)).toHaveLength(1);

    // Down through 5% and 0 in one debit: two more alerts, largest first — and ONE email,
    // for the lowest threshold crossed, not one per threshold.
    await debit(ws.workspaceId, 95); // −1
    await waitFor('5% and 0', async () => ((await openLowBalance(ws.workspaceId)).length === 3 ? true : null));
    expect((await openLowBalance(ws.workspaceId)).map((a) => a.threshold!.toNumber())).toEqual([20, 5, 0]);
    await waitFor('the 0 email', async () => (emailsTo(ws.email).length >= 2 ? true : null));
    expect(emailsTo(ws.email)).toHaveLength(2);
    expect(emailsTo(ws.email).at(-1)!.subject).toMatch(/run out of credits/);

    // Recovery: a purchase resolves every open alert; a later drop is a new crossing.
    await wallet.grant(ws.workspaceId, { credits: 500, reason: 'purchase', expiresAt: new Date(Date.now() + 365 * 86_400_000) }); // 499
    await waitFor('resolution', async () => ((await openLowBalance(ws.workspaceId)).length === 0 ? true : null));
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'low_balance', resolvedAt: { not: null } } })).toBe(3);

    await debit(ws.workspaceId, 420); // 79
    await waitFor('the second 20% alert', async () => ((await openLowBalance(ws.workspaceId)).length === 1 ? true : null));
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'low_balance' } })).toBe(4);
    await waitFor('the second 20% email', async () => (emailsTo(ws.email).length >= 3 ? true : null));
    expect(emailsTo(ws.email)).toHaveLength(3);
  });

  it('respects the member’s low_balance_email preference and the workspace default', async () => {
    const ws = await paidWorkspace(app, 'lowbal-pref', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const off = await call('PATCH', '/workspace/notification-settings', headers, { low_balance_email: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ low_balance_email: false, is_default: false });
    await debit(ws.workspaceId, 450); // 50 → crosses 20%
    await waitFor('the alert', async () => ((await openLowBalance(ws.workspaceId)).length ? true : null));
    await new Promise((r) => setTimeout(r, 200));
    expect(emailsTo(ws.email)).toHaveLength(0);
    // The banner still shows it.
    const active = await call('GET', '/alerts/active', headers);
    expect(active.status).toBe(200);
    expect((active.body.items as Array<{ type: string }>).map((a) => a.type)).toEqual(['low_balance']);
  });

  it('two evaluations racing on one crossing open one alert and send one email', async () => {
    const ws = await paidWorkspace(app, 'lowbal-race', 'growth');
    // Take the balance down *without* the listener noticing by writing the decision by hand.
    await Promise.all([lowBalance.evaluate(ws.workspaceId, 'schedule', 50), lowBalance.evaluate(ws.workspaceId, 'schedule', 50), lowBalance.evaluate(ws.workspaceId, 'schedule', 50)]);
    expect(await adminDb.alert.count({ where: { tenantId: ws.workspaceId, type: 'low_balance' } })).toBe(1);
    expect(emailsTo(ws.email)).toHaveLength(1);
    expect(await adminDb.notification.count({ where: { tenantId: ws.workspaceId, kind: 'low_balance' } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('the in-app alert routes', () => {
  it('lists open, undismissed alerts to any member; dismiss hides one; another workspace sees nothing', async () => {
    const ws = await paidWorkspace(app, 'alerts-api', 'growth');
    const viewer = await addMember(ws.workspaceId, 'alerts-viewer', 'viewer');
    const other = await paidWorkspace(app, 'alerts-other', 'growth');
    await lowBalance.evaluate(ws.workspaceId, 'schedule', 10);

    const asViewer = await auth(viewer.sub, ws.workspaceId);
    const list = await call('GET', '/alerts/active', asViewer);
    expect(list.status).toBe(200);
    const items = list.body.items as Array<{ id: string; type: string; threshold: number; meta: Record<string, unknown> }>;
    expect(items.map((a) => [a.type, a.threshold])).toEqual([
      ['low_balance', 5],
      ['low_balance', 20],
    ]);
    expect(JSON.stringify(list.body)).not.toMatch(/retell|stripe/i);

    const dismissed = await call('POST', `/alerts/${items[0]!.id}/dismiss`, asViewer);
    expect(dismissed.body).toEqual({ dismissed: true });
    expect((await call('POST', `/alerts/${items[0]!.id}/dismiss`, asViewer)).body).toEqual({ dismissed: false });
    expect(((await call('GET', '/alerts/active', asViewer)).body.items as unknown[]).length).toBe(1);

    const asOther = await auth(other.sub, other.workspaceId);
    expect(((await call('GET', '/alerts/active', asOther)).body.items as unknown[]).length).toBe(0);
    expect((await call('POST', `/alerts/${items[1]!.id}/dismiss`, asOther)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('daily digest (§13.11 daily-digest, per workspace timezone)', () => {
  async function callAt(ws: string, at: Date, seconds = 60) {
    await adminDb.call.create({ data: { id: `call_${randomUUID().replace(/-/g, '')}`, tenantId: ws, channel: 'phone', status: 'ended', startedAt: at, endedAt: new Date(at.getTime() + seconds * 1000), durationS: seconds, rate: new Prisma.Decimal(1), creditsCharged: new Prisma.Decimal(seconds / 60) } });
  }
  async function digestWorkspace(label: string, timezone: string): Promise<PaidWorkspace & { name: string }> {
    const ws = await paidWorkspace(app, label, 'growth');
    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { timezone } });
    await adminDb.notificationSetting.upsert({
      where: { tenantId_userId: { tenantId: ws.workspaceId, userId: ws.userId } },
      create: { tenantId: ws.workspaceId, userId: ws.userId, newMessage: 'daily' },
      update: { newMessage: 'daily' },
    });
    const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { id: ws.workspaceId }, select: { name: true } });
    return { ...ws, name: tenant.name };
  }
  const tenantOf = (ws: PaidWorkspace & { name: string }, timezone: string) => ({ id: ws.workspaceId, name: ws.name, timezone });

  it('sends each workspace yesterday’s digest for its own local day, at its own morning, exactly once', async () => {
    const toronto = await digestWorkspace('digest-yyz', 'America/Toronto');
    const kolkata = await digestWorkspace('digest-blr', 'Asia/Kolkata');

    // Toronto local 21 Sep 2026 is [04:00Z 21 Sep, 04:00Z 22 Sep). Two inside, two just outside.
    await callAt(toronto.workspaceId, new Date('2026-09-21T04:30:00Z')); // 00:30 local, in
    await callAt(toronto.workspaceId, new Date('2026-09-22T03:30:00Z')); // 23:30 local, in
    await callAt(toronto.workspaceId, new Date('2026-09-21T03:30:00Z')); // 23:30 local the day before, out
    await callAt(toronto.workspaceId, new Date('2026-09-22T04:30:00Z')); // 00:30 local the day after, out
    // Kolkata local 21 Sep is [18:30Z 20 Sep, 18:30Z 21 Sep).
    await callAt(kolkata.workspaceId, new Date('2026-09-20T19:00:00Z')); // 00:30 local, in
    await callAt(kolkata.workspaceId, new Date('2026-09-21T18:00:00Z')); // 23:30 local, in
    await callAt(kolkata.workspaceId, new Date('2026-09-21T18:45:00Z')); // 00:15 local the next day, out

    // 05:00Z on 22 Sep: 10:30 in Kolkata (past 08:00), 01:00 in Toronto (not yet).
    const early = new Date('2026-09-22T05:00:00Z');
    expect(await digest.evaluate(tenantOf(toronto, 'America/Toronto'), early, 8)).toMatchObject({ outcome: 'skipped', reason: 'not_yet', date: '2026-09-21' });
    const sentBlr = await digest.evaluate(tenantOf(kolkata, 'Asia/Kolkata'), early, 8);
    expect(sentBlr).toMatchObject({ outcome: 'sent', date: '2026-09-21', recipients: 1 });
    const blrEmail = emailsTo(kolkata.email).at(-1)!;
    expect(blrEmail.subject).toBe(`${kolkata.name}: 2 calls on 2026-09-21`);
    expect(blrEmail.text).toContain('Calls answered:   2');
    expect(blrEmail.text).toContain('(Asia/Kolkata)');
    const blrRow = await adminDb.notification.findFirstOrThrow({ where: { tenantId: kolkata.workspaceId, kind: 'daily_digest' } });
    expect(blrRow.payloadJson).toMatchObject({ date: '2026-09-21', window_start: '2026-09-20T18:30:00.000Z', window_end: '2026-09-21T18:30:00.000Z', calls: 2 });

    // 13:00Z: 09:00 in Toronto — its turn; Kolkata already done.
    const later = new Date('2026-09-22T13:00:00Z');
    expect(await digest.evaluate(tenantOf(toronto, 'America/Toronto'), later, 8)).toMatchObject({ outcome: 'sent', date: '2026-09-21', recipients: 1 });
    expect(emailsTo(toronto.email).at(-1)!.subject).toBe(`${toronto.name}: 2 calls on 2026-09-21`);
    expect(await digest.evaluate(tenantOf(kolkata, 'Asia/Kolkata'), later, 8)).toMatchObject({ outcome: 'skipped', reason: 'already_done' });

    // The hourly sweep, twice: nothing more goes out for that day.
    const before = emails.sent.length;
    await Promise.all([digest.sweep(later, 8), digest.sweep(later, 8)]);
    expect(emailsTo(toronto.email)).toHaveLength(1);
    expect(emailsTo(kolkata.email)).toHaveLength(1);
    expect(await adminDb.notification.count({ where: { tenantId: { in: [toronto.workspaceId, kolkata.workspaceId] }, kind: 'daily_digest', status: 'sent' } })).toBe(2);
    void before;
  });

  it('handles the DST fall-back day as 25 hours, and skips (once) a workspace with nobody opted in or no calls', async () => {
    const ws = await digestWorkspace('digest-dst', 'America/Toronto');
    // 1 Nov 2026 in Toronto runs 04:00Z 1 Nov → 05:00Z 2 Nov.
    await callAt(ws.workspaceId, new Date('2026-11-01T04:10:00Z')); // 00:10 EDT, in
    await callAt(ws.workspaceId, new Date('2026-11-02T04:50:00Z')); // 23:50 EST, in — would be excluded by a 24-hour window
    await callAt(ws.workspaceId, new Date('2026-11-02T05:10:00Z')); // 00:10 EST 2 Nov, out
    const sent = await digest.evaluate(tenantOf(ws, 'America/Toronto'), new Date('2026-11-02T14:00:00Z'), 8);
    expect(sent).toMatchObject({ outcome: 'sent', date: '2026-11-01' });
    const row = await adminDb.notification.findFirstOrThrow({ where: { tenantId: ws.workspaceId, kind: 'daily_digest', dedupeKey: { contains: '2026-11-01' } } });
    expect(row.payloadJson).toMatchObject({ calls: 2, window_start: '2026-11-01T04:00:00.000Z', window_end: '2026-11-02T05:00:00.000Z' });

    // The 2nd had one call (00:10 EST); the 3rd had none: recorded as skipped, not re-evaluated every hour.
    expect(await digest.evaluate(tenantOf(ws, 'America/Toronto'), new Date('2026-11-03T14:00:00Z'), 8)).toMatchObject({ outcome: 'sent', date: '2026-11-02' });
    expect(await digest.evaluate(tenantOf(ws, 'America/Toronto'), new Date('2026-11-04T14:00:00Z'), 8)).toMatchObject({ outcome: 'skipped', reason: 'no_activity', date: '2026-11-03' });
    expect(await digest.evaluate(tenantOf(ws, 'America/Toronto'), new Date('2026-11-04T15:00:00Z'), 8)).toMatchObject({ outcome: 'skipped', reason: 'already_done' });

    // Nobody wants a digest: skipped, recorded.
    const quiet = await paidWorkspace(app, 'digest-quiet', 'growth');
    await callAt(quiet.workspaceId, new Date('2026-09-21T12:00:00Z'));
    expect(await digest.evaluate({ id: quiet.workspaceId, name: 'q', timezone: 'UTC' }, new Date('2026-09-22T09:00:00Z'), 8)).toMatchObject({ outcome: 'skipped', reason: 'no_recipient' });
    expect(await adminDb.notification.count({ where: { tenantId: quiet.workspaceId, status: 'skipped' } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('the notifications outbox', () => {
  it('claims a dedupe key once, re-sends a failed row from what it stored, and stops after the attempt cap', async () => {
    const ws = await paidWorkspace(app, 'outbox', 'growth');
    const key = `test:${randomUUID()}`;
    const email = { to: ws.email, subject: 'Outbox check', text: 'body' };
    const results = await Promise.all([
      notifications.deliver({ workspaceId: ws.workspaceId, userId: ws.userId, kind: 'low_balance', dedupeKey: key, email }),
      notifications.deliver({ workspaceId: ws.workspaceId, userId: ws.userId, kind: 'low_balance', dedupeKey: key, email }),
    ]);
    expect(results.filter((r) => r.outcome === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(1);
    expect(emails.sent.filter((e) => e.subject === 'Outbox check')).toHaveLength(1);

    // A send that failed is retried by the sweep, from the stored body.
    const sendSpy = vi.spyOn(emails, 'send').mockRejectedValueOnce(new Error('provider 500'));
    const failed = await notifications.deliver({ workspaceId: ws.workspaceId, userId: ws.userId, kind: 'low_balance', dedupeKey: `${key}:retry`, email: { ...email, subject: 'Retry me' } });
    expect(failed.outcome).toBe('failed');
    sendSpy.mockRestore();
    const row = await adminDb.notification.findUniqueOrThrow({ where: { dedupeKey: `${key}:retry` } });
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/provider 500/);
    await adminDb.notification.update({ where: { id: row.id }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    const retried = await notifications.retryFailed();
    expect(retried.sent).toBeGreaterThanOrEqual(1);
    expect((await adminDb.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('sent');
    expect(emails.sent.filter((e) => e.subject === 'Retry me')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('auto top-up under duplicate execution (§5.4)', () => {
  function stripeSucceeds(created: PaymentIntentFacts[]) {
    return vi.spyOn(stripe, 'createOffSessionPaymentIntent').mockImplementation(async (input) => {
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
  }

  it('the listener and two concurrent schedule sweeps produce exactly one charge, and nothing is credited before Stripe confirms', async () => {
    const ws = await paidWorkspace(app, 'topup-dup', 'growth', { savedCard: true });
    const headers = await auth(ws.sub, ws.workspaceId);
    expect((await call('PUT', '/wallet/auto-topup', headers, { enabled: true, pack_id: 'growth', threshold: 100 })).status).toBe(200);
    const created: PaymentIntentFacts[] = [];
    const spy = stripeSucceeds(created);
    try {
      await Promise.all([debit(ws.workspaceId, 450), topups.sweep(), topups.sweep(), topups.evaluate(ws.workspaceId, 'schedule')]);
      await waitFor('the charge', async () => (created.length ? true : null));
      await Promise.all([topups.sweep(), topups.evaluate(ws.workspaceId, 'schedule')]);
      // `sweep()` is global by design: on a shared dev database it also re-evaluates other
      // suites' leftover workspaces once their pending top-ups age past the in-flight window,
      // so the spy is judged on this workspace's charges only.
      const ours = created.filter((intent) => intent.metadata.workspace_id === ws.workspaceId);
      expect(ours).toHaveLength(1);
      expect(spy.mock.calls.filter(([input]) => input.workspaceId === ws.workspaceId)).toHaveLength(1);
      expect(await adminDb.purchase.count({ where: { tenantId: ws.workspaceId, isAutoTopup: true } })).toBe(1);
      expect(await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId, reason: 'topup' } })).toBe(0);
      expect(await wallet.balance(ws.workspaceId)).toBe(50);
    } finally {
      spy.mockRestore();
    }
  });

  it('does nothing when disabled or above the threshold, however low the balance goes', async () => {
    const ws = await paidWorkspace(app, 'topup-off', 'growth', { savedCard: true });
    const headers = await auth(ws.sub, ws.workspaceId);
    const created: PaymentIntentFacts[] = [];
    const spy = stripeSucceeds(created);
    try {
      // Disabled (the saved card is there, the switch is off).
      await debit(ws.workspaceId, 450);
      await topups.sweep();
      expect(await topups.evaluate(ws.workspaceId, 'schedule')).toEqual({ outcome: 'skipped', reason: 'disabled' });
      // Enabled but the balance is above the threshold.
      await wallet.grant(ws.workspaceId, { credits: 500, reason: 'purchase', expiresAt: new Date(Date.now() + 365 * 86_400_000) }); // 550
      expect((await call('PUT', '/wallet/auto-topup', headers, { enabled: true, pack_id: 'growth', threshold: 100 })).status).toBe(200);
      expect(await topups.evaluate(ws.workspaceId, 'schedule')).toEqual({ outcome: 'skipped', reason: 'above_threshold' });
      await topups.sweep();
      expect(spy).not.toHaveBeenCalled();
      expect(await adminDb.purchase.count({ where: { tenantId: ws.workspaceId, isAutoTopup: true } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
