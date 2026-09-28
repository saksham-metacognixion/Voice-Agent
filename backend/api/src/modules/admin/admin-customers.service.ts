import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminCreditAdjustRequest,
  AdminCreditAdjustResponse,
  AdminCustomerAuditEntry,
  AdminCustomerAuditQuery,
  AdminCustomerDetail,
  AdminCustomerSummary,
  AdminCustomersQuery,
  AdminCustomerWallet,
  AdminMemberResponse,
  AdminPurchaseResponse,
  AdminTenantStatusResponse,
  Page,
  PaginationQuery,
  StaffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, decodeCursor, encodeCursor, toPage } from '../../common/pagination';
import type { StaffContext } from '../auth';
import { PlatformConfigService } from '../config';
import { RuntimeCacheService } from '../runtime-cache';
import { WalletService, addMonths } from '../wallet';
import { DAY_MS, customerStatusOf, iso, num, numOrNull, record, uuidParam, idMatch } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';

/** The list computes status and balance in memory, so it reads at most this many rows. */
const LIST_SCAN_MAX = 500;

interface TenantFacts {
  balance: number;
  balanceSince: Date | null;
  lastPackCredits: number | null;
  usage30d: number;
  agentsLive: number;
  agentsTotal: number;
  numbersActive: number;
  ownerEmail: string | null;
  lastActivityAt: Date | null;
  flags: string[];
}

/**
 * SA2 (D12): the customers list and the 360. Reads cross every workspace on purpose and
 * run on `adminDb` (ADR 0006). Writes — pause, resume, adjust credits — go through the
 * same services the customer path uses (the wallet for the ledger, the runtime cache for
 * the hot path) and are audited twice: `staff_audit_log` with the reason code, and the
 * customer's own `audit_log` so D6's Audit tab shows "paused by support" as well.
 */
@Injectable()
export class AdminCustomersService {
  private readonly log = new Logger(AdminCustomersService.name);

  constructor(
    private readonly wallet: WalletService,
    private readonly runtimeCache: RuntimeCacheService,
    private readonly config: PlatformConfigService,
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
  ) {}

  // ------------------------------------------------------------------ list + detail

  async list(query: AdminCustomersQuery): Promise<Page<AdminCustomerSummary>> {
    const where: Prisma.TenantWhereInput = {};
    if (query.plan) where.planTier = query.plan;
    if (query.country) where.country = query.country.toUpperCase();
    if (query.q) {
      const q = query.q;
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        ...idMatch(q),
        { stripeCustomerId: q },
        { memberships: { some: { user: { email: { contains: q, mode: 'insensitive' } } } } },
      ];
    }
    const tenants = await adminDb.tenant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: LIST_SCAN_MAX,
    });
    const facts = await this.facts(tenants.map((t) => t.id));
    let rows = tenants.map((t) => this.summary(t, facts.get(t.id)!));
    if (query.status) rows = rows.filter((r) => r.status === query.status);
    const dir = query.order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      switch (query.sort) {
        case 'name':
          return a.name.localeCompare(b.name) * dir;
        case 'balance':
          return (a.balance - b.balance) * dir;
        case 'last_activity':
          return (
            ((a.last_activity_at ?? '').localeCompare(b.last_activity_at ?? '') ||
              a.created_at.localeCompare(b.created_at)) * dir
          );
        default:
          return a.created_at.localeCompare(b.created_at) * dir;
      }
    });
    // An offset cursor: the page is computed in memory, so a keyset would buy nothing.
    const offset = query.cursor ? Number(decodeCursor(query.cursor).id) || 0 : 0;
    const items = rows.slice(offset, offset + query.limit);
    return {
      items,
      next_cursor:
        offset + query.limit < rows.length
          ? encodeCursor({ id: String(offset + query.limit) })
          : null,
      total: rows.length,
    };
  }

  async detail(idRaw: string): Promise<AdminCustomerDetail> {
    const id = uuidParam(idRaw, 'Customer');
    const tenant = await adminDb.tenant.findUnique({ where: { id }, include: { overrides: true } });
    if (!tenant) throw AppError.notFound('Customer');
    const facts = (await this.facts([id])).get(id)!;
    const d30 = new Date(Date.now() - 30 * DAY_MS);
    const [members, calls30d, purchases, sales, openAlerts, impersonations] = await Promise.all([
      adminDb.membership.count({ where: { tenantId: id } }),
      adminDb.call.count({ where: { tenantId: id, createdAt: { gte: d30 } } }),
      adminDb.purchase.count({ where: { tenantId: id, status: 'paid' } }),
      adminDb.purchase.aggregate({
        where: { tenantId: id, status: 'paid' },
        _sum: { amountCents: true },
      }),
      adminDb.alert.count({ where: { tenantId: id, resolvedAt: null } }),
      adminDb.impersonationSession.count({
        where: { tenantId: id, endedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    const autoTopup = record(tenant.autoTopupJson);
    return {
      ...this.summary(tenant, facts),
      timezone: tenant.timezone,
      website: tenant.website,
      concurrency_cap: tenant.concurrencyCap,
      kb_allowance: tenant.kbAllowance,
      stripe_customer_id: tenant.stripeCustomerId,
      paused_at: iso(tenant.pausedAt),
      auto_topup_enabled: autoTopup.enabled === true,
      members,
      calls_30d: calls30d,
      purchases_paid: purchases,
      lifetime_sales_cents: sales._sum.amountCents ?? 0,
      overrides: tenant.overrides
        ? {
            concurrency_cap: tenant.overrides.concurrencyCap,
            kb_allowance: tenant.overrides.kbAllowance,
            max_agents: tenant.overrides.maxAgents,
            max_numbers: tenant.overrides.maxNumbers,
            reason: tenant.overrides.reason,
            updated_at: iso(tenant.overrides.updatedAt),
          }
        : null,
      open_alerts: openAlerts,
      impersonations_open: impersonations,
    };
  }

  private summary(
    t: {
      id: string;
      name: string;
      country: string;
      planTier: AdminCustomerSummary['plan_tier'];
      pausedAt: Date | null;
      pausedReason: string | null;
      onboardingStep: number;
      onboardingCompletedAt: Date | null;
      customDealId: string | null;
      createdAt: Date;
    },
    f: TenantFacts,
  ): AdminCustomerSummary {
    return {
      id: t.id,
      name: t.name,
      country: t.country,
      plan_tier: t.planTier,
      status: customerStatusOf({
        pausedAt: t.pausedAt,
        onboardingCompletedAt: t.onboardingCompletedAt,
        balance: f.balance,
        balanceSince: f.balanceSince,
        lastActivityAt: f.lastActivityAt,
      }),
      paused_reason: t.pausedReason,
      onboarding_step: t.onboardingStep,
      onboarding_completed_at: iso(t.onboardingCompletedAt),
      balance: f.balance,
      last_pack_credits: f.lastPackCredits,
      usage_30d: f.usage30d,
      agents_live: f.agentsLive,
      agents_total: f.agentsTotal,
      numbers_active: f.numbersActive,
      owner_email: f.ownerEmail,
      last_activity_at: iso(f.lastActivityAt),
      flags: f.flags,
      custom_deal: t.customDealId !== null,
      created_at: t.createdAt.toISOString(),
    };
  }

  /** Everything the list needs beyond the tenant row, in a handful of grouped queries rather than one per tenant. */
  private async facts(ids: string[]): Promise<Map<string, TenantFacts>> {
    const out = new Map<string, TenantFacts>();
    for (const id of ids)
      out.set(id, {
        balance: 0,
        balanceSince: null,
        lastPackCredits: null,
        usage30d: 0,
        agentsLive: 0,
        agentsTotal: 0,
        numbersActive: 0,
        ownerEmail: null,
        lastActivityAt: null,
        flags: [],
      });
    if (!ids.length) return out;
    const d30 = new Date(Date.now() - 30 * DAY_MS);
    const [balances, ledgerLast, usage, agents, numbers, owners, lastCalls, lastPacks, flags] =
      await Promise.all([
        // The wallet's own reader (`bal:{ws}`, rebuilt from the ledger on a miss): the newest
        // ledger row is not a balance — an expiry sweep and the debit it precedes share one
        // transaction-stable `created_at`, and DISTINCT ON picked either (review, 28 Sep).
        Promise.all(
          ids.map(async (tenantId) => ({
            tenant_id: tenantId,
            balance: await this.wallet.balance(tenantId),
          })),
        ),
        adminDb.$queryRaw<Array<{ tenant_id: string; created_at: Date }>>(
          Prisma.sql`SELECT tenant_id, max(created_at) AS created_at FROM credit_ledger WHERE tenant_id = ANY(${ids}::uuid[]) GROUP BY tenant_id`,
        ),
        adminDb.creditLedger.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids }, reason: 'call', createdAt: { gte: d30 } },
          _sum: { delta: true },
        }),
        adminDb.agent.groupBy({
          by: ['tenantId', 'status'],
          where: { tenantId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
        adminDb.phoneNumber.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids }, status: 'active' },
          _count: { _all: true },
        }),
        adminDb.membership.findMany({
          where: { tenantId: { in: ids }, role: 'owner' },
          select: { tenantId: true, user: { select: { email: true } } },
        }),
        adminDb.$queryRaw<Array<{ tenant_id: string; at: Date }>>(
          Prisma.sql`SELECT tenant_id, max(created_at) AS at FROM calls WHERE tenant_id = ANY(${ids}::uuid[]) GROUP BY tenant_id`,
        ),
        adminDb.$queryRaw<Array<{ tenant_id: string; credits: number }>>(
          Prisma.sql`SELECT DISTINCT ON (tenant_id) tenant_id, credits FROM purchases WHERE tenant_id = ANY(${ids}::uuid[]) AND status = 'paid' ORDER BY tenant_id, updated_at DESC`,
        ),
        adminDb.customerFlag
          .findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true, flag: true } })
          .catch(() => [] as Array<{ tenantId: string; flag: string }>),
      ]);
    for (const b of balances) out.get(b.tenant_id)!.balance = b.balance;
    for (const l of ledgerLast) {
      const f = out.get(l.tenant_id)!;
      f.balanceSince = l.created_at;
      f.lastActivityAt = l.created_at;
    }
    for (const u of usage)
      out.get(u.tenantId)!.usage30d = Math.round(-num(u._sum.delta) * 100) / 100;
    for (const a of agents) {
      const f = out.get(a.tenantId)!;
      f.agentsTotal += a._count._all;
      if (a.status === 'live') f.agentsLive += a._count._all;
    }
    for (const n of numbers) out.get(n.tenantId)!.numbersActive = n._count._all;
    for (const o of owners) out.get(o.tenantId)!.ownerEmail = o.user.email;
    for (const c of lastCalls) {
      const f = out.get(c.tenant_id)!;
      if (!f.lastActivityAt || c.at > f.lastActivityAt) f.lastActivityAt = c.at;
    }
    for (const p of lastPacks) out.get(p.tenant_id)!.lastPackCredits = p.credits;
    for (const fl of flags) out.get(fl.tenantId)!.flags.push(fl.flag);
    return out;
  }

  // ------------------------------------------------------------------ tabs

  async members(idRaw: string): Promise<AdminMemberResponse[]> {
    const id = uuidParam(idRaw, 'Customer');
    await this.exists(id);
    const rows = await adminDb.membership.findMany({
      where: { tenantId: id },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      user_id: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      mfa_enabled: m.user.mfaEnabled,
      locked_at: iso(m.user.lockedAt),
      joined_at: m.createdAt.toISOString(),
    }));
  }

  async walletTab(idRaw: string, query: PaginationQuery): Promise<AdminCustomerWallet> {
    const id = uuidParam(idRaw, 'Customer');
    await this.exists(id);
    const [balance, lots, ledger, adjustments, lastPack] = await Promise.all([
      this.wallet.balance(id),
      adminDb.creditLot.findMany({
        where: { tenantId: id },
        orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
      }),
      adminDb.creditLedger.findMany({
        where: { tenantId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(query),
      }),
      adminDb.creditAdjustment.findMany({
        where: { tenantId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { staff: { select: { email: true } } },
      }),
      adminDb.purchase.findFirst({
        where: { tenantId: id, status: 'paid' },
        orderBy: { updatedAt: 'desc' },
        select: { credits: true },
      }),
    ]);
    const page = toPage(ledger, query);
    return {
      balance,
      last_pack_credits: lastPack?.credits ?? null,
      lots: lots.map((l) => ({
        id: l.id,
        purchase_id: l.purchaseId,
        credits_total: num(l.creditsTotal),
        credits_remaining: num(l.creditsRemaining),
        expires_at: l.expiresAt.toISOString(),
        created_at: l.createdAt.toISOString(),
      })),
      ledger: page.items.map((r) => ({
        id: r.id,
        delta: num(r.delta),
        balance_after: num(r.balanceAfter),
        reason: r.reason,
        ref_type: r.refType,
        ref_id: r.refId,
        created_at: r.createdAt.toISOString(),
      })),
      ledger_next_cursor: page.next_cursor,
      adjustments: adjustments.map((a) => ({
        id: a.id,
        ledger_id: a.ledgerId,
        delta: num(a.delta),
        reason_code: a.reasonCode,
        note: a.note,
        customer_text: a.customerText,
        staff_email: a.staff.email,
        created_at: a.createdAt.toISOString(),
      })),
    };
  }

  async purchases(idRaw: string, query: PaginationQuery): Promise<Page<AdminPurchaseResponse>> {
    const id = uuidParam(idRaw, 'Customer');
    await this.exists(id);
    const rows = await adminDb.purchase.findMany({
      where: { tenantId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    return { ...page, items: page.items.map(toPurchase) };
  }

  async customerAudit(
    idRaw: string,
    query: AdminCustomerAuditQuery,
  ): Promise<Page<AdminCustomerAuditEntry>> {
    const id = uuidParam(idRaw, 'Customer');
    await this.exists(id);
    const rows = await adminDb.auditLog.findMany({
      where: { tenantId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { actor: { select: { email: true } } },
      ...cursorArgs(query),
    });
    const page = toPage(rows, query);
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.id,
        action: r.action,
        target_type: r.targetType,
        target_id: r.targetId,
        actor_email: r.actor?.email ?? null,
        ip: r.ip,
        meta: r.metaJson,
        created_at: r.createdAt.toISOString(),
      })),
    };
  }

  // ------------------------------------------------------------------ pause / resume (admin §4 SA2, §7.4 macro)

  async pause(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminTenantStatusResponse> {
    const id = uuidParam(idRaw, 'Customer');
    await this.limits.assertCan(staff, 'can_pause_tenant');
    const tenant = await this.exists(id);
    // Admin §2.2: support may pause only against a ticket — one of this workspace's, not
    // any number typed into the field (review, 28 Sep).
    if (staff.role === 'support') {
      const ticket = body.ticket_id
        ? await adminDb.supportTicket.findFirst({
            where: { id: body.ticket_id, tenantId: id },
            select: { id: true },
          })
        : null;
      if (!ticket)
        throw new AppError(
          'STAFF_LIMIT_EXCEEDED',
          body.ticket_id
            ? `Ticket #${body.ticket_id} is not one of this workspace's tickets.`
            : 'Support pauses a workspace against a ticket. Add the ticket number.',
        );
    }
    if (!tenant.pausedAt) {
      const reason = body.note ? `${body.reason_code}: ${body.note}` : body.reason_code;
      await adminDb.$transaction(async (tx) => {
        await tx.tenant.update({
          where: { id },
          data: { pausedAt: new Date(), pausedReason: reason },
        });
        await tx.auditLog.create({
          data: {
            tenantId: id,
            action: 'workspace.paused',
            targetType: 'workspace',
            targetId: id,
            metaJson: { by: 'staff', reason_code: body.reason_code },
          },
        });
        await this.audit.record(
          {
            staff,
            action: 'customer.paused',
            targetType: 'tenant',
            targetId: id,
            tenantId: id,
            reasonCode: body.reason_code,
            note: body.note,
            before: { paused: false },
            after: { paused: true, reason },
            request,
          },
          tx,
        );
      });
      await this.afterTenantChange(id);
      this.log.warn(`workspace ${id} paused by ${staff.email} (${body.reason_code})`);
    }
    return this.status(id);
  }

  async resume(
    staff: StaffContext,
    idRaw: string,
    body: StaffActionRequest,
    request: FastifyRequest,
  ): Promise<AdminTenantStatusResponse> {
    const id = uuidParam(idRaw, 'Customer');
    await this.limits.assertCan(staff, 'can_pause_tenant');
    const tenant = await this.exists(id);
    if (tenant.pausedAt) {
      await adminDb.$transaction(async (tx) => {
        await tx.tenant.update({ where: { id }, data: { pausedAt: null, pausedReason: null } });
        await tx.auditLog.create({
          data: {
            tenantId: id,
            action: 'workspace.resumed',
            targetType: 'workspace',
            targetId: id,
            metaJson: { by: 'staff', reason_code: body.reason_code },
          },
        });
        await this.audit.record(
          {
            staff,
            action: 'customer.resumed',
            targetType: 'tenant',
            targetId: id,
            tenantId: id,
            reasonCode: body.reason_code,
            note: body.note,
            before: { paused: true, reason: tenant.pausedReason },
            after: { paused: false },
            request,
          },
          tx,
        );
      });
      await this.afterTenantChange(id);
      this.log.log(`workspace ${id} resumed by ${staff.email}`);
    }
    return this.status(id);
  }

  async status(id: string): Promise<AdminTenantStatusResponse> {
    const t = await this.exists(id);
    return {
      id: t.id,
      paused: t.pausedAt !== null,
      paused_at: iso(t.pausedAt),
      paused_reason: t.pausedReason,
    };
  }

  /** The §13.9 hot path reads `num:{e164}.workspace_paused`; the portal reads `GET /workspace`. Both from here. */
  private async afterTenantChange(id: string): Promise<void> {
    await this.config.invalidateWorkspace(id);
    await this.runtimeCache.refresh(id);
  }

  // ------------------------------------------------------------------ credits (admin §4 SA2 "Adjust credits", §7.3 "Comp credits")

  /**
   * A staff adjustment is an ordinary ledger movement (`reason = adjustment`) written by
   * the wallet under the workspace lock, plus a `credit_adjustments` row that says who and
   * why — both in one transaction, so there is no adjustment without its record and no
   * record without its ledger row. Positive adjustments create a lot with the standard
   * expiry (admin §5 wallet policy); negative ones draw down FIFO like a call would, and
   * may take the balance negative (the ledger allows it; the customer sees it).
   */
  async adjustCredits(
    staff: StaffContext,
    idRaw: string,
    body: AdminCreditAdjustRequest,
    request: FastifyRequest,
  ): Promise<AdminCreditAdjustResponse> {
    return (await this.adjustCreditsOnce(staff, idRaw, body, request)).adjustment;
  }

  /**
   * `adjustCredits` plus whether this call moved the credits or answered an earlier one
   * under the same key. The SA4 macros need the difference: a replayed comp must not post
   * a second "Comped N credits" line on the ticket (review, 28 Sep).
   */
  async adjustCreditsOnce(
    staff: StaffContext,
    idRaw: string,
    body: AdminCreditAdjustRequest,
    request: FastifyRequest,
  ): Promise<{ adjustment: AdminCreditAdjustResponse; replayed: boolean }> {
    const id = uuidParam(idRaw, 'Customer');
    await this.exists(id);
    const adjustmentId = body.idempotency_key ?? randomUUID();
    // The replay is answered before the role limit is checked: the first attempt already
    // counts against today's budget, so a retry of it would otherwise be refused with
    // STAFF_LIMIT_EXCEEDED after the credits had moved (review, 28 Sep).
    if (body.idempotency_key) {
      const replay = await this.existingAdjustment(id, adjustmentId);
      if (replay) return { adjustment: replay, replayed: true };
    }
    await this.limits.assertCreditAdjustment(staff, body.delta);
    const { policy, configVersion } = await this.config.walletPolicy();
    // `credit_adjustments.ticket_id` references `support_tickets`, which fills up with SA4 (P2).
    // Until then a ticket number is an external reference (the helpdesk's): link it when we
    // hold the ticket, otherwise keep it in the audit row instead of failing the write.
    const ticketLinked = body.ticket_id ? (await adminDb.supportTicket.count({ where: { id: body.ticket_id } })) > 0 : false;

    let result: Awaited<ReturnType<WalletService['grant']>>;
    try {
    result = await this.wallet.withWallet(id, async (tx, wallet) => {
      const write =
        body.delta > 0
          ? await wallet.grant({
              credits: body.delta,
              reason: 'adjustment',
              expiresAt: addMonths(new Date(), policy.credit_expiry_months),
              refType: 'credit_adjustment',
              refId: adjustmentId,
              policyVersion: configVersion,
            })
          : await wallet.debit({
              credits: -body.delta,
              reason: 'adjustment',
              refType: 'credit_adjustment',
              refId: adjustmentId,
            });
      await tx.creditAdjustment.create({
        data: {
          id: adjustmentId,
          tenantId: id,
          ledgerId: write.id,
          delta: body.delta,
          reasonCode: body.reason_code,
          note: body.note ?? null,
          customerText: body.customer_text ?? null,
          staffId: staff.staffId,
          ticketId: ticketLinked ? body.ticket_id : null,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: id,
          action: 'credits.adjusted',
          targetType: 'credit_ledger',
          targetId: write.id,
          metaJson: {
            by: 'staff',
            delta: body.delta,
            reason_code: body.reason_code,
            text: body.customer_text ?? null,
          },
        },
      });
      await this.audit.record(
        {
          staff,
          action: 'credits.adjusted',
          targetType: 'credit_adjustment',
          targetId: adjustmentId,
          tenantId: id,
          reasonCode: body.reason_code,
          note: body.note,
          after: {
            delta: body.delta,
            balance_after: write.balance_after,
            ledger_id: write.id,
            ticket_id: body.ticket_id ?? null,
            ticket_linked: ticketLinked,
          },
          request,
        },
        tx,
      );
      return write;
    });
    } catch (error) {
      // The same key racing itself: both waited on the wallet lock, the second one's
      // `credit_adjustments` insert collided on the id and rolled its ledger row back with it.
      if (body.idempotency_key && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.existingAdjustment(id, adjustmentId);
        if (replay) return { adjustment: replay, replayed: true };
      }
      throw error;
    }
    this.log.log(
      `credits ${body.delta > 0 ? '+' : ''}${body.delta} on ${id} by ${staff.email} (${body.reason_code}) → ${result.balance_after}`,
    );
    return {
      adjustment: {
        adjustment_id: adjustmentId,
        ledger_id: result.id,
        delta: body.delta,
        balance_after: result.balance_after,
      },
      replayed: false,
    };
  }

  /** An adjustment already made under this key, answered as the original response. A key reused on another workspace is refused. */
  private async existingAdjustment(tenantId: string, adjustmentId: string): Promise<AdminCreditAdjustResponse | null> {
    const row = await adminDb.creditAdjustment.findUnique({ where: { id: adjustmentId }, include: { ledger: { select: { id: true, balanceAfter: true } } } });
    if (!row) return null;
    if (row.tenantId !== tenantId) throw new AppError('CONFLICT', 'This idempotency key was already used for another customer.');
    return { adjustment_id: row.id, ledger_id: row.ledger.id, delta: num(row.delta), balance_after: num(row.ledger.balanceAfter) };
  }

  private async exists(id: string) {
    const tenant = await adminDb.tenant.findUnique({ where: { id } });
    if (!tenant) throw AppError.notFound('Customer');
    return tenant;
  }
}

export function toPurchase(p: {
  id: string;
  tenantId: string;
  packId: string | null;
  amountCents: number;
  currency: string;
  credits: number;
  status: AdminPurchaseResponse['status'];
  isAutoTopup: boolean;
  failureReason: string | null;
  stripeSessionId: string | null;
  stripePaymentIntent: string | null;
  invoiceUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AdminPurchaseResponse {
  return {
    id: p.id,
    tenant_id: p.tenantId,
    pack_id: p.packId,
    amount_cents: p.amountCents,
    currency: p.currency,
    credits: p.credits,
    status: p.status,
    is_auto_topup: p.isAutoTopup,
    failure_reason: p.failureReason,
    stripe_session_id: p.stripeSessionId,
    stripe_payment_intent: p.stripePaymentIntent,
    invoice_url: p.invoiceUrl,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

export { numOrNull };
