import { Global, Module } from '@nestjs/common';
import { OpsAlertService, createOpsAlertService } from './ops-alert.service';

/**
 * Operations alerts: a log line always, a webhook post when `OPS_ALERT_WEBHOOK_URL` is
 * set. Global so a job in any module can raise one without an import each.
 */
@Global()
@Module({
  providers: [{ provide: OpsAlertService, useFactory: () => createOpsAlertService() }],
  exports: [OpsAlertService],
})
export class AlertsModule {}
