import { Injectable } from '@nestjs/common';
import { type Prisma, withWorkspace } from '@portal/db';
import {
  DEFAULT_OUTBOUND_SETTINGS,
  type KycDetails,
  type KycResponse,
  type KycStatus,
  type OutboundOverview,
  type OutboundSettings,
  callerIdVia,
  kycDetails,
  localClock,
  outboundSettings,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { callerIdCandidates, usableCallerId } from './caller-ids';
import { usedOn } from './outbound-usage';

/**
 * D18 — the D6 "Outbound calling" tab (ADR 0031 §1, §5): the business verification the
 * customer submits and staff decide, the voicemail setting, the caller IDs and today's use.
 * Staff set the verdict (`AdminOutboundService`); a database trigger refuses it from here.
 */
@Injectable()
export class OutboundSettingsService {
  constructor(private readonly config: PlatformConfigService) {}

  async overview(ctx: WorkspaceContext): Promise<OutboundOverview> {
    const [{ policy }, flags] = await Promise.all([this.config.outboundPolicy(), this.config.flagsFor(ctx.workspaceId)]);
    return withWorkspace(ctx, async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { kycStatus: true, kycJson: true, kycSubmittedAt: true, kycDecidedAt: true, kycReason: true, outboundSettingsJson: true, planTier: true, timezone: true },
      });
      const localDay = localClock(new Date(), tenant.timezone)?.date;
      // The same rows and the same count the callback gate reads (QA-085, QA-086).
      const [numbers, used] = await Promise.all([
        callerIdCandidates(db, ctx.workspaceId, { nickname: true, type: true, callerIdVerifiedVia: true }),
        localDay ? usedOn(db, ctx.workspaceId, localDay) : 0,
      ]);
      const settings = outboundSettings.safeParse(tenant.outboundSettingsJson ?? DEFAULT_OUTBOUND_SETTINGS);
      return {
        enabled: flags.flags.outbound_calls === true,
        kyc: kycOf(tenant),
        settings: settings.success ? settings.data : DEFAULT_OUTBOUND_SETTINGS,
        caller_ids: numbers.map((n) => {
          const via = callerIdVia.safeParse(n.callerIdVerifiedVia);
          return {
            number_id: n.id,
            e164: n.e164!,
            nickname: n.nickname,
            kind: n.type === 'custom_sip' ? ('sip' as const) : ('bought' as const),
            status: n.status,
            verified: n.callerIdVerifiedAt !== null,
            verified_via: n.callerIdVerifiedAt !== null && via.success ? via.data : null,
            usable: usableCallerId(n),
          };
        }),
        daily_cap: policy.daily_caps[tenant.planTier],
        used_today: used,
        prior_contact_days: policy.prior_contact_days,
        countries: Object.keys(policy.countries).sort(),
      };
    });
  }

  /** PUT /outbound/settings — owner/admin. Validated by `outboundSettings` before it is stored. */
  async updateSettings(ctx: WorkspaceContext, settings: OutboundSettings): Promise<OutboundOverview> {
    await withWorkspace(ctx, async (db) => {
      await db.tenant.update({ where: { id: ctx.workspaceId }, data: { outboundSettingsJson: settings as Prisma.InputJsonValue } });
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'workspace.outbound_settings_updated',
          targetType: 'workspace',
          targetId: ctx.workspaceId,
          ip: ctx.ip ?? null,
          // The setting, not the message text: what was chosen is what an audit needs.
          metaJson: { voicemail_detection: settings.voicemail_detection, request_id: ctx.requestId ?? null },
        },
      });
    });
    return this.overview(ctx);
  }

  /**
   * POST /outbound/kyc — owner/admin. Moves the workspace to `pending` with the details for
   * staff to review. Refused while a review is open and once verified (a verified business
   * changing its details goes through support, which can withdraw and re-review).
   */
  async submitKyc(ctx: WorkspaceContext, details: KycDetails): Promise<OutboundOverview> {
    await withWorkspace(ctx, async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { kycStatus: true } });
      if (tenant.kycStatus === 'pending') throw new AppError('CONFLICT', 'Your verification is already being reviewed.');
      if (tenant.kycStatus === 'verified') throw new AppError('CONFLICT', 'Your business is already verified. Contact support to change its details.');
      await db.tenant.update({
        where: { id: ctx.workspaceId },
        data: { kycStatus: 'pending', kycJson: details as Prisma.InputJsonValue, kycSubmittedAt: new Date(), kycReason: null },
      });
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'workspace.kyc_submitted',
          targetType: 'workspace',
          targetId: ctx.workspaceId,
          ip: ctx.ip ?? null,
          metaJson: { registration_country: details.registration_country, request_id: ctx.requestId ?? null },
        },
      });
    });
    return this.overview(ctx);
  }
}

export function kycOf(t: { kycStatus: string; kycJson: unknown; kycSubmittedAt: Date | null; kycDecidedAt: Date | null; kycReason: string | null }): KycResponse {
  const details = kycDetails.safeParse(t.kycJson);
  return {
    status: t.kycStatus as KycStatus,
    submitted_at: t.kycSubmittedAt?.toISOString() ?? null,
    decided_at: t.kycDecidedAt?.toISOString() ?? null,
    reason: t.kycStatus === 'rejected' ? t.kycReason : null,
    details: details.success ? details.data : null,
  };
}
