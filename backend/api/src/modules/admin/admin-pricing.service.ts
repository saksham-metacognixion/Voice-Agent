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
import { AgentStackService } from '../agents';
import { StripePriceSyncService, planPriceSync } from '../billing';
import { PlatformConfigService } from '../config';
import { type AgentStackTiers, type TierStack, providerOfVoiceId, voiceModelFor } from '../retell';
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
    private readonly stack: AgentStackService,
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
    const packs = packChanges(current.config, draft, changes);
    const previousRows = await this.prices.rowsFor(current.version);
    const stripe = planPriceSync(draft, current.config, previousRows).map((a) => ({
      pack_id: a.packId,
      currency: a.currency,
      action: a.action,
      detail: a.detail,
    }));

    const { margins, marginBlockers: overridable, hardBlockers } = await this.blockersFor(draft, current.config, costs?.costs ?? null);
    const scheduled = await this.scheduledVersions();
    const warnings: string[] = [];
    const analysis = costs ? analysisNote(costs.costs, (await this.stack.current()).tiers) : null;
    if (analysis) warnings.push(analysis);
    if (!draftRow)
      warnings.push('There is no draft: the preview compares the current version with itself.');
    return {
      current_version: current.version,
      next_version: (latest._max.version ?? 0) + 1,
      has_draft: Boolean(draftRow),
      changes,
      packs,
      margins,
      stripe,
      blockers: [...hardBlockers, ...overridable],
      hard_blockers: hardBlockers,
      scheduled,
      warnings,
    };
  }

  /** Versions published with an `effective_at` still ahead, soonest first. */
  private async scheduledVersions(): Promise<Array<{ version: number; effective_at: string }>> {
    const rows = await adminDb.pricingConfig.findMany({
      where: { effectiveAt: { gt: new Date() } },
      orderBy: { effectiveAt: 'asc' },
      select: { version: true, effectiveAt: true },
    });
    return rows.map((r) => ({ version: r.version, effective_at: r.effectiveAt!.toISOString() }));
  }

  /**
   * The admin §5.4 checks for putting `next` in effect in place of `current`: a tier under
   * the margin floor (overridable by a super admin with a note), and a pack bought in the
   * last 12 months that `next` would remove (never overridable). One function for the
   * preview, the publish and the rollback (QA-040) — a rollback is a publish of an old
   * config, and removing a pack someone bought is no safer for being one.
   *
   * The two kinds come back apart and are never told apart again by their text: a pack id
   * with "margin" in it used to turn the hard blocker into an overridable one.
   *
   * Removing is the pack leaving the config. Switching Active off keeps it there, unsold,
   * and is what the blocker tells staff to do — so it is never one itself.
   */
  private async blockersFor(
    next: PricingConfig,
    current: PricingConfig,
    costs: RetellCostInputs | null,
  ): Promise<{ margins: ReturnType<typeof marginsFor>; marginBlockers: string[]; hardBlockers: string[] }> {
    const tiers = (await this.stack.current()).tiers;
    const margins = marginsFor(next, costs, tiers);
    const hardBlockers: string[] = [];
    const removed = removedPackIds(current, next);
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
        hardBlockers.push(
          `Pack "${b.packId}" was bought ${b._count._all} time(s) in the last 12 months and cannot be removed. Keep it in the config and switch Active off instead.`,
        );
    }
    return { margins, marginBlockers: marginBlockers(margins, costs, tiers), hardBlockers };
  }

  /** Refuses on the hard blockers; the margin floor only with `override_margin` and a note. */
  private assertPublishable(
    blockers: { marginBlockers: string[]; hardBlockers: string[] },
    body: { override_margin: boolean; note?: string },
  ): void {
    if (blockers.hardBlockers.length) throw new AppError('CONFLICT', blockers.hardBlockers.join(' '));
    if (blockers.marginBlockers.length && !body.override_margin)
      throw new AppError('MARGIN_FLOOR', blockers.marginBlockers.join(' '));
    if (blockers.marginBlockers.length && body.override_margin && !body.note)
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
    this.assertPublishable(
      { hardBlockers: preview.hard_blockers, marginBlockers: preview.blockers.filter((b) => !preview.hard_blockers.includes(b)) },
      body,
    );
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
      await this.config.writePackCatalogue(config, tx);
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
            changed_paths: preview.changes.map((c) => c.path).slice(0, 100),
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
    if (!target || !target.effectiveAt || target.effectiveAt.getTime() > Date.now())
      throw new AppError('CONFLICT', 'Only a version that was in effect can be rolled back to.');
    const current = await this.config.currentPricing();
    if (current.version === version)
      throw new AppError('CONFLICT', `Version ${version} is already in effect.`);
    const config = pricingConfig.parse(target.configJson);
    // Publish's checks (QA-040): rolling back to a version without a pack bought since is
    // removing that pack, and an old price may now sit under the margin floor.
    this.assertPublishable(await this.blockersFor(config, current.config, (await this.costInputs())?.costs ?? null), body);

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
      await this.config.writePackCatalogue(config, tx);
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

  /**
   * Cancels a version published with a date that has not arrived: `effective_at` goes back
   * to NULL, the state of a version that was never put in effect, so it is never served.
   * Nothing a customer saw changes — the version had not started — which is why this is
   * not a rewrite of history; a version whose date has passed is undone by a rollback.
   * Its Stripe Prices stay as they are (publishing the same config again resumes this row
   * and reuses them).
   */
  async cancelScheduled(
    staff: StaffContext,
    version: number,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminPricingVersion> {
    await this.limits.assertCan(staff, 'can_publish_pricing');
    const row = await adminDb.pricingConfig.findUnique({ where: { version }, select: { version: true, effectiveAt: true, changeSummary: true } });
    if (!row) throw AppError.notFound('Pricing version');
    if (!row.effectiveAt || row.effectiveAt.getTime() <= Date.now())
      throw new AppError('CONFLICT', `Only a scheduled version can be cancelled; v${version} ${row.effectiveAt ? 'has already taken effect. Roll back instead.' : 'is not scheduled.'}`);
    const scheduledFor = row.effectiveAt;
    await adminDb.$transaction(async (tx) => {
      // Conditional on the date still being ahead: a cancel that loses the race with the
      // clock must not pull a version out from under the customers it now serves.
      const cancelled = await tx.pricingConfig.updateMany({
        where: { version, effectiveAt: { gt: new Date() } },
        data: { effectiveAt: null, changeSummary: `Cancelled before taking effect. ${row.changeSummary ?? ''}`.trim().slice(0, 500) },
      });
      if (cancelled.count === 0) throw new AppError('CONFLICT', `v${version} took effect while you were looking. Roll back instead.`);
      await this.audit.record(
        {
          staff,
          action: 'pricing.schedule_cancelled',
          targetType: 'pricing_config',
          targetId: String(version),
          reasonCode: body.reason_code,
          note: body.note ?? null,
          before: { version, effective_at: scheduledFor.toISOString() },
          after: { version, effective_at: null },
          request,
        },
        tx,
      );
    });
    this.log.warn(`pricing v${version} (scheduled for ${scheduledFor.toISOString()}) cancelled by ${staff.email}`);
    return this.version(version);
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
  // Calling windows, daily dial caps and the prior-contact days (ADR 0031) are published
  // with pricing and felt by customers like a rate; they are previewed and audited like one.
  walk('outbound', before.outbound, after.outbound);
  return changes;
}

/** Packs whose id is in `current` and not in `next` at all. Switching Active off is not this. */
export function removedPackIds(current: PricingConfig, next: PricingConfig): string[] {
  const nextIds = new Set(next.packs.map((p) => p.id));
  return current.packs.filter((p) => !nextIds.has(p.id)).map((p) => p.id);
}

/**
 * The preview's pack lists: `added` and `removed` are ids entering and leaving the config,
 * `deactivated` is Active switched off on a pack that stays, `changed` is every other
 * pack with a difference.
 */
export function packChanges(
  current: PricingConfig,
  next: PricingConfig,
  changes: AdminPricingPreviewResponse['changes'],
): AdminPricingPreviewResponse['packs'] {
  const before = new Map(current.packs.map((p) => [p.id, p]));
  const after = new Map(next.packs.map((p) => [p.id, p]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = removedPackIds(current, next);
  const deactivated = [...after.values()].filter((p) => !p.active && before.get(p.id)?.active === true).map((p) => p.id);
  const touched = new Set(changes.map((c) => /^packs\.([^.]+)(?:\.|$)/.exec(c.path)?.[1]).filter((id): id is string => Boolean(id)));
  const changed = [...touched].filter((id) => before.has(id) && after.has(id) && !deactivated.includes(id));
  return { added, removed, deactivated, changed };
}

/**
 * What one minute of a tier costs on the platform, from the itemised inputs and the tier's
 * current stack (ADR 0038): voice engine + the default voice's TTS + the in-call model +
 * telephony in the dearest country listed + knowledge-base retrieval. That is the §4.3
 * "COGS / min (phone, Retell number)" line, priced at the worst case a floor should guard.
 * Anything the stack needs and the table lacks is named in `missing` and the cost is null —
 * never a guessed or zero line that would show a margin better than the real one.
 */
export function tierCostPerMin(costs: RetellCostInputs, stack: TierStack): { cents: number | null; missing: string[] } {
  const missing: string[] = [];
  const provider = providerOfVoiceId(stack.default_voice_id);
  const model = voiceModelFor(provider, stack.voice_model);
  // A named voice model is priced as itself or not at all: falling back to the provider's
  // plain row would price ElevenLabs Multilingual v2 ($0.06) as Flash ($0.04).
  const tts = provider === null ? undefined : costs.tts_cents_per_min[model ? `${provider}:${model}` : provider];
  if (tts === undefined) missing.push(`tts:${provider ?? stack.default_voice_id}${model ? `:${model}` : ''}`);
  const llm = costs.llm_cents_per_min[stack.model];
  if (llm === undefined) missing.push(`llm:${stack.model}`);
  const telephony = Object.values(costs.telephony_cents_per_min);
  if (telephony.length === 0) missing.push('telephony');
  if (missing.length) return { cents: null, missing };
  const cents = costs.voice_engine_cents_per_min + tts! + llm! + Math.max(...telephony) + costs.knowledge_base_cents_per_min;
  return { cents: Math.round(cents * 10_000) / 10_000, missing };
}

/**
 * Admin §5.4 / SA5: for every active pack, Standard and Premium margin at that pack's price
 * per credit. The old check priced one row per tier at the *dearest* credit (Starter's), so
 * a Pro pack under the floor published unchallenged (super-admin audit AS-223, AS-224).
 * A pack with no price (Volume, sold by quote) has no margin to check.
 */
export function marginsFor(
  config: PricingConfig,
  costs: RetellCostInputs | null,
  tiers: AgentStackTiers | null,
): AdminPricingPreviewResponse['margins'] {
  const packs = config.packs.filter((p) => p.active && p.price_cents > 0 && p.credits + p.bonus_credits > 0);
  const tierCosts = (['standard', 'premium'] as const).map((tier) => ({
    tier,
    cost: costs && tiers ? tierCostPerMin(costs, tiers[tier]) : { cents: null, missing: costs ? ['tier_stack'] : ['cost_inputs'] },
  }));
  return packs.flatMap((pack) =>
    tierCosts.map(({ tier, cost }) => {
      const revenue = Math.round((pack.price_cents / (pack.credits + pack.bonus_credits)) * rateForTier(config.rates, tier) * 100) / 100;
      const margin = cost.cents !== null && revenue > 0 ? Math.round(((revenue - cost.cents) / revenue) * 1000) / 10 : null;
      const floor = costs?.margin_floor_pct ?? null;
      return {
        pack_id: pack.id,
        tier,
        revenue_cents_per_min: revenue,
        cost_cents_per_min: cost.cents,
        margin_pct: margin,
        floor_pct: floor,
        below_floor: margin !== null && floor !== null && margin < floor,
        missing: cost.missing,
      };
    }),
  );
}

/**
 * The margin blockers, overridable by a super admin with a note like the floor itself: a
 * margin under the floor, and a margin nobody could compute. The second used to be a
 * warning, so an environment without cost inputs published any price at all; an unknown
 * margin is not a passing one.
 */
export function marginBlockers(
  margins: AdminPricingPreviewResponse['margins'],
  costs: RetellCostInputs | null,
  tiers: AgentStackTiers | null,
): string[] {
  if (!costs) return ['No voice platform cost inputs are set (PUT /admin/retell-costs), so the margin check cannot run; a super admin can override with a note.'];
  if (!tiers) return ['The agent stack has no readable tiers, so the margin check cannot run; a super admin can override with a note.'];
  const blockers: string[] = [];
  const unknown = [...new Set(margins.flatMap((m) => m.missing))];
  if (unknown.length) blockers.push(`The margin check cannot price ${unknown.join(', ')}; add it to the cost inputs, or a super admin can override with a note.`);
  for (const m of margins)
    if (m.below_floor)
      blockers.push(`${m.tier} margin on ${m.pack_id} is ${m.margin_pct}%, under the ${m.floor_pct}% floor; a super admin can override with a note.`);
  return blockers;
}

/** The flat post-call analysis charge, which the per-minute margin leaves out (ADR 0037 §2). */
function analysisNote(costs: RetellCostInputs, tiers: AgentStackTiers | null): string | null {
  const models = [...new Set(tiers ? [tiers.standard.post_call_analysis_model, tiers.premium.post_call_analysis_model] : [])].filter((m): m is string => Boolean(m));
  const priced = models.filter((m) => costs.analysis_cents_per_call[m] !== undefined).map((m) => `${m} ${costs.analysis_cents_per_call[m]}¢`);
  const unpriced = models.filter((m) => costs.analysis_cents_per_call[m] === undefined);
  const parts = [
    priced.length ? `Post-call analysis is charged per call on top of these margins (${priced.join(', ')}), so short calls earn less than shown.` : '',
    unpriced.length ? `No per-call cost is set for the analysis model ${unpriced.join(', ')}.` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
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
  if (preview.packs.deactivated.length) parts.push(`deactivated ${preview.packs.deactivated.join(', ')}`);
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
    is_scheduled: r.effectiveAt !== null && r.effectiveAt.getTime() > Date.now(),
    // Version 1 (the seed) predates the sync and carries no record: shown as skipped, never as pending.
    stripe_sync: sync.success
      ? sync.data
      : { status: r.effectiveAt ? 'skipped' : 'pending', synced_at: null, error: null, prices: [] },
    packs: packs.success ? packs.data.packs.length : 0,
  };
}

export { uuidParam };
