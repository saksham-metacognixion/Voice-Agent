import { Injectable } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminBreakageReport,
  AdminCogsReport,
  AdminDeferredReport,
  AdminKbResponse,
  AdminKbsQuery,
  AdminRange,
  Page,
} from '@portal/schemas';
import { cursorArgs, toPage } from '../../common/pagination';
import { DAY_MS, iso, rangeWindow } from './admin.helpers';

/** SQL numerics arrive as strings or Decimals; every figure here leaves as a plain number. */
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const credits2 = (v: unknown): number => Math.round(n(v) * 100) / 100;

const KB_STATUSES = ['pending', 'syncing', 'ready', 'failed', 'deleting'] as const;

/**
 * Admin §9 finance reports and the knowledge-base list. Read-only and cross-workspace on
 * `adminDb`, aggregated in Postgres so a report never pulls the ledger into memory.
 *
 * Money is valued at what was actually paid: a lot carries its purchase, so a credit is
 * worth `amount_cents / credits` of the pack that bought it, and a credit nobody paid for
 * (the trial, a staff adjustment) is counted apart at no value. Currencies are never added
 * together (§20 item 2 is still open).
 */
@Injectable()
export class AdminReportsService {
  /** Revenue is SA9's summary (`AdminBillingService.summary`); this is what it cost. */
  async cogs(range: AdminRange, now = new Date()): Promise<AdminCogsReport> {
    const { from, to } = rangeWindow(range, now);
    const window = Prisma.sql`created_at >= ${from} AND created_at <= ${to} AND status <> 'declined'`;
    const [byTier, byDay, prices] = await Promise.all([
      adminDb.$queryRaw<Array<{ tier: string; calls: bigint; no_cost: bigint; secs: bigint; credits: unknown; cost: bigint }>>(Prisma.sql`
        SELECT tier::text AS tier, count(*) AS calls,
               count(*) FILTER (WHERE retell_cost_cents IS NULL AND status IN ('ended', 'analyzed')) AS no_cost,
               coalesce(sum(duration_s), 0)::bigint AS secs,
               coalesce(sum(coalesce(credits_charged, 0) + coalesce(transfer_credits_charged, 0)), 0) AS credits,
               coalesce(sum(retell_cost_cents), 0)::bigint AS cost
          FROM calls WHERE ${window} GROUP BY 1 ORDER BY 1`),
      adminDb.$queryRaw<Array<{ day: string; calls: bigint; credits: unknown; cost: bigint }>>(Prisma.sql`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*) AS calls,
               coalesce(sum(coalesce(credits_charged, 0) + coalesce(transfer_credits_charged, 0)), 0) AS credits,
               coalesce(sum(retell_cost_cents), 0)::bigint AS cost
          FROM calls WHERE ${window} GROUP BY 1 ORDER BY 1`),
      adminDb.$queryRaw<Array<{ currency: string; cents: bigint; credits: bigint }>>(Prisma.sql`
        SELECT currency, sum(amount_cents)::bigint AS cents, sum(credits)::bigint AS credits
          FROM purchases WHERE status = 'paid' AND created_at >= ${new Date(now.getTime() - 365 * DAY_MS)} GROUP BY 1`),
    ]);
    const creditsBilled = credits2(byTier.reduce((sum, t) => sum + n(t.credits), 0));
    const cost = byTier.reduce((sum, t) => sum + n(t.cost), 0);
    const price = prices.length === 1 && n(prices[0]!.credits) > 0 ? n(prices[0]!.cents) / n(prices[0]!.credits) : null;
    const revenue = price === null ? null : Math.round(creditsBilled * price);
    return {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      calls: byTier.reduce((sum, t) => sum + n(t.calls), 0),
      calls_without_cost: byTier.reduce((sum, t) => sum + n(t.no_cost), 0),
      billed_seconds: byTier.reduce((sum, t) => sum + n(t.secs), 0),
      credits_billed: creditsBilled,
      platform_cost_cents: cost,
      by_tier: byTier.map((t) => ({ tier: t.tier, calls: n(t.calls), credits_billed: credits2(t.credits), platform_cost_cents: n(t.cost) })),
      by_day: byDay.map((d) => ({ day: d.day, calls: n(d.calls), credits_billed: credits2(d.credits), platform_cost_cents: n(d.cost) })),
      avg_price_cents_per_credit: price === null ? null : Math.round(price * 10_000) / 10_000,
      price_currency: prices.length === 1 ? prices[0]!.currency : null,
      estimated_revenue_cents: revenue,
      estimated_margin_pct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
    };
  }

  /** As of now: the paid, unexpired, unused credits — what is still owed as service. */
  async deferred(now = new Date()): Promise<AdminDeferredReport> {
    const live = Prisma.sql`l.credits_remaining > 0 AND l.expires_at > ${now}`;
    const [paid, byMonth, unpaid, workspaces] = await Promise.all([
      adminDb.$queryRaw<Array<{ currency: string; credits: unknown; value: unknown }>>(Prisma.sql`
        SELECT p.currency, sum(l.credits_remaining) AS credits, sum(l.credits_remaining * p.amount_cents / nullif(p.credits, 0)) AS value
          FROM credit_lots l JOIN purchases p ON p.id = l.purchase_id WHERE ${live} GROUP BY 1 ORDER BY 1`),
      adminDb.$queryRaw<Array<{ month: string; currency: string; credits: unknown; value: unknown }>>(Prisma.sql`
        SELECT to_char(date_trunc('month', l.expires_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, p.currency,
               sum(l.credits_remaining) AS credits, sum(l.credits_remaining * p.amount_cents / nullif(p.credits, 0)) AS value
          FROM credit_lots l JOIN purchases p ON p.id = l.purchase_id WHERE ${live} GROUP BY 1, 2 ORDER BY 1, 2`),
      adminDb.$queryRaw<Array<{ credits: unknown }>>(Prisma.sql`SELECT coalesce(sum(l.credits_remaining), 0) AS credits FROM credit_lots l WHERE l.purchase_id IS NULL AND ${live}`),
      adminDb.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT count(DISTINCT l.tenant_id) AS n FROM credit_lots l WHERE ${live}`),
    ]);
    return {
      as_of: now.toISOString(),
      workspaces: n(workspaces[0]?.n),
      paid: paid.map((p) => ({ currency: p.currency, credits: credits2(p.credits), value_cents: Math.round(n(p.value)) })),
      unpaid_credits: credits2(unpaid[0]?.credits),
      by_expiry_month: byMonth.map((m) => ({ month: m.month, currency: m.currency, credits: credits2(m.credits), value_cents: Math.round(n(m.value)) })),
    };
  }

  /** Credits that expired unused in the range: the `expiry` ledger rows, each valued through its lot. */
  async breakage(range: AdminRange, now = new Date()): Promise<AdminBreakageReport> {
    const { from, to } = rangeWindow(range, now);
    const rows = Prisma.sql`
      FROM credit_ledger cl
      JOIN credit_lots l ON l.id::text = cl.ref_id
      LEFT JOIN purchases p ON p.id = l.purchase_id
     WHERE cl.reason = 'expiry' AND cl.ref_type = 'lot' AND cl.created_at >= ${from} AND cl.created_at <= ${to}`;
    const [paid, byDay, unpaid] = await Promise.all([
      adminDb.$queryRaw<Array<{ currency: string; credits: unknown; value: unknown; lots: bigint }>>(Prisma.sql`
        SELECT p.currency, sum(-cl.delta) AS credits, sum(-cl.delta * p.amount_cents / nullif(p.credits, 0)) AS value, count(DISTINCT l.id) AS lots
        ${rows} AND p.id IS NOT NULL GROUP BY 1 ORDER BY 1`),
      adminDb.$queryRaw<Array<{ day: string; currency: string; credits: unknown; value: unknown }>>(Prisma.sql`
        SELECT to_char(date_trunc('day', cl.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, p.currency,
               sum(-cl.delta) AS credits, sum(-cl.delta * p.amount_cents / nullif(p.credits, 0)) AS value
        ${rows} AND p.id IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`),
      adminDb.$queryRaw<Array<{ credits: unknown; lots: bigint }>>(Prisma.sql`SELECT coalesce(sum(-cl.delta), 0) AS credits, count(DISTINCT l.id) AS lots ${rows} AND p.id IS NULL`),
    ]);
    return {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      lots: paid.reduce((sum, p) => sum + n(p.lots), 0) + n(unpaid[0]?.lots),
      paid: paid.map((p) => ({ currency: p.currency, credits: credits2(p.credits), value_cents: Math.round(n(p.value)) })),
      unpaid_credits: credits2(unpaid[0]?.credits),
      by_day: byDay.map((d) => ({ day: d.day, currency: d.currency, credits: credits2(d.credits), value_cents: Math.round(n(d.value)) })),
    };
  }

  /** Admin §9 `GET /admin/kbs`: every agent with knowledge, across workspaces, with its sources by state. */
  async kbs(query: AdminKbsQuery): Promise<Page<AdminKbResponse>> {
    const where: Prisma.AgentWhereInput = {
      deletedAt: null,
      OR: [{ retellKbId: { not: null } }, { knowledgeSources: { some: {} } }],
      ...(query.tenant_id ? { tenantId: query.tenant_id } : {}),
      ...(query.status ? { knowledgeSources: { some: { status: query.status } } } : {}),
    };
    const [rows, total] = await Promise.all([
      adminDb.agent.findMany({
        where,
        select: { id: true, name: true, status: true, tenantId: true, retellKbId: true, createdAt: true, tenant: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(query),
      }),
      adminDb.agent.count({ where }),
    ]);
    const page = toPage(rows, query);
    const ids = page.items.map((a) => a.id);
    const [counts, facts, failures] = ids.length
      ? await Promise.all([
          adminDb.knowledgeSource.groupBy({ by: ['agentId', 'status'], where: { agentId: { in: ids } }, _count: { _all: true } }),
          adminDb.knowledgeSource.groupBy({ by: ['agentId'], where: { agentId: { in: ids } }, _sum: { sizeBytes: true }, _max: { syncedAt: true, updatedAt: true } }),
          adminDb.knowledgeSource.findMany({ where: { agentId: { in: ids }, status: 'failed' }, orderBy: { updatedAt: 'desc' }, distinct: ['agentId'], select: { agentId: true, error: true } }),
        ])
      : [[], [], []];
    const menus = ids.length ? await adminDb.knowledgeSource.findMany({ where: { agentId: { in: ids }, role: 'menu' }, select: { agentId: true } }) : [];
    const hasMenu = new Set(menus.map((m) => m.agentId));
    const factOf = new Map(facts.map((f) => [f.agentId, f]));
    const errorOf = new Map(failures.map((f) => [f.agentId, f.error]));
    return {
      ...page,
      total,
      items: page.items.map((a) => {
        const byStatus = Object.fromEntries(KB_STATUSES.map((s) => [s, 0])) as AdminKbResponse['by_status'];
        for (const c of counts) if (c.agentId === a.id) byStatus[c.status] = c._count._all;
        const f = factOf.get(a.id);
        return {
          agent_id: a.id,
          agent_name: a.name,
          agent_status: a.status,
          tenant_id: a.tenantId,
          tenant_name: a.tenant.name,
          has_platform_kb: a.retellKbId !== null,
          sources: Object.values(byStatus).reduce((sum, v) => sum + v, 0),
          by_status: byStatus,
          has_menu: hasMenu.has(a.id),
          size_bytes: f?._sum.sizeBytes ?? 0,
          last_synced_at: iso(f?._max.syncedAt ?? null),
          last_error: errorOf.get(a.id) ?? null,
          updated_at: (f?._max.updatedAt ?? a.createdAt).toISOString(),
        };
      }),
    };
  }
}
