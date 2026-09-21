import { Module, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AlertsModule } from '../alerts';
import { PlatformConfigModule } from '../config';
import { CryptoModule } from '../crypto';
import { JOBS, JobHandlerRegistry, type ProvisionNumberJob, QUEUES } from '../jobs';
import { RetellModule } from '../retell';
import { RuntimeCacheModule } from '../runtime-cache';
import { WalletModule } from '../wallet';
import { NumberProvisioningService } from './number-provisioning.service';
import { NumbersController, PhonePlanController } from './numbers.controller';
import { NumbersService } from './numbers.service';
import { PhonePlansService } from './phone-plans.service';
import { ProvisionNumberWorker } from './provision-number.worker';

/**
 * Spec §13.1 `numbers` (§11, W6, D4). `NumberProvisioningService` is exported because
 * the activation workflow's *provision* and *bind* steps are these same operations;
 * `activation` depends on `numbers`, never the reverse.
 */
@Module({
  // The two global modules are imported explicitly for the same reason BillingModule does it.
  imports: [RetellModule, PlatformConfigModule, RuntimeCacheModule, WalletModule, AlertsModule, CryptoModule],
  controllers: [PhonePlanController, NumbersController],
  providers: [PhonePlansService, NumberProvisioningService, NumbersService, ProvisionNumberWorker],
  exports: [PhonePlansService, NumberProvisioningService, NumbersService],
})
export class NumbersModule implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly worker: ProvisionNumberWorker,
  ) {}

  onModuleInit(): void {
    this.registry.register<ProvisionNumberJob>(QUEUES.provisioning, JOBS.provisionNumber, (job: Job<ProvisionNumberJob>) => this.worker.run(job));
  }
}
