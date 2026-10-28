import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { adminDb } from '@portal/db';
import {
  type AdminKycResponse,
  adminCallerIdRequest,
  adminKycDecisionRequest,
  type AdminAgentResponse,
  type AdminAuditEntry,
  type AdminCallResponse,
  type AdminCreditAdjustResponse,
  type AdminCustomerAuditEntry,
  type AdminCustomerDetail,
  type AdminCustomerSummary,
  type AdminCustomerWallet,
  type AdminFeatureFlag,
  type AdminFlagsResponse,
  type AdminFunnelResponse,
  type AdminJobResponse,
  type AdminKillSwitch,
  type AdminKpisResponse,
  type AdminMemberResponse,
  type AdminNumberResponse,
  type AdminNumberResyncResponse,
  type AdminPricingDraftResponse,
  type AdminPricingPreviewResponse,
  type AdminPricingVersion,
  type AdminPricingVersionDetail,
  type AdminPurchaseResponse,
  type AdminReconciliationRun,
  type AdminRetellCostsResponse,
  type AdminSearchResponse,
  type AdminSystemHealthResponse,
  type AdminTestAlertResponse,
  type AdminTenantStatusResponse,
  type AdminUserActionResponse,
  type AdminUserResponse,
  type AdminWebhookEventDetail,
  type AdminWebhookEventResponse,
  type AdminWebhookReplayResponse,
  type DeletedResponse,
  type EndedResponse,
  type ImpersonationResponse,
  type Page,
  type RemovedResponse,
  type StaffMeResponse,
  adminAgentsQuery,
  adminAuditFilters,
  adminAuditQuery,
  adminCallFlagRequest,
  adminCallRefundRequest,
  adminCallsQuery,
  adminCreditAdjustRequest,
  adminCustomerAuditQuery,
  adminCustomerUpdateRequest,
  adminCustomersQuery,
  adminImpersonateRequest,
  adminJobsQuery,
  adminKpisQuery,
  adminMemberUpdateRequest,
  adminNumbersQuery,
  adminOverridesRequest,
  adminPricingDraftRequest,
  adminPricingPublishRequest,
  adminPricingRollbackRequest,
  adminReconciliationRunRequest,
  adminReconciliationsQuery,
  adminSearchQuery,
  adminSetKillSwitchRequest,
  adminUpsertFlagRequest,
  adminUsersQuery,
  adminWebhookEventsQuery,
  paginationQuery,
  retellCostInputs,
  staffActionRequest,
  STAFF_ROUTE_ROLES,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { OpsAlertService } from '../alerts';
import { StaffCtx, StaffRoles } from '../auth';
import type { StaffContext } from '../auth';
import { AdminAgentsService } from './admin-agents.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminCallsService } from './admin-calls.service';
import { AdminCustomersService } from './admin-customers.service';
import { AdminFlagsService } from './admin-flags.service';
import { AdminJobsService } from './admin-jobs.service';
import { AdminKpisService } from './admin-kpis.service';
import { AdminNumbersService } from './admin-numbers.service';
import { AdminOutboundService } from './admin-outbound.service';
import { AdminPricingService } from './admin-pricing.service';
import { AdminReconciliationService } from './admin-reconciliation.service';
import { AdminSearchService } from './admin-search.service';
import { AdminSystemService } from './admin-system.service';
import { AdminUsersService } from './admin-users.service';
import { AdminWebhooksService } from './admin-webhooks.service';
import { iso, uuidParam } from './admin.helpers';
import { ImpersonationService } from './impersonation.service';
import { StaffLimitsService } from './staff-limits.service';

/*
 * The staff console's routes (admin §9, D12). Everything under `/admin` is verified
 * against the staff tenant by AuthGuard (MFA claim required), and `@StaffRoles` is the
 * admin §2.2 matrix per route. The finer limits — how many credits, whether this role may
 * pause or publish — are `StaffLimitsService` inside the services, so a role that passes
 * the route can still be refused with `403 STAFF_LIMIT_EXCEEDED` naming who could.
 *
 * Every controller here is small on purpose: parse, delegate, return. The services own
 * the reads, the writes, and the audit rows.
 */

// One matrix for the routes and the console's buttons (`STAFF_ROUTE_ROLES`, QA-048).
const MUTATE = STAFF_ROUTE_ROLES.mutate;
const MONEY = STAFF_ROUTE_ROLES.money;
const SYSTEM = STAFF_ROUTE_ROLES.system;
const COMMERCIAL = STAFF_ROUTE_ROLES.commercial;
const PRICING_EDIT = STAFF_ROUTE_ROLES.pricingEdit;
const COMPLIANCE = STAFF_ROUTE_ROLES.compliance;
const PRICING_PUBLISH = STAFF_ROUTE_ROLES.pricingPublish;
const VIEW_AS = STAFF_ROUTE_ROLES.viewAs;
/**
 * A stored webhook body (QA-033): every staff role that works customer cases, not
 * read-only. What is in it is narrowed again by `can_listen_recordings` in the service.
 */
const PAYLOAD_VIEW = STAFF_ROUTE_ROLES.payloadView;

@Controller('admin')
export class AdminMeController {
  constructor(
    private readonly limits: StaffLimitsService,
    private readonly impersonation: ImpersonationService,
  ) {}

  @Get('me')
  async me(@StaffCtx() staff: StaffContext): Promise<StaffMeResponse> {
    const [row, limits, impersonations] = await Promise.all([
      adminDb.staffUser.findUniqueOrThrow({ where: { id: staff.staffId }, select: { name: true } }),
      this.limits.limitsFor(staff.role),
      this.impersonation.openFor(staff.staffId),
    ]);
    // A cheap "last seen" the SA13 staff list reads; never awaited for the answer.
    void adminDb.staffUser
      .update({ where: { id: staff.staffId }, data: { lastLoginAt: new Date() } })
      .catch(() => undefined);
    return {
      id: staff.staffId,
      email: staff.email,
      name: row.name,
      role: staff.role,
      limits,
      impersonations,
    };
  }
}

@Controller('admin/kpis')
export class AdminKpisController {
  constructor(private readonly kpis: AdminKpisService) {}

  @Get()
  overview(@Query() query: Record<string, unknown>): Promise<AdminKpisResponse> {
    return this.kpis.kpis(adminKpisQuery.parse(query).range);
  }

  @Get('funnel')
  funnel(@Query() query: Record<string, unknown>): Promise<AdminFunnelResponse> {
    return this.kpis.funnel(adminKpisQuery.parse(query).range);
  }
}

@Controller('admin/customers')
export class AdminCustomersController {
  constructor(
    private readonly customers: AdminCustomersService,
    private readonly agents: AdminAgentsService,
    private readonly numbers: AdminNumbersService,
    private readonly calls: AdminCallsService,
    private readonly jobs: AdminJobsService,
    private readonly webhooks: AdminWebhooksService,
    private readonly impersonation: ImpersonationService,
    private readonly outbound: AdminOutboundService,
  ) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<Page<AdminCustomerSummary>> {
    return this.customers.list(adminCustomersQuery.parse(query));
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<AdminCustomerDetail> {
    return this.customers.detail(id);
  }

  @Get(':id/members')
  members(@Param('id') id: string): Promise<AdminMemberResponse[]> {
    return this.customers.members(id);
  }

  @Get(':id/wallet')
  wallet(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<AdminCustomerWallet> {
    return this.customers.walletTab(id, paginationQuery.parse(query));
  }

  @Get(':id/purchases')
  purchases(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<Page<AdminPurchaseResponse>> {
    return this.customers.purchases(id, paginationQuery.parse(query));
  }

  @Get(':id/agents')
  agentsOf(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<Page<AdminAgentResponse>> {
    return this.agents.list(
      adminAgentsQuery.parse({ ...query, tenant_id: uuidParam(id, 'Customer') }),
    );
  }

  @Get(':id/numbers')
  numbersOf(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<Page<AdminNumberResponse>> {
    return this.numbers.list(
      adminNumbersQuery.parse({ ...query, tenant_id: uuidParam(id, 'Customer') }),
    );
  }

  @Get(':id/calls')
  callsOf(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<Page<AdminCallResponse>> {
    return this.calls.list(
      adminCallsQuery.parse({ ...query, tenant_id: uuidParam(id, 'Customer') }),
    );
  }

  @Get(':id/jobs')
  jobsOf(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<Page<AdminJobResponse>> {
    return this.jobs.list(adminJobsQuery.parse({ ...query, tenant_id: uuidParam(id, 'Customer') }));
  }

  @Get(':id/webhook-events')
  webhooksOf(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<Page<AdminWebhookEventResponse>> {
    return this.webhooks.list(
      adminWebhookEventsQuery.parse({ ...query, tenant_id: uuidParam(id, 'Customer') }),
    );
  }

  @Get(':id/audit')
  audit(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<Page<AdminCustomerAuditEntry>> {
    return this.customers.customerAudit(id, adminCustomerAuditQuery.parse(query));
  }

  /** SA2 "Edit profile" (admin §9): name, country, timezone, website, with a reason. */
  @Patch(':id')
  @StaffRoles(...MUTATE)
  update(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminCustomerDetail> {
    return this.customers.updateProfile(staff, id, adminCustomerUpdateRequest.parse(body), request);
  }

  /** SA2 per-customer caps (admin §9 `PUT /admin/customers/:id/overrides`): a custom deal. */
  @Put(':id/overrides')
  @StaffRoles(...COMMERCIAL)
  overrides(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminCustomerDetail> {
    return this.customers.setOverrides(staff, id, adminOverridesRequest.parse(body), request);
  }

  /** A member's role (admin §9 `PATCH /admin/customers/:id/members/:mid`); never the owner's. */
  @Patch(':id/members/:mid')
  @StaffRoles(...MUTATE)
  updateMember(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Param('mid') mid: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminMemberResponse> {
    return this.customers.updateMember(staff, id, mid, adminMemberUpdateRequest.parse(body), request);
  }

  /** Removes a member; never the owner. A body on a DELETE, as for flags: it carries the reason. */
  @Delete(':id/members/:mid')
  @StaffRoles(...MUTATE)
  removeMember(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Param('mid') mid: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<RemovedResponse> {
    return this.customers.removeMember(staff, id, mid, staffActionRequest.parse(body ?? {}), request);
  }

  /** D18: the business verification the customer submitted for outbound calling. */
  @Get(':id/kyc')
  kyc(@Param('id') id: string): Promise<AdminKycResponse> {
    return this.outbound.kyc(id);
  }

  /** D18: approve or reject (or withdraw) it — a compliance decision, audited. */
  @Post(':id/kyc')
  @HttpCode(200)
  @StaffRoles(...COMPLIANCE)
  decideKyc(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminKycResponse> {
    return this.outbound.decideKyc(staff, id, adminKycDecisionRequest.parse(body), request);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  pause(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminTenantStatusResponse> {
    return this.customers.pause(staff, id, staffActionRequest.parse(body), request);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  resume(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminTenantStatusResponse> {
    return this.customers.resume(staff, id, staffActionRequest.parse(body), request);
  }

  @Post(':id/credits/adjust')
  @StaffRoles(...MONEY)
  adjust(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminCreditAdjustResponse> {
    return this.customers.adjustCredits(staff, id, adminCreditAdjustRequest.parse(body), request);
  }

  @Post(':id/impersonate')
  @StaffRoles(...VIEW_AS)
  impersonate(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<ImpersonationResponse> {
    return this.impersonation.start(staff, id, adminImpersonateRequest.parse(body ?? {}), request);
  }
}

@Controller('admin/impersonations')
export class AdminImpersonationsController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @Get()
  list(): Promise<ImpersonationResponse[]> {
    return this.impersonation.listOpen();
  }

  @Post(':id/open')
  @StaffRoles(...VIEW_AS)
  open(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<ImpersonationResponse> {
    return this.impersonation.reopen(staff, id, request);
  }

  @Delete(':id')
  @StaffRoles(...VIEW_AS)
  end(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<EndedResponse> {
    return this.impersonation.endFromAdmin(staff, id, request);
  }
}

@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<Page<AdminUserResponse>> {
    return this.users.list(adminUsersQuery.parse(query));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AdminUserResponse> {
    return this.users.get(id);
  }

  @Post(':id/verify-email')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  verifyEmail(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    return this.users.verifyEmail(staff, id, staffActionRequest.parse(body), request);
  }

  @Post(':id/reset-mfa')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  resetMfa(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    return this.users.resetMfa(staff, id, staffActionRequest.parse(body), request);
  }

  @Post(':id/lock')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  lock(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    return this.users.lock(staff, id, staffActionRequest.parse(body), request);
  }

  @Post(':id/unlock')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  unlock(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    return this.users.unlock(staff, id, staffActionRequest.parse(body), request);
  }

  @Post(':id/force-logout')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  forceLogout(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminUserActionResponse> {
    return this.users.forceLogout(staff, id, staffActionRequest.parse(body), request);
  }
}

@Controller('admin/agents')
export class AdminAgentsController {
  constructor(private readonly agents: AdminAgentsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<Page<AdminAgentResponse>> {
    return this.agents.list(adminAgentsQuery.parse(query));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AdminAgentResponse> {
    return this.agents.get(id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  pause(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminAgentResponse> {
    return this.agents.pause(staff, id, staffActionRequest.parse(body), request);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  resume(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminAgentResponse> {
    return this.agents.resume(staff, id, staffActionRequest.parse(body), request);
  }
}

@Controller('admin/numbers')
export class AdminNumbersController {
  constructor(
    private readonly numbers: AdminNumbersService,
    private readonly outbound: AdminOutboundService,
  ) {}

  /** D18: verify a SIP import as an outbound caller ID, or revoke any number's. */
  @Post(':id/caller-id')
  @HttpCode(200)
  @StaffRoles(...COMPLIANCE)
  async callerId(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminNumberResponse> {
    await this.outbound.setCallerId(staff, id, adminCallerIdRequest.parse(body), request);
    return this.numbers.get(id);
  }

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<Page<AdminNumberResponse>> {
    return this.numbers.list(adminNumbersQuery.parse(query));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AdminNumberResponse> {
    return this.numbers.get(id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  pause(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminNumberResponse> {
    return this.numbers.pause(staff, id, staffActionRequest.parse(body), request);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  resume(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminNumberResponse> {
    return this.numbers.resume(staff, id, staffActionRequest.parse(body), request);
  }

  /** Admin §9: release for the customer (platform first, row kept as `released`). */
  @Post(':id/release')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  release(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminNumberResponse> {
    return this.numbers.release(staff, id, staffActionRequest.parse(body), request);
  }

  /** Admin §9: re-point a drifted platform binding at the agent and our inbound webhook. */
  @Post(':id/resync')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  resync(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminNumberResyncResponse> {
    return this.numbers.resync(staff, id, staffActionRequest.parse(body), request);
  }

  /** Admin §9: start a failed number's provisioning again (look before you buy). */
  @Post(':id/reprovision')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  reprovision(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminNumberResponse> {
    return this.numbers.reprovision(staff, id, staffActionRequest.parse(body), request);
  }
}

@Controller('admin/calls')
export class AdminCallsController {
  constructor(private readonly calls: AdminCallsService) {}

  /** Admin §9: give back what the call cost, once per call (the SA4 macro's path and key). */
  @Post(':id/refund')
  @StaffRoles(...MONEY)
  async refund(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminCreditAdjustResponse> {
    return (await this.calls.refundCall(staff, id, adminCallRefundRequest.parse(body), request)).adjustment;
  }

  /** Admin §9: flag the call for a second look (with a note), or clear the flag. */
  @Post(':id/flag')
  @HttpCode(200)
  @StaffRoles(...MUTATE)
  flag(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminCallResponse> {
    return this.calls.flag(staff, id, adminCallFlagRequest.parse(body), request);
  }

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<Page<AdminCallResponse>> {
    return this.calls.list(adminCallsQuery.parse(query));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AdminCallResponse> {
    return this.calls.get(id);
  }
}

@Controller('admin/jobs')
export class AdminJobsController {
  constructor(private readonly jobs: AdminJobsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<Page<AdminJobResponse>> {
    return this.jobs.list(adminJobsQuery.parse(query));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AdminJobResponse> {
    return this.jobs.get(id);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @StaffRoles(...SYSTEM)
  retry(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminJobResponse> {
    return this.jobs.retry(staff, id, staffActionRequest.parse(body), request);
  }

  @Post(':id/discard')
  @HttpCode(200)
  @StaffRoles(...SYSTEM)
  discard(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminJobResponse> {
    return this.jobs.discard(staff, id, staffActionRequest.parse(body), request);
  }
}

@Controller('admin/webhook-events')
export class AdminWebhooksController {
  constructor(private readonly webhooks: AdminWebhooksService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<Page<AdminWebhookEventResponse>> {
    return this.webhooks.list(adminWebhookEventsQuery.parse(query));
  }

  @Get(':id')
  @StaffRoles(...PAYLOAD_VIEW)
  get(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<AdminWebhookEventDetail> {
    return this.webhooks.get(staff, id, request);
  }

  @Post(':id/replay')
  @HttpCode(200)
  @StaffRoles(...SYSTEM)
  replay(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminWebhookReplayResponse> {
    return this.webhooks.replay(staff, id, staffActionRequest.parse(body), request);
  }
}

@Controller('admin')
export class AdminFlagsController {
  constructor(private readonly flags: AdminFlagsService) {}

  @Get('flags')
  list(): Promise<AdminFlagsResponse> {
    return this.flags.list();
  }

  @Put('flags/:key')
  @StaffRoles(...SYSTEM)
  upsert(
    @StaffCtx() staff: StaffContext,
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminFeatureFlag> {
    return this.flags.upsertFlag(staff, key, adminUpsertFlagRequest.parse(body), request);
  }

  @Delete('flags/:key')
  @StaffRoles(...SYSTEM)
  remove(
    @StaffCtx() staff: StaffContext,
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<DeletedResponse> {
    return this.flags.deleteFlag(staff, key, staffActionRequest.parse(body), request);
  }

  @Put('kill-switches/:key')
  @StaffRoles(...SYSTEM)
  killSwitch(
    @StaffCtx() staff: StaffContext,
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminKillSwitch> {
    return this.flags.setKillSwitch(staff, key, adminSetKillSwitchRequest.parse(body), request);
  }
}

@Controller('admin')
export class AdminPricingController {
  constructor(private readonly pricing: AdminPricingService) {}

  @Get('pricing/draft')
  draft(): Promise<AdminPricingDraftResponse> {
    return this.pricing.draft();
  }

  @Put('pricing/draft')
  @StaffRoles(...PRICING_EDIT)
  saveDraft(
    @StaffCtx() staff: StaffContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminPricingDraftResponse> {
    return this.pricing.saveDraft(staff, adminPricingDraftRequest.parse(body), request);
  }

  @Delete('pricing/draft')
  @StaffRoles(...PRICING_EDIT)
  discardDraft(
    @StaffCtx() staff: StaffContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<DeletedResponse> {
    // A body on a DELETE, as for flags: throwing away a draft someone built is audited with a reason (QA-039).
    return this.pricing.discardDraft(staff, staffActionRequest.parse(body ?? {}), request);
  }

  @Get('pricing/preview')
  preview(): Promise<AdminPricingPreviewResponse> {
    return this.pricing.preview();
  }

  @Post('pricing/publish')
  @StaffRoles(...PRICING_PUBLISH)
  publish(
    @StaffCtx() staff: StaffContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminPricingVersion> {
    return this.pricing.publish(staff, adminPricingPublishRequest.parse(body ?? {}), request);
  }

  @Get('pricing/versions')
  versions(): Promise<AdminPricingVersion[]> {
    return this.pricing.versions();
  }

  @Get('pricing/versions/:version')
  version(@Param('version') version: string): Promise<AdminPricingVersionDetail> {
    return this.pricing.version(versionParam(version));
  }

  @Post('pricing/rollback/:version')
  @StaffRoles(...PRICING_PUBLISH)
  rollback(
    @StaffCtx() staff: StaffContext,
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminPricingVersion> {
    return this.pricing.rollback(
      staff,
      versionParam(version),
      adminPricingRollbackRequest.parse(body ?? {}),
      request,
    );
  }

  @Get('retell-costs')
  costs(): Promise<AdminRetellCostsResponse> {
    return this.pricing.costs();
  }

  @Put('retell-costs')
  @StaffRoles(...PRICING_EDIT)
  saveCosts(
    @StaffCtx() staff: StaffContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminRetellCostsResponse> {
    return this.pricing.saveCosts(staff, retellCostInputs.parse(body), request);
  }
}

@Controller('admin')
export class AdminSearchController {
  constructor(private readonly search: AdminSearchService) {}

  @Get('search')
  find(@Query() query: Record<string, unknown>): Promise<AdminSearchResponse> {
    const q = adminSearchQuery.parse(query);
    return this.search.search(q.q, q.limit);
  }
}

@Controller('admin/system')
export class AdminSystemController {
  constructor(
    private readonly system: AdminSystemService,
    private readonly opsAlerts: OpsAlertService,
  ) {}

  @Get('health')
  health(): Promise<AdminSystemHealthResponse> {
    return this.system.health();
  }

  /**
   * D14 "trigger a controlled test error and confirm it reaches Sentry". Thrown, not
   * captured here, so it travels the path a real bug does: the exception filter logs it,
   * answers 500 INTERNAL and reports it. Touches no customer data.
   */
  @Post('test-error')
  @StaffRoles('super_admin', 'ops')
  testError(@StaffCtx() staff: StaffContext): never {
    throw new Error(`Admin diagnostics: controlled test error requested by ${staff.email}`);
  }

  /** D14: one test ops alert through every sink; Slack is the webhook sink. */
  @Post('test-alert')
  @StaffRoles('super_admin', 'ops')
  async testAlert(@StaffCtx() staff: StaffContext): Promise<AdminTestAlertResponse> {
    const delivered = await this.opsAlerts.send({
      kind: 'diagnostics_test',
      severity: 'warning',
      title: 'Test alert from the admin console — no action needed',
      fields: { requested_by: staff.email, env: process.env.APP_ENV ?? null },
    });
    return { delivered };
  }
}

/** SA12 "Reconciliation" (admin §9 `GET /admin/reconciliations`, `POST …/run`). */
@Controller('admin/reconciliations')
export class AdminReconciliationsController {
  constructor(private readonly reconciliation: AdminReconciliationService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<Page<AdminReconciliationRun>> {
    return this.reconciliation.list(adminReconciliationsQuery.parse(query));
  }

  @Post('run')
  @HttpCode(200)
  @StaffRoles(...SYSTEM)
  run(@StaffCtx() staff: StaffContext, @Body() body: unknown, @Req() request: FastifyRequest): Promise<AdminReconciliationRun> {
    return this.reconciliation.run(staff, adminReconciliationRunRequest.parse(body ?? {}), request);
  }
}

@Controller('admin/audit')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  list(@Query() raw: Record<string, unknown>): Promise<Page<AdminAuditEntry>> {
    return this.audit.list(adminAuditQuery.parse(raw));
  }

  /**
   * SA14 "Export" (admin §9 `GET /admin/audit/export`): the rows the filters select, as
   * CSV, streamed as read. Same roles as the list. `@Res()` hands the reply to Fastify.
   */
  @Get('export')
  async export(
    @StaffCtx() staff: StaffContext,
    @Query() raw: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const filters = adminAuditFilters.parse(raw);
    await this.audit.recordExport(staff, filters, request);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    void reply
      .code(200)
      .headers({
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="staff-audit-${stamp}.csv"`,
        'cache-control': 'private, no-store',
      })
      .send(Readable.from(this.audit.exportCsv(filters)));
  }
}

function versionParam(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw AppError.notFound('Pricing version');
  return n;
}

export { iso };
