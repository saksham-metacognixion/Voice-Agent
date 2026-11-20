'use client';

import { useApi, useGetWallet } from '@portal/api-client';
import { Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn } from '@portal/ui';
import { Coins } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { canTopUp, creditsOutlook } from '@/src/dashboard/home-view';
import { balanceTone } from '@/src/dashboard/wallet-view';
import { formatCreditsValue, formatNumber } from '@/src/lib/format';
import { routes } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';
import { usePricing } from '@/src/lib/use-pricing';

/**
 * §7.2 "balance pill": credits, ≈ minutes of a Standard agent at the published rate,
 * amber under 20 % of the last pack, red at or below 0 — where it reads "Agent paused —
 * top up" for an owner or admin, who can, and "out of credits" for a role that cannot.
 * The tooltip carries the plan and, for owner/admin, the Top up link; the pill itself
 * opens the wallet for everyone (a viewer may look).
 *
 * Reads `getWallet`, which the shell's SSE stream (`DashboardLiveProvider`) writes on
 * every `wallet` frame — so the number moves the moment a call is billed or a pack is
 * credited, on whatever page is open, without a refetch or a second connection.
 * `compact` drops the words for the phone header.
 */
export function BalancePill({ className, compact = false }: { className?: string; compact?: boolean }) {
  const t = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const { role } = useRole();
  const wallet = useGetWallet(api, { enabled: Boolean(ws.active), staleTime: 15_000 });
  const pricing = usePricing({}, { enabled: Boolean(ws.active) });

  if (wallet.isPending) return <Skeleton className={cn('h-8 w-20 rounded-full', className)} data-testid="balance-pill-loading" />;
  if (wallet.isError || !wallet.data) {
    return <span className={cn('text-xs text-muted-foreground', className)} data-testid="balance-pill-unavailable">{compact ? '–' : t('shell.balanceUnavailable')}</span>;
  }
  const balance = Number(wallet.data.balance ?? 0);
  const tone = balanceTone(balance, wallet.data.last_pack_credits);
  const formatted = formatCreditsValue(balance);
  const rate = pricing.data?.rates.standard_per_min;
  const minutes = rate ? creditsOutlook({ balance, standardRatePerMin: rate, burn: 0 }).minutes : null;
  const topUp = canTopUp(role);
  const out = tone === 'danger';

  // `compact` first: the phone header has room for the number only, and the red tone says the rest.
  const label = compact
    ? formatted
    : out
      ? topUp ? t('shell.balanceOutTopUp') : t('shell.balanceOut')
      : minutes !== null
        ? t('shell.balanceWithMinutes', { credits: formatted, minutes: formatNumber(minutes, 0) })
        : t('shell.balance', { credits: formatted });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={routes.app.wallet}
          aria-label={t('shell.balanceAria', { credits: formatted })}
          data-testid="balance-pill"
          data-tone={tone}
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium tabular-nums transition-colors hover:bg-muted',
            tone === 'ok' && 'border-border bg-card text-foreground',
            tone === 'warning' && 'border-warning/50 bg-warning/15 text-warning-emphasis',
            tone === 'danger' && 'border-danger/40 bg-danger/10 text-danger',
            className,
          )}
        >
          <Coins className="size-3.5" aria-hidden />
          {label}
        </Link>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        <span>{t('shell.balance', { credits: formatted })}{minutes !== null ? ` · ${t('shell.approxMinutes', { minutes: formatNumber(minutes, 0) })}` : ''}</span>
        <span>{t('shell.planTier', { tier: t(`shell.tier.${wallet.data.plan_tier}` as never) })}</span>
        {topUp ? <span className="font-medium">{t('shell.topUpHint')}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
