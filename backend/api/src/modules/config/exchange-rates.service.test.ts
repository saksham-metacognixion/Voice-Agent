import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * ADR 0049: the exchange-rate service. `exchange_rates` is an in-memory table and the
 * source, the cache and the alert channel are stand-ins; what is asserted is what gets
 * stored, what stays in force when the source fails, and what operations are told.
 */

interface Row {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: { toFixed(): string };
  observedOn: Date;
  source: string;
  series: string;
  fetchedAt: Date;
  confirmedAt: Date;
}

const table = vi.hoisted(() => ({ rows: [] as Row[] }));
const db = vi.hoisted(() => {
  class Decimal {
    constructor(private readonly text: string | number) {}
    toFixed(): string {
      return String(this.text);
    }
  }
  const newest = (rows: Row[]) => [...rows].sort((a, b) => b.observedOn.getTime() - a.observedOn.getTime() || b.fetchedAt.getTime() - a.fetchedAt.getTime());
  return {
    Decimal,
    exchangeRate: {
      findFirst: vi.fn(async () => newest(table.rows)[0] ?? null),
      findMany: vi.fn(async ({ take }: { take?: number }) => newest(table.rows).slice(0, take ?? 100)),
      aggregate: vi.fn(async () => ({ _max: { confirmedAt: table.rows.length ? new Date(Math.max(...table.rows.map((r) => r.confirmedAt.getTime()))) : null } })),
      createMany: vi.fn(async ({ data }: { data: Array<Omit<Row, 'id'>> }) => {
        let count = 0;
        for (const row of data) {
          if (table.rows.some((r) => r.source === row.source && r.observedOn.getTime() === row.observedOn.getTime())) continue;
          table.rows.push({ ...row, id: `rate-${table.rows.length + 1}` });
          count += 1;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { observedOn: Date }; data: { confirmedAt: Date } }) => {
        const hit = table.rows.filter((r) => r.observedOn.getTime() === where.observedOn.getTime());
        for (const row of hit) row.confirmedAt = data.confirmedAt;
        return { count: hit.length };
      }),
    },
  };
});
vi.mock('@portal/db', () => ({ adminDb: db, Prisma: { Decimal: db.Decimal } }));

import type { PricingResponse } from '@portal/schemas';
import type { FxObservation } from './bank-of-canada.client';
import { ExchangeRatesService, implausibleMove, rateAgeDays, refreshDue } from './exchange-rates.service';
import { FX_SETTING_DEFAULTS, cadRounding, fxSettingsFromEnv } from './fx-settings';

const NOV = (day: number, hour = 21) => new Date(Date.UTC(2026, 10, day, hour));
const WEEK: FxObservation[] = [
  { observedOn: '2026-11-17', rate: '1.4291' },
  { observedOn: '2026-11-16', rate: '1.4298' },
  { observedOn: '2026-11-13', rate: '1.4257' },
];

function harness(settings: Partial<typeof FX_SETTING_DEFAULTS> = {}) {
  const locks = new Set<string>();
  const cache = {
    remember: vi.fn(async (_key: string, _ttl: number, load: () => Promise<unknown>) => ({ value: await load(), hit: false })),
    del: vi.fn(async (...keys: string[]) => (keys.forEach((k) => locks.delete(k)), keys.length)),
    acquireLock: vi.fn(async (key: string) => (locks.has(key) ? false : (locks.add(key), true))),
  };
  const resolved = { ...FX_SETTING_DEFAULTS, ...settings };
  const config = {
    settings: vi.fn(async () => ({ settings: resolved })),
    pricingResponse: vi.fn(async (): Promise<PricingResponse> => PRICING),
  };
  const source = { source: 'bank_of_canada', series: 'FXUSDCAD', recent: vi.fn<() => Promise<FxObservation[]>>() };
  const alerts = { send: vi.fn(async () => undefined) };
  const service = new ExchangeRatesService(cache as never, config as never, source as never, alerts as never);
  return { service, cache, config, source, alerts, resolved };
}

const pack = (id: string, price_cents: number, credits: number) => ({
  id,
  name: id,
  price_cents,
  currency: 'USD' as const,
  credits,
  bonus_credits: 0,
  plan_tier: id as 'starter',
  concurrency_cap: 2,
  kb_allowance: 0,
  max_agents: 1,
  max_numbers: 1,
  feature_gates: [],
  badge: null,
  description: null,
  sort_order: 0,
});
const PRICING: PricingResponse = {
  version: 3,
  effective_at: '2026-11-01T00:00:00.000Z',
  currency: 'USD',
  base_currency: 'USD',
  fx: null,
  currency_unavailable: false,
  packs: [pack('starter', 4_900, 150), pack('growth', 14_900, 500), pack('scale', 39_900, 1_500), pack('pro', 99_900, 4_500)],
  rates: { standard_per_min: 1, premium_per_min: 1.5, web_call_per_min: null, toll_free_surcharge_per_min: 0, transferred_leg_per_min: 0.25, rounding_dp: 2 },
  recurring: { number_rental_credits: 15, extra_kb_credits: 30, release_after_days_at_zero_balance: 30, rental_warning_days: [7] },
  wallet_policy: { trial_credits: 20, trial_validity_days: 30, credit_expiry_months: 12, grace_overdraft_credits: 10, low_balance_thresholds_pct: [20, 5, 0], auto_topup_default_on: true, auto_topup_threshold_pct: 10 },
};

beforeEach(() => {
  table.rows = [];
  vi.clearAllMocks();
});

describe('refresh', () => {
  it('stores the published rate with its business day, source and series, and puts it in force', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    const result = await h.service.refresh(NOV(17));
    expect(result).toMatchObject({ outcome: 'stored', added: 3, rate: { rate: '1.4291', observedOn: '2026-11-17', source: 'bank_of_canada', series: 'FXUSDCAD' } });
    expect(await h.service.current()).toMatchObject({ rate: '1.4291', observedOn: '2026-11-17' });
    expect(h.alerts.send).not.toHaveBeenCalled();
  });

  it('keeps every day as history: a new day is a new row, earlier rows are untouched', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK.slice(1));
    await h.service.refresh(NOV(16));
    const before = table.rows.map((r) => ({ ...r }));
    h.source.recent.mockResolvedValue(WEEK);
    const result = await h.service.refresh(NOV(17));
    expect(result).toMatchObject({ outcome: 'stored', added: 1 });
    expect(table.rows).toHaveLength(3);
    for (const old of before) expect(table.rows.find((r) => r.id === old.id)).toMatchObject({ rate: old.rate, fetchedAt: old.fetchedAt });
    expect((await h.service.history()).map((r) => r.observedOn)).toEqual(['2026-11-17', '2026-11-16', '2026-11-13']);
  });

  it('a second refresh the same day adds nothing and only records that it succeeded', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17, 21));
    const result = await h.service.refresh(NOV(17, 23));
    expect(result).toMatchObject({ outcome: 'unchanged', rate: { rate: '1.4291' } });
    expect(table.rows).toHaveLength(3);
    expect(await h.service.lastRefreshAt()).toEqual(NOV(17, 23));
  });

  it('on a weekend or a holiday the newest rate is the last business day: unchanged, not a failure', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK.slice(2)); // Friday 13 Nov
    await h.service.refresh(NOV(13));
    const saturday = await h.service.refresh(NOV(14));
    const sunday = await h.service.refresh(NOV(15));
    expect(saturday.outcome).toBe('unchanged');
    expect(sunday.outcome).toBe('unchanged');
    expect(await h.service.current()).toMatchObject({ rate: '1.4257', observedOn: '2026-11-13' });
    expect(h.alerts.send).not.toHaveBeenCalled();
  });

  it('adds the days it missed after an outage', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue([{ observedOn: '2026-11-10', rate: '1.4181' }]);
    await h.service.refresh(NOV(10));
    h.source.recent.mockResolvedValue([...WEEK, { observedOn: '2026-11-12', rate: '1.4255' }, { observedOn: '2026-11-10', rate: '1.4181' }]);
    expect(await h.service.refresh(NOV(17))).toMatchObject({ outcome: 'stored', added: 4 });
  });

  it.each([
    ['a timeout', () => Promise.reject(new Error('The operation was aborted due to timeout'))],
    ['an HTTP 503', () => Promise.reject(new Error('the exchange-rate source answered 503'))],
    ['an answer with no usable rate', () => Promise.resolve([])],
  ])('on %s it keeps the last valid rate, stores nothing and alerts operations', async (_name, answer) => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17));
    h.source.recent.mockImplementation(answer);
    const result = await h.service.refresh(NOV(18));
    expect(result.outcome).toBe('failed');
    expect(table.rows).toHaveLength(3);
    expect(await h.service.current()).toMatchObject({ rate: '1.4291', observedOn: '2026-11-17' });
    expect(h.alerts.send).toHaveBeenCalledTimes(1);
    expect(h.alerts.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fx_refresh_failed', severity: 'warning', fields: expect.objectContaining({ rate_in_force: '1.4291', observed_on: '2026-11-17' }) }));
  });

  it('with no rate ever stored a failure is critical, and still no rate is invented', async () => {
    const h = harness();
    h.source.recent.mockRejectedValue(new Error('fetch failed'));
    expect((await h.service.refresh(NOV(18))).outcome).toBe('failed');
    expect(await h.service.current()).toBeNull();
    expect(table.rows).toHaveLength(0);
    expect(h.alerts.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fx_refresh_failed', severity: 'critical' }));
  });

  it('alerts once per incident, however many ticks fail, and again after a recovery', async () => {
    const h = harness();
    h.source.recent.mockRejectedValue(new Error('fetch failed'));
    await h.service.refresh(NOV(18, 1));
    await h.service.refresh(NOV(18, 2));
    await h.service.refresh(NOV(18, 3));
    expect(h.alerts.send).toHaveBeenCalledTimes(1);
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(18, 4));
    h.source.recent.mockRejectedValue(new Error('fetch failed'));
    await h.service.refresh(NOV(19, 4));
    expect(h.alerts.send).toHaveBeenCalledTimes(2);
  });

  it('refuses a rate implausibly far from the stored one (a misprint) and keeps the stored rate', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17));
    h.source.recent.mockResolvedValue([{ observedOn: '2026-11-18', rate: '14.291' }, ...WEEK]);
    const result = await h.service.refresh(NOV(18));
    expect(result.outcome).toBe('failed');
    expect(await h.service.current()).toMatchObject({ rate: '1.4291', observedOn: '2026-11-17' });
    expect(h.alerts.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fx_rate_implausible', severity: 'critical' }));
  });

  it('refuses an answer whose newest day is older than the one stored', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17));
    h.source.recent.mockResolvedValue(WEEK.slice(2));
    expect((await h.service.refresh(NOV(18))).outcome).toBe('failed');
    expect(await h.service.current()).toMatchObject({ observedOn: '2026-11-17' });
  });
});

describe('refreshIfDue (the hourly tick)', () => {
  it('asks the source when nothing is stored', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    expect((await h.service.refreshIfDue(NOV(17))).outcome).toBe('stored');
  });

  it('asks once per interval: 23 hours after a success it does not, 24 hours after it does', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refreshIfDue(NOV(17, 21));
    expect((await h.service.refreshIfDue(NOV(18, 20))).outcome).toBe('not_due');
    expect(h.source.recent).toHaveBeenCalledTimes(1);
    expect((await h.service.refreshIfDue(NOV(18, 21))).outcome).toBe('unchanged');
    expect(h.source.recent).toHaveBeenCalledTimes(2);
  });

  it('follows the configured interval without a code change', async () => {
    const h = harness({ fx_refresh_interval_hours: 6 });
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refreshIfDue(NOV(17, 12));
    expect((await h.service.refreshIfDue(NOV(17, 17))).outcome).toBe('not_due');
    expect((await h.service.refreshIfDue(NOV(17, 18))).outcome).toBe('unchanged');
  });

  it('retries on the next tick after a failure rather than a day later', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refreshIfDue(NOV(17, 21));
    h.source.recent.mockRejectedValue(new Error('fetch failed'));
    expect((await h.service.refreshIfDue(NOV(18, 21))).outcome).toBe('failed');
    h.source.recent.mockResolvedValue(WEEK);
    expect((await h.service.refreshIfDue(NOV(18, 22))).outcome).toBe('unchanged');
  });

  it('alerts when the rate in force is stale, once, and still uses it', async () => {
    const h = harness({ fx_stale_after_days: 5 });
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refreshIfDue(NOV(17));
    h.source.recent.mockRejectedValue(new Error('fetch failed'));
    await h.service.refreshIfDue(NOV(21)); // 4 days old: a failed refresh, not stale yet
    expect(h.alerts.send.mock.calls.map((c) => (c as unknown as [{ kind: string }])[0].kind)).toEqual(['fx_refresh_failed']);
    await h.service.refreshIfDue(NOV(22)); // 5 days
    await h.service.refreshIfDue(NOV(22, 22));
    const kinds = h.alerts.send.mock.calls.map((c) => (c as unknown as [{ kind: string }])[0].kind);
    expect(kinds.filter((k) => k === 'fx_rate_stale')).toHaveLength(1);
    expect(await h.service.current()).toMatchObject({ rate: '1.4291' });
  });

  it('a long weekend is not stale: Friday’s rate on the following Tuesday', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK.slice(2));
    await h.service.refreshIfDue(NOV(13));
    await h.service.refreshIfDue(NOV(17, 12));
    expect(h.alerts.send).not.toHaveBeenCalled();
  });
});

describe('quote', () => {
  it('a USD workspace pays the published price and no rate is involved', async () => {
    const h = harness();
    expect(await h.service.quote({ price_cents: 4_900, currency: 'USD' }, 'USD')).toEqual({ amountCents: 4_900, currency: 'USD', baseAmountCents: 4_900, baseCurrency: 'USD', fx: null });
    expect(db.exchangeRate.findFirst).not.toHaveBeenCalled();
  });

  it('a CAD workspace pays the converted, rounded price and the quote names the rate row', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17));
    const quote = await h.service.quote({ price_cents: 14_900, currency: 'USD' }, 'CAD');
    expect(quote).toMatchObject({ amountCents: 21_300, currency: 'CAD', baseAmountCents: 14_900, baseCurrency: 'USD', fx: { rate: '1.4291', observedOn: '2026-11-17' } });
    expect(quote.fx?.id).toBeTruthy();
  });

  it('follows the configured rounding', async () => {
    const h = harness({ cad_rounding_step_cents: 1, cad_rounding_mode: 'nearest' });
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17));
    expect((await h.service.quote({ price_cents: 4_900, currency: 'USD' }, 'CAD')).amountCents).toBe(7_003);
  });

  it('refuses CAD with CURRENCY_UNAVAILABLE when no rate is stored', async () => {
    const h = harness();
    await expect(h.service.quote({ price_cents: 4_900, currency: 'USD' }, 'CAD')).rejects.toMatchObject({ code: 'CURRENCY_UNAVAILABLE' });
  });
});

describe('pricingResponse', () => {
  it('is the published config for USD or no currency', async () => {
    const h = harness();
    expect(await h.service.pricingResponse({})).toMatchObject({ currency: 'USD', fx: null, currency_unavailable: false });
    expect((await h.service.pricingResponse({ currency: 'USD' })).packs.map((p) => p.price_cents)).toEqual([4_900, 14_900, 39_900, 99_900]);
  });

  it('converts every pack for CAD, says which rate, and leaves credits and rates alone', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17));
    const cad = await h.service.pricingResponse({ currency: 'CAD' });
    expect(cad).toMatchObject({ currency: 'CAD', base_currency: 'USD', currency_unavailable: false, fx: { rate: '1.4291', observed_on: '2026-11-17', source: 'bank_of_canada' } });
    expect(cad.packs.map((p) => [p.id, p.price_cents, p.currency, p.credits])).toEqual([
      ['starter', 7_000, 'CAD', 150],
      ['growth', 21_300, 'CAD', 500],
      ['scale', 57_000, 'CAD', 1_500],
      ['pro', 142_800, 'CAD', 4_500],
    ]);
    expect(cad.rates).toEqual(PRICING.rates);
    expect(cad.recurring).toEqual(PRICING.recurring);
    expect(cad.wallet_policy).toEqual(PRICING.wallet_policy);
  });

  it('one pack that cannot be priced is left out; it never takes the catalogue off sale', async () => {
    const h = harness();
    const mixed = { ...PRICING, packs: [...PRICING.packs, { ...pack('maple', 7_000, 150), currency: 'CAD' as const }] };
    h.config.pricingResponse.mockResolvedValue(mixed);
    // USD, before any rate exists: the USD packs are on sale, the CAD-published one is not listed.
    const usd = await h.service.pricingResponse({ currency: 'USD' });
    expect(usd).toMatchObject({ currency: 'USD', currency_unavailable: false });
    expect(usd.packs.map((p) => [p.id, p.price_cents, p.currency])).toEqual([['starter', 4_900, 'USD'], ['growth', 14_900, 'USD'], ['scale', 39_900, 'USD'], ['pro', 99_900, 'USD']]);
    expect((await h.service.pricingResponse({})).currency_unavailable).toBe(false);

    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17));
    const cad = await h.service.pricingResponse({ currency: 'CAD' });
    expect(cad.currency_unavailable).toBe(false);
    expect(cad.packs.map((p) => [p.id, p.price_cents, p.currency])).toEqual([['starter', 7_000, 'CAD'], ['growth', 21_300, 'CAD'], ['scale', 57_000, 'CAD'], ['pro', 142_800, 'CAD'], ['maple', 7_000, 'CAD']]);
  });

  it('a pack the rounding rule converts to nothing is not listed at 0', async () => {
    const h = harness({ cad_rounding_step_cents: 10_000, cad_rounding_mode: 'down' });
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17));
    const cad = await h.service.pricingResponse({ currency: 'CAD' });
    expect(cad.packs.map((p) => [p.id, p.price_cents])).toEqual([['growth', 20_000], ['scale', 50_000], ['pro', 140_000]]);
    await expect(h.service.quote(PRICING.packs[0]!, 'CAD')).rejects.toMatchObject({ code: 'CURRENCY_UNAVAILABLE' });
  });

  it('with no rate it lists the USD prices and says CAD is unavailable; it never labels a USD figure CAD', async () => {
    const h = harness();
    const cad = await h.service.pricingResponse({ currency: 'CAD' });
    expect(cad).toMatchObject({ currency: 'USD', fx: null, currency_unavailable: true });
    expect(cad.packs.every((p) => p.currency === 'USD')).toBe(true);
    expect(cad.packs.map((p) => p.price_cents)).toEqual([4_900, 14_900, 39_900, 99_900]);
  });

  it('what GET /pricing shows is what quote() charges, pack by pack', async () => {
    const h = harness();
    h.source.recent.mockResolvedValue(WEEK);
    await h.service.refresh(NOV(17));
    const shown = await h.service.pricingResponse({ currency: 'CAD' });
    for (const p of PRICING.packs) {
      const charged = await h.service.quote(p, 'CAD');
      expect(shown.packs.find((s) => s.id === p.id)?.price_cents).toBe(charged.amountCents);
    }
  });
});

describe('pure rules', () => {
  it('rateAgeDays counts calendar days from the rate’s business day', () => {
    expect(rateAgeDays('2026-11-17', NOV(17, 23))).toBe(0);
    expect(rateAgeDays('2026-11-13', NOV(16, 1))).toBe(3);
    expect(rateAgeDays('2026-11-18', NOV(17))).toBe(0);
  });

  it('refreshDue: never refreshed, or a full interval ago', () => {
    expect(refreshDue(null, 24, NOV(17))).toBe(true);
    expect(refreshDue(NOV(16, 21), 24, NOV(17, 20))).toBe(false);
    expect(refreshDue(NOV(16, 21), 24, NOV(17, 21))).toBe(true);
    expect(refreshDue(NOV(17, 20), 1, NOV(17, 21))).toBe(true);
  });

  it('refreshDue: a tick a moment early is still the daily tick, not next hour’s', () => {
    const last = new Date('2026-11-16T16:20:01.500Z');
    expect(refreshDue(last, 24, new Date('2026-11-17T16:20:01.200Z'))).toBe(true);
    expect(refreshDue(last, 24, new Date('2026-11-17T15:20:01.200Z'))).toBe(false);
  });

  it('implausibleMove compares in integers and treats an unreadable rate as implausible', () => {
    expect(implausibleMove('1.4291', '1.4298', 10)).toBe(false);
    expect(implausibleMove('1.4000', '1.5400', 10)).toBe(false); // exactly 10 %
    expect(implausibleMove('1.4000', '1.5401', 10)).toBe(true);
    expect(implausibleMove('1.4000', '1.2599', 10)).toBe(true);
    expect(implausibleMove('1.4291', '14.291', 10)).toBe(true);
    expect(implausibleMove('1.4291', '0', 10)).toBe(true);
    expect(implausibleMove('bad', '1.4291', 10)).toBe(true);
  });
});

describe('settings', () => {
  it('default to the proposal: Bank of Canada, daily, nearest whole dollar', () => {
    expect(fxSettingsFromEnv({})).toEqual({ fx_source: 'bank_of_canada', fx_refresh_interval_hours: 24, fx_stale_after_days: 5, fx_max_move_pct: 10, cad_rounding_step_cents: 100, cad_rounding_mode: 'nearest' });
    expect(cadRounding(FX_SETTING_DEFAULTS)).toEqual({ step_cents: 100, mode: 'nearest' });
  });

  it('are read from the environment, so a change needs no code', () => {
    expect(fxSettingsFromEnv({ FX_REFRESH_INTERVAL_HOURS: '12', FX_STALE_AFTER_DAYS: '3', FX_MAX_MOVE_PCT: '5', CAD_ROUNDING_STEP_CENTS: '5', CAD_ROUNDING_MODE: 'up' })).toMatchObject({
      fx_refresh_interval_hours: 12,
      fx_stale_after_days: 3,
      fx_max_move_pct: 5,
      cad_rounding_step_cents: 5,
      cad_rounding_mode: 'up',
    });
  });

  it('fall back to the default on a value that is unset, not a number or out of range', () => {
    expect(fxSettingsFromEnv({ FX_REFRESH_INTERVAL_HOURS: '0', FX_STALE_AFTER_DAYS: 'soon', CAD_ROUNDING_STEP_CENTS: '-100', CAD_ROUNDING_MODE: 'bankers', FX_SOURCE: 'ecb', FX_MAX_MOVE_PCT: '1.5' })).toEqual(FX_SETTING_DEFAULTS);
  });
});
