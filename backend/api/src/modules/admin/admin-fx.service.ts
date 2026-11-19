import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { adminDb } from '@portal/db';
import {
  type AdminCustomerCurrencyRequest,
  type AdminFxRefreshResponse,
  type AdminFxResponse,
  BASE_CURRENCY,
  type ExchangeRateResponse,
  type StaffActionRequest,
  priceInCurrency,
  storedCurrency,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { StaffContext } from '../auth';
import { AutoTopupService } from '../billing';
import { ExchangeRatesService, PlatformConfigService, QUOTE_CURRENCY, type StoredRate, cadRounding, rateAgeDays } from '../config';
import { uuidParam } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';

/**
 * ADR 0049, the staff side of two currencies: what SA5 shows about the exchange rate (the
 * base and derived price of every pack, the rate in force, the last successful refresh,
 * how conversion is configured), a refresh on demand, and the one way a workspace's
 * currency changes after its first purchase — a staff write with a reason code.
 */
@Injectable()
export class AdminFxService {
  private readonly log = new Logger(AdminFxService.name);

  constructor(
    private readonly fx: ExchangeRatesService,
    private readonly config: PlatformConfigService,
    private readonly topups: AutoTopupService,
    private readonly audit: StaffAuditService,
  ) {}

  async overview(now = new Date()): Promise<AdminFxResponse> {
    const [{ settings }, pricing, inForce, lastRefresh, history] = await Promise.all([
      this.config.settings(),
      this.config.currentPricing(),
      this.fx.current(),
      this.fx.lastRefreshAt(),
      this.fx.history(30),
    ]);
    const rounding = cadRounding(settings);
    const age = inForce ? rateAgeDays(inForce.observedOn, now) : 0;
    return {
      base_currency: BASE_CURRENCY,
      quote_currency: QUOTE_CURRENCY,
      in_force: inForce ? { ...toResponse(inForce), age_days: age, stale: age >= settings.fx_stale_after_days } : null,
      last_refresh_at: lastRefresh?.toISOString() ?? null,
      next_refresh_due_at: lastRefresh ? new Date(lastRefresh.getTime() + settings.fx_refresh_interval_hours * 60 * 60_000).toISOString() : null,
      settings: {
        fx_source: settings.fx_source,
        fx_refresh_interval_hours: settings.fx_refresh_interval_hours,
        fx_stale_after_days: settings.fx_stale_after_days,
        rounding,
      },
      pricing_version: pricing.version,
      packs: [...pricing.config.packs]
        .sort((a, b) => a.sort_order - b.sort_order || a.price_cents - b.price_cents)
        .map((pack) => ({
          pack_id: pack.id,
          name: pack.name,
          active: pack.active,
          credits: pack.credits,
          base_price_cents: pack.price_cents,
          base_currency: pack.currency,
          derived_price_cents: pack.currency === BASE_CURRENCY ? priceInCurrency(pack, QUOTE_CURRENCY, inForce, rounding) : null,
        })),
      history: history.map(toResponse),
    };
  }

  /**
   * "Refresh now". A new rate reprices every CAD pack and no transaction can hold the
   * source's answer, so it is audited the way a webhook replay is: the request is written
   * first — no audit row, no write — and what the source answered is a second row
   * (`fx.refreshed` / `fx.refresh_failed`). A failure keeps the rate in force, alerts
   * operations as the schedule would, and is reported in the answer rather than thrown,
   * so the console shows why.
   */
  async refresh(staff: StaffContext, body: StaffActionRequest, request: FastifyRequest): Promise<AdminFxRefreshResponse> {
    const before = await this.fx.current();
    const entry = {
      staff,
      targetType: 'exchange_rate',
      targetId: `${BASE_CURRENCY}/${QUOTE_CURRENCY}`,
      reasonCode: body.reason_code,
      note: body.note,
      before: before ? { rate: before.rate, observed_on: before.observedOn } : null,
      request,
    };
    await this.audit.record({ ...entry, action: 'fx.refresh_requested', after: null });

    const result = await this.fx.refresh();
    const outcome = result.outcome === 'stored' || result.outcome === 'unchanged' ? result.outcome : 'failed';
    const error = result.outcome === 'failed' ? result.error : null;
    // The rate is already stored (or not): losing this row must not turn the answer into a 500.
    await this.audit
      .record({
        ...entry,
        action: outcome === 'failed' ? 'fx.refresh_failed' : 'fx.refreshed',
        after: { outcome, ...(result.outcome === 'stored' || result.outcome === 'unchanged' ? { rate: result.rate.rate, observed_on: result.rate.observedOn } : { error: error?.slice(0, 300) }) },
      })
      .catch((e: unknown) => this.log.error(`fx refresh by ${staff.email} ended ${outcome} but its outcome was not audited: ${String(e)}`));
    return { outcome, error, fx: await this.overview() };
  }

  /**
   * A workspace's currency, changed by staff (super admin, ops, finance) with a reason
   * code. The customer can do this themselves until their first purchase; after it, this
   * is the only way. Nothing already charged is touched: purchases, refunds and invoices
   * keep the currency they were made in. Auto top-up is switched off in the same
   * transaction, because the customer agreed to it at prices in the old currency — they
   * switch it back on to agree to the new one.
   */
  async setCustomerCurrency(staff: StaffContext, idRaw: string, body: AdminCustomerCurrencyRequest, request: FastifyRequest): Promise<{ changed: boolean }> {
    const id = uuidParam(idRaw, 'Customer');
    const tenant = await adminDb.tenant.findUnique({ where: { id }, select: { currency: true, autoTopupJson: true } });
    if (!tenant) throw AppError.notFound('Customer');
    const from = storedCurrency(tenant.currency) ?? tenant.currency.trim();
    if (from === body.currency) return { changed: false };
    // A currency nobody can be charged in is not a setting to hand a customer.
    if (body.currency !== BASE_CURRENCY && !(await this.fx.current())) {
      throw new AppError('CURRENCY_UNAVAILABLE', `No exchange rate is stored yet, so nothing can be priced in ${body.currency}. Refresh the rate first.`);
    }
    const topup = AutoTopupService.parse(tenant.autoTopupJson);
    await adminDb.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id }, data: { currency: body.currency } });
      await tx.auditLog.create({
        data: {
          tenantId: id,
          action: 'workspace.currency_changed',
          targetType: 'workspace',
          targetId: id,
          metaJson: { by: 'staff', reason_code: body.reason_code, from, to: body.currency },
        },
      });
      if (topup?.enabled) {
        await this.topups.writeSettings(tx, id, AutoTopupService.disabled(topup), 'disabled', {
          actorUserId: null,
          meta: { by: 'staff', reason_code: body.reason_code, because: 'currency_changed' },
        });
      }
      await this.audit.record(
        {
          staff,
          action: 'customer.currency_changed',
          targetType: 'tenant',
          targetId: id,
          tenantId: id,
          reasonCode: body.reason_code,
          note: body.note,
          before: { currency: from, auto_topup_enabled: topup?.enabled === true },
          after: { currency: body.currency, auto_topup_enabled: false, ticket_id: body.ticket_id ?? null },
          request,
        },
        tx,
      );
    });
    this.log.warn(`workspace ${id} currency ${from} → ${body.currency} by ${staff.email} (${body.reason_code})`);
    return { changed: true };
  }
}

function toResponse(rate: StoredRate): ExchangeRateResponse {
  return {
    id: rate.id,
    base_currency: BASE_CURRENCY,
    quote_currency: QUOTE_CURRENCY,
    rate: rate.rate,
    observed_on: rate.observedOn,
    source: rate.source,
    series: rate.series,
    fetched_at: rate.fetchedAt,
    confirmed_at: rate.confirmedAt,
  };
}
