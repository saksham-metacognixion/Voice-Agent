import { Module } from '@nestjs/common';
import { ActivationModule } from '../activation';
import { AgentsModule } from '../agents';
import { AlertsModule } from '../alerts';
import { BillingModule } from '../billing';
import { CallsModule } from '../calls';
import { PlatformConfigModule } from '../config';
import { EventsModule } from '../events';
import { RedisModule } from '../redis';
import { RetellModule } from '../retell';
import { RuntimeCacheModule } from '../runtime-cache';
import { WalletModule } from '../wallet';
import { WebhooksModule } from '../webhooks';
import { NumbersModule } from '../numbers';
import { AdminAgentsService } from './admin-agents.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminCallsService } from './admin-calls.service';
import { AdminCustomersService } from './admin-customers.service';
import { AdminFlagsService } from './admin-flags.service';
import { AdminJobsService } from './admin-jobs.service';
import { AdminKpisService } from './admin-kpis.service';
import { AdminNumbersService } from './admin-numbers.service';
import { AdminOutboundService } from './admin-outbound.service';
import { AdminOperationsController } from './admin-operations.controller';
import { AdminOperationsService } from './admin-operations.service';
import { AdminPricingService } from './admin-pricing.service';
import { AdminSearchService } from './admin-search.service';
import { AdminStaffController } from './admin-staff.controller';
import { AdminStaffService } from './admin-staff.service';
import { AdminSystemService } from './admin-system.service';
import { AdminUsersService } from './admin-users.service';
import { AdminSupportService } from './admin-support.service';
import { AdminWebhooksService } from './admin-webhooks.service';
import { AdminBillingService } from './admin-billing.service';
import { AdminBillingController, AdminCustomerBillingController } from './admin-billing.controller';
import {
  AdminAgentsController,
  AdminAuditController,
  AdminCallsController,
  AdminCustomersController,
  AdminFlagsController,
  AdminImpersonationsController,
  AdminJobsController,
  AdminKpisController,
  AdminMeController,
  AdminNumbersController,
  AdminPricingController,
  AdminSearchController,
  AdminSystemController,
  AdminUsersController,
  AdminWebhooksController,
} from './admin.controllers';
import { AdminCannedResponsesController, AdminTicketsController } from './admin-support.controller';
import { ImpersonationController } from './impersonation.controller';
import { ImpersonationService } from './impersonation.service';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';

/**
 * Spec §13.1 `admin` (admin spec §9, D12): the staff console's API. It sits at the top
 * of the module graph — it imports the wallet, the runtime cache, billing, webhooks and
 * the config module and nothing imports it — so every staff action goes through the same
 * service a customer action would, plus a `staff_audit_log` row. Reads cross workspaces
 * on `adminDb` (ADR 0006).
 */
@Module({
  imports: [
    RedisModule,
    PlatformConfigModule,
    WalletModule,
    RuntimeCacheModule,
    EventsModule,
    AgentsModule,
    BillingModule,
    WebhooksModule,
    CallsModule,
    RetellModule,
    AlertsModule,
    ActivationModule,
    NumbersModule,
  ],
  controllers: [
    AdminMeController,
    AdminKpisController,
    AdminCustomersController,
    AdminImpersonationsController,
    AdminUsersController,
    AdminAgentsController,
    AdminNumbersController,
    AdminCallsController,
    AdminJobsController,
    AdminWebhooksController,
    AdminFlagsController,
    AdminPricingController,
    AdminSearchController,
    AdminSystemController,
    AdminAuditController,
    AdminStaffController,
    AdminOperationsController,
    // D13 — SA9 billing & finance.
    AdminBillingController,
    AdminCustomerBillingController,
    // D13 — SA4 support tickets and canned responses.
    AdminTicketsController,
    AdminCannedResponsesController,
    ImpersonationController,
  ],
  providers: [
    StaffAuditService,
    StaffLimitsService,
    ImpersonationService,
    AdminKpisService,
    AdminAuditService,
    AdminCustomersService,
    AdminAgentsService,
    AdminNumbersService,
    AdminOutboundService,
    AdminCallsService,
    AdminUsersService,
    AdminJobsService,
    AdminWebhooksService,
    AdminFlagsService,
    AdminPricingService,
    AdminSearchService,
    AdminSystemService,
    AdminSupportService,
    AdminStaffService,
    AdminOperationsService,
    AdminBillingService,
  ],
  exports: [StaffAuditService, StaffLimitsService, ImpersonationService],
})
export class AdminModule {}
