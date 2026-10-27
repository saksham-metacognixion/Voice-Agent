import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import type { AdminFunnelResponse, AdminKpisResponse, AdminRange } from '@portal/schemas';
import { REDIS, RedisCache, type RedisLike, redisKeys, workspaceOfActiveKey } from '../redis';
import { parseActiveHash, platformConcurrencyLimit } from '../calls';
import { AT_RISK_AFTER_MS, DAY_MS, num, rangeWindow } from './admin.helpers';

/**
 * The wizard steps as SA1 draws the funnel (W1 → W7 → paid → live). W4 (knowledge) is
 * after payment since ADR 0024, so step 4 is unused and not drawn.
 */
const FUNNEL_STEPS = [
  { key: 'signed_up', label: 'Signed up', step: 1 },
  { key: 'brief', label: 'Brief (W2)', step: 2 },
  { key: 'voice', label: 'Voice (W3)', step: 3 },
  { key: 'test', label: 'Test call (W5)', step: 5 },
  { key: 'phone', label: 'Phone (W6)', step: 6 },
  { key: 'activate', label: 'Activate (W7)', step: 7 },
] as const;

/**
 * SA1 and Appendix A (D12): the numbers a founder reads every morning, computed in
 * Postgres — never on the frontend — from the tables that already hold them. Every
 * figure is derivable from the definitions in Appendix A; where the appendix names a
 * $-weighted figure (recognised revenue, COGS) that needs `retell_cost_inputs` and the
 * lot's $/credit, P2 adds it beside these.
 *
 * All on `adminDb`: this is the "legitimately crosses workspaces" case of ADR 0006.
 */
@Injectable()
export class AdminKpisService {
  private readonly log = new Logger(AdminKpisService.name);

  constructor(
    private readonly cache: RedisCache,
    @Inject(REDIS) private readonly redis: RedisLike,
  ) {}

  async kpis(range: AdminRange, now = new Date()): Promise<AdminKpisResponse> {
    const { from, to } = rangeWindow(range, now);
    const d30 = new Date(now.getTime() - 30 * DAY_MS);
    const d1 = new Date(now.getTime() - DAY_MS);

    const [
      total,
      activeCalls,
      activePurchases,
      onboarding,
      paused,
      atRisk,
      newInRange,
      agentsByStatus,
      numbersActive,
      numbersProvisioning,
      numbersReleased,
      salesByCurrency,
      salesByPack,
      creditsUsed,
      callsConnected,
      declinedByReason,
      minutes,
      outstanding,
      expired,
      kbs,
      failedJobs,
      unprocessed,
      overdue,
      openAlerts,
      pendingPurchases,
      failedActivations,
      failedTopups,
      onboardingStuck,
      series,
      concurrency,
    ] = await Promise.all([
      adminDb.tenant.count(),
      adminDb.call.findMany({
        where: {
          startedAt: { gte: d30 },
          status: { in: ['ended', 'analyzed'] },
          isTest: false,
          durationS: { gt: 0 },
        },
        distinct: ['tenantId'],
        select: { tenantId: true },
      }),
      adminDb.purchase.findMany({
        where: { status: 'paid', updatedAt: { gte: d30 } },
        distinct: ['tenantId'],
        select: { tenantId: true },
      }),
      adminDb.tenant.count({ where: { onboardingCompletedAt: null, pausedAt: null } }),
      adminDb.tenant.count({ where: { pausedAt: { not: null } } }),
      this.atRiskCount(now),
      adminDb.tenant.count({ where: { createdAt: { gte: from } } }),
      adminDb.agent.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      adminDb.phoneNumber.count({ where: { status: 'active' } }),
      adminDb.phoneNumber.count({ where: { status: 'provisioning' } }),
      adminDb.phoneNumber.count({ where: { releasedAt: { gte: from } } }),
      adminDb.purchase.groupBy({
        by: ['currency'],
        where: { status: 'paid', updatedAt: { gte: from } },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      adminDb.purchase.groupBy({
        by: ['packId'],
        where: { status: 'paid', updatedAt: { gte: from } },
        _sum: { credits: true },
        _count: { _all: true },
      }),
      this.creditsUsed(from),
      adminDb.call.count({
        where: {
          startedAt: { gte: from },
          status: { in: ['ended', 'analyzed'] },
          durationS: { gt: 0 },
        },
      }),
      adminDb.call.groupBy({
        by: ['declineReason'],
        where: { createdAt: { gte: from }, status: 'declined' },
        _count: { _all: true },
      }),
      adminDb.call.aggregate({
        where: { startedAt: { gte: from }, status: { in: ['ended', 'analyzed'] } },
        _sum: { durationS: true },
      }),
      adminDb.creditLot.aggregate({
        where: { expiresAt: { gt: now }, creditsRemaining: { gt: 0 } },
        _sum: { creditsRemaining: true },
      }),
      adminDb.creditLedger.aggregate({
        where: { reason: 'expiry', createdAt: { gte: from } },
        _sum: { delta: true },
      }),
      adminDb.agent.count({ where: { deletedAt: null, retellKbId: { not: null } } }),
      adminDb.job.count({ where: { status: 'failed', updatedAt: { gte: d1 } } }),
      adminDb.webhookEvent.count({
        where: { processedAt: null, receivedAt: { lt: new Date(now.getTime() - 60_000) } },
      }),
      adminDb.phoneNumber.count({
        where: { rentalOverdueSince: { not: null }, status: { in: ['active', 'paused'] } },
      }),
      adminDb.alert.count({ where: { resolvedAt: null } }),
      adminDb.purchase.count({
        where: {
          status: 'pending',
          isAutoTopup: false,
          createdAt: { lt: new Date(now.getTime() - 5 * 60_000) },
        },
      }),
      // D13 QA: the three the ops rota asks about first — a paid customer whose activation
      // died, a card that declined, and a sign-up that never reached the end of the wizard.
      adminDb.job.count({ where: { type: 'activate-agent', status: 'failed', updatedAt: { gte: d1 } } }),
      adminDb.purchase.count({ where: { isAutoTopup: true, status: 'abandoned', updatedAt: { gte: d1 } } }),
      adminDb.tenant.count({
        where: { onboardingCompletedAt: null, pausedAt: null, createdAt: { lt: new Date(now.getTime() - 7 * DAY_MS) }, purchases: { some: { status: 'paid' } } },
      }),
      this.series(from, to),
      this.liveConcurrency(now),
    ]);

    const active = new Set([
      ...activeCalls.map((c) => c.tenantId),
      ...activePurchases.map((p) => p.tenantId),
    ]).size;
    const agentCount = (status: 'live' | 'draft' | 'paused') =>
      agentsByStatus.find((g) => g.status === status)?._count._all ?? 0;

    return {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      customers: { total, active, onboarding, paused, at_risk: atRisk, new_in_range: newInRange },
      agents: {
        live: agentCount('live'),
        draft: agentCount('draft'),
        paused: agentCount('paused'),
      },
      numbers: {
        active: numbersActive,
        provisioning: numbersProvisioning,
        released_in_range: numbersReleased,
      },
      credit_sales: {
        by_currency: salesByCurrency.map((g) => ({
          currency: g.currency,
          amount_cents: g._sum.amountCents ?? 0,
          purchases: g._count._all,
        })),
        by_pack: salesByPack.map((g) => ({
          pack_id: g.packId ?? 'custom',
          purchases: g._count._all,
          credits: g._sum.credits ?? 0,
        })),
      },
      credits_used: creditsUsed,
      calls: {
        connected: callsConnected,
        declined: declinedByReason.reduce((n, g) => n + g._count._all, 0),
        declined_by_reason: Object.fromEntries(
          declinedByReason.map((g) => [g.declineReason ?? 'unknown', g._count._all]),
        ),
        minutes: Math.round(((minutes._sum.durationS ?? 0) / 60) * 100) / 100,
      },
      wallet: {
        outstanding_credits: num(outstanding._sum.creditsRemaining),
        expired_in_range: -num(expired._sum.delta),
      },
      concurrency,
      knowledge: { bases: kbs },
      attention: {
        failed_jobs_24h: failedJobs,
        unprocessed_webhooks: unprocessed,
        overdue_rentals: overdue,
        open_alerts: openAlerts,
        pending_purchases: pendingPurchases,
        failed_activations_24h: failedActivations,
        failed_topups_24h: failedTopups,
        onboarding_stuck: onboardingStuck,
      },
      series,
    };
  }

  async funnel(range: AdminRange, now = new Date()): Promise<AdminFunnelResponse> {
    const { from } = rangeWindow(range, now);
    const cohort = await adminDb.tenant.findMany({
      where: { createdAt: { gte: from } },
      select: { id: true, onboardingStep: true, onboardingCompletedAt: true, createdAt: true },
    });
    const ids = cohort.map((t) => t.id);
    const paid = ids.length
      ? await adminDb.purchase.findMany({
          where: { tenantId: { in: ids }, status: 'paid' },
          distinct: ['tenantId'],
          select: { tenantId: true },
        })
      : [];
    const paidSet = new Set(paid.map((p) => p.tenantId));

    const reached = (step: number) =>
      cohort.filter((t) => t.onboardingCompletedAt || t.onboardingStep >= step).length;
    const steps = [
      ...FUNNEL_STEPS.map((s) => ({ key: s.key, label: s.label, count: reached(s.step) })),
      { key: 'paid', label: 'Paid', count: paidSet.size },
      { key: 'live', label: 'Live', count: cohort.filter((t) => t.onboardingCompletedAt).length },
    ];
    const minutesToLive = cohort
      .filter((t) => t.onboardingCompletedAt)
      .map((t) => (t.onboardingCompletedAt!.getTime() - t.createdAt.getTime()) / 60_000)
      .sort((a, b) => a - b);
    const median = minutesToLive.length
      ? Math.round(minutesToLive[Math.floor(minutesToLive.length / 2)]! * 10) / 10
      : null;
    const stuck = new Map<number, number>();
    for (const t of cohort)
      if (!t.onboardingCompletedAt)
        stuck.set(t.onboardingStep, (stuck.get(t.onboardingStep) ?? 0) + 1);

    return {
      range,
      cohort_size: cohort.length,
      steps,
      activation_rate: cohort.length
        ? Math.round((paidSet.size / cohort.length) * 1000) / 1000
        : null,
      median_minutes_to_live: median,
      stuck_by_step: [...stuck.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([step, count]) => ({ step, count })),
    };
  }

  /** Tenants whose newest ledger row left the balance at or below zero more than three days ago. */
  private async atRiskCount(now: Date): Promise<number> {
    const rows = await adminDb.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM (
        SELECT DISTINCT ON (tenant_id) tenant_id, balance_after, created_at
        FROM credit_ledger ORDER BY tenant_id, created_at DESC
      ) latest
      JOIN tenants t ON t.id = latest.tenant_id
      WHERE latest.balance_after <= 0 AND latest.created_at < ${new Date(now.getTime() - AT_RISK_AFTER_MS)} AND t.paused_at IS NULL AND t.onboarding_completed_at IS NOT NULL`);
    return Number(rows[0]?.n ?? 0);
  }

  private async creditsUsed(from: Date): Promise<AdminKpisResponse['credits_used']> {
    const rows = await adminDb.$queryRaw<
      Array<{ tier: string; is_test: boolean; used: Prisma.Decimal | null }>
    >(Prisma.sql`
      SELECT c.tier::text AS tier, c.is_test, coalesce(sum(-l.delta), 0) AS used
      FROM credit_ledger l JOIN calls c ON c.id = l.ref_id
      WHERE l.reason IN ('call', 'transfer') AND l.created_at >= ${from}
      GROUP BY 1, 2`);
    let total = 0;
    let standard = 0;
    let premium = 0;
    let test = 0;
    for (const r of rows) {
      const used = num(r.used);
      total += used;
      if (r.is_test) test += used;
      else if (r.tier === 'premium') premium += used;
      else standard += used;
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      total: round(total),
      standard: round(standard),
      premium: round(premium),
      test: round(test),
    };
  }

  private async series(from: Date, to: Date): Promise<AdminKpisResponse['series']> {
    const [calls, credits, signups, sales] = await Promise.all([
      adminDb.$queryRaw<Array<{ day: string; n: bigint }>>(
        Prisma.sql`SELECT to_char(date_trunc('day', started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::bigint AS n FROM calls WHERE started_at >= ${from} AND started_at <= ${to} AND status IN ('ended','analyzed') GROUP BY 1`,
      ),
      adminDb.$queryRaw<Array<{ day: string; n: Prisma.Decimal | null }>>(
        Prisma.sql`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, coalesce(sum(-delta), 0) AS n FROM credit_ledger WHERE reason IN ('call', 'transfer') AND created_at >= ${from} AND created_at <= ${to} GROUP BY 1`,
      ),
      adminDb.$queryRaw<Array<{ day: string; n: bigint }>>(
        Prisma.sql`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::bigint AS n FROM tenants WHERE created_at >= ${from} AND created_at <= ${to} GROUP BY 1`,
      ),
      adminDb.$queryRaw<Array<{ day: string; n: bigint }>>(
        Prisma.sql`SELECT to_char(date_trunc('day', updated_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, coalesce(sum(amount_cents), 0)::bigint AS n FROM purchases WHERE status = 'paid' AND updated_at >= ${from} AND updated_at <= ${to} GROUP BY 1`,
      ),
    ]);
    const byDay = new Map<string, AdminKpisResponse['series'][number]>();
    for (
      let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
      t <= to.getTime();
      t += DAY_MS
    ) {
      const day = new Date(t).toISOString().slice(0, 10);
      byDay.set(day, { day, calls: 0, credits_used: 0, signups: 0, sales_cents: 0 });
    }
    for (const r of calls) if (byDay.has(r.day)) byDay.get(r.day)!.calls = Number(r.n);
    for (const r of credits)
      if (byDay.has(r.day)) byDay.get(r.day)!.credits_used = Math.round(num(r.n) * 100) / 100;
    for (const r of signups) if (byDay.has(r.day)) byDay.get(r.day)!.signups = Number(r.n);
    for (const r of sales) if (byDay.has(r.day)) byDay.get(r.day)!.sales_cents = Number(r.n);
    return [...byDay.values()];
  }

  /** Live calls platform-wide from `active:*`, the same hashes the inbound checks read. Null when Redis did not answer. */
  async liveConcurrency(now = new Date()): Promise<AdminKpisResponse['concurrency']> {
    const allowance = platformConcurrencyLimit() ?? null;
    const scan = await this.cache.scanKeys(redisKeys.activeCallsPattern);
    if (!scan) return { live: null, allowance };
    let live = 0;
    for (const key of scan.keys) {
      if (!workspaceOfActiveKey(key)) continue;
      try {
        live += parseActiveHash(await this.redis.hgetall(key), now.getTime()).live.length;
      } catch (error) {
        this.log.warn(`concurrency: ${key} unreadable (${String(error)})`);
      }
    }
    return { live, allowance };
  }
}
