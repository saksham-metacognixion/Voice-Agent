import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import {
  type FlagsResponse,
  type KillSwitchKey,
  type OutboundPolicy,
  type PricingConfig,
  type PricingPack,
  type PricingResponse,
  type WalletPolicy,
  type WorkspaceCaps,
  type AgentTier,
  outboundPolicy,
  pricingConfig,
  pricingResponse,
  rateForTier,
  type PlatformSettingKey,
  platformSettings,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { RedisCache, redisKeys } from '../redis';
import { type ResolvedSettings, resolveSettings } from './platform-settings';
import { type FeatureFlagRow, type KillSwitchRow, isKillSwitchKey, killSwitchActive, resolveCaps, resolveFlags } from './config.resolve';

/** The current pricing_configs row, parsed. */
export interface CurrentPricing {
  version: number;
  effective_at: string;
  config: PricingConfig;
}

interface GlobalFlags {
  flags: FeatureFlagRow[];
  kill_switches: KillSwitchRow[];
}

/**
 * How long a cached config may be stale after a publish that failed to invalidate. Admin
 * §5.2 step 4 promises the portal re-reads within 60 s; this is that promise, enforced by
 * Redis rather than by remembering to call invalidate().
 */
export const CONFIG_TTL_S = 60;

export type PlatformSettingsSnapshot = ResolvedSettings & { updated_at: string | null; updated_by: string | null };
/** Caps are re-derived on every mutating path anyway; the TTL only bounds a missed refresh. */
export const CAPS_TTL_S = 300;
/**
 * `kill:reject_inbound` outlives its refresh cadence many times over, on purpose: the
 * inbound path reads it raw, and a miss there reads as "switch off". At the 60 s config
 * TTL the key would be absent for four minutes in every five-minute `runtime-cache-refresh`
 * cycle and the veto would do nothing (see redisKeys.rejectInbound).
 */
export const REJECT_INBOUND_TTL_S = 3_600;

/**
 * Configuration as data (spec §13.12, admin §5): pricing, flags, kill switches and the
 * per-workspace caps derived from them, read through Redis with Postgres as the truth.
 *
 * Reads go `pricing:current` → `pricing_configs`; `flags:global` → `feature_flags` +
 * `kill_switches`; `flags:{ws}` and `caps:{ws}` → the resolvers in config.resolve.ts.
 * Publishing anything invalidates `pricing:current`, `flags:*` and `caps:*` (admin §5.2
 * step 4). Redis being down degrades to a Postgres read per call, never to an error.
 *
 * Global tables carry no tenant_id and no RLS, and this service runs on the customer,
 * webhook and worker paths alike, so it reads them on the admin connection — that is the
 * "legitimately crosses workspaces" case of ADR 0006, not a shortcut.
 */
@Injectable()
export class PlatformConfigService {
  private readonly log = new Logger(PlatformConfigService.name);

  constructor(private readonly cache: RedisCache) {}

  // ------------------------------------------------------------------ pricing

  async currentPricing(): Promise<CurrentPricing> {
    const { value } = await this.cache.remember<CurrentPricing>(redisKeys.pricingCurrent, CONFIG_TTL_S, () =>
      this.loadCurrentPricing(),
    );
    
    return value;
  }

  private async loadCurrentPricing(): Promise<CurrentPricing> {
    const row = await adminDb.pricingConfig.findFirst({
      where: { effectiveAt: { lte: new Date() } },
      orderBy: [{ effectiveAt: 'desc' }, { version: 'desc' }],
    });
    if (!row) {
      throw new Error('No pricing config is in effect. Run `pnpm db:seed` to publish version 1.');
    }
    return {
      version: row.version,
      effective_at: (row.effectiveAt ?? new Date(0)).toISOString(),
      config: pricingConfig.parse(row.configJson),
    };
  }

  /** GET /pricing: the customer-visible subset, filtered to packs sold in `region`. */
  async pricingResponse(region?: string): Promise<PricingResponse> {
    const current = await this.currentPricing();
    const { config } = current;
    const packs = config.packs
      .filter((p) => p.active && p.visibility === 'public')
      .filter((p) => !region || p.regions.length === 0 || p.regions.includes(region))
      .sort((a, b) => a.sort_order - b.sort_order || a.price_cents - b.price_cents);
    return pricingResponse.parse({
      version: current.version,
      effective_at: current.effective_at,
      currency: config.currency_default,
      packs,
      rates: config.rates,
      recurring: config.recurring,
      wallet_policy: config.wallet_policy,
    });
  }

  /** Credits per minute for a tier, from the config current *now* (captured at call_started). */
  async rateFor(tier: AgentTier): Promise<{ rate: number; configVersion: number }> {
    const current = await this.currentPricing();
    return { rate: rateForTier(current.config.rates, tier), configVersion: current.version };
  }

  /**
   * D16: credits per minute for a transferred leg (admin §5 "Transferred-leg credits/min").
   * Read from the version the call was rated under when it is known — the leg belongs to
   * that call, and a publish between the call's start and its transfer must not re-price
   * it (§14.2, the same rule as `calls.rate`). An unknown or unreadable version falls back
   * to the version in effect now.
   */
  async transferRate(configVersion: number | null): Promise<{ rate: number; configVersion: number }> {
    if (configVersion !== null) {
      const row = await adminDb.pricingConfig.findUnique({ where: { version: configVersion }, select: { version: true, configJson: true } }).catch(() => null);
      const parsed = row ? pricingConfig.safeParse(row.configJson) : null;
      if (row && parsed?.success) return { rate: parsed.data.rates.transferred_leg_per_min, configVersion: row.version };
    }
    const current = await this.currentPricing();
    return { rate: current.config.rates.transferred_leg_per_min, configVersion: current.version };
  }

  /**
   * D18 outbound policy (ADR 0031): daily caps, the prior-contact window, the calling rules.
   * Re-parsed here, not trusted from the cache: a `pricing:current` entry written before
   * the block existed carries no `outbound`, and that must read as the defaults.
   */
  async outboundPolicy(): Promise<{ policy: OutboundPolicy; configVersion: number }> {
    const current = await this.currentPricing();
    const parsed = outboundPolicy.safeParse((current.config as { outbound?: unknown }).outbound ?? {});
    if (!parsed.success) throw new AppError('NOT_CONFIGURED', 'Outbound calling is not configured on this platform yet.');
    return { policy: parsed.data, configVersion: current.version };
  }

  async walletPolicy(): Promise<{ policy: WalletPolicy; configVersion: number }> {
    const current = await this.currentPricing();
    return { policy: current.config.wallet_policy, configVersion: current.version };
  }

  /** An active pack a customer may buy, or undefined. Hidden packs are staff-assignable only. */
  async purchasablePack(packId: string): Promise<{ pack: PricingPack; configVersion: number } | undefined> {
    const current = await this.currentPricing();
    const pack = current.config.packs.find((p) => p.id === packId && p.active && p.visibility !== 'hidden');
    return pack ? { pack, configVersion: current.version } : undefined;
  }

  /**
   * Publishes a new version (admin §5.2 step 2 + 4). Versions are immutable: this only
   * ever inserts. The Stripe price sync (step 3) and staff audit row land with SA5.
   */
  async publishPricing(input: {
    config: PricingConfig;
    publishedBy?: string;
    effectiveAt?: Date;
    changeSummary?: string;
    grandfatherMode?: 'keep_until_next_purchase' | 'apply_now';
  }): Promise<number> {
    const config = pricingConfig.parse(input.config);
    const version = await adminDb.$transaction(async (tx) => {
      const latest = await tx.pricingConfig.aggregate({ _max: { version: true } });
      const next = (latest._max.version ?? 0) + 1;
      await tx.pricingConfig.create({
        data: {
          version: next,
          configJson: config as unknown as Prisma.InputJsonValue,
          publishedBy: input.publishedBy,
          publishedAt: new Date(),
          effectiveAt: input.effectiveAt ?? new Date(),
          changeSummary: input.changeSummary,
          grandfatherMode: input.grandfatherMode ?? 'keep_until_next_purchase',
        },
      });
      return next;
    });
    await this.invalidateAll();
    this.log.log(`pricing config v${version} published`);
    return version;
  }

  // ------------------------------------------------------------------ flags

  private async globalFlags(): Promise<GlobalFlags> {
    const { value } = await this.cache.remember<GlobalFlags>(redisKeys.flagsGlobal, CONFIG_TTL_S, async () => {
      const [flags, switches] = await Promise.all([adminDb.featureFlag.findMany(), adminDb.killSwitch.findMany()]);
      return {
        flags: flags.map((f) => ({
          key: f.key,
          defaultOn: f.defaultOn,
          rolloutPct: f.rolloutPct,
          tenantOverridesJson: f.tenantOverridesJson,
        })),
        kill_switches: switches.map((s) => ({ key: s.key, on: s.on, expiresAt: s.expiresAt?.toISOString() ?? null })),
      };
    });
    return value;
  }

  /** True while the switch is on and unexpired. Unknown keys are off. */
  async killSwitch(key: KillSwitchKey): Promise<boolean> {
    const { kill_switches } = await this.globalFlags();
    const row = kill_switches.find((s) => s.key === key);
    return row ? killSwitchActive(row) : false;
  }

  async setKillSwitch(key: KillSwitchKey, input: { on: boolean; reason?: string; setBy?: string; expiresAt?: Date | null }): Promise<void> {
    await this.writeKillSwitch(key, input);
    await this.publishKillSwitch(key, input);
  }

  /**
   * The row only, on `tx` when the caller holds a transaction (the SA12 write commits with
   * its `staff_audit_log` row). The cache is not touched here: `refreshRejectInbound()`
   * reads the switch back from Postgres, and inside an open transaction it would read —
   * and republish — the value being replaced. Call `publishKillSwitch()` after the commit.
   */
  async writeKillSwitch(
    key: KillSwitchKey,
    input: { on: boolean; reason?: string; setBy?: string; expiresAt?: Date | null },
    tx: Prisma.TransactionClient | typeof adminDb = adminDb,
  ): Promise<void> {
    if (!isKillSwitchKey(key)) throw new Error(`unknown kill switch ${key}`);
    await tx.killSwitch.upsert({
      where: { key },
      create: { key, on: input.on, reason: input.reason, setBy: input.setBy, expiresAt: input.expiresAt ?? null },
      update: { on: input.on, reason: input.reason, setBy: input.setBy, expiresAt: input.expiresAt ?? null },
    });
  }

  /** Drops `flags:*` and republishes `kill:reject_inbound`; runs after the row is committed. */
  async publishKillSwitch(key: KillSwitchKey, input: { on: boolean; reason?: string }): Promise<void> {
    await this.cache.delPattern(redisKeys.flagsPattern);
    // The one switch with a reader that cannot fall back to Postgres. Republish it now so
    // an operator flipping it during an incident is obeyed by the next call, not by the
    // next five-minute refresh.
    await this.refreshRejectInbound();
    this.log.warn(`kill switch ${key} ${input.on ? 'ON' : 'off'}${input.reason ? ` — ${input.reason}` : ''}`);
  }

  /**
   * Projects `reject_inbound` to `kill:reject_inbound` for the §13.9 hot path, which has
   * no time to resolve a flags document and no Postgres to fall back to. Called on every
   * flip and by `runtime-cache-refresh`; returns what it wrote.
   */
  async refreshRejectInbound(): Promise<boolean> {
    const on = await this.killSwitch('reject_inbound');
    await this.cache.set(redisKeys.rejectInbound, on ? '1' : '0', REJECT_INBOUND_TTL_S);
    return on;
  }

  /** GET /flags for one workspace (admin §5.3: tier defaults ∘ tenant overrides ∘ feature flags). */
  async flagsFor(workspaceId: string): Promise<FlagsResponse> {
    const { value } = await this.cache.remember<FlagsResponse>(redisKeys.flagsWorkspace(workspaceId), CONFIG_TTL_S, async () => {
      const [current, globals, tenant, override] = await Promise.all([
        this.currentPricing(),
        this.globalFlags(),
        this.tenant(workspaceId),
        adminDb.tenantOverride.findUnique({ where: { tenantId: workspaceId } }),
      ]);
      return resolveFlags({
        config: current.config,
        configVersion: current.version,
        tenant,
        override,
        featureFlags: globals.flags,
        killSwitches: globals.kill_switches,
      });
    });
    return value;
  }

  // ------------------------------------------------------------------ caps

  /** `caps:{ws}` — what the inbound checks and the portal gates enforce for one workspace. */
  async capsFor(workspaceId: string): Promise<WorkspaceCaps> {
    const { value } = await this.cache.remember<WorkspaceCaps>(redisKeys.caps(workspaceId), CAPS_TTL_S, () =>
      this.loadCaps(workspaceId),
    );
    return value;
  }

  private async loadCaps(workspaceId: string): Promise<WorkspaceCaps> {
    const [current, tenant, override] = await Promise.all([
      this.currentPricing(),
      this.tenant(workspaceId),
      adminDb.tenantOverride.findUnique({ where: { tenantId: workspaceId } }),
    ]);
    return resolveCaps(current.config, current.version, tenant, override);
  }

  private async tenant(workspaceId: string) {
    const tenant = await adminDb.tenant.findUnique({
      where: { id: workspaceId },
      select: { id: true, planTier: true, concurrencyCap: true, kbAllowance: true },
    });
    if (!tenant) throw new Error(`workspace ${workspaceId} does not exist`);
    return tenant;
  }

  // ------------------------------------------------------------------ invalidation

  /**
   * Admin §5.2 step 4: after any publish.
   *
   * `stack:current` is dropped here as well as by `AgentStackService.invalidate()`. The
   * agent stack is published from the same SA6 screens as pricing, and a §9.4 guardrail
   * edit that stayed cached for a minute while the pricing beside it went live would be
   * the kind of inconsistency nobody thinks to look for.
   */
  async invalidateAll(): Promise<void> {
    await Promise.all([
      this.cache.del(redisKeys.pricingCurrent),
      this.cache.del(redisKeys.agentStackCurrent),
      this.cache.delPattern(redisKeys.flagsPattern),
      this.cache.delPattern(redisKeys.capsPattern),
    ]);
  }

  // ------------------------------------------------------------------ platform settings (admin §9)

  /**
   * The platform knobs (`platform_settings`): a console row over its env var over the
   * default, cached like the rest of the config. Each row is re-validated on read, so a
   * hand-edited value that would not parse falls back instead of reaching a schedule.
   */
  async settings(): Promise<PlatformSettingsSnapshot> {
    const { value } = await this.cache.remember<PlatformSettingsSnapshot>(redisKeys.platformSettings, CONFIG_TTL_S, () => this.loadSettings());
    return value;
  }

  async invalidateSettings(): Promise<void> {
    await this.cache.del(redisKeys.platformSettings);
  }

  private async loadSettings(): Promise<PlatformSettingsSnapshot> {
    const rows = await adminDb.platformSetting.findMany();
    const valid = new Map<string, unknown>();
    for (const row of rows) {
      const schema = platformSettings.shape[row.key as PlatformSettingKey];
      const parsed = schema?.safeParse(row.value);
      if (parsed?.success) valid.set(row.key, parsed.data);
      else this.log.warn(`platform_settings.${row.key} does not parse; falling back to its env var / default`);
    }
    const latest = rows.reduce<(typeof rows)[number] | null>((a, r) => (!a || r.updatedAt > a.updatedAt ? r : a), null);
    return { ...resolveSettings(valid), updated_at: latest?.updatedAt.toISOString() ?? null, updated_by: latest?.updatedBy ?? null };
  }

  /** After a plan change, override edit, pause or purchase for one workspace. */
  async invalidateWorkspace(workspaceId: string): Promise<void> {
    await this.cache.del(redisKeys.flagsWorkspace(workspaceId), redisKeys.caps(workspaceId));
  }

  /** Rebuild `caps:{ws}` now rather than on the next read — the D4 runtime-cache hook. */
  async refreshCaps(workspaceId: string): Promise<WorkspaceCaps> {
    const caps = await this.loadCaps(workspaceId);
    await this.cache.setJson(redisKeys.caps(workspaceId), caps, CAPS_TTL_S);
    await this.cache.del(redisKeys.flagsWorkspace(workspaceId));
    return caps;
  }
}
