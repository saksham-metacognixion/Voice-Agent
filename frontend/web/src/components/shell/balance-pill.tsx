'use client';

import { useApi, useGetWallet } from '@portal/api-client';
import { Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn } from '@portal/ui';
import { Coins } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { balanceTone } from '@/src/dashboard/wallet-view';
import { formatCreditsValue } from '@/src/lib/format';
import { routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * §7.2 "balance pill": amber under 20 % of the last pack, red at or below 0.
 *
 * Reads `getWallet`, which the shell's SSE stream (`DashboardLiveProvider`) writes on
 * every `wallet` frame — so the number moves the moment a call is billed or a pack is
 * credited, on whatever page is open, without a refetch or a second connection.
 * `compact` drops the word "credits" for the phone header.
 */
export function BalancePill({ className, compact = false }: { className?: string; compact?: boolean }) {
  const t = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const wallet = useGetWallet(api, { enabled: Boolean(ws.active), staleTime: 15_000 });

  if (wallet.isPending) return <Skeleton className={cn('h-8 w-20 rounded-full', className)} />;
  if (wallet.isError || !wallet.data) {
    return <span className={cn('text-xs text-muted-foreground', className)}>{compact ? '–' : t('shell.balanceUnavailable')}</span>;
  }
  const balance = Number(wallet.data.balance ?? 0);
  const tone = balanceTone(balance, wallet.data.last_pack_credits);
  const formatted = formatCreditsValue(balance);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={routes.app.wallet}
          aria-label={t('shell.balanceAria', { credits: formatted })}
          data-testid="balance-pill"
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium tabular-nums transition-colors hover:bg-muted',
            tone === 'ok' && 'border-border bg-card text-foreground',
            tone === 'warning' && 'border-warning/50 bg-warning/15 text-warning-emphasis',
            tone === 'danger' && 'border-danger/40 bg-danger/10 text-danger',
            className,
          )}
        >
          <Coins className="size-3.5" aria-hidden />
          {compact ? formatted : t('shell.balance', { credits: formatted })}
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        {t('shell.balanceTitle')} · {t('shell.planTier', { tier: t(`shell.tier.${wallet.data.plan_tier}` as never) })}
      </TooltipContent>
    </Tooltip>
  );
}
