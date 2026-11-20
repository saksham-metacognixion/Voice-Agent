import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import { portalUrl } from '../../common/env';
import { PlatformConfigService } from '../config';
import { WalletService } from '../wallet/wallet.service';
import { decideLowBalance, lowBalanceKey, pctOfLowBalanceKey } from './low-balance.decide';
import { NotificationsService } from './notifications.service';
import { WorkspaceAlertsService } from './workspace-alerts.service';

export interface LowBalanceOutcome {
  workspaceId: string;
  balance: number;
  baseCredits: number;
  opened: number[];
  resolved: number[];
  emailed: number;
}

/**
 * §5.4 low-balance alerts (§13.11 `low-balance-alerts`).
 *
 * Runs from two places with one body: the ledger listener on every debit (the crossing
 * is noticed the moment a call is billed) and the 15-minute schedule (the backstop for a
 * listener a worker restart missed, and the only path that *resolves* after a purchase
 * landed while the worker was down). Both are safe to run at once: the alert state is
 * the `alerts_open_key_idx` row, and the email is claimed through the notifications
 * outbox, so a duplicate evaluation opens nothing and sends nothing.
 *
 * One evaluation sends at most one email, for the *lowest* threshold it crossed. A single
 * call that takes the balance through 20 %, 5 % and 0 opens three alerts — the banner is
 * true three times over — but the customer hears about it once, with the worst news, not
 * three times in the same second.
 */
@Injectable()
export class LowBalanceAlertsService {
  private readonly log = new Logger(LowBalanceAlertsService.name);

  constructor(
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly alerts: WorkspaceAlertsService,
    private readonly notifications: NotificationsService,
  ) {}

  async evaluate(workspaceId: string, trigger: 'ledger' | 'schedule', knownBalance?: number): Promise<LowBalanceOutcome | null> {
    const tenant = await adminDb.tenant.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, pausedAt: true } });
    if (!tenant) return null;

    const [{ policy }, balance, lastPaid, trial] = await Promise.all([
      this.config.walletPolicy(),
      knownBalance === undefined ? this.wallet.balance(workspaceId) : Promise.resolve(knownBalance),
      adminDb.purchase.findFirst({ where: { tenantId: workspaceId, status: 'paid' }, orderBy: { createdAt: 'desc' }, select: { credits: true } }),
      adminDb.creditLedger.findFirst({ where: { tenantId: workspaceId, reason: 'trial' }, select: { delta: true } }),
    ]);
    const baseCredits = lastPaid?.credits ?? trial?.delta.toNumber() ?? 0;
    const openKeys = await this.alerts.openKeys(workspaceId, 'low_balance');
    const openPct = new Set([...openKeys].map(pctOfLowBalanceKey).filter((p): p is number => p !== null));

    const decision = decideLowBalance({ balance, baseCredits, thresholdsPct: policy.low_balance_thresholds_pct, openPct });
    const outcome: LowBalanceOutcome = { workspaceId, balance, baseCredits, opened: [], resolved: [], emailed: 0 };

    for (const pct of decision.resolve) {
      if ((await this.alerts.resolve(workspaceId, { key: lowBalanceKey(pct) })) > 0) outcome.resolved.push(pct);
    }
    if (outcome.resolved.length) this.log.log(`low-balance ${workspaceId}: balance ${balance} recovered above ${outcome.resolved.join('%, ')}% (${trigger})`);

    // `decision.open` is largest threshold first, so the last one opened is the lowest.
    let worst: { id: string; pct: number; credits: number } | null = null;
    for (const { pct, credits } of decision.open) {
      const opened = await this.alerts.open(workspaceId, {
        type: 'low_balance',
        key: lowBalanceKey(pct),
        threshold: pct,
        meta: { balance, threshold_credits: credits, base_credits: baseCredits },
      });
      if (!opened.created) continue;
      outcome.opened.push(pct);
      worst = { id: opened.id, pct, credits };
      this.log.warn(`low-balance ${workspaceId}: balance ${balance} ≤ ${credits} (${pct}% of ${baseCredits}) — alert ${opened.id} opened (${trigger})`);
    }
    // The paused check is on the email only: the banner is still true for a paused workspace.
    if (worst && !tenant.pausedAt) outcome.emailed += await this.email(tenant, worst.id, worst.pct, worst.credits, balance);
    return outcome;
  }

  private async email(tenant: { id: string; name: string }, alertId: string, pct: number, credits: number, balance: number): Promise<number> {
    const recipients = (await this.notifications.recipients(tenant.id)).filter((r) => r.settings.low_balance_email);
    let sent = 0;
    const portal = portalUrl();
    for (const r of recipients) {
      const subject = pct === 0 ? `${tenant.name}: your agent has run out of credits` : `${tenant.name}: credits are running low (${pct}% left)`;
      const text = [
        `Hi ${r.name ?? 'there'},`,
        '',
        pct === 0
          ? `${tenant.name} has used all of its credits (balance ${balance.toFixed(2)}). Your phone agent will stop answering once the small grace allowance is used.`
          : `${tenant.name} has ${balance.toFixed(2)} credits left, below the ${pct}% mark (${credits.toFixed(0)} credits) of your last pack.`,
        '',
        `Top up here: ${portal}/app/wallet`,
        'Turn on auto top-up on the same page and this will not happen again.',
      ].join('\n');
      const result = await this.notifications.deliver({
        workspaceId: tenant.id,
        userId: r.userId,
        kind: 'low_balance',
        dedupeKey: `low_balance:${alertId}:${r.userId}`,
        email: { to: r.email, subject, text },
        payload: { alert_id: alertId, pct, balance },
      });
      if (result.outcome === 'sent') sent += 1;
    }
    return sent;
  }

  /**
   * The 15-minute sweep. Two kinds of workspace can have anything to do: one with an open
   * low-balance alert (a purchase may have cleared it while the worker was down), and one
   * whose ledger moved since the last sweep (a crossing the listener missed). Everyone else
   * is exactly where the last evaluation left them. So the sweep reads the ledger only for
   * those — the table is append-only, one row per call, and aggregating it whole 96 times
   * a day on the pool the webhooks share is a cost that grows with every call ever made.
   * The lookback is three intervals, so a tick the lock skipped is still covered.
   */
  async sweep(lookbackMs = SWEEP_LOOKBACK_MS): Promise<{ evaluated: number; opened: number; resolved: number; emailed: number }> {
    const since = new Date(Date.now() - lookbackMs);
    const [moved, open] = await Promise.all([
      adminDb.creditLedger.findMany({ where: { createdAt: { gte: since } }, select: { tenantId: true }, distinct: ['tenantId'] }),
      adminDb.alert.findMany({ where: { type: 'low_balance', resolvedAt: null }, select: { tenantId: true }, distinct: ['tenantId'] }),
    ]);
    const workspaces = new Set([...moved, ...open].map((row) => row.tenantId));
    const totals = { evaluated: 0, opened: 0, resolved: 0, emailed: 0 };
    for (const workspaceId of workspaces) {
      try {
        const outcome = await this.evaluate(workspaceId, 'schedule');
        if (!outcome) continue;
        totals.evaluated += 1;
        totals.opened += outcome.opened.length;
        totals.resolved += outcome.resolved.length;
        totals.emailed += outcome.emailed;
      } catch (error) {
        this.log.error(`low-balance sweep for ${workspaceId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (totals.opened || totals.resolved) this.log.log(`low-balance sweep: ${totals.evaluated} evaluated, ${totals.opened} opened, ${totals.resolved} resolved, ${totals.emailed} emails`);
    return totals;
  }
}

/** How far back the sweep looks for ledger movement: three 15-minute intervals. */
export const SWEEP_LOOKBACK_MS = 45 * 60_000;
