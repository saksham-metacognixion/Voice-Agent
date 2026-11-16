'use client';

import { useApi, useGetPricing, useGetStats, useGetWallet } from '@portal/api-client';
import { Button, Card, CardContent, CardHeader, CardTitle, Progress, Skeleton } from '@portal/ui';
import { Coins } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Fact, LoadError } from '@/src/components/dashboard/query-states';
import { canTopUp, creditsOutlook } from '@/src/dashboard/home-view';
import { formatCreditsValue, formatDate, formatNumber } from '@/src/lib/format';
import { PRICING_STALE_MS } from '@/src/lib/pricing';
import { routes } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D1 credits card (spec p. 33): the balance from `GET /wallet`, what it is worth in
 * Standard minutes at the published rate, how many days it lasts at the last seven
 * days' burn (`GET /stats?range=7d`, ADR 0041), what expires next, today's spend, and
 * the auto top-up state. "Top up" is an owner's or admin's (§6.1); a viewer sees the
 * figures and no button. The `wallet` SSE topic refreshes it on every ledger write.
 */
export function CreditsCard() {
  const t = useTranslations('dashboard.home.credits');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const { role } = useRole();
  const wallet = useGetWallet(api, { staleTime: 15_000 });
  const today = useGetStats(api, { range: 'today' }, { staleTime: 30_000 });
  const week = useGetStats(api, { range: '7d' }, { staleTime: 60_000 });
  const pricing = useGetPricing(api, undefined, { staleTime: PRICING_STALE_MS });
  const topUp = canTopUp(role);

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Coins className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        {topUp ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={routes.app.wallet} data-testid="top-up">{t('buy')}</Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {wallet.isPending ? (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : wallet.isError ? (
          <LoadError compact error={wallet.error} onRetry={() => void wallet.refetch()} />
        ) : (
          <>
            <div>
              <p className={`text-3xl font-semibold tabular-nums tracking-tight ${wallet.data.balance <= 0 ? 'text-danger' : ''}`}>
                {formatCreditsValue(wallet.data.balance)} <span className="text-base font-normal text-muted-foreground">{t('credits')}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {tc('shell.planTier', { tier: tc(`shell.tier.${wallet.data.plan_tier}`) })}
                {wallet.data.last_pack_credits ? ` · ${t('ofPack', { pack: formatCreditsValue(wallet.data.last_pack_credits) })}` : ''}
              </p>
            </div>
            {wallet.data.last_pack_credits ? (
              <Progress value={Math.max(0, Math.min(100, (wallet.data.balance / wallet.data.last_pack_credits) * 100))} aria-label={t('remaining')} />
            ) : null}
            <Outlook balance={wallet.data.balance} rate={pricing.data?.rates.standard_per_min ?? null} burn={week.data?.credits_used ?? null} pending={week.isPending || pricing.isPending} />
            <dl className="grid grid-cols-2 gap-3">
              <Fact label={t('usedToday')}>{today.isPending ? <Skeleton className="h-4 w-12" /> : today.isError ? '–' : formatCreditsValue(today.data.credits_used)}</Fact>
              <Fact label={t('expiring')} wrap>
                {wallet.data.expiring_next ? t('expiringValue', { credits: formatCreditsValue(wallet.data.expiring_next.credits), date: formatDate(wallet.data.expiring_next.expires_at, ws.workspace?.timezone) }) : t('nothingExpiring')}
              </Fact>
            </dl>
            <p className="text-xs text-muted-foreground" data-testid="auto-topup-state">
              {wallet.data.auto_topup?.enabled ? t('autoTopupOn', { threshold: formatCreditsValue(wallet.data.auto_topup.threshold ?? 0) }) : t('autoTopupOff')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** "≈ 312 min · ≈ 9 days left" — approximate by its sign and its hint, never presented as exact. */
function Outlook({ balance, rate, burn, pending }: { balance: number; rate: number | null; burn: number | null; pending: boolean }) {
  const t = useTranslations('dashboard.home.credits');
  if (pending && (rate === null || burn === null)) return <Skeleton className="h-4 w-48" />;
  const outlook = creditsOutlook({ balance, standardRatePerMin: rate ?? 0, burn: burn ?? 0 });
  const minutes = rate !== null && rate > 0 ? t('approxMinutes', { minutes: formatNumber(outlook.minutes, 0) }) : null;
  const days = burn === null ? null : outlook.daysLeft === null ? t('noUsage') : outlook.daysLeft === 0 ? t('outOfCredits') : t('approxDays', { days: outlook.daysLeft });
  if (!minutes && !days) return null;
  return (
    <p className="text-sm" data-testid="credits-outlook">
      {[minutes, days].filter(Boolean).join(' · ')}
      <span className="block text-[11px] text-muted-foreground">{t('approxHint')}</span>
    </p>
  );
}
