import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import {
  type AutoTopup,
  type InvoiceResponse,
  type Page,
  type PortalSessionResponse,
  autoTopupRequest,
  invoicesQuery,
  portalSessionRequest,
} from '@portal/schemas';
import { Ctx, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { AutoTopupService } from './auto-topup.service';
import { BillingService } from './billing.service';
import { InvoicesService } from './invoices.service';

/**
 * D5 Wallet, the billing half (§16): `PUT /wallet/auto-topup · GET /wallet/invoices ·
 * POST /wallet/portal-session`. Same prefix as `WalletController`, served from here so the
 * wallet module does not import billing's services (the two modules already reference each
 * other through a forwardRef, and a third file-level edge made `tsx` evaluate
 * `BillingService` before `StripeGateway` existed).
 *
 * Owner/admin for anything that authorises a charge or opens the card page; every role may
 * read invoices.
 */
@Controller('wallet')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly topups: AutoTopupService,
    private readonly invoices: InvoicesService,
  ) {}

  /** §5.4 D5 "Auto top-up". */
  @Put('auto-topup')
  @Roles('owner', 'admin')
  autoTopup(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<AutoTopup> {
    return this.topups.update(ctx, autoTopupRequest.parse(body));
  }

  /** D5 "Invoices": the Stripe invoices this workspace's customer received. */
  @Get('invoices')
  listInvoices(@Ctx() ctx: WorkspaceContext, @Query() query: Record<string, unknown>): Promise<Page<InvoiceResponse>> {
    return this.invoices.list(ctx, invoicesQuery.parse(query));
  }

  /** D5 "Payment methods": a Stripe Customer Portal session for this workspace's customer only. */
  @Post('portal-session')
  @Roles('owner', 'admin')
  portalSession(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<PortalSessionResponse> {
    return this.billing.createPortalSession(ctx, portalSessionRequest.parse(body ?? {}).return_path);
  }
}
