import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import { portalUrl } from '../../common/env';
import { OpsAlertService } from '../alerts';
import { PlatformConfigService } from '../config';
import { NotificationsService, WorkspaceAlertsService } from '../notifications';
import { DuplicateRentalDebit, RENTAL_REF_TYPE, WalletService, addMonths } from '../wallet/wallet.service';
import { NumberProvisioningService } from './number-provisioning.service';

export type RentalOutcome =
  | { outcome: 'charged'; numberId: string; workspaceId: string; credits: number; period: string; balanceAfter: number; duplicate: boolean }
  | { outcome: 'free'; numberId: string; workspaceId: string; period: string }
  | { outcome: 'overdue'; numberId: string; workspaceId: string; period: string; balance: number; daysOverdue: number; warned: number[] }
  | { outcome: 'not_due'; numberId: string; workspaceId: string }
  | { outcome: 'failed'; numberId: string; workspaceId: string; error: string };

export type ReleaseOutcome =
  | { outcome: 'released'; numberId: string; workspaceId: string; e164: string | null; daysOverdue: number }
  | { outcome: 'failed'; numberId: string; workspaceId: string; error: string };

/**
 * Pure: charge, or mark overdue? The one rule the wallet asks recurring charges to obey
 * (WalletService.debit): never debit past the grace overdraft — take the §5.3 "release
 * after N days at zero balance" path instead.
 */
export function decideRental(input: { balance: number; rental: number; grace: number }): 'charge' | 'overdue' {
  if (input.rental <= 0) return 'charge';
  return input.balance - input.rental >= -input.grace ? 'charge' : 'overdue';
}

/** Whole days between `since` and `now`, floored. */
export function daysBetween(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000));
}

/**
 * §5.3 recurring number charges (§13.11 `number-rental`, `number-release`).
 *
 * A platform-bought number costs `recurring.number_rental_credits` a month, on the
 * anniversary `next_rental_at` set at bind. A BYO SIP number (`custom_sip`) costs 0 and
 * is never touched here — the type is the rule, not the row's `rental_credits`.
 *
 * Idempotent by construction, in three layers:
 *   1. the ledger row carries `ref_id = <number id>:<period>` under the partial unique
 *      index, so a second run of the same period is a no-op even without the lock (the
 *      loser's transaction is aborted by the index, and it reports the period as charged);
 *   2. the debit and the advance of `next_rental_at` happen in one wallet transaction
 *      under the per-workspace advisory lock — a crash between them cannot happen, and two
 *      workers cannot both see the period as due;
 *   3. the row is re-read *inside* that transaction, so a number released between the
 *      sweep's SELECT and the lock is skipped.
 *
 * Overdue: a due rental the wallet cannot cover past the grace sets `rental_overdue_since`
 * and leaves `next_rental_at` where it is. Every later run re-tries the *same* period, warns
 * at `rental_warning_days`, and `releaseOverdue()` releases the number once
 * `release_after_days_at_zero_balance` have passed — platform first, row `released` after,
 * exactly the DELETE path (NumberProvisioningService.release), so a platform failure leaves
 * the row `releasing` and the next run tries again.
 */
@Injectable()
export class NumberRentalService {
  private readonly log = new Logger(NumberRentalService.name);

  constructor(
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly provisioning: NumberProvisioningService,
    private readonly alerts: WorkspaceAlertsService,
    private readonly notifications: NotificationsService,
    private readonly ops: OpsAlertService,
  ) {}

  /** The hourly sweep: every rentable number whose anniversary has passed. */
  async chargeDue(now = new Date(), limit = 500): Promise<{ due: number; charged: number; overdue: number; failed: number; credits: number }> {
    const due = await adminDb.phoneNumber.findMany({
      where: { nextRentalAt: { lte: now }, status: { in: ['active', 'paused'] }, type: { not: 'custom_sip' }, e164: { not: null } },
      orderBy: { nextRentalAt: 'asc' },
      take: limit,
      select: { id: true, tenantId: true },
    });
    const totals = { due: due.length, charged: 0, overdue: 0, failed: 0, credits: 0 };
    for (const row of due) {
      const outcome = await this.chargeOne(row.id, now);
      if (outcome.outcome === 'charged') {
        totals.charged += 1;
        if (!outcome.duplicate) totals.credits += outcome.credits;
      } else if (outcome.outcome === 'overdue') totals.overdue += 1;
      else if (outcome.outcome === 'failed') totals.failed += 1;
    }
    if (due.length) this.log.log(`number-rental: ${due.length} due, ${totals.charged} charged (${totals.credits} credits), ${totals.overdue} overdue, ${totals.failed} failed`);
    return totals;
  }

  /** One number's rental for the period `next_rental_at` names. Safe to call for a number that is not due. */
  async chargeOne(numberId: string, now = new Date()): Promise<RentalOutcome> {
    const snapshot = await adminDb.phoneNumber.findUnique({ where: { id: numberId }, select: { id: true, tenantId: true } });
    if (!snapshot) return { outcome: 'failed', numberId, workspaceId: '', error: 'no such number' };
    const workspaceId = snapshot.tenantId;

    const [{ config, version }, { policy }] = await Promise.all([this.config.currentPricing(), this.config.walletPolicy()]);
    const rental = Math.round(config.recurring.number_rental_credits * 100) / 100;
    const grace = policy.grace_overdraft_credits;

    let result: RentalOutcome;
    try {
      result = await this.wallet.withWallet(workspaceId, async (tx, wallet) => {
        // Under the lock: the row as it is *now*, not as the sweep saw it.
        const row = await tx.phoneNumber.findUnique({
          where: { id: numberId },
          select: { id: true, tenantId: true, e164: true, type: true, status: true, nextRentalAt: true, rentalOverdueSince: true, agentId: true },
        });
        if (!row || row.tenantId !== workspaceId) return { outcome: 'failed' as const, numberId, workspaceId, error: 'number moved or vanished under the lock' };
        if (!row.nextRentalAt || row.nextRentalAt > now) return { outcome: 'not_due' as const, numberId, workspaceId };
        if (row.status !== 'active' && row.status !== 'paused') return { outcome: 'not_due' as const, numberId, workspaceId };
        if (row.type === 'custom_sip' || !row.e164) return { outcome: 'not_due' as const, numberId, workspaceId };

        const period = row.nextRentalAt.toISOString();
        const nextPeriod = addMonths(row.nextRentalAt, 1);

        if (rental <= 0) {
          await tx.phoneNumber.update({ where: { id: row.id }, data: { nextRentalAt: nextPeriod, lastRentalAt: row.nextRentalAt, rentalCredits: 0, rentalOverdueSince: null } });
          return { outcome: 'free' as const, numberId, workspaceId, period };
        }

        const balance = await wallet.balanceInTx();
        if (decideRental({ balance, rental, grace }) === 'overdue') {
          const since = row.rentalOverdueSince ?? now;
          if (!row.rentalOverdueSince) await tx.phoneNumber.update({ where: { id: row.id }, data: { rentalOverdueSince: since } });
          return { outcome: 'overdue' as const, numberId, workspaceId, period, balance, daysOverdue: daysBetween(since, now), warned: [] as number[] };
        }

        // A replay of this period is answered by the pre-check inside `debit` with
        // `duplicate: true`. A *race* past it raises DuplicateRentalDebit, which has to
        // propagate: the unique violation has already aborted this Postgres transaction,
        // so nothing after it can run — it is handled below, outside the transaction.
        const write = await wallet.debit({ credits: rental, reason: 'rental', refType: RENTAL_REF_TYPE, refId: `${row.id}:${period}` });
        await tx.phoneNumber.update({
          where: { id: row.id },
          data: { nextRentalAt: nextPeriod, lastRentalAt: row.nextRentalAt, rentalCredits: Math.round(rental), rentalOverdueSince: null },
        });
        return { outcome: 'charged' as const, numberId, workspaceId, credits: Math.abs(write.delta), period, balanceAfter: write.balance_after, duplicate: write.duplicate };
      });
    } catch (error) {
      if (error instanceof DuplicateRentalDebit) {
        // Two runs raced on one period and the other won: its transaction debited the
        // ledger and advanced `next_rental_at` together, and ours rolled back before it
        // touched the row. Nothing is owed and nothing is left to retry.
        const period = error.refId.slice(numberId.length + 1);
        this.log.log(`number-rental ${numberId} (${workspaceId}): period ${period} was charged by a concurrent run`);
        return { outcome: 'charged', numberId, workspaceId, credits: rental, period, balanceAfter: await this.wallet.balance(workspaceId), duplicate: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`number-rental ${numberId} (${workspaceId}): failed: ${message}`);
      return { outcome: 'failed', numberId, workspaceId, error: message };
    }

    if (result.outcome === 'charged') {
      this.log.log(
        `number-rental ${numberId} (${workspaceId}): ${result.duplicate ? 'already charged' : `charged ${result.credits} credits`} for period ${result.period} at pricing v${version}; balance ${result.balanceAfter.toFixed(2)}`,
      );
      const cleared = await this.alerts.resolve(workspaceId, { prefix: `rental_overdue:${numberId}:` });
      if (cleared) this.log.log(`number-rental ${numberId}: ${cleared} overdue alert(s) resolved`);
    } else if (result.outcome === 'overdue') {
      this.log.warn(`number-rental ${numberId} (${workspaceId}): balance ${result.balance.toFixed(2)} cannot cover ${rental} credits past the ${grace}-credit grace; overdue ${result.daysOverdue} day(s)`);
      result.warned = await this.warnOverdue(numberId, workspaceId, result.daysOverdue, config.recurring.rental_warning_days, config.recurring.release_after_days_at_zero_balance, rental);
    }
    return result;
  }

  /** §5.3 warnings at `rental_warning_days`: one alert and one email per warning day, ever, per overdue spell. */
  private async warnOverdue(numberId: string, workspaceId: string, daysOverdue: number, warningDays: number[], releaseAfter: number, rental: number): Promise<number[]> {
    const warned: number[] = [];
    const [number, tenant] = await Promise.all([
      adminDb.phoneNumber.findUnique({ where: { id: numberId }, select: { e164: true } }),
      adminDb.tenant.findUnique({ where: { id: workspaceId }, select: { name: true, pausedAt: true } }),
    ]);
    // Day 0 is always a warning, so the customer hears about it the day it happens.
    const days = [...new Set([0, ...warningDays])].filter((d) => d <= daysOverdue).sort((a, b) => a - b);
    for (const day of days) {
      const opened = await this.alerts.open(workspaceId, {
        type: 'rental_overdue',
        key: `rental_overdue:${numberId}:${day}`,
        threshold: day,
        meta: { number_id: numberId, e164: number?.e164 ?? null, days_overdue: daysOverdue, rental_credits: rental, release_after_days: releaseAfter },
      });
      if (!opened.created) continue;
      warned.push(day);
      if (tenant && !tenant.pausedAt) {
        const recipients = (await this.notifications.recipients(workspaceId)).filter((r) => r.settings.low_balance_email);
        const daysLeft = Math.max(0, releaseAfter - daysOverdue);
        for (const r of recipients) {
          await this.notifications.deliver({
            workspaceId,
            userId: r.userId,
            kind: 'rental_overdue',
            dedupeKey: `rental_overdue:${opened.id}:${r.userId}`,
            email: {
              to: r.email,
              subject: `${tenant.name}: your phone number's monthly rental is unpaid`,
              text: [
                `Hi ${r.name ?? 'there'},`,
                '',
                `We could not take the ${rental} credits for this month's rental of ${number?.e164 ?? 'your number'} because the balance is too low.`,
                `The number keeps answering for now. If the balance is not topped up within ${daysLeft} day${daysLeft === 1 ? '' : 's'}, the number will be released and cannot be recovered.`,
                '',
                `Top up here: ${portalUrl()}/app/wallet`,
              ].join('\n'),
            },
            payload: { number_id: numberId, days_overdue: daysOverdue, warning_day: day },
          });
        }
      }
    }
    return warned;
  }

  /** The daily `number-release` sweep: numbers unpaid for `release_after_days_at_zero_balance`. */
  async releaseOverdue(now = new Date(), limit = 100): Promise<{ candidates: number; released: number; failed: number }> {
    const { config } = await this.config.currentPricing();
    const cutoff = new Date(now.getTime() - config.recurring.release_after_days_at_zero_balance * 86_400_000);
    const rows = await adminDb.phoneNumber.findMany({
      where: { rentalOverdueSince: { lte: cutoff }, status: { in: ['active', 'paused', 'releasing'] }, type: { not: 'custom_sip' } },
      orderBy: { rentalOverdueSince: 'asc' },
      take: limit,
      select: { id: true, tenantId: true, e164: true, rentalOverdueSince: true },
    });
    const totals = { candidates: rows.length, released: 0, failed: 0 };
    for (const row of rows) {
      const outcome = await this.releaseOne(row, now);
      if (outcome.outcome === 'released') totals.released += 1;
      else totals.failed += 1;
    }
    if (rows.length) this.log.warn(`number-release: ${rows.length} unpaid past ${config.recurring.release_after_days_at_zero_balance} days, ${totals.released} released, ${totals.failed} failed`);
    return totals;
  }

  private async releaseOne(row: { id: string; tenantId: string; e164: string | null; rentalOverdueSince: Date | null }, now: Date): Promise<ReleaseOutcome> {
    const daysOverdue = row.rentalOverdueSince ? daysBetween(row.rentalOverdueSince, now) : 0;
    try {
      // Platform first, row after — a failure here leaves the row `releasing` and the next
      // daily run comes back to it. Never `released` on a platform error.
      const { released } = await this.provisioning.release(row.id, row.tenantId);
      if (released) {
        await adminDb.auditLog.create({
          data: {
            tenantId: row.tenantId,
            actorUserId: null,
            action: 'number.released_unpaid',
            targetType: 'phone_number',
            targetId: row.id,
            metaJson: { e164: row.e164, days_overdue: daysOverdue, overdue_since: row.rentalOverdueSince?.toISOString() ?? null } as Prisma.InputJsonValue,
          },
        });
        await this.alerts.resolve(row.tenantId, { prefix: `rental_overdue:${row.id}:` });
        const opened = await this.alerts.open(row.tenantId, {
          type: 'number_released',
          key: `number_released:${row.id}`,
          meta: { number_id: row.id, e164: row.e164, days_overdue: daysOverdue },
        });
        if (opened.created) await this.notifyReleased(row, daysOverdue, opened.id);
        this.log.warn(`number-release ${row.id} (${row.tenantId}): released ${row.e164 ?? '(no e164)'} after ${daysOverdue} unpaid days`);
      }
      return { outcome: 'released', numberId: row.id, workspaceId: row.tenantId, e164: row.e164, daysOverdue };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`number-release ${row.id} (${row.tenantId}): platform release failed, row left as-is: ${message}`);
      await this.ops.send({
        kind: 'number_release_failed',
        severity: 'warning',
        title: 'Unpaid number could not be released on the platform',
        fields: { workspace_id: row.tenantId, number_id: row.id, e164: row.e164, days_overdue: daysOverdue, error: message.slice(0, 200) },
      });
      return { outcome: 'failed', numberId: row.id, workspaceId: row.tenantId, error: message };
    }
  }

  private async notifyReleased(row: { id: string; tenantId: string; e164: string | null }, daysOverdue: number, alertId: string): Promise<void> {
    const tenant = await adminDb.tenant.findUnique({ where: { id: row.tenantId }, select: { name: true, pausedAt: true } });
    if (!tenant || tenant.pausedAt) return;
    const recipients = await this.notifications.recipients(row.tenantId);
    for (const r of recipients) {
      await this.notifications.deliver({
        workspaceId: row.tenantId,
        userId: r.userId,
        kind: 'number_released',
        dedupeKey: `number_released:${alertId}:${r.userId}`,
        email: {
          to: r.email,
          subject: `${tenant.name}: ${row.e164 ?? 'your phone number'} has been released`,
          text: [
            `Hi ${r.name ?? 'there'},`,
            '',
            `The monthly rental for ${row.e164 ?? 'your number'} went unpaid for ${daysOverdue} days, so the number has been released and no longer rings your agent.`,
            `Your agent, its settings and call history are untouched. To go live again, buy credits and attach a new number from the Numbers page.`,
            '',
            `${portalUrl()}/app/numbers`,
          ].join('\n'),
        },
        payload: { number_id: row.id, days_overdue: daysOverdue },
      });
    }
  }
}
