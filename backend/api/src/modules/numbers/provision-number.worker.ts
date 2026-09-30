import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { adminDb } from '@portal/db';
import { failActiveSpan, reportError } from '../../observability';
import { OpsAlertService } from '../alerts';
import type { ProvisionNumberJob } from '../jobs';
import { NumberProvisioningService } from './number-provisioning.service';
import { classifyError } from './provisioning-error';

/**
 * `provision-number` — the off-wizard buy/import (§11), which is the activation job's
 * *provision* and *bind* steps without the publish around them. Same idempotency, same
 * classification, same alert when it gives up.
 */
@Injectable()
export class ProvisionNumberWorker {
  private readonly log = new Logger(ProvisionNumberWorker.name);

  constructor(
    private readonly provisioning: NumberProvisioningService,
    private readonly alerts: OpsAlertService,
  ) {}

  async run(job: Job<ProvisionNumberJob>): Promise<{ outcome: string; e164?: string; reason?: string }> {
    const { numberId, workspaceId } = job.data;
    const attemptsLeft = Math.max(0, (job.opts.attempts ?? 1) - job.attemptsMade - 1);
    try {
      const provisioned = await this.provisioning.provision(numberId, workspaceId);
      await this.provisioning.bind(numberId, workspaceId);
      this.log.log(`number ${numberId}: provisioned and bound (${provisioned.e164})`);
      return { outcome: 'active', e164: provisioned.e164 };
    } catch (raw) {
      const error = classifyError(raw);
      const willRetry = error.retryable && attemptsLeft > 0;
      this.log.error(`number ${numberId}: provisioning failed (${error.kind}: ${error.message}); ${willRetry ? 'retrying' : 'giving up'}`);
      if (willRetry) throw error;

      await this.provisioning.markFailed(numberId, error.customerReason, `${error.kind}: ${error.message}`);
      const row = await adminDb.phoneNumber.findUnique({ where: { id: numberId }, select: { agentId: true, e164: true, type: true } });
      // Returned, not thrown: BullMQ records success, so report the failure here or no one sees it.
      failActiveSpan(error);
      reportError(error, {
        tags: { queue: 'provisioning', job: 'provision-number', error_kind: error.kind },
        extra: { workspace_id: workspaceId, number_id: numberId, number_type: row?.type ?? null, job_id: job.id ?? null, platform_status: error.options.status ?? null },
      });
      await this.alerts.send({
        kind: 'number_provisioning_failed',
        severity: 'critical',
        title: 'Phone number provisioning failed for good',
        fields: {
          workspace_id: workspaceId,
          agent_id: row?.agentId ?? null,
          number_id: numberId,
          number_type: row?.type ?? null,
          e164: row?.e164 ?? null,
          attempts: job.attemptsMade + 1,
          error_kind: error.kind,
          error: error.message,
          job_id: job.id ?? null,
        },
      });
      return { outcome: 'failed', reason: `${error.kind}: ${error.message}` };
    }
  }
}
