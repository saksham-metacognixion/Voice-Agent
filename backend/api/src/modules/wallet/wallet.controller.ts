import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  type CheckoutConfirmResponse,
  type CheckoutResponse,
  type CreditLotResponse,
  type LedgerEntryResponse,
  type LedgerQuery,
  type Page,
  type WalletResponse,
  checkoutConfirmRequest,
  checkoutRequest,
  ledgerQuery,
} from '@portal/schemas';
import { z } from 'zod';
import { Ctx, RequireEmailVerified, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { BillingService } from '../billing/billing.service';
import { WalletService } from './wallet.service';

/**
 * D5 Wallet (§16): balance, lots, ledger, and the way in — Stripe Checkout.
 *
 * Every role may look; only an owner or admin may buy (§6.1). Auto top-up, invoices and
 * the Stripe Customer Portal session are the same `/wallet` prefix served from the billing
 * module (`BillingController`), so this file does not import billing's D6 services and the
 * wallet ↔ billing import cycle stays where it was in D3.
 */
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly billing: BillingService,
  ) {}

  @Get()
  summary(@Ctx() ctx: WorkspaceContext): Promise<WalletResponse> {
    return this.wallet.summary(ctx);
  }

  @Get('lots')
  lots(@Ctx() ctx: WorkspaceContext): Promise<CreditLotResponse[]> {
    return this.wallet.lots(ctx);
  }

  @Get('ledger')
  ledger(@Ctx() ctx: WorkspaceContext, @Query() query: LedgerQuery): Promise<Page<LedgerEntryResponse>> {
    return this.wallet.ledger(ctx, ledgerQuery.parse(query));
  }

  /** §13.7 step 1. Returns the hosted Checkout URL; credits arrive via the webhook. */
  @Post('checkout')
  @Roles('owner', 'admin')
  @RequireEmailVerified()
  checkout(@Ctx() ctx: WorkspaceContext, @Body() body: z.infer<typeof checkoutRequest>): Promise<CheckoutResponse> {
    return this.billing.createCheckout(ctx, checkoutRequest.parse(body));
  }

  /**
   * §13.7 back from Stripe: `session_id` in the return URL is verified with Stripe and the
   * pack credited if the webhook has not done it yet. Idempotent; a paid purchase answers
   * `credited: false`.
   */
  @Post('checkout/confirm')
  @Roles('owner', 'admin')
  confirmCheckout(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<CheckoutConfirmResponse> {
    return this.billing.confirmCheckout(ctx, checkoutConfirmRequest.parse(body).session_id);
  }
}
