'use client';

import { useApi, useGetWallet } from '@portal/api-client';
import { Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn } from '@portal/ui';
import { Coins } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/** §7.2 "balance pill". Colour follows the balance: normal, warning under 20 %, danger at 0. */
export function BalancePill({ className }: { className?: string }) {
  const t = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const wallet = useGetWallet(api, { enabled: Boolean(ws.active), staleTime: 15_000 });

  if (wallet.isPending) return <Skeleton className={cn('h-8 w-24 rounded-full', className)} />;
  if (wallet.isError || !wallet.data) {
    return <span className={cn('text-xs text-muted-foreground', className)}>{t('shell.balanceUnavailable')}</span>;
  }
  const balance = Number(wallet.data.balance ?? 0);
  const tone = balance <= 0 ? 'danger' : balance < 20 ? 'warning' : 'ok';
  const formatted = new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(balance);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={routes.app.wallet}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors hover:bg-muted',
            tone === 'ok' && 'border-border bg-card text-foreground',
            tone === 'warning' && 'border-warning/50 bg-warning/15 text-warning-foreground dark:text-warning',
            tone === 'danger' && 'border-danger/40 bg-danger/10 text-danger',
            className,
          )}
        >
          <Coins className="size-3.5" aria-hidden />
          {t('shell.balance', { credits: formatted })}
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        {t('shell.balanceTitle')} · {t('shell.planTier', { tier: t(`shell.tier.${wallet.data.plan_tier}` as never) })}
      </TooltipContent>
    </Tooltip>
  );
}
