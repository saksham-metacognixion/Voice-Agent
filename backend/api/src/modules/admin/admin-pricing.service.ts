import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import {
  type AdminPricingDraftRequest,
  type AdminPricingDraftResponse,
  type AdminPricingPreviewResponse,
  type AdminPricingPublishRequest,
  type AdminPricingRollbackRequest,
  type AdminPricingVersion,
  type AdminPricingVersionDetail,
  type AdminRetellCostsResponse,
  type PricingConfig,
  type RetellCostInputs,
  type StaffActionRequest,
  type StripeSyncResult,
  pricingConfig,
  rateForTier,
  retellCostInputs,
  stripeSyncResult,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { StaffContext } from '../auth';
import { StripePriceSyncService, planPriceSync } from '../billing';
import { PlatformConfigService } from '../config';
import { DAY_MS, iso, uuidParam } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';

const PENDING: StripeSyncResult = { status: 'pending', synced_at: null, error: null, prices: [] };

/**
 * SA5 (D12 §13–§14, admin §5): draft → preview → publish → rollback.
 *
 * A version is a `pricing_configs` row and versions are immutable — publish only ever
 * inserts, rollback inserts a copy of an older one, and history is the table. The Stripe
 * sync (admin §5.2 step 3) is the one step that leaves our systems, so it runs *between*
 * the insert and `effective_at`: a version whose sync failed stays with `effective_at`
 * NULL, is never served by `GET /pricing`, keeps the draft, and can be published again —
 * the same row is resumed and the sync picks up where it stopped (look-before-you-buy on
 * Stripe's lookup keys). Only a synced (or, on a keyless dev box, skipped) version becomes
 * effective, and that flip is what invalidates `pricing:current` / `flags:*` / `caps:*`
 * so the portal re-reads within the 60 s TTL (§20 of the D12 brief; admin §5.3).
 */
@Injectable()
export class AdminPricingService {
  private readonly log = new Logger(AdminPricingService.name);

  constructor(
    private readonly config: PlatformConfigService,
    private readonly prices: StripePriceSyncService,
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
  ) {}

  // ------------------------------------------------------------------ draft

  async draft(): Promise<AdminPricingDraftResponse> {
    const [row, current] = await Promise.all([
      adminDb.pricingDraft.findFirst({ orderBy: { updatedAt: 'desc' } }),
      this.config.currentPricing(),
    ]);
    if (!row)
      return {
        id: null,
        based_on_version: null,
        current_version: current.version,
        config: current.config,
        edited_by: null,
        edited_by_email: null,
        updated_at: null,
      };
    const editor = row.editedBy
      ? await adminDb.staffUser.findUnique({ where: { id: row.editedBy }, select: { email: true } })
      : null;
    return {
      id: row.id,
      based_on_version: row.basedOnVersion,
      current_version: current.version,
      config: pricingConfig.parse(row.configJson),
      edited_by: row.editedBy,
      edited_by_email: editor?.email ?? null,
      updated_at: row.updatedAt.toISOString(),
    };
  }

  async saveDraft(
    staff: StaffContext,
    body: AdminPricingDraftRequest,
    request: FastifyRequest,
  ): Promise<AdminPricingDraftResponse> {
    await this.limits.assertCan(staff, 'can_edit_pricing_draft');
    const config = pricingConfig.parse(body.config);
    const current = await this.config.currentPricing();
    const existing = await adminDb.pricingDraft.findFirst({ orderBy: { updatedAt: 'desc' } });
    const data = {
      basedOnVersion: current.version,
      configJson: config as unknown as Prisma.InputJsonValue,
      editedBy: staff.staffId,
    };
    // The row and its audit row commit together (QA-039: no audit row, no write).
    await adminDb.$transaction(async (tx) => {
      const row = existing
        ? await tx.pricingDraft.update({ where: { id: existing.id }, data })
        : await tx.pricingDraft.create({ data });
      await this.audit.record(
        {
          staff,
          action: 'pricing.draft_saved',
          targetType: 'pricing_draft',
          targetId: row.id,
          after: {
            based_on_version: current.version,
            changes: diffConfig(current.config, config).length,
          },
          request,
        },
        tx,
      );
    });
    return this.draft();
  }

  async discardDraft(staff: StaffContext, body: StaffActionRequest, request: FastifyRequest): Promise<{ deleted: boolean }> {
    await this.limits.assertCan(staff, 'can_edit_pricing_draft');
    const count = await adminDb.$transaction(async (tx) => {
      const { count } = await tx.pricingDraft.deleteMany({});
      if (count)
        await this.audit.record(
          {
            staff,
            action: 'pricing.draft_discarded',
            targetType: 'pricing_draft',
            reasonCode: body.reason_code,
            note: body.note ?? null,
            request,
          },
          tx,
        );
      return count;
    });
    return { deleted: count > 0 };
  }

  // ------------------------------------------------------------------ preview

  async preview(): Promise<AdminPricingPreviewResponse> {
    const [draftRow, current, latest, costs] = await Promise.all([
      adminDb.pricingDraft.findFirst({ orderBy: { updatedAt: 'desc' } }),
      this.config.currentPricing(),
      adminDb.pricingConfig.aggregate({ _max: { version: true } }),
      this.costInputs(),
    ]);
    const draft = draftRow ? pricingConfig.parse(draftRow.configJson) : current.config;
    const changes = diffConfig(current.config, draft);
    const currentIds = new Set(current.config.packs.filter((p) => p.active).map((p) => p.id));
    const draftIds = new Set(draft.packs.filter((p) => p.active).map((p) => p.id));
    const added = [...draftIds].filter((id) => !currentIds.has(id));
    const removed = [...currentIds].filter((id) => !draftIds.has(id));
    const changed = [
      ...new Set(
        changes
          .map((c) => /^packs\.([^.]+)\./.exec(c.path)?.[1])
          .filter((id): id is string => Boolean(id) && currentIds.has(id!) && draftIds.has(id!)),
      ),
    ];
    const previousRows = await this.prices.rowsFor(current.version);
    const stripe = planPriceSync(draft, current.config, previousRows).map((a) => ({
      pack_id: a.packId,
      currency: a.currency,
      action: a.action,
      detail: a.detail,
    }));

    const { margins, blockers } = await this.blockersFor(draft, current.config, costs?.costs ?? null);
    const warnings: string[] = [];
    if (!costs)
      warnings.push(
        'No Retell cost inputs are set (PUT /admin/retell-costs); the margin check cannot run.',
      );
    if (!draftRow)
      warnings.push('There is no draft: the preview compares the current version with itself.');
    return {
      current_version: current.version,
      next_version: (latest._max.version ?? 0) + 1,
      has_draft: Boolean(draftRow),
      changes,
      packs: { added, removed, changed },
      margins,
      stripe,
      blockers,
      warnings,
    };
  }

  /**
   * The admin §5.4 checks for putting `next` in effect in place of `current`: a tier under
   * the margin floor (overridable by a super admin with a note), and a pack bought in the
   * last 12 months that `next` would remove (never overridable). One function for the
   * preview, the publish and the rollback (QA-040) — a rollback is a publish of an old
   * config, and removing a pack someone bought is no safer for being one.
   */
  private async blockersFor(
    next: PricingConfig,
    current: PricingConfig,
    costs: RetellCostInputs | null,
  ): Promise<{ margins: ReturnType<typeof marginsFor>; blockers: string[] }> {
    const margins = marginsFor(next, costs);
    const blockers: string[] = [];
    for (const m of margins)
      if (m.below_floor)
        blockers.push(
          `${m.tier} margin ${m.margin_pct}% is under the ${m.floor_pct}% floor; a super admin can override with a note.`,
        );
    const nextIds = new Set(next.packs.filter((p) => p.active).map((p) => p.id));
    const removed = current.packs.filter((p) => p.active && !nextIds.has(p.id)).map((p) => p.id);
    if (removed.length) {
      const bought = await adminDb.purchase.groupBy({
        by: ['packId'],
        where: {
          packId: { in: removed },
          status: 'paid',
          updatedAt: { gte: new Date(Date.now() - 365 * DAY_MS) },
        },
        _count: { _all: true },
      });
      for (const b of bought)
        blockers.push(
          `Pack "${b.packId}" was bought ${b._count._all} time(s) in the last 12 months and cannot be removed — deactivate it instead.`,
        );
    }
    return { margins, blockers };
  }

  /** Refuses on the hard blockers; the margin floor only with `override_margin` and a note. */
  private assertPublishable(blockers: string[], body: { override_margin: boolean; note?: string }): void {
    const hardBlockers = blockers.filter((b) => !b.includes('margin'));
    if (hardBlockers.length) throw new AppError('CONFLICT', hardBlockers.join(' '));
    const marginBlockers = blockers.filter((b) => b.includes('margin'));
    if (marginBlockers.length && !body.override_margin)
      throw new AppError('MARGIN_FLOOR', marginBlockers.join(' '));
    if (marginBlockers.length && body.override_margin && !body.note)
      throw new AppError('VALIDATION_FAILED', 'Overriding the margin floor needs a note.', [
        { field: 'note', message: 'Required with override_margin' },
      ]);
  }

  // ------------------------------------------------------------------ publish

  async publish(
    staff: StaffContext,
    body: AdminPricingPublishRequest,
    request: FastifyRequest,
  ): Promise<AdminPricingVersion> {
    await this.limits.assertCan(staff, 'can_publish_pricing');
    const draftRow = await adminDb.pricingDraft.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!draftRow)
      throw new AppError('CONFLICT', 'There is no pricing draft to publish. Save one first.');
    const config = pricingConfig.parse(draftRow.configJson);
    const preview = await this.preview();
    this.assertPublishable(preview.blockers, body);
    if (body.effective_at && new Date(body.effective_at).getTime() < Date.now() - 60_000)
      throw new AppError('VALIDATION_FAILED', 'effective_at is in the past.', [
        { field: 'effective_at', message: 'Must be now or later' },
      ]);
    // Caps are applied inside the publish transaction; with a dated version that would move
    // every tenant's concurrency and KB caps days before the pricing that justifies them is
    // served (review, 28 Sep). Refused rather than silently skipped.
    if (
      body.grandfather_mode === 'apply_now' &&
      body.effective_at &&
      new Date(body.effective_at).getTime() > Date.now() + 60_000
    )
      throw new AppError(
        'VALIDATION_FAILED',
        '"Apply new tier caps now" needs an immediate effective date; publish the dated version with keep_until_next_purchase and apply the caps when it is in effect.',
        [{ field: 'grandfather_mode', message: 'Not with a future effective_at' }],
      );

    const current = await this.config.currentPricing();
    // A version dated ahead that has since come into effect still holds the Prices of the
    // one it replaced; settle that before planning against the current rows.
    await this.prices.archiveSuperseded(current.version);
    const version = await this.pendingOrNewVersion(config, staff.staffId);
    const sync = await this.prices.sync({
      version,
      config,
      previousVersion: current.version,
      previousConfig: current.config,
    });
    await adminDb.pricingConfig.update({
      where: { version },
      data: { stripeSyncJson: sync as unknown as Prisma.InputJsonValue },
    });

    if (sync.status === 'failed') {
      await this.audit.record({
        staff,
        action: 'pricing.publish_failed',
        targetType: 'pricing_config',
        targetId: String(version),
        reasonCode: body.reason_code,
        note: body.note ?? null,
        after: { version, stripe: sync.status, error: sync.error },
        request,
      });
      throw new AppError(
        'STRIPE_SYNC_FAILED',
        `Stripe did not accept the price sync (${sync.error}). Version ${version} was created but is not in effect; fix the cause and publish again to resume.`,
      );
    }

    const effectiveAt = body.effective_at ? new Date(body.effective_at) : new Date();
    await adminDb.$transaction(async (tx) => {
      await tx.pricingConfig.update({
        where: { version },
        data: {
          publishedAt: new Date(),
          publishedBy: staff.staffId,
          effectiveAt,
          changeSummary: body.change_summary ?? summarise(preview),
          grandfatherMode: body.grandfather_mode,
        },
      });
      if (body.grandfather_mode === 'apply_now') await applyTierCapsNow(tx, config);
      await tx.pricingDraft.deleteMany({});
      await this.audit.record(
        {
          staff,
          action: 'pricing.published',
          targetType: 'pricing_config',
          targetId: String(version),
          reasonCode: body.reason_code,
          note: body.note ?? null,
          before: { version: current.version },
          after: {
            version,
            effective_at: effectiveAt.toISOString(),
            grandfather_mode: body.grandfather_mode,
            stripe: sync.status,
            override_margin: body.override_margin,
            changes: preview.changes.length,
          },
          request,
        },
        tx,
      );
    });
    // Admin §5.2 step 4: the cache is what the portal reads; drop it now, and the TTL
    // bounds a missed drop at 60 s either way.
    await this.config.invalidateAll();
    // Only now, with the new version in effect, may the Prices it replaced be archived; a
    // dated version's are archived at the next publish or rollback (`archiveSuperseded`).
    if (effectiveAt.getTime() <= Date.now()) await this.prices.archiveSuperseded(version);
    this.log.warn(
      `pricing v${version} published by ${staff.email}, effective ${effectiveAt.toISOString()} (stripe ${sync.status})`,
    );
    return this.version(version);
  }

  /** A version left unpublished by a failed sync with the same config is resumed, not duplicated. */
  private async pendingOrNewVersion(config: PricingConfig, staffId: string): Promise<number> {
    const pending = await adminDb.pricingConfig.findMany({
      where: { effectiveAt: null },
      orderBy: { version: 'desc' },
      take: 5,
    });
    const same = pending.find(
      (p) => JSON.stringify(pricingConfig.parse(p.configJson)) === JSON.stringify(config),
    );
    if (same) return same.version;
    return adminDb.$transaction(async (tx) => {
      const latest = await tx.pricingConfig.aggregate({ _max: { version: true } });
      const next = (latest._max.version ?? 0) + 1;
      await tx.pricingConfig.create({
        data: {
          version: next,
          configJson: config as unknown as Prisma.InputJsonValue,
          publishedBy: staffId,
          effectiveAt: null,
          stripeSyncJson: PENDING as unknown as Prisma.InputJsonValue,
        },
      });
      return next;
    });
  }

  // ------------------------------------------------------------------ versions + rollback

  async versions(): Promise<AdminPricingVersion[]> {
    const [rows, current] = await Promise.all([
      adminDb.pricingConfig.findMany({ orderBy: { version: 'desc' }, take: 50 }),
      this.config.currentPricing(),
    ]);
    const staffIds = [
      ...new Set(rows.map((r) => r.publishedBy).filter((x): x is string => Boolean(x))),
    ];
    const staff = staffIds.length
      ? await adminDb.staffUser.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, email: true },
        })
      : [];
    const emails = new Map(staff.map((s) => [s.id, s.email]));
    return rows.map((r) => toVersion(r, current.version, emails.get(r.publishedBy ?? '') ?? null));
  }

  async version(version: number): Promise<AdminPricingVersionDetail> {
    const row = await adminDb.pricingConfig.findUnique({ where: { version } });
    if (!row) throw AppError.notFound('Pricing version');
    const current = await this.config.currentPricing();
    const publisher = row.publishedBy
      ? await adminDb.staffUser.findUnique({
          where: { id: row.publishedBy },
          select: { email: true },
        })
      : null;
    return {
      ...toVersion(row, current.version, publisher?.email ?? null),
      config: pricingConfig.parse(row.configJson),
    };
  }

  /**
   * Rollback is a new version carrying an older config (history is never rewritten).
   * Its Stripe sync is planned against the version in effect *now*, not the target's own
   * rows: a pack the abandoned version re-priced had the target's Price archived, so the
   * rollback needs a fresh Price for it, while every pack the abandoned version left alone
   * is a reuse. Prices the abandoned version created and nothing sells any more are
   * archived once the rollback is in effect.
   */
  async rollback(
    staff: StaffContext,
    version: number,
    body: AdminPricingRollbackRequest,
    request: FastifyRequest,
  ): Promise<AdminPricingVersion> {
    await this.limits.assertCan(staff, 'can_publish_pricing');
    const target = await adminDb.pricingConfig.findUnique({ where: { version } });
    if (!target || !target.effectiveAt)
      throw new AppError('CONFLICT', 'Only a version that was in effect can be rolled back to.');
    const current = await this.config.currentPricing();
    if (current.version === version)
      throw new AppError('CONFLICT', `Version ${version} is already in effect.`);
    const config = pricingConfig.parse(target.configJson);
    // Publish's checks (QA-040): rolling back to a version without a pack bought since is
    // removing that pack, and an old price may now sit under the margin floor.
    const { blockers } = await this.blockersFor(config, current.config, (await this.costInputs())?.costs ?? null);
    this.assertPublishable(blockers, body);

    // A rollback whose Stripe sync failed left its version unpublished; the retry resumes
    // that version instead of stacking another orphan (QA-040).
    const next = await this.pendingOrNewVersion(config, staff.staffId);
    await this.prices.archiveSuperseded(current.version);
    const sync = await this.prices.sync({
      version: next,
      config,
      previousVersion: current.version,
      previousConfig: current.config,
    });
    await adminDb.pricingConfig.update({
      where: { version: next },
      data: { stripeSyncJson: sync as unknown as Prisma.InputJsonValue },
    });
    if (sync.status === 'failed') {
      await this.audit.record({
        staff,
        action: 'pricing.rollback_failed',
        targetType: 'pricing_config',
        targetId: String(next),
        reasonCode: body.reason_code,
        note: body.note ?? null,
        after: { to: version, stripe: sync.status, error: sync.error },
        request,
      });
      throw new AppError(
        'STRIPE_SYNC_FAILED',
        `Stripe did not accept the price sync (${sync.error}). Version ${next} is not in effect.`,
      );
    }
    await adminDb.$transaction(async (tx) => {
      await tx.pricingConfig.update({
        where: { version: next },
        data: {
          publishedAt: new Date(),
          publishedBy: staff.staffId,
          effectiveAt: new Date(),
          changeSummary: `Rollback to v${version}`,
          grandfatherMode: 'keep_until_next_purchase',
        },
      });
      await tx.pricingDraft.deleteMany({});
      await this.audit.record(
        {
          staff,
          action: 'pricing.rolled_back',
          targetType: 'pricing_config',
          targetId: String(next),
          reasonCode: body.reason_code,
          note: body.note ?? null,
          before: { version: current.version },
          after: { version: next, restored: version, stripe: sync.status },
          request,
        },
        tx,
      );
    });
    await this.config.invalidateAll();
    await this.prices.archiveSuperseded(next);
    this.log.warn(`pricing rolled back to v${version} as v${next} by ${staff.email}`);
    return this.version(next);
  }

  // ------------------------------------------------------------------ Retell cost inputs (admin §5.4, Appendix A)

  async costs(): Promise<AdminRetellCostsResponse> {
    const row = await this.costInputs();
    if (!row) return { version: null, costs: null, updated_by_email: null, updated_at: null };
    const by = row.updatedBy
      ? await adminDb.staffUser.findUnique({
          where: { id: row.updatedBy },
          select: { email: true },
        })
      : null;
    return {
      version: row.version,
      costs: row.costs,
      updated_by_email: by?.email ?? null,
      updated_at: row.updatedAt.toISOString(),
    };
  }

  async saveCosts(
    staff: StaffContext,
    body: RetellCostInputs,
    request: FastifyRequest,
  ): Promise<AdminRetellCostsResponse> {
    await this.limits.assertCan(staff, 'can_edit_pricing_draft');
    const costs = retellCostInputs.parse(body);
    const before = await this.costInputs();
    await adminDb.$transaction(async (tx) => {
      const latest = await tx.retellCostInput.aggregate({ _max: { version: true } });
      await tx.retellCostInput.create({
        data: {
          version: (latest._max.version ?? 0) + 1,
          costsJson: costs as unknown as Prisma.InputJsonValue,
          updatedBy: staff.staffId,
        },
      });
      await this.audit.record(
        {
          staff,
          action: 'pricing.costs_updated',
          targetType: 'retell_cost_inputs',
          before: before?.costs ?? null,
          after: costs,
          request,
        },
        tx,
      );
    });
    return this.costs();
  }

  private async costInputs(): Promise<{
    version: number;
    costs: RetellCostInputs;
    updatedBy: string | null;
    updatedAt: Date;
  } | null> {
    const row = await adminDb.retellCostInput.findFirst({ orderBy: { version: 'desc' } });
    if (!row) return null;
    const parsed = retellCostInputs.safeParse(row.costsJson);
    if (!parsed.success) return null;
    return {
      version: row.version,
      costs: parsed.data,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }
}

// ---------------------------------------------------------------------- pure helpers

/** Dotted-path diff of two configs; packs are keyed by id so a reorder is not a change. */
export function diffConfig(
  before: PricingConfig,
  after: PricingConfig,
): AdminPricingPreviewResponse['changes'] {
  const changes: AdminPricingPreviewResponse['changes'] = [];
  const walk = (path: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys)
        walk(
          path ? `${path}.${k}` : k,
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        );
      return;
    }
    changes.push({ path, before: a ?? null, after: b ?? null });
  };
  const packsBefore = Object.fromEntries(before.packs.map((p) => [p.id, p]));
  const packsAfter = Object.fromEntries(after.packs.map((p) => [p.id, p]));
  walk('packs', packsBefore, packsAfter);
  walk('rates', before.rates, after.rates);
  walk('recurring', before.recurring, after.recurring);
  walk('wallet_policy', before.wallet_policy, after.wallet_policy);
  walk('trial', before.trial, after.trial);
  walk('currency_default', before.currency_default, after.currency_default);
  return changes;
}

/** Per-tier margin at the cheapest public pack's $/credit (admin §5.4, Appendix A). */
export function marginsFor(
  config: PricingConfig,
  costs: RetellCostInputs | null,
): AdminPricingPreviewResponse['margins'] {
  const publicPacks = config.packs.filter((p) => p.active && p.visibility === 'public');
  const centsPerCredit = publicPacks.length
    ? Math.max(...publicPacks.map((p) => p.price_cents / (p.credits + p.bonus_credits)))
    : 0;
  return (['standard', 'premium'] as const).map((tier) => {
    const revenue = Math.round(centsPerCredit * rateForTier(config.rates, tier) * 100) / 100;
    const cost = costs
      ? tier === 'premium'
        ? costs.premium_cents_per_min
        : costs.standard_cents_per_min
      : null;
    const margin =
      cost !== null && revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null;
    const floor = costs?.margin_floor_pct ?? null;
    return {
      tier,
      revenue_cents_per_min: revenue,
      cost_cents_per_min: cost,
      margin_pct: margin,
      floor_pct: floor,
      below_floor: margin !== null && floor !== null && margin < floor,
    };
  });
}

/** Admin §5.2 step 6 "Apply new tier caps to all tenants now": the largest pack of each tier sets the tier's caps. */
async function applyTierCapsNow(
  tx: Prisma.TransactionClient,
  config: PricingConfig,
): Promise<void> {
  const byTier = new Map<string, { concurrencyCap: number; kbAllowance: number }>();
  for (const pack of config.packs.filter((p) => p.active)) {
    const prev = byTier.get(pack.plan_tier);
    if (!prev || pack.credits > 0)
      byTier.set(pack.plan_tier, {
        concurrencyCap: Math.max(prev?.concurrencyCap ?? 0, pack.concurrency_cap),
        kbAllowance: Math.max(prev?.kbAllowance ?? 0, pack.kb_allowance),
      });
  }
  for (const [tier, caps] of byTier)
    await tx.tenant.updateMany({
      where: { planTier: tier as PricingConfig['packs'][number]['plan_tier'] },
      data: caps,
    });
  await tx.tenant.updateMany({
    where: { planTier: 'trial' },
    data: { concurrencyCap: config.trial.concurrency_cap, kbAllowance: config.trial.kb_allowance },
  });
}

function summarise(preview: AdminPricingPreviewResponse): string {
  const parts: string[] = [];
  if (preview.packs.added.length) parts.push(`added ${preview.packs.added.join(', ')}`);
  if (preview.packs.removed.length) parts.push(`removed ${preview.packs.removed.join(', ')}`);
  if (preview.packs.changed.length) parts.push(`changed ${preview.packs.changed.join(', ')}`);
  const other = preview.changes.filter((c) => !c.path.startsWith('packs.')).map((c) => c.path);
  if (other.length) parts.push(other.join(', '));
  return parts.length ? parts.join('; ').slice(0, 500) : 'no changes';
}

function toVersion(
  r: {
    version: number;
    publishedAt: Date | null;
    effectiveAt: Date | null;
    publishedBy: string | null;
    changeSummary: string | null;
    grandfatherMode: string | null;
    stripeSyncJson: unknown;
    configJson: unknown;
  },
  currentVersion: number,
  email: string | null,
): AdminPricingVersion {
  const sync = stripeSyncResult.safeParse(r.stripeSyncJson);
  const packs = pricingConfig.safeParse(r.configJson);
  return {
    version: r.version,
    published_at: iso(r.publishedAt),
    effective_at: iso(r.effectiveAt),
    published_by: r.publishedBy,
    published_by_email: email,
    change_summary: r.changeSummary,
    grandfather_mode: r.grandfatherMode,
    is_current: r.version === currentVersion,
    // Version 1 (the seed) predates the sync and carries no record: shown as skipped, never as pending.
    stripe_sync: sync.success
      ? sync.data
      : { status: r.effectiveAt ? 'skipped' : 'pending', synced_at: null, error: null, prices: [] },
    packs: packs.success ? packs.data.packs.length : 0,
  };
}

export { uuidParam };
