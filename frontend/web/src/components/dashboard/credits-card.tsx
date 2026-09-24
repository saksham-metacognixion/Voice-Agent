'use client';

import { useApi, useGetStats, useGetWallet } from '@portal/api-client';
import { Button, Card, CardContent, CardHeader, CardTitle, Progress, Skeleton } from '@portal/ui';
import { Coins } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Fact, LoadError } from '@/src/components/dashboard/query-states';
import { formatCreditsValue, formatDateTime } from '@/src/lib/format';
import { routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D1 credits card (spec p. 33): the balance from `GET /wallet`, how much of the last
 * pack is left, what expires next, and today's spend from `GET /stats?range=today`.
 * The `wallet` SSE topic refreshes it on every ledger write.
 */
export function CreditsCard() {
  const t = useTranslations('dashboard.home.credits');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const wallet = useGetWallet(api, { staleTime: 15_000 });
  const today = useGetStats(api, { range: 'today' }, { staleTime: 30_000 });

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Coins className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <Button size="sm" variant="outline" asChild>
          <Link href={routes.app.wallet}>{t('buy')}</Link>
        </Button>
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
            <dl className="grid grid-cols-2 gap-3">
              <Fact label={t('usedToday')}>{today.isPending ? <Skeleton className="h-4 w-12" /> : today.isError ? '–' : formatCreditsValue(today.data.credits_used)}</Fact>
              <Fact label={t('expiring')}>
                {wallet.data.expiring_next ? t('expiringValue', { credits: formatCreditsValue(wallet.data.expiring_next.credits), date: formatDateTime(wallet.data.expiring_next.expires_at, ws.workspace?.timezone) }) : t('nothingExpiring')}
              </Fact>
            </dl>
            {wallet.data.auto_topup?.enabled ? <p className="text-xs text-muted-foreground">{t('autoTopupOn', { threshold: formatCreditsValue(wallet.data.auto_topup.threshold ?? 0) })}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
