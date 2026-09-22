import { Module, type OnModuleInit } from '@nestjs/common';
import { AutoTopupService, BillingModule } from '../billing';
import { PlatformConfigModule } from '../config';
import { EventsModule } from '../events';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { AlertsController } from './alerts.controller';
import { DailyDigestService } from './daily-digest.service';
import { createEmailSender } from './email.sender';
import { LowBalanceAlertsService } from './low-balance.service';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationsService } from './notifications.service';
import { EMAIL_SENDER } from './notifications.tokens';
import { AUTO_TOPUP_FAILED_KEY, WorkspaceAlertsService } from './workspace-alerts.service';

/**
 * Spec §13.1 `notifications` (D7): the outbox, the email sender, the customer alert
 * state (`alerts`), §5.4 low-balance alerts and the §13.11 daily digest.
 *
 * `numbers` (rental overdue, release) and `calls` (concurrency) raise their alerts
 * through `WorkspaceAlertsService`. This module depends on `wallet`, `billing` and
 * `config`; `billing` announces a top-up outcome and the listener here turns it into
 * the customer's `auto_topup_failed` alert, so billing never writes `alerts` and never
 * imports this module. The arrows stay one-way: notifications → billing → wallet.
 */
@Module({
  imports: [EventsModule, WalletModule, BillingModule, PlatformConfigModule],
  controllers: [AlertsController],
  providers: [
    { provide: EMAIL_SENDER, useFactory: () => createEmailSender() },
    NotificationsService,
    WorkspaceAlertsService,
    LowBalanceAlertsService,
    DailyDigestService,
    NotificationSettingsService,
  ],
  exports: [NotificationsService, WorkspaceAlertsService, LowBalanceAlertsService, DailyDigestService, NotificationSettingsService, EMAIL_SENDER],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly wallet: WalletService,
    private readonly lowBalance: LowBalanceAlertsService,
    private readonly topups: AutoTopupService,
    private readonly alerts: WorkspaceAlertsService,
  ) {}

  /**
   * §5.4: every ledger write re-evaluates the low-balance thresholds — a debit may cross
   * one, a grant may clear one. The listener's own work is bounded (a few reads and an
   * idempotent insert); the email goes through the outbox with its own timeout.
   *
   * §5.4 auto top-up: a declined or given-up charge opens one keyed alert for the D1
   * banner — a second decline during the cooldown opens nothing while it is open — and a
   * top-up Stripe confirmed resolves it, so the banner clears itself once the card works.
   */
  onModuleInit(): void {
    this.wallet.onLedgerWrite(async ({ workspaceId, write }) => {
      await this.lowBalance.evaluate(workspaceId, 'ledger', write.balance_after);
    });
    this.topups.onAbandoned(async ({ workspaceId, purchaseId, reason }) => {
      await this.alerts.open(workspaceId, { type: 'auto_topup_failed', key: AUTO_TOPUP_FAILED_KEY, meta: { purchase_id: purchaseId, reason } });
    });
    this.topups.onCredited(async ({ workspaceId }) => {
      await this.alerts.resolve(workspaceId, { key: AUTO_TOPUP_FAILED_KEY });
    });
  }
}
