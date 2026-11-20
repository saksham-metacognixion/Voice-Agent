import { Injectable, Logger } from '@nestjs/common';
import { portalUrl } from '../../common/env';
import { Prisma, adminDb } from '@portal/db';
import { WalletService } from '../wallet/wallet.service';
import { localDayBounds, localDate, localHour, previousDate } from './local-day';
import { NotificationsService } from './notifications.service';

/** Local hour after which a workspace's digest for the previous local day goes out. */
export const DEFAULT_DIGEST_LOCAL_HOUR = 8;

export interface DigestStats {
  calls: number;
  answered: number;
  missed: number;
  minutes: number;
  credits: number;
  balance: number;
}

export type DigestOutcome =
  | { outcome: 'sent'; workspaceId: string; date: string; recipients: number }
  | { outcome: 'skipped'; workspaceId: string; date: string; reason: 'not_yet' | 'already_done' | 'no_recipient' | 'no_activity' | 'bad_timezone' }
  | { outcome: 'failed'; workspaceId: string; date: string; error: string };

/**
 * §13.11 `daily-digest`, in each workspace's own timezone.
 *
 * The schedule runs **hourly**, not at one UTC midnight: on every tick, each workspace
 * is asked "is it past the digest hour in *your* zone, and has the digest for *your*
 * previous local day gone out?" — so Toronto gets its digest at 08:00 Toronto time,
 * Kolkata at 08:00 Kolkata time, and a DST day is a 23- or 25-hour day rather than a
 * UTC-shifted 24 hours (`local-day.ts`).
 *
 * Exactly once per workspace-day: the notifications outbox row keyed
 * `daily_digest:<ws>:<local date>[:<user>]` is the claim, so two ticks (or two workers)
 * racing on the same day send one digest, and a day that was skipped (nobody opted in,
 * no activity) is recorded and not re-evaluated every hour.
 */
@Injectable()
export class DailyDigestService {
  private readonly log = new Logger(DailyDigestService.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly wallet: WalletService,
  ) {}

  /** The hourly tick. `now` and `hour` are parameters for the tests. */
  async sweep(now = new Date(), hour = digestHour()): Promise<{ workspaces: number; sent: number; skipped: number; failed: number }> {
    const tenants = await adminDb.tenant.findMany({ where: { pausedAt: null }, select: { id: true, name: true, timezone: true } });
    const totals = { workspaces: tenants.length, sent: 0, skipped: 0, failed: 0 };
    for (const tenant of tenants) {
      const outcome = await this.evaluate(tenant, now, hour);
      if (outcome.outcome === 'sent') totals.sent += 1;
      else if (outcome.outcome === 'skipped') totals.skipped += 1;
      else totals.failed += 1;
    }
    if (totals.sent || totals.failed) this.log.log(`daily-digest: ${totals.sent} sent, ${totals.skipped} skipped, ${totals.failed} failed across ${totals.workspaces} workspaces`);
    return totals;
  }

  async evaluate(tenant: { id: string; name: string; timezone: string }, now = new Date(), hour = digestHour()): Promise<DigestOutcome> {
    const today = localDate(now, tenant.timezone) ?? localDate(now, 'UTC')!;
    const zone = localDate(now, tenant.timezone) ? tenant.timezone : 'UTC';
    if (zone !== tenant.timezone) this.log.warn(`daily-digest ${tenant.id}: timezone "${tenant.timezone}" is unknown; using UTC`);
    const date = previousDate(today);
    const currentHour = localHour(now, zone) ?? 0;
    if (currentHour < hour) return { outcome: 'skipped', workspaceId: tenant.id, date, reason: 'not_yet' };

    const base = `daily_digest:${tenant.id}:${date}`;
    const done = await adminDb.notification.findFirst({ where: { dedupeKey: { startsWith: base } }, select: { id: true } });
    if (done) return { outcome: 'skipped', workspaceId: tenant.id, date, reason: 'already_done' };

    const bounds = localDayBounds(date, zone);
    if (!bounds) return { outcome: 'skipped', workspaceId: tenant.id, date, reason: 'bad_timezone' };

    try {
      const recipients = (await this.notifications.recipients(tenant.id, ['owner', 'admin', 'editor', 'viewer'])).filter((r) => r.settings.new_message === 'daily');
      if (recipients.length === 0) {
        await this.notifications.skip({ workspaceId: tenant.id, kind: 'daily_digest', dedupeKey: base, reason: 'no_recipient', payload: { date, timezone: zone } });
        return { outcome: 'skipped', workspaceId: tenant.id, date, reason: 'no_recipient' };
      }
      const stats = await this.stats(tenant.id, bounds.start, bounds.end);
      if (stats.calls === 0) {
        await this.notifications.skip({ workspaceId: tenant.id, kind: 'daily_digest', dedupeKey: base, reason: 'no_activity', payload: { date, timezone: zone } });
        return { outcome: 'skipped', workspaceId: tenant.id, date, reason: 'no_activity' };
      }
      const email = renderDigest(tenant.name, date, zone, stats, portalUrl());
      let sent = 0;
      for (const r of recipients) {
        const result = await this.notifications.deliver({
          workspaceId: tenant.id,
          userId: r.userId,
          kind: 'daily_digest',
          dedupeKey: `${base}:${r.userId}`,
          email: { ...email, to: r.email },
          payload: { date, timezone: zone, window_start: bounds.start.toISOString(), window_end: bounds.end.toISOString(), ...stats },
        });
        if (result.outcome === 'sent') sent += 1;
      }
      this.log.log(`daily-digest ${tenant.id}: ${date} (${zone}) → ${sent}/${recipients.length} recipients, ${stats.calls} calls`);
      return { outcome: 'sent', workspaceId: tenant.id, date, recipients: sent };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`daily-digest ${tenant.id}: ${date} failed: ${message}`);
      return { outcome: 'failed', workspaceId: tenant.id, date, error: message };
    }
  }

  /** The previous local day's numbers, from `calls` on the admin connection. */
  async stats(workspaceId: string, start: Date, end: Date): Promise<DigestStats> {
    const where: Prisma.CallWhereInput = { tenantId: workspaceId, startedAt: { gte: start, lt: end }, isTest: false };
    const [totals, answered, balance] = await Promise.all([
      adminDb.call.aggregate({ where, _count: { _all: true }, _sum: { durationS: true, creditsCharged: true } }),
      adminDb.call.count({ where: { ...where, status: { not: 'declined' } } }),
      this.wallet.balance(workspaceId),
    ]);
    const calls = totals._count._all;
    return {
      calls,
      answered,
      missed: calls - answered,
      minutes: Math.round(((totals._sum.durationS ?? 0) / 60) * 100) / 100,
      credits: Math.round((totals._sum.creditsCharged?.toNumber() ?? 0) * 100) / 100,
      balance,
    };
  }
}

export function digestHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DIGEST_LOCAL_HOUR);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : DEFAULT_DIGEST_LOCAL_HOUR;
}

export function renderDigest(workspaceName: string, date: string, timeZone: string, s: DigestStats, portalUrl: string): { subject: string; text: string } {
  const subject = `${workspaceName}: ${s.calls} call${s.calls === 1 ? '' : 's'} on ${date}`;
  const text = [
    `Your agent's day — ${date} (${timeZone})`,
    '',
    `Calls answered:   ${s.answered}`,
    `Missed:           ${s.missed}`,
    `Minutes on phone: ${s.minutes.toFixed(2)}`,
    `Credits used:     ${s.credits.toFixed(2)}`,
    `Balance now:      ${s.balance.toFixed(2)} credits`,
    '',
    `Call list and recordings: ${portalUrl}/app/calls?date=${date}`,
    `Change how often you hear from us: ${portalUrl}/app/settings/notifications`,
  ].join('\n');
  return { subject, text };
}
