import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import {
  type AdminConcurrencyAllowanceRequest,
  type AdminSettingsResponse,
  type AdminSettingsUpdateRequest,
  type PlatformSettingKey,
  platformSettingKey,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { StaffContext } from '../auth';
import { PlatformConfigService } from '../config';
import { StaffAuditService } from './staff-audit.service';

/**
 * Admin §9 `GET|PUT /admin/settings` and `PUT /admin/concurrency/allowance`: the platform
 * knobs that used to need an environment variable and a redeploy. A write upserts the keys
 * it sends and deletes the keys it resets (back to the env var / default), audits the
 * resolved values before and after in the same transaction, and drops the cached settings
 * so the next schedule tick reads the new ones.
 */
@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly config: PlatformConfigService,
    private readonly audit: StaffAuditService,
  ) {}

  async get(): Promise<AdminSettingsResponse> {
    const snapshot = await this.config.settings();
    const by = snapshot.updated_by
      ? await adminDb.staffUser.findUnique({ where: { id: snapshot.updated_by }, select: { email: true } })
      : null;
    return { settings: snapshot.settings, source: snapshot.source, updated_at: snapshot.updated_at, updated_by_email: by?.email ?? null };
  }

  async update(staff: StaffContext, body: AdminSettingsUpdateRequest, request: FastifyRequest): Promise<AdminSettingsResponse> {
    const set = platformSettingKey.options.filter((k) => body[k] !== undefined);
    const reset = [...new Set(body.reset ?? [])];
    const both = set.filter((k) => reset.includes(k));
    if (both.length) throw new AppError('VALIDATION_FAILED', 'A setting cannot be set and reset at once.', both.map((field) => ({ field, message: 'Set or reset, not both' })));
    await this.write(staff, Object.fromEntries(set.map((k) => [k, body[k]])), reset, body, request);
    return this.get();
  }

  async setAllowance(staff: StaffContext, body: AdminConcurrencyAllowanceRequest, request: FastifyRequest): Promise<void> {
    await this.write(staff, { concurrency_platform_limit: body.allowance }, [], body, request);
  }

  private async write(
    staff: StaffContext,
    values: Partial<Record<PlatformSettingKey, unknown>>,
    reset: PlatformSettingKey[],
    reason: { reason_code: AdminSettingsUpdateRequest['reason_code']; note?: string; ticket_id?: number },
    request: FastifyRequest,
  ): Promise<void> {
    const before = (await this.config.settings()).settings;
    await adminDb.$transaction(async (tx) => {
      for (const [key, value] of Object.entries(values)) {
        // A JSON null is a value here ("not monitored"), not an absent row.
        const json = value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
        await tx.platformSetting.upsert({
          where: { key },
          create: { key, value: json, updatedBy: staff.staffId },
          update: { value: json, updatedBy: staff.staffId },
        });
      }
      if (reset.length) await tx.platformSetting.deleteMany({ where: { key: { in: reset } } });
      await this.audit.record(
        {
          staff,
          action: 'settings.updated',
          targetType: 'platform_settings',
          targetId: [...Object.keys(values), ...reset].join(','),
          reasonCode: reason.reason_code,
          note: reason.note,
          before: Object.fromEntries([...Object.keys(values), ...reset].map((k) => [k, before[k as PlatformSettingKey]])),
          after: { ...values, ...(reset.length ? { reset } : {}) },
          request,
        },
        tx,
      );
    });
    await this.config.invalidateSettings();
  }
}
