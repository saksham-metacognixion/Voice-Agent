import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import {
  BASE_CURRENCY,
  type CurrencyCode,
  type CurrencyRounding,
  type PricingPack,
  type PricingResponse,
  parseFxRate,
  priceInCurrency,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { OpsAlertService } from '../alerts';
import { RedisCache, redisKeys } from '../redis';
import { BankOfCanadaClient, type FxObservation } from './bank-of-canada.client';
import { cadRounding } from './fx-settings';
import { CONFIG_TTL_S, PlatformConfigService } from './platform-config.service';

/** The derived currency. One pair today: the base (USD) priced in CAD. */
export const QUOTE_CURRENCY: CurrencyCode = 'CAD';

/** A stored rate, as the rest of the API reads it. `rate` is the decimal text, never a float. */
export interface StoredRate {
  id: string;
  rate: string;
  observedOn: string;
  source: string;
  series: string;
  fetchedAt: string;
  confirmedAt: string;
}

/** What one pack costs one workspace right now, and what that figure was derived from. */
export interface PriceQuote {
  amountCents: number;
  currency: CurrencyCode;
  baseAmountCents: number;
  baseCurrency: CurrencyCode;
  /** The rate used; null when no conversion happened. */
  fx: StoredRate | null;
}

export type RefreshOutcome =
  | { outcome: 'stored'; rate: StoredRate; added: number }
  | { outcome: 'unchanged'; rate: StoredRate }
  | { outcome: 'failed'; error: string }
  | { outcome: 'not_due' };

/** How long one open incident keeps its alert quiet: a failing source is retried every tick, ops is told once. */
const ALERT_QUIET_S = 6 * 60 * 60;
const DAY_MS = 24 * 60 * 60_000;

/** Whole days from the business day of a rate to `now` (UTC). A Friday rate is 3 days old on Monday. */
export function rateAgeDays(observedOn: string, now: Date): number {
  return Math.max(0, Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.parse(`${observedOn}T00:00:00Z`)) / DAY_MS));
}

/**
 * How much short of a full interval still counts as due. The tick is hourly and never
 * fires on the same millisecond twice: without this, a tick 300 ms "early" reads
 * 23 h 59 m 59.7 s as not due and the daily refresh slips an hour, again and again.
 */
export const REFRESH_DUE_SLACK_MS = 5 * 60_000;

/** True when the last successful refresh is one interval old (to within the tick's jitter), or there has never been one. */
export function refreshDue(lastConfirmedAt: Date | null, intervalHours: number, now: Date): boolean {
  return lastConfirmedAt === null || now.getTime() - lastConfirmedAt.getTime() >= intervalHours * 60 * 60_000 - REFRESH_DUE_SLACK_MS;
}

/**
 * How far `next` is from `previous`, in percent of `previous`, compared in integers.
 * True when it is further than `maxPct`: a misprint (14.291 for 1.4291) must not reprice
 * every pack, so it is refused and the stored rate stays in force.
 */
export function implausibleMove(previous: string, next: string, maxPct: number): boolean {
  const a = parseFxRate(previous);
  const b = parseFxRate(next);
  if (a === null || b === null) return true;
  const diff = a > b ? a - b : b - a;
  return diff * 100n > a * BigInt(maxPct);
}

/**
 * The USD/CAD exchange rate (ADR 0049): fetched from the configured source, stored as
 * history in `exchange_rates`, and applied to prices and limits in one place.
 *
 * The rate in force is the newest stored business day. A refresh that fails, returns
 * nothing usable or returns an implausible figure changes nothing: the last valid rate
 * stays in force and operations are alerted. There is no fallback rate anywhere in the
 * code; with no row stored, a CAD price does not exist and CAD checkout is refused
 * (`CURRENCY_UNAVAILABLE`).
 */
@Injectable()
export class ExchangeRatesService {
  private readonly log = new Logger(ExchangeRatesService.name);

  constructor(
    private readonly cache: RedisCache,
    private readonly config: PlatformConfigService,
    private readonly source: BankOfCanadaClient,
    private readonly alerts: OpsAlertService,
  ) {}

  // ------------------------------------------------------------------ reads

  /** The rows this service reads and writes: the pair, from the configured source only. Another source's history is never mixed in. */
  private pair(): { baseCurrency: string; quoteCurrency: string; source: string } {
    return { baseCurrency: BASE_CURRENCY, quoteCurrency: QUOTE_CURRENCY, source: this.source.source };
  }

  /** The rate prices are converted with now, or null before the first successful refresh. */
  async current(): Promise<StoredRate | null> {
    const { value } = await this.cache.remember<StoredRate | null>(redisKeys.fxCurrent(this.source.source), CONFIG_TTL_S, () => this.loadCurrent());
    return value;
  }

  private async loadCurrent(): Promise<StoredRate | null> {
    const row = await adminDb.exchangeRate.findFirst({
      where: this.pair(),
      orderBy: [{ observedOn: 'desc' }, { fetchedAt: 'desc' }],
    });
    return row ? toStored(row) : null;
  }

  async history(limit = 30): Promise<StoredRate[]> {
    const rows = await adminDb.exchangeRate.findMany({
      where: this.pair(),
      orderBy: [{ observedOn: 'desc' }, { fetchedAt: 'desc' }],
      take: limit,
    });
    return rows.map(toStored);
  }

  /** The last refresh that reached the source and read a rate, new or not. */
  async lastRefreshAt(): Promise<Date | null> {
    const row = await adminDb.exchangeRate.aggregate({ where: this.pair(), _max: { confirmedAt: true } });
    return row._max.confirmedAt ?? null;
  }

  async rounding(): Promise<CurrencyRounding> {
    return cadRounding((await this.config.settings()).settings);
  }

  // ------------------------------------------------------------------ pricing

  /**
   * What `pack` costs in `currency` now: the published price in its own currency, the
   * converted and rounded figure otherwise. The one function checkout, auto top-up, the
   * review and `GET /pricing` price with, so a screen and a charge cannot disagree.
   * Throws `CURRENCY_UNAVAILABLE` when there is no rate to convert with.
   */
  async quote(pack: Pick<PricingPack, 'price_cents' | 'currency'>, currency: CurrencyCode): Promise<PriceQuote> {
    if (pack.currency === currency) {
      return { amountCents: pack.price_cents, currency, baseAmountCents: pack.price_cents, baseCurrency: pack.currency, fx: null };
    }
    const [fx, rounding] = await Promise.all([this.current(), this.rounding()]);
    const amount = priceInCurrency(pack, currency, fx, rounding);
    if (amount === null || !fx) {
      throw new AppError('CURRENCY_UNAVAILABLE', `Prices in ${currency} are not available right now. Please try again later.`);
    }
    return { amountCents: amount, currency, baseAmountCents: pack.price_cents, baseCurrency: pack.currency, fx };
  }

  /**
   * GET /pricing in `currency`. The base currency (or none) is the published config as it
   * is. A derived currency converts every base-currency pack with the rate in force; with
   * no rate the packs stay at their base price and the answer says `currency_unavailable`,
   * which the portal shows as "not on sale in your currency yet" and checkout refuses.
   *
   * `currency_unavailable` is about the rate and nothing else. One pack that cannot be
   * priced in `currency` — published in another currency, or converted to nothing by the
   * rounding rule — is left out of the list, exactly as `quote()` refuses to sell it; it
   * never takes the rest of the catalogue off sale.
   */
  async pricingResponse(input: { region?: string; pack?: string; currency?: CurrencyCode }): Promise<PricingResponse> {
    const base = await this.config.pricingResponse(input.region, input.pack);
    const target = input.currency ?? BASE_CURRENCY;
    if (base.packs.every((p) => p.currency === target)) return { ...base, currency: target, base_currency: BASE_CURRENCY };
    const converts = base.packs.some((p) => p.currency !== target && p.currency === BASE_CURRENCY);
    if (!converts) {
      return { ...base, currency: target, base_currency: BASE_CURRENCY, packs: base.packs.filter((p) => p.currency === target) };
    }
    const [fx, rounding] = await Promise.all([this.current(), this.rounding()]);
    if (!fx) return { ...base, currency: BASE_CURRENCY, base_currency: BASE_CURRENCY, fx: null, currency_unavailable: true };
    const sellable = base.packs.flatMap((pack) => {
      const cents = priceInCurrency(pack, target, fx, rounding);
      return cents === null ? [] : [{ ...pack, price_cents: cents, currency: target }];
    });
    return {
      ...base,
      currency: target,
      base_currency: BASE_CURRENCY,
      fx: { rate: fx.rate, observed_on: fx.observedOn, source: fx.source },
      currency_unavailable: false,
      packs: sellable,
    };
  }

  // ------------------------------------------------------------------ refresh

  /** The hourly `fx-refresh` tick: refresh when the configured interval has passed, then check staleness either way. */
  async refreshIfDue(now = new Date()): Promise<RefreshOutcome> {
    const { settings } = await this.config.settings();
    const outcome = refreshDue(await this.lastRefreshAt(), settings.fx_refresh_interval_hours, now) ? await this.refresh(now) : ({ outcome: 'not_due' } as const);
    await this.checkStale(now);
    return outcome;
  }

  /**
   * Asks the source and stores what is new. Every failure path returns `failed`, alerts
   * operations once per incident and leaves `exchange_rates` exactly as it was.
   */
  async refresh(now = new Date()): Promise<RefreshOutcome> {
    const { settings } = await this.config.settings();
    let observations: FxObservation[];
    try {
      observations = await this.source.recent();
    } catch (error) {
      return this.failed('refresh_failed', error instanceof Error ? error.message : String(error));
    }
    const newest = observations[0];
    if (!newest) return this.failed('refresh_failed', 'the exchange-rate source published no usable rate');

    const previous = await this.loadCurrent();
    if (previous && newest.observedOn < previous.observedOn) {
      return this.failed('refresh_failed', `the source's newest rate (${newest.observedOn}) is older than the one stored (${previous.observedOn})`);
    }
    if (previous && implausibleMove(previous.rate, newest.rate, settings.fx_max_move_pct)) {
      return this.failed('implausible', `the source published ${newest.rate} for ${newest.observedOn}, more than ${settings.fx_max_move_pct}% from the stored ${previous.rate}`, 'critical');
    }

    // Days already stored are left as they are (history is never rewritten); days the
    // source has that we do not — after an outage, several — are added.
    const fresh = previous ? observations.filter((o) => o.observedOn > previous.observedOn) : observations;
    const { count } = await adminDb.exchangeRate.createMany({
      data: fresh.map((o) => ({
        baseCurrency: BASE_CURRENCY,
        quoteCurrency: QUOTE_CURRENCY,
        rate: new Prisma.Decimal(o.rate),
        observedOn: new Date(`${o.observedOn}T00:00:00Z`),
        source: this.source.source,
        series: this.source.series,
        fetchedAt: now,
        confirmedAt: now,
      })),
      skipDuplicates: true,
    });
    await adminDb.exchangeRate.updateMany({
      where: { ...this.pair(), observedOn: new Date(`${newest.observedOn}T00:00:00Z`) },
      data: { confirmedAt: now },
    });
    await this.cache.del(redisKeys.fxCurrent(this.source.source), redisKeys.fxAlert('refresh_failed'), redisKeys.fxAlert('implausible'));
    const rate = (await this.loadCurrent())!;
    if (count > 0) {
      this.log.log(`exchange rate ${BASE_CURRENCY}/${QUOTE_CURRENCY} ${rate.rate} for ${rate.observedOn} stored (${count} day(s) added)`);
      return { outcome: 'stored', rate, added: count };
    }
    return { outcome: 'unchanged', rate };
  }

  /** The rate in force is still used when it is old; operations are told once a day while it stays so. */
  private async checkStale(now: Date): Promise<void> {
    const [{ settings }, rate] = await Promise.all([this.config.settings(), this.loadCurrent()]);
    if (!rate) return;
    const age = rateAgeDays(rate.observedOn, now);
    if (age < settings.fx_stale_after_days) {
      await this.cache.del(redisKeys.fxAlert('stale'));
      return;
    }
    if (!(await this.cache.acquireLock(redisKeys.fxAlert('stale'), now.toISOString(), DAY_MS / 1000))) return;
    await this.alerts.send({
      kind: 'fx_rate_stale',
      severity: 'warning',
      title: `The ${BASE_CURRENCY}/${QUOTE_CURRENCY} exchange rate is ${age} days old`,
      fields: { rate: rate.rate, observed_on: rate.observedOn, age_days: age, stale_after_days: settings.fx_stale_after_days, source: rate.source },
    });
  }

  private async failed(kind: 'refresh_failed' | 'implausible', error: string, severity: 'warning' | 'critical' = 'warning'): Promise<RefreshOutcome> {
    const inForce = await this.loadCurrent().catch(() => null);
    this.log.error(`exchange-rate refresh failed: ${error}; ${inForce ? `keeping ${inForce.rate} (${inForce.observedOn})` : 'no rate is stored, CAD cannot be priced'}`);
    if (await this.cache.acquireLock(redisKeys.fxAlert(kind), new Date().toISOString(), ALERT_QUIET_S)) {
      await this.alerts.send({
        kind: kind === 'implausible' ? 'fx_rate_implausible' : 'fx_refresh_failed',
        // With no rate at all nothing can be sold in CAD, which is an outage, not a warning.
        severity: inForce ? severity : 'critical',
        title: inForce ? `The ${BASE_CURRENCY}/${QUOTE_CURRENCY} exchange rate could not be refreshed` : `No ${BASE_CURRENCY}/${QUOTE_CURRENCY} exchange rate is stored: CAD purchases are refused`,
        fields: { error: error.slice(0, 300), rate_in_force: inForce?.rate ?? null, observed_on: inForce?.observedOn ?? null, source: this.source.source },
      });
    }
    return { outcome: 'failed', error };
  }
}

function toStored(row: { id: string; rate: Prisma.Decimal; observedOn: Date; source: string; series: string; fetchedAt: Date; confirmedAt: Date }): StoredRate {
  return {
    id: row.id,
    rate: decimalText(row.rate),
    observedOn: row.observedOn.toISOString().slice(0, 10),
    source: row.source,
    series: row.series,
    fetchedAt: row.fetchedAt.toISOString(),
    confirmedAt: row.confirmedAt.toISOString(),
  };
}

/** A stored rate as plain decimal text ("1.4291"), never exponent notation. */
export function decimalText(value: Prisma.Decimal | { toFixed(): string }): string {
  return value.toFixed();
}
