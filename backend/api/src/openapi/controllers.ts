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
  AdminSearchController,
  AdminSystemController,
  AdminUsersController,
  AdminWebhooksController,
} from '../modules/admin/admin.controllers';
import { ImpersonationController } from '../modules/admin/impersonation.controller';
import { AgentsController, TemplatesController } from '../modules/agents/agents.controller';
import { BillingController } from '../modules/billing/billing.controller';
import { CallsController, StatsController } from '../modules/calls/calls.controller';
import { TestCallController } from '../modules/calls/test-call.controller';
import { ConfigController } from '../modules/config/config.controller';
import { EventsController } from '../modules/events/events.controller';
import { JobsController } from '../modules/jobs/jobs.controller';
import { AgentKnowledgeController, KnowledgeController } from '../modules/knowledge/knowledge.controller';
import { AlertsController } from '../modules/notifications/alerts.controller';
import { NumbersController, PhonePlanController } from '../modules/numbers/numbers.controller';
import { PromptingController } from '../modules/prompting/prompting.controller';
import { VoicesController } from '../modules/voices/voices.controller';
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
  WalletController,
  BillingController,
  JobsController,
  EventsController,
  AlertsController,
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
  AdminAuditController,
] as const;
