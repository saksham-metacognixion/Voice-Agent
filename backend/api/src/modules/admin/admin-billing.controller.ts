import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  type AdminAutoTopupStatusResponse,
  type AdminBillingPurchase,
  type AdminBillingSummaryResponse,
  type AdminBreakageReport,
  type AdminCogsReport,
  type AdminDeferredReport,
  type AdminFailedTopup,
  type AdminPurchaseDetail,
  type AdminTopupRetryResponse,
  type Page,
  adminFailedTopupsQuery,
  adminKpisQuery,
  adminPurchasesQuery,
  adminRefundRequest,
  staffActionRequest,
  STAFF_ROUTE_ROLES,
} from '@portal/schemas';
import { StaffCtx, StaffRoles } from '../auth';
import type { StaffContext } from '../auth';
import { AdminBillingService } from './admin-billing.service';
import { AdminReportsService } from './admin-reports.service';

/*
 * SA9 Billing & finance (admin §4 SA9, D13). Parse, delegate, return — the service owns
 * the reads, the Stripe calls, the wallet writes and the audit rows. Reads are open to
 * every staff role; the three money actions are the admin §2.2 MONEY matrix at the route
 * and `StaffLimitsService.assertRefund` (`refund_max_cents`) inside the refund.
 */

const MONEY = STAFF_ROUTE_ROLES.money;

@Controller('admin')
export class AdminBillingController {
  constructor(
    private readonly billing: AdminBillingService,
    private readonly reports: AdminReportsService,
  ) {}

  @Get('purchases')
  purchases(@Query() query: Record<string, unknown>): Promise<Page<AdminBillingPurchase>> {
    return this.billing.listPurchases(adminPurchasesQuery.parse(query));
  }

  @Get('purchases/:id')
  purchase(@Param('id') id: string): Promise<AdminPurchaseDetail> {
    return this.billing.purchaseDetail(id);
  }

  @Post('purchases/:id/refund')
  @StaffRoles(...MONEY)
  refund(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminPurchaseDetail> {
    return this.billing.refund(staff, id, adminRefundRequest.parse(body), request);
  }

  @Get('topups/failed')
  failedTopups(@Query() query: Record<string, unknown>): Promise<Page<AdminFailedTopup>> {
    return this.billing.failedTopups(adminFailedTopupsQuery.parse(query));
  }

  @Post('topups/:id/retry')
  @StaffRoles(...MONEY)
  retryTopup(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminTopupRetryResponse> {
    return this.billing.retryTopup(staff, id, staffActionRequest.parse(body), request);
  }

  @Get('billing/summary')
  summary(@Query() query: Record<string, unknown>): Promise<AdminBillingSummaryResponse> {
    return this.billing.summary(adminKpisQuery.parse(query).range);
  }

  /** Admin §9 `GET /admin/reports/revenue`: the SA9 summary under the spec's name. */
  @Get('reports/revenue')
  revenue(@Query() query: Record<string, unknown>): Promise<AdminBillingSummaryResponse> {
    return this.billing.summary(adminKpisQuery.parse(query).range);
  }

  @Get('reports/cogs')
  cogs(@Query() query: Record<string, unknown>): Promise<AdminCogsReport> {
    return this.reports.cogs(adminKpisQuery.parse(query).range);
  }

  @Get('reports/deferred')
  deferred(): Promise<AdminDeferredReport> {
    return this.reports.deferred();
  }

  @Get('reports/breakage')
  breakage(@Query() query: Record<string, unknown>): Promise<AdminBreakageReport> {
    return this.reports.breakage(adminKpisQuery.parse(query).range);
  }
}

/** The one SA9 action that lives on the customer resource (admin §4 SA2 "auto top-up"). */
@Controller('admin/customers')
export class AdminCustomerBillingController {
  constructor(private readonly billing: AdminBillingService) {}

  @Post(':id/auto-topup/disable')
  @StaffRoles(...MONEY)
  disableAutoTopup(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminAutoTopupStatusResponse> {
    return this.billing.disableAutoTopup(staff, id, staffActionRequest.parse(body), request);
  }
}
