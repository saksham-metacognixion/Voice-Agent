import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import type { PricingConfig, PricingPack, StripeSyncResult } from '@portal/schemas';
import { StripeGateway } from './stripe.gateway';

/** One (pack, currency) row of `stripe_price_map`. */
export interface PriceMapRow {
  packId: string;
  currency: string;
  stripeProductId: string;
  stripePriceId: string;
  active: boolean;
}

export type PlannedAction =
  | { action: 'reuse'; packId: string; currency: string; detail: string; row: PriceMapRow }
  | {
      action: 'create';
      packId: string;
      currency: string;
      detail: string;
      pack: PricingPack;
      productId: string | null;
      archive: PriceMapRow | null;
    }
  | { action: 'archive'; packId: string; currency: string; detail: string; row: PriceMapRow };

/**
 * Stripe wants a stable, unique key per price; this is ours. The environment is part of it:
 * dev and staging share one Stripe test account, and without it staging's v2 would find — and
 * sell at — the Price a laptop created for *its* v2 (lookup keys are unique per account).
 */
export function lookupKey(env: string, packId: string, currency: string, version: number): string {
  return `${env}_pack_${packId}_${currency.toLowerCase()}_v${version}`;
}

/**
 * Admin §5.2 step 3, as a pure plan: what the new version needs from Stripe given the
 * rows the version *currently in effect* has.
 *
 *   - same amount and currency as before  → reuse the current Price (copy the row)
 *   - a new or re-priced (pack, currency) → create a Price on the pack's Product; the
 *                                            current Price is archived once the new
 *                                            version is in effect
 *   - a pack that left the config          → its Price is archived once the new version
 *                                            is in effect
 *
 * Prices in Stripe are immutable, so "changed" always means a new Price object; the old
 * one is archived so it cannot be picked by hand in the dashboard. Products are keyed by
 * pack id and outlive prices. Exported so the SA5 preview shows exactly what publish will
 * do before anything leaves our systems.
 *
 * `previous` must be the version checkout sells *today*, whatever version the config was
 * copied from: a rollback planned against the target's own rows reads as "all reuse" and
 * copies Price ids the current version archived, and every purchase after it fails on an
 * inactive Price (review, 28 Sep).
 */
export function planPriceSync(
  next: PricingConfig,
  previous: PricingConfig | null,
  previousRows: PriceMapRow[],
): PlannedAction[] {
  const prevPack = new Map((previous?.packs ?? []).map((p) => [`${p.id}:${p.currency}`, p]));
  const prevRow = new Map(
    previousRows.filter((r) => r.active).map((r) => [`${r.packId}:${r.currency}`, r]),
  );
  const productFor = new Map<string, string>();
  for (const r of previousRows) productFor.set(r.packId, r.stripeProductId);

  const actions: PlannedAction[] = [];
  const seen = new Set<string>();
  for (const pack of next.packs) {
    if (!pack.active) continue;
    const key = `${pack.id}:${pack.currency}`;
    seen.add(key);
    const before = prevPack.get(key);
    const row = prevRow.get(key);
    if (before && row && before.price_cents === pack.price_cents) {
      actions.push({
        action: 'reuse',
        packId: pack.id,
        currency: pack.currency,
        detail: `${pack.price_cents} ${pack.currency} unchanged — keeps ${row.stripePriceId}`,
        row,
      });
      continue;
    }
    actions.push({
      action: 'create',
      packId: pack.id,
      currency: pack.currency,
      detail:
        before && row
          ? `${before.price_cents} → ${pack.price_cents} ${pack.currency} — new Price; ${row.stripePriceId} archived once in effect`
          : `${pack.price_cents} ${pack.currency} — new Price${productFor.has(pack.id) ? '' : ' and Product'}`,
      pack,
      productId: productFor.get(pack.id) ?? null,
      archive: row ?? null,
    });
  }
  for (const [key, row] of prevRow) {
    if (seen.has(key)) continue;
    actions.push({
      action: 'archive',
      packId: row.packId,
      currency: row.currency,
      detail: `pack no longer sold — ${row.stripePriceId} archived once in effect`,
      row,
    });
  }
  return actions;
}

/**
 * Executes the plan for one published version, look-before-you-buy (ADR 0013 §2): a
 * Price is searched by its lookup key before it is created, and every row is persisted
 * as soon as Stripe answers, so a run that dies half-way resumes where it stopped and
 * never creates a second Price for the same (pack, currency, version). `sync()` never
 * throws for Stripe's sake — the result says `failed` with the message, and the caller
 * decides what that means for the version (it stays unpublished, admin §5.2).
 */
@Injectable()
export class StripePriceSyncService {
  private readonly log = new Logger(StripePriceSyncService.name);

  constructor(private readonly stripe: StripeGateway) {}

  async rowsFor(version: number): Promise<PriceMapRow[]> {
    const rows = await adminDb.stripePriceMap.findMany({ where: { configVersion: version } });
    return rows.map((r) => ({
      packId: r.packId,
      currency: r.currency,
      stripeProductId: r.stripeProductId,
      stripePriceId: r.stripePriceId,
      active: r.active,
    }));
  }

  async sync(input: {
    version: number;
    config: PricingConfig;
    previousVersion: number | null;
    previousConfig: PricingConfig | null;
  }): Promise<StripeSyncResult> {
    const previousRows =
      input.previousVersion === null ? [] : await this.rowsFor(input.previousVersion);
    const plan = planPriceSync(input.config, input.previousConfig, previousRows);
    const done = new Map(
      (await this.rowsFor(input.version)).map((r) => [`${r.packId}:${r.currency}`, r]),
    );

    if (!this.stripe.config.configured) {
      // A dev box without keys. Recorded as skipped, never as synced: checkout falls back
      // to inline price data (BillingService.createCheckout) and `pnpm doctor` is loud.
      this.log.warn(
        `pricing v${input.version}: Stripe is not configured, price sync skipped (${plan.length} planned actions)`,
      );
      return {
        status: 'skipped',
        synced_at: new Date().toISOString(),
        error: null,
        prices: [...done.values()].map(toRow),
      };
    }

    try {
      for (const step of plan) {
        const key = `${step.packId}:${step.currency}`;
        if (step.action === 'reuse') {
          if (!done.has(key))
            done.set(key, await this.persist(input.version, { ...step.row, active: true }));
          continue;
        }
        // Archives are not executed here: the rows being superseded are the ones checkout
        // sells until this version is in effect. `archiveSuperseded()` runs after the flip.
        if (step.action === 'archive') continue;
        if (done.has(key)) continue;
        const productId = step.productId ?? (await this.stripe.ensureProduct(step.pack));
        const lookup = lookupKey(this.stripe.config.env, step.packId, step.currency, input.version);
        // Look before you buy, but only reuse a Price that sells what this version says: a key
        // left by an abandoned attempt at another amount is taken over, never charged.
        const found = await this.stripe.findPriceByLookupKey(lookup);
        const reusable =
          found !== null &&
          found.unitAmount === step.pack.price_cents &&
          found.currency === step.pack.currency.toLowerCase() &&
          found.productId === productId;
        const priceId = reusable
          ? found.id
          : await this.stripe.createPrice({
              productId,
              pack: step.pack,
              lookupKey: lookup,
              transferLookupKey: found !== null,
            });
        done.set(
          key,
          await this.persist(input.version, {
            packId: step.packId,
            currency: step.currency,
            stripeProductId: productId,
            stripePriceId: priceId,
            active: true,
          }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.log.error(`pricing v${input.version}: Stripe price sync failed — ${message}`);
      return {
        status: 'failed',
        synced_at: null,
        error: message.slice(0, 500),
        prices: [...done.values()].map(toRow),
      };
    }
    this.log.log(`pricing v${input.version}: Stripe prices in sync (${done.size} rows)`);
    return {
      status: 'synced',
      synced_at: new Date().toISOString(),
      error: null,
      prices: [...done.values()].map(toRow),
    };
  }

  /**
   * Archives, on Stripe and in `stripe_price_map`, every Price an *earlier effective*
   * version sold that the version now in effect does not. Runs only once `current` is
   * what checkout sells — after the publish transaction, or at the next publish for a
   * version that was dated ahead — never during the sync: a Price archived while its
   * version is still current fails every purchase of that pack until the new version
   * lands, and a sync that then dies leaves it archived for good (review, 28 Sep).
   * Best-effort and idempotent: a Stripe failure is logged and the row stays `active`,
   * which is harmless (checkout reads the current version's rows only) and retried on
   * the next call.
   */
  async archiveSuperseded(current: number): Promise<number> {
    const [currentRows, older] = await Promise.all([
      this.rowsFor(current),
      adminDb.stripePriceMap.findMany({
        where: {
          active: true,
          configVersion: { not: current },
          config: { effectiveAt: { not: null, lte: new Date() } },
        },
      }),
    ]);
    const superseded = supersededPriceRows(
      currentRows,
      older.map((r) => ({
        version: r.configVersion,
        packId: r.packId,
        currency: r.currency,
        stripeProductId: r.stripeProductId,
        stripePriceId: r.stripePriceId,
        active: r.active,
      })),
    );
    let archived = 0;
    for (const row of superseded) {
      try {
        if (this.stripe.config.configured) await this.stripe.archivePrice(row.stripePriceId);
        await adminDb.stripePriceMap.update({
          where: {
            packId_currency_configVersion: {
              packId: row.packId,
              currency: row.currency,
              configVersion: row.version,
            },
          },
          data: { active: false },
        });
        archived += 1;
      } catch (error) {
        this.log.warn(
          `pricing v${current}: could not archive ${row.stripePriceId} (v${row.version} ${row.packId}/${row.currency}): ${String(error)}`,
        );
      }
    }
    if (archived) this.log.log(`pricing v${current}: ${archived} superseded Stripe price(s) archived`);
    return archived;
  }

  private async persist(version: number, row: PriceMapRow): Promise<PriceMapRow> {
    await adminDb.stripePriceMap.upsert({
      where: {
        packId_currency_configVersion: {
          packId: row.packId,
          currency: row.currency,
          configVersion: version,
        },
      },
      create: {
        packId: row.packId,
        currency: row.currency,
        configVersion: version,
        stripeProductId: row.stripeProductId,
        stripePriceId: row.stripePriceId,
        active: row.active,
      },
      update: {
        stripeProductId: row.stripeProductId,
        stripePriceId: row.stripePriceId,
        active: row.active,
      },
    });
    return row;
  }
}

/**
 * The rows of earlier effective versions whose Price the current version no longer sells.
 * A Price the current version reused is shared by id and stays active whatever row it
 * came from. Pure, for the test.
 */
export function supersededPriceRows(
  current: PriceMapRow[],
  older: Array<PriceMapRow & { version: number }>,
): Array<PriceMapRow & { version: number }> {
  const live = new Set(current.filter((r) => r.active).map((r) => r.stripePriceId));
  return older.filter((r) => r.active && !live.has(r.stripePriceId));
}

function toRow(r: PriceMapRow): StripeSyncResult['prices'][number] {
  return {
    pack_id: r.packId,
    currency: r.currency,
    stripe_product_id: r.stripeProductId,
    stripe_price_id: r.stripePriceId,
    active: r.active,
  };
}

export type { Prisma };
