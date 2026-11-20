import { RETELL_COSTS_V1 } from '../../db/prisma/seed-data/retell-costs-v1';
import { randomUUID } from 'node:crypto';
import { Prisma, adminDb } from '@portal/db';
import { type PricingConfig, pricingConfig } from '@portal/schemas';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AutoTopupService, StripeGateway } from '../src/modules/billing';
import { PlatformConfigService } from '../src/modules/config';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { type D5Harness, startD5Harness } from './d5-fixtures';
import { paidWorkspace, type PaidWorkspace } from './d6-fixtures';

/*
 * The 18 Nov 2026 QA batch (QA BUG LIST, pricing and the staff console). Against real
 * Postgres and Redis, with Stripe stubbed at the gateway:
 *   - a pack added in SA5 can be bought (the `packs` catalogue row exists);
 *   - a publish rebuilds `caps:{ws}` instead of dropping it;
 *   - auto top-up never charges for a pack staff switched off;
 *   - switching Active off on a sold pack publishes, removing it never does, and no
 *     override lifts that whatever the pack is called;
 *   - the outbound rules show in the preview and the audit;
 *   - a scheduled version does not undo a newer publish, and can be cancelled;
 *   - a link-only pack is listed for its link and nowhere else;
 *   - staff overrides are what the customer's Wallet shows;
 *   - the customers list filters and counts in Postgres;
 *   - sales per pack and per day are per currency.
 */

let h: D5Harness;
let ws: PaidWorkspace;
let staff: Record<'superAdmin' | 'finance' | 'ops' | 'readOnly', { id: string; token: string }>;
let original: PricingConfig;
let originalVersion: number | null = null;
const run = randomUUID().slice(0, 8);
const createdPacks: string[] = [];

type Res = { status: number; body: Record<string, unknown> & { code?: string; message?: string } };

async function call(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await h.app.inject({
    method: method as 'GET',
    url: path,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Res['body']) : {} };
}

async function owner(): Promise<{ token: string; headers: Record<string, string> }> {
  return { token: await h.customerTenant.mint(ws.sub, { mfa: true }), headers: { 'x-workspace-id': ws.workspaceId } };
}

async function saveDraft(config: PricingConfig): Promise<Res> {
  const saved = await call('PUT', '/admin/pricing/draft', staff.finance.token, { config });
  expect(saved.status).toBe(200);
  return call('GET', '/admin/pricing/preview', staff.finance.token);
}

async function publish(config: PricingConfig, extra: Record<string, unknown> = {}): Promise<Res> {
  await saveDraft(config);
  return call('POST', '/admin/pricing/publish', staff.superAdmin.token, { reason_code: 'promo', ...extra });
}

const discard = () => call('DELETE', '/admin/pricing/draft', staff.finance.token, { reason_code: 'testing_internal' });

async function currentConfig(): Promise<PricingConfig> {
  return (await h.app.get(PlatformConfigService).currentPricing()).config;
}

const pack = (id: string, over: Partial<PricingConfig['packs'][number]> = {}): PricingConfig['packs'][number] => {
  createdPacks.push(id);
  return { id, name: `QA ${id}`, price_cents: 1_900, currency: 'USD', credits: 50, bonus_credits: 0, plan_tier: 'starter', concurrency_cap: 2, kb_allowance: 0, max_agents: 1, max_numbers: 1, feature_gates: [], badge: null, description: null, sort_order: 90, visibility: 'public', regions: [], active: true, ...over };
};

beforeAll(async () => {
  h = await startD5Harness({ workers: false });
  const make = async (label: string, role: 'super_admin' | 'finance' | 'ops' | 'read_only') => {
    const row = await adminDb.staffUser.create({ data: { authProviderId: `google-oauth2|qa18-${label}-${run}`, email: `qa18-${label}-${run}@metacognixion.test`, role } });
    return { id: row.id, token: await h.staffTenant.mint(row.authProviderId, { mfa: true }) };
  };
  staff = { superAdmin: await make('sa', 'super_admin'), finance: await make('fin', 'finance'), ops: await make('ops', 'ops'), readOnly: await make('ro', 'read_only') };
  ws = await paidWorkspace(h.app, `qa18-${run}`, 'growth', { savedCard: true });
  await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { name: `QA18 Bakery ${run}`, onboardingCompletedAt: new Date(), onboardingStep: 7 } });

  const current = (await adminDb.pricingConfig.findFirst({ where: { effectiveAt: { lte: new Date() } }, orderBy: { version: 'desc' } }))!;
  original = pricingConfig.parse(current.configJson);
  originalVersion = current.version;
  await adminDb.pricingDraft.deleteMany({});

  const stripe = h.app.get(StripeGateway);
  vi.spyOn(stripe, 'ensureProduct').mockResolvedValue('prod_qa18');
  vi.spyOn(stripe, 'findPriceByLookupKey').mockResolvedValue(null);
  vi.spyOn(stripe, 'createPrice').mockImplementation(async (input) => `price_${input.pack.id}_${input.lookupKey}`);
  vi.spyOn(stripe, 'archivePrice').mockResolvedValue(undefined);
  // A floor every seeded pack clears, so only the blockers under test can refuse a publish.
  const costs = await call('PUT', '/admin/retell-costs', staff.finance.token, { ...RETELL_COSTS_V1, margin_floor_pct: 1 });
  expect(costs.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await adminDb.pricingDraft.deleteMany({});
  if (originalVersion !== null) await adminDb.pricingConfig.deleteMany({ where: { version: { gt: originalVersion } } });
  // The catalogue rows this run's packs left behind; `purchases.pack_id` is ON DELETE SET NULL.
  if (createdPacks.length) await adminDb.pack.deleteMany({ where: { id: { in: createdPacks } } });
  for (const p of original.packs) await adminDb.pack.updateMany({ where: { id: p.id }, data: { active: p.active } });
  await h.app.get(RedisCache).del(redisKeys.pricingCurrent);
  await h?.stop();
  await adminDb.$disconnect();
});

describe('a pack added in Pricing can be bought', () => {
  const id = `qa_new_${run}`;

  it('publishing writes its catalogue row, and checkout opens', async () => {
    expect(await adminDb.pack.findUnique({ where: { id } })).toBeNull();
    const published = await publish({ ...original, packs: [...original.packs, pack(id)] });
    expect(published.status).toBe(201);
    expect(await adminDb.pack.findUnique({ where: { id } })).toMatchObject({ name: `QA ${id}`, priceCents: 1_900, credits: 50, planTier: 'starter', active: true });

    const session = vi.spyOn(h.app.get(StripeGateway), 'createCheckoutSession').mockImplementation(async (input) => ({ id: `cs_test_${randomUUID().replace(/-/g, '')}`, url: `https://checkout.stripe.test/${input.purchaseId}` }));
    const { token, headers } = await owner();
    const res = await call('POST', '/wallet/checkout', token, { pack_id: id }, headers);
    session.mockRestore();
    expect([200, 201]).toContain(res.status);
    expect(res.body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(await adminDb.purchase.count({ where: { tenantId: ws.workspaceId, packId: id, status: 'pending' } })).toBe(1);
  });

  it('a pack published before the catalogue was written heals on its first purchase', async () => {
    await adminDb.purchase.deleteMany({ where: { packId: id } });
    await adminDb.pack.delete({ where: { id } });
    const session = vi.spyOn(h.app.get(StripeGateway), 'createCheckoutSession').mockImplementation(async (input) => ({ id: `cs_test_${randomUUID().replace(/-/g, '')}`, url: `https://checkout.stripe.test/${input.purchaseId}` }));
    const { token, headers } = await owner();
    const res = await call('POST', '/wallet/checkout', token, { pack_id: id }, headers);
    session.mockRestore();
    expect([200, 201]).toContain(res.status);
    expect(await adminDb.pack.findUnique({ where: { id } })).not.toBeNull();
  });
});

describe('a publish never leaves a workspace without its line limit', () => {
  it('rebuilds caps:{ws} in place, from the new version', async () => {
    const config = h.app.get(PlatformConfigService);
    const cache = h.app.get(RedisCache);
    const before = await config.refreshCaps(ws.workspaceId);
    const live = await currentConfig();
    const published = await publish({ ...live, recurring: { ...live.recurring, extra_kb_credits: live.recurring.extra_kb_credits + 1 } });
    expect(published.status).toBe(201);
    const after = JSON.parse((await cache.get(redisKeys.caps(ws.workspaceId))) ?? 'null') as Record<string, unknown> | null;
    expect(after).not.toBeNull();
    expect(after).toMatchObject({ concurrency_cap: before.concurrency_cap, config_version: published.body.version });
  });
});

describe('auto top-up and a pack staff switched off', () => {
  it('charges nothing for the inactive pack, and refuses to save it or a hidden one', async () => {
    const topups = h.app.get(AutoTopupService);
    const intent = vi.spyOn(h.app.get(StripeGateway), 'createOffSessionPaymentIntent');
    await adminDb.tenant.update({
      where: { id: ws.workspaceId },
      data: { autoTopupJson: { enabled: true, pack_id: 'starter', threshold: 100_000, payment_method_id: 'pm_qa18', card_last4: '4242' } as Prisma.InputJsonValue },
    });
    const live = await currentConfig();
    const off = await publish({ ...live, packs: live.packs.map((p) => (p.id === 'starter' ? { ...p, active: false } : p)) });
    expect(off.status).toBe(201);

    const purchasesBefore = await adminDb.purchase.count({ where: { tenantId: ws.workspaceId } });
    expect(await topups.evaluate(ws.workspaceId, 'schedule')).toEqual({ outcome: 'skipped', reason: 'no_pack' });
    // SA9 "Retry now" skips the cooldown, never the pack check.
    expect(await topups.evaluate(ws.workspaceId, 'staff', { ignoreCooldown: true })).toEqual({ outcome: 'skipped', reason: 'no_pack' });
    expect(await adminDb.purchase.count({ where: { tenantId: ws.workspaceId } })).toBe(purchasesBefore);
    expect(intent).not.toHaveBeenCalled();

    const { token, headers } = await owner();
    const inactive = await call('PUT', '/wallet/auto-topup', token, { enabled: true, pack_id: 'starter', threshold: 20 }, headers);
    expect(inactive.body.code).toBe('PACK_UNAVAILABLE');
    const hidden = await publish({ ...(await currentConfig()), packs: (await currentConfig()).packs.map((p) => (p.id === 'scale' ? { ...p, visibility: 'hidden' as const } : p)) });
    expect(hidden.status).toBe(201);
    expect((await call('PUT', '/wallet/auto-topup', token, { enabled: true, pack_id: 'scale', threshold: 20 }, headers)).body.code).toBe('PACK_UNAVAILABLE');

    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { autoTopupJson: Prisma.DbNull } });
    intent.mockRestore();
  });
});

describe('deactivating, removing and the blockers', () => {
  it('a sold pack switched off is a deactivation and publishes; the preview says so', async () => {
    // `growth` was bought by this workspace (the fixture's paid purchase).
    const live = { ...original, packs: original.packs.map((p) => ({ ...p })) };
    expect((await publish(live)).status).toBe(201);
    const preview = await saveDraft({ ...live, packs: live.packs.map((p) => (p.id === 'growth' ? { ...p, active: false } : p)) });
    expect(preview.body.hard_blockers).toEqual([]);
    expect(preview.body.blockers).toEqual([]);
    expect(preview.body.packs).toMatchObject({ removed: [], deactivated: ['growth'] });
    const published = await call('POST', '/admin/pricing/publish', staff.superAdmin.token, { reason_code: 'promo' });
    expect(published.status).toBe(201);
    expect((await call('GET', '/pricing', null)).body.packs).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'growth' })]));
    expect((await adminDb.pack.findUnique({ where: { id: 'growth' } }))?.active).toBe(false);
  });

  it('removing a sold pack is refused, and the margin override does not lift it', async () => {
    const preview = await saveDraft({ ...original, packs: original.packs.filter((p) => p.id !== 'growth') });
    expect(preview.body.packs).toMatchObject({ removed: ['growth'] });
    expect((preview.body.hard_blockers as string[]).join(' ')).toMatch(/"growth" was bought .* switch Active off instead/);
    const refused = await call('POST', '/admin/pricing/publish', staff.superAdmin.token, { reason_code: 'promo', override_margin: true, note: 'trying the override' });
    expect(refused.status).toBe(409);
    await discard();
  });

  it('a sold pack with "margin" in its id is still a hard blocker', async () => {
    const id = `margin_qa_${run}`;
    expect((await publish({ ...original, packs: [...original.packs, pack(id)] })).status).toBe(201);
    await adminDb.purchase.create({ data: { tenantId: ws.workspaceId, packId: id, amountCents: 1_900, currency: 'USD', credits: 50, status: 'paid' } });
    const preview = await saveDraft(original);
    expect((preview.body.hard_blockers as string[]).some((b) => b.includes(id))).toBe(true);
    const refused = await call('POST', '/admin/pricing/publish', staff.superAdmin.token, { reason_code: 'promo', override_margin: true, note: 'the id says margin' });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain(id);
    expect((await currentConfig()).packs.some((p) => p.id === id)).toBe(true);
    await adminDb.purchase.deleteMany({ where: { packId: id } });
    await discard();
  });
});

describe('the outbound rules are previewed and audited', () => {
  it('lists a change to the prior-contact days, and the audit counts it', async () => {
    const live = await currentConfig();
    const days = live.outbound.prior_contact_days;
    const preview = await saveDraft({ ...live, outbound: { ...live.outbound, prior_contact_days: days - 30 } });
    expect(preview.body.changes).toEqual([{ path: 'outbound.prior_contact_days', before: days, after: days - 30 }]);
    const saved = await adminDb.staffAuditLog.findFirst({ where: { action: 'pricing.draft_saved' }, orderBy: { createdAt: 'desc' } });
    expect(saved?.afterJson).toMatchObject({ changes: 1 });
    const published = await call('POST', '/admin/pricing/publish', staff.superAdmin.token, { reason_code: 'promo' });
    expect(published.status).toBe(201);
    expect(published.body.change_summary).toContain('outbound.prior_contact_days');
    const audit = await adminDb.staffAuditLog.findFirst({ where: { action: 'pricing.published' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.afterJson).toMatchObject({ changes: 1, changed_paths: ['outbound.prior_contact_days'] });
  });
});

describe('a scheduled version and a newer publish', () => {
  it('the newer publish stays when the scheduled date arrives, and the preview warned', async () => {
    const live = await currentConfig();
    const bump = (config: PricingConfig, id: string) => ({ ...config, packs: config.packs.map((p) => (p.id === id ? { ...p, price_cents: p.price_cents + 100 } : p)) });
    const scheduled = await publish(bump(live, 'pro'), { effective_at: new Date(Date.now() + 15 * 60_000).toISOString() });
    expect(scheduled.status).toBe(201);
    expect(scheduled.body).toMatchObject({ is_scheduled: true, is_current: false });
    const scheduledVersion = scheduled.body.version as number;

    const preview = await saveDraft(bump(live, 'scale'));
    expect(preview.body.scheduled).toEqual([{ version: scheduledVersion, effective_at: scheduled.body.effective_at }]);
    const newer = await call('POST', '/admin/pricing/publish', staff.superAdmin.token, { reason_code: 'promo' });
    expect(newer.status).toBe(201);
    const newerVersion = newer.body.version as number;
    expect(newerVersion).toBeGreaterThan(scheduledVersion);

    // The scheduled date arrives.
    await adminDb.pricingConfig.update({ where: { version: scheduledVersion }, data: { effectiveAt: new Date(Date.now() - 1_000) } });
    await h.app.get(RedisCache).del(redisKeys.pricingCurrent);
    const served = await call('GET', '/pricing', null);
    expect(served.body.version).toBe(newerVersion);
    const price = (id: string) => (served.body.packs as Array<{ id: string; price_cents: number }>).find((p) => p.id === id)?.price_cents;
    expect(price('scale')).toBe(live.packs.find((p) => p.id === 'scale')!.price_cents + 100);
    expect(price('pro')).toBe(live.packs.find((p) => p.id === 'pro')!.price_cents);
  });

  it('a scheduled version can be cancelled before it starts, with a reason, and never after', async () => {
    const live = await currentConfig();
    const scheduled = await publish({ ...live, recurring: { ...live.recurring, extra_kb_credits: live.recurring.extra_kb_credits + 5 } }, { effective_at: new Date(Date.now() + 60 * 60_000).toISOString() });
    expect(scheduled.status).toBe(201);
    const version = scheduled.body.version as number;
    const path = `/admin/pricing/versions/${version}/cancel`;

    expect((await call('POST', path, staff.finance.token, { reason_code: 'promo' })).status).toBe(403);
    expect((await call('POST', path, staff.superAdmin.token, {})).status).toBe(422);
    const cancelled = await call('POST', path, staff.superAdmin.token, { reason_code: 'service_issue', note: 'scheduled by mistake' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ version, effective_at: null, is_scheduled: false, is_current: false });
    expect(cancelled.body.change_summary).toMatch(/^Cancelled before taking effect/);
    const audit = await adminDb.staffAuditLog.findFirst({ where: { action: 'pricing.schedule_cancelled' }, orderBy: { createdAt: 'desc' } });
    expect(audit).toMatchObject({ targetId: String(version), reasonCode: 'service_issue', staffId: staff.superAdmin.id });
    expect((await call('GET', '/admin/pricing/preview', staff.finance.token)).body.scheduled).toEqual([]);

    // Not scheduled any more, and a version in effect is rolled back, not cancelled.
    expect((await call('POST', path, staff.superAdmin.token, { reason_code: 'service_issue' })).status).toBe(409);
    const current = (await call('GET', '/pricing', null)).body.version as number;
    expect((await call('POST', `/admin/pricing/versions/${current}/cancel`, staff.superAdmin.token, { reason_code: 'service_issue' })).status).toBe(409);
    expect((await call('GET', '/pricing', null)).body.version).toBe(current);
  });
});

describe('a link-only pack', () => {
  it('is listed for whoever holds its link, and can be bought', async () => {
    const live = await currentConfig();
    const published = await publish({ ...live, packs: live.packs.map((p) => (p.id === 'pro' ? { ...p, visibility: 'link_only' as const } : p.id === 'scale' ? { ...p, visibility: 'hidden' as const } : p)) });
    expect(published.status).toBe(201);
    const ids = async (query: string) => ((await call('GET', `/pricing${query}`, null)).body.packs as Array<{ id: string }>).map((p) => p.id);
    expect(await ids('')).not.toContain('pro');
    expect(await ids('?pack=pro')).toContain('pro');
    // Naming a hidden, unknown or junk id lists nothing extra and is not an error.
    expect(await ids('?pack=scale')).not.toContain('scale');
    expect(await ids('?pack=no_such_pack')).not.toContain('no_such_pack');
    expect((await call('GET', '/pricing?pack=%3Cscript%3E', null)).status).toBe(200);
    expect(await h.app.get(PlatformConfigService).purchasablePack('pro')).toBeDefined();
  });
});

describe('staff overrides are what the customer sees', () => {
  it('Wallet shows the limits in force, and the plan’s own again once cleared', async () => {
    const { token, headers } = await owner();
    const before = await call('GET', '/wallet', token, undefined, headers);
    expect(before.body).toMatchObject({ concurrency_cap: 3, kb_allowance: 1 });
    const path = `/admin/customers/${ws.workspaceId}/overrides`;
    const set = await call('PUT', path, staff.ops.token, { concurrency_cap: 8, kb_allowance: 3, max_agents: null, max_numbers: null, reason_code: 'service_issue', note: 'qa18' });
    expect(set.status).toBe(200);
    expect((await call('GET', '/wallet', token, undefined, headers)).body).toMatchObject({ concurrency_cap: 8, kb_allowance: 3 });
    await call('PUT', path, staff.ops.token, { concurrency_cap: null, kb_allowance: null, max_agents: null, max_numbers: null, reason_code: 'service_issue', note: 'qa18' });
    expect((await call('GET', '/wallet', token, undefined, headers)).body).toMatchObject({ concurrency_cap: 3, kb_allowance: 1 });
  });
});

describe('the customers list filters, sorts and counts in Postgres', () => {
  const list = (query: string) => call('GET', `/admin/customers?${query}`, staff.readOnly.token);
  type Row = { id: string; status: string; balance: number; name: string };

  it('the total is every matching workspace, and a page is a window on it', async () => {
    const tenants = await adminDb.tenant.count();
    const first = await list('limit=1');
    expect(first.body.total).toBe(tenants);
    expect((first.body.items as Row[]).length).toBe(1);
    if (tenants > 1) expect(first.body.next_cursor).not.toBeNull();
    const second = await list(`limit=1&cursor=${encodeURIComponent(String(first.body.next_cursor))}`);
    expect((second.body.items as Row[])[0]?.id).not.toBe((first.body.items as Row[])[0]?.id);
  });

  it('a Status filter finds a workspace however old it is, and every row it lists has that status', async () => {
    // Older than every other workspace: the list used to read only the newest 500.
    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { createdAt: new Date('2020-01-01T00:00:00Z'), pausedAt: new Date(), pausedReason: 'qa18' } });
    try {
      const paused = await list(`status=paused&q=${encodeURIComponent(`QA18 Bakery ${run}`)}`);
      expect(paused.body.total).toBe(1);
      expect((paused.body.items as Row[])[0]).toMatchObject({ id: ws.workspaceId, status: 'paused' });
      const allPaused = await list('status=paused&limit=100');
      expect(allPaused.body.total).toBe(await adminDb.tenant.count({ where: { pausedAt: { not: null } } }));
      expect((allPaused.body.items as Row[]).every((r) => r.status === 'paused')).toBe(true);
      expect((await list(`status=active&q=${encodeURIComponent(`QA18 Bakery ${run}`)}`)).body.total).toBe(0);
    } finally {
      await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { pausedAt: null, pausedReason: null } });
    }
    // The SQL status and the row's own status are one rule: no status filter lists a row under another status.
    for (const status of ['active', 'onboarding', 'at_risk', 'churned'] as const) {
      const page = await list(`status=${status}&limit=100`);
      expect(page.status).toBe(200);
      expect((page.body.items as Row[]).filter((r) => r.status !== status)).toEqual([]);
    }
    expect((await list(`status=active&q=${encodeURIComponent(`QA18 Bakery ${run}`)}`)).body.total).toBe(1);
  });

  it('sorts by balance and by name across the whole list', async () => {
    const byBalance = (await list('sort=balance&order=desc&limit=100')).body.items as Row[];
    expect(byBalance.map((r) => r.balance)).toEqual([...byBalance.map((r) => r.balance)].sort((a, b) => b - a));
    const lowest = (await list('sort=balance&order=asc&limit=1')).body.items as Row[];
    const smallest = await adminDb.$queryRaw<Array<{ b: number }>>(Prisma.sql`SELECT min(coalesce(l.b, 0))::float8 AS b FROM tenants t LEFT JOIN (SELECT tenant_id, sum(delta) AS b FROM credit_ledger GROUP BY tenant_id) l ON l.tenant_id = t.id`);
    expect(lowest[0]?.balance).toBeCloseTo(smallest[0]!.b, 2);
    const byName = (await list('sort=name&order=asc&limit=100')).body.items as Row[];
    expect(byName.map((r) => r.name.toLowerCase())).toEqual([...byName.map((r) => r.name.toLowerCase())].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('searches by name, owner email and id, and treats % and _ as text', async () => {
    expect(((await list(`q=${encodeURIComponent(ws.email)}`)).body.items as Row[]).map((r) => r.id)).toContain(ws.workspaceId);
    expect(((await list(`q=${ws.workspaceId}`)).body.items as Row[]).map((r) => r.id)).toEqual([ws.workspaceId]);
    // A literal percent sign, not "anything": only workspaces whose name or a member's email contains one.
    const literal = await adminDb.$queryRaw<Array<{ n: bigint }>>(
      Prisma.sql`SELECT count(*)::bigint AS n FROM tenants t WHERE strpos(t.name, '%') > 0 OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = t.id AND strpos(u.email, '%') > 0)`,
    );
    expect((await list(`q=${encodeURIComponent('%')}`)).body.total).toBe(Number(literal[0]!.n));
  });
});

describe('sales are never added across currencies', () => {
  it('per pack and per day, USD and CAD are separate figures', async () => {
    const other = await paidWorkspace(h.app, `qa18-cad-${run}`, 'starter');
    const usd = await adminDb.purchase.findUniqueOrThrow({ where: { id: other.purchaseId } });
    await adminDb.purchase.create({ data: { tenantId: other.workspaceId, packId: 'starter', amountCents: 6_500, currency: 'CAD', credits: 150, status: 'paid' } });
    const today = new Date().toISOString().slice(0, 10);

    const summary = await call('GET', '/admin/billing/summary?range=7d', staff.finance.token);
    expect(summary.status).toBe(200);
    const packs = summary.body.packs as Array<{ pack_id: string; currency: string; amount_cents: number }>;
    const starter = packs.filter((p) => p.pack_id === 'starter');
    expect(starter.map((p) => p.currency).sort()).toEqual(['CAD', 'USD']);
    expect(starter.find((p) => p.currency === 'CAD')!.amount_cents % 100).toBe(0);
    expect(starter.find((p) => p.currency === 'CAD')!.amount_cents).toBeGreaterThanOrEqual(6_500);
    expect(starter.find((p) => p.currency === 'USD')!.amount_cents).toBeGreaterThanOrEqual(usd.amountCents);
    const day = (summary.body.series as Array<{ day: string; sales_cents: number; by_currency: Array<{ currency: string; sales_cents: number }> }>).find((d) => d.day === today)!;
    const cad = day.by_currency.find((c) => c.currency === 'CAD')!;
    const usdDay = day.by_currency.find((c) => c.currency === 'USD')!;
    expect(cad.sales_cents).toBeGreaterThanOrEqual(6_500);
    expect(usdDay.sales_cents).toBeGreaterThanOrEqual(usd.amountCents);
    expect(cad.sales_cents + usdDay.sales_cents).toBe(day.sales_cents);
    // Each currency's days add up to its own headline, so no cent crossed over.
    const headline = (currency: string) => (summary.body.sales as Array<{ currency: string; amount_cents: number }>).find((s) => s.currency === currency)!.amount_cents;
    const series = summary.body.series as Array<{ by_currency: Array<{ currency: string; sales_cents: number }> }>;
    const total = (currency: string) => series.reduce((n, d) => n + (d.by_currency.find((c) => c.currency === currency)?.sales_cents ?? 0), 0);
    expect(total('CAD')).toBe(headline('CAD'));
    expect(total('USD')).toBe(headline('USD'));

    const kpis = await call('GET', '/admin/kpis?range=7d', staff.readOnly.token);
    const kpiDay = (kpis.body.series as Array<{ day: string; sales_by_currency: Array<{ currency: string; cents: number }> }>).find((d) => d.day === today)!;
    expect(kpiDay.sales_by_currency.map((c) => c.currency).sort()).toEqual(['CAD', 'USD']);
    expect(kpiDay.sales_by_currency.find((c) => c.currency === 'CAD')!.cents).toBeGreaterThanOrEqual(6_500);
  });
});
