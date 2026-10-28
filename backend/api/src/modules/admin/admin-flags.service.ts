import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import {
  type AdminFeatureFlag,
  type AdminFlagsResponse,
  type AdminKillSwitch,
  type AdminSetKillSwitchRequest,
  type AdminUpsertFlagRequest,
  type KillSwitchKey,
  type StaffActionRequest,
  FLAG_KEY_PATTERN,
  killSwitchKey,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { StaffContext } from '../auth';
import { PlatformConfigService, killSwitchActive } from '../config';
import { RedisCache, redisKeys } from '../redis';
import { iso, record } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';

/** What each SA12 switch does — shown beside the toggle so nobody flips one blind. */
export const KILL_SWITCH_DESCRIPTIONS: Record<KillSwitchKey, string> = {
  reject_inbound:
    'Decline every new inbound call platform-wide (busy tone, no cost). For a platform incident or maintenance. Takes effect on the next call.',
  pause_web_tests: 'Refuse browser test calls (the setup wizard and an agent’s Test tab). Live phone numbers keep answering.',
  pause_purchases:
    'Refuse new Checkout sessions (the setup wizard’s payment step and Wallet → "Buy credits"). Pending sessions and webhooks still settle.',
  pause_generation:
    'Refuse brief → script generation and feedback (an LLM outage). Publishing and calls are unaffected.',
};

/**
 * SA12 "Flags" and "Kill switches" (D12 §12). Feature flags are rows in `feature_flags`
 * (`GET /flags` resolves them per workspace); kill switches are the four fixed keys in
 * `kill_switches`, read by `PlatformConfigService.killSwitch()` — and, for
 * `reject_inbound`, projected to `kill:reject_inbound` for the §13.9 hot path. Every
 * change invalidates `flags:*` so the portal re-reads within 60 s, and lands in the
 * staff audit with who, when and why. Nothing here reaches infrastructure: a switch is
 * a row the code consults, never a deploy.
 */
@Injectable()
export class AdminFlagsService {
  private readonly log = new Logger(AdminFlagsService.name);

  constructor(
    private readonly config: PlatformConfigService,
    private readonly cache: RedisCache,
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
  ) {}

  async list(): Promise<AdminFlagsResponse> {
    const [flags, switches] = await Promise.all([
      adminDb.featureFlag.findMany({ orderBy: { key: 'asc' } }),
      adminDb.killSwitch.findMany(),
    ]);
    const staffIds = [
      ...new Set(switches.map((s) => s.setBy).filter((x): x is string => Boolean(x))),
    ];
    const staff = staffIds.length
      ? await adminDb.staffUser.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, email: true },
        })
      : [];
    const emails = new Map(staff.map((s) => [s.id, s.email]));
    const byKey = new Map(switches.map((s) => [s.key, s]));
    return {
      flags: flags.map(toFlag),
      kill_switches: killSwitchKey.options.map((key) => {
        const row = byKey.get(key);
        const on = row?.on ?? false;
        return {
          key,
          description: KILL_SWITCH_DESCRIPTIONS[key],
          on,
          active: row ? killSwitchActive({ key, on, expiresAt: row.expiresAt }) : false,
          reason: row?.reason ?? null,
          set_by: row?.setBy ?? null,
          set_by_email: row?.setBy ? (emails.get(row.setBy) ?? null) : null,
          expires_at: iso(row?.expiresAt),
          updated_at: iso(row?.updatedAt),
        } satisfies AdminKillSwitch;
      }),
    };
  }

  async upsertFlag(
    staff: StaffContext,
    key: string,
    body: AdminUpsertFlagRequest,
    request: FastifyRequest,
  ): Promise<AdminFeatureFlag> {
    await this.limits.assertCan(staff, 'can_manage_flags');
    if (!FLAG_KEY_PATTERN.test(key))
      throw new AppError(
        'VALIDATION_FAILED',
        'A flag key is lower-case letters, digits and underscores.',
        [{ field: 'key', message: 'Invalid key' }],
      );
    const before = await adminDb.featureFlag.findUnique({ where: { key } });
    // The row and its audit row commit together (CLAUDE.md: no audit row, no write).
    const row = await adminDb.$transaction(async (tx) => {
      const written = await tx.featureFlag.upsert({
        where: { key },
        create: {
          key,
          description: body.description ?? null,
          defaultOn: body.default_on ?? false,
          rolloutPct: body.rollout_pct ?? 0,
          tenantOverridesJson: (body.tenant_overrides ?? {}) as Prisma.InputJsonValue,
        },
        update: {
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.default_on !== undefined ? { defaultOn: body.default_on } : {}),
          ...(body.rollout_pct !== undefined ? { rolloutPct: body.rollout_pct } : {}),
          ...(body.tenant_overrides !== undefined
            ? { tenantOverridesJson: body.tenant_overrides as Prisma.InputJsonValue }
            : {}),
        },
      });
      await this.audit.record(
        {
          staff,
          action: before ? 'flag.updated' : 'flag.created',
          targetType: 'feature_flag',
          targetId: key,
          reasonCode: body.reason_code ?? null,
          note: body.note ?? null,
          before: before ? toFlag(before) : null,
          after: toFlag(written),
          request,
        },
        tx,
      );
      return written;
    });
    await this.cache.delPattern(redisKeys.flagsPattern);
    this.log.log(
      `flag ${key} ${before ? 'updated' : 'created'} by ${staff.email}: on=${row.defaultOn} rollout=${row.rolloutPct}%`,
    );
    return toFlag(row);
  }

  async deleteFlag(
    staff: StaffContext,
    key: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<{ deleted: boolean }> {
    await this.limits.assertCan(staff, 'can_manage_flags');
    const before = await adminDb.featureFlag.findUnique({ where: { key } });
    if (!before) throw AppError.notFound('Flag');
    await adminDb.$transaction(async (tx) => {
      await tx.featureFlag.delete({ where: { key } });
      await this.audit.record(
        {
          staff,
          action: 'flag.deleted',
          targetType: 'feature_flag',
          targetId: key,
          reasonCode: body.reason_code,
          note: body.note ?? null,
          before: toFlag(before),
          request,
        },
        tx,
      );
    });
    await this.cache.delPattern(redisKeys.flagsPattern);
    this.log.log(`flag ${key} deleted by ${staff.email} (${body.reason_code})`);
    return { deleted: true };
  }

  async setKillSwitch(
    staff: StaffContext,
    keyRaw: string,
    body: AdminSetKillSwitchRequest,
    request: FastifyRequest,
  ): Promise<AdminKillSwitch> {
    await this.limits.assertCan(staff, 'can_manage_flags');
    const parsed = killSwitchKey.safeParse(keyRaw);
    if (!parsed.success) throw AppError.notFound('Kill switch');
    const key = parsed.data;
    // The line shown on the card while the switch is on: the free text when given, else
    // the reason code and note the dialog collected.
    const reason = body.on
      ? (body.reason ?? (body.note ? `${body.reason_code}: ${body.note}` : body.reason_code))
      : undefined;
    const before = await adminDb.killSwitch.findUnique({ where: { key } });
    const input = {
      on: body.on,
      reason,
      setBy: staff.staffId,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
    };
    // Row and audit row in one transaction; the cache republish waits for the commit
    // (`refreshRejectInbound()` reads the row back, and inside the transaction it would
    // republish the value being replaced).
    await adminDb.$transaction(async (tx) => {
      await this.config.writeKillSwitch(key, input, tx);
      await this.audit.record(
        {
          staff,
          action: body.on ? 'kill_switch.on' : 'kill_switch.off',
          targetType: 'kill_switch',
          targetId: key,
          reasonCode: body.reason_code,
          note: body.note ?? body.reason ?? null,
          before: before
            ? { on: before.on, reason: before.reason, expires_at: iso(before.expiresAt) }
            : { on: false },
          after: { on: body.on, reason: reason ?? null, expires_at: body.expires_at ?? null },
          request,
        },
        tx,
      );
    });
    await this.config.publishKillSwitch(key, input);
    const list = await this.list();
    return list.kill_switches.find((s) => s.key === key)!;
  }
}

function toFlag(row: {
  key: string;
  description: string | null;
  defaultOn: boolean;
  rolloutPct: number;
  tenantOverridesJson: unknown;
}): AdminFeatureFlag {
  const overrides: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(record(row.tenantOverridesJson)))
    if (typeof v === 'boolean') overrides[k] = v;
  return {
    key: row.key,
    description: row.description,
    default_on: row.defaultOn,
    rollout_pct: row.rolloutPct,
    tenant_overrides: overrides,
  };
}
