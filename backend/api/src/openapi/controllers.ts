import { HealthController } from '../health/health.controller';
import { ActivationController } from '../modules/activation/activation.controller';
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
  AdminReconciliationsController,
  AdminSearchController,
  AdminSystemController,
  AdminUsersController,
  AdminWebhooksController,
} from '../modules/admin/admin.controllers';
import { AdminOperationsController } from '../modules/admin/admin-operations.controller';
import { AdminStaffController } from '../modules/admin/admin-staff.controller';
import { AdminBillingController, AdminCustomerBillingController } from '../modules/admin/admin-billing.controller';
import { AdminCannedResponsesController, AdminTicketsController } from '../modules/admin/admin-support.controller';
import { ImpersonationController } from '../modules/admin/impersonation.controller';
import { AgentsController, TemplatesController } from '../modules/agents/agents.controller';
import { BillingController } from '../modules/billing/billing.controller';
import { CallsController, StatsController } from '../modules/calls/calls.controller';
import { TestCallController } from '../modules/calls/test-call.controller';
import { AgentWidgetController, PublicWidgetController } from '../modules/calls/widget.controller';
import { CallbackController, DncController, OutboundSettingsController } from '../modules/outbound/outbound.controller';
import { ConfigController } from '../modules/config/config.controller';
import { EventsController } from '../modules/events/events.controller';
import { JobsController } from '../modules/jobs/jobs.controller';
import { AgentKnowledgeController, KnowledgeController } from '../modules/knowledge/knowledge.controller';
import { AlertsController } from '../modules/notifications/alerts.controller';
import { NumbersController, PhonePlanController } from '../modules/numbers/numbers.controller';
import { PromptingController } from '../modules/prompting/prompting.controller';
import { VoicesController } from '../modules/voices/voices.controller';
import { SupportController } from '../modules/support/support.controller';
import { DataRequestsController } from '../modules/data-requests/data-requests.controller';
import { WalletController } from '../modules/wallet/wallet.controller';
import { WebhooksController } from '../modules/webhooks/webhooks.controller';
import { WorkspacesController } from '../modules/workspaces/workspaces.controller';

/**
 * Every controller the API serves in staging and prod, for route discovery. The one
 * omission is deliberate: `RetellDevController` exists only when `APP_ENV=dev` and is not
 * part of the contract. A controller added to a module and not to this list fails
 * `worker-module`-style at generation time: its routes are discovered by the test that
 * boots the real `AppModule` and compares.
 */
export const CONTROLLERS = [
  HealthController,
  ConfigController,
  WorkspacesController,
  AgentsController,
  TemplatesController,
  PromptingController,
  VoicesController,
  AgentKnowledgeController,
  KnowledgeController,
  PhonePlanController,
  NumbersController,
  ActivationController,
  CallsController,
  StatsController,
  TestCallController,
  AgentWidgetController,
  PublicWidgetController,
  CallbackController,
  OutboundSettingsController,
  DncController,
  WalletController,
  BillingController,
  JobsController,
  EventsController,
  AlertsController,
  // D13 — the customer side of support tickets (D7 Help).
  SupportController,
  DataRequestsController,
  WebhooksController,
  // D12 — the staff console (admin §9) and the view-as routes on the customer side.
  ImpersonationController,
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
  AdminReconciliationsController,
  AdminAuditController,
  // D13 — SA9 billing & finance.
  AdminBillingController,
  AdminCustomerBillingController,
  // D13 — SA13 staff & settings, SA7 provisioning queue and concurrency.
  AdminStaffController,
  AdminOperationsController,
  // D13 — SA4 support tickets and canned responses.
  AdminTicketsController,
  AdminCannedResponsesController,
] as const;
