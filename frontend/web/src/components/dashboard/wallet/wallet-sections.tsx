'use client';

import {
  createPortalSession, isApiError, updateAutoTopup, useApi, useGetFlags, useGetPricing, useGetStats, useGetWallet, useListCreditLots, useListInvoices, useListLedger,
} from '@portal/api-client';
import type { InvoiceResponse, LedgerEntryResponse, LedgerReason, WalletResponse } from '@portal/schemas';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, EmptyState, Field, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, cn, toast,
} from '@portal/ui';
import { BarChart3, CalendarClock, Coins, CreditCard, ExternalLink, FileText, Receipt } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { ActivityBars } from '@/src/components/dashboard/activity-chart';
import { DataTable, type DataColumn } from '@/src/components/dashboard/data-table';
import { LiveDot } from '@/src/components/dashboard/live-dot';
import { Pager } from '@/src/components/dashboard/pager';
import { LoadError } from '@/src/components/dashboard/query-states';
import { PackageSelector } from '@/src/components/wizard/package-selector';
import { activitySeries } from '@/src/dashboard/activity-series';
import { useDashboardLive } from '@/src/dashboard/use-dashboard-live';
import { LEDGER_REASONS, autoTopupBody, balanceTone, expiringSoon, ledgerLink, usageSummary } from '@/src/dashboard/wallet-view';
import { errorMessage } from '@/src/lib/errors';
import { formatCreditsValue, formatDate, formatDateTime, formatNumber } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { formatMoney } from '@/src/wizard/plan-gates';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

// ------------------------------------------------------------------ Balance

/**
 * D5 balance card (Figure 12): the balance — written by the shell's SSE stream on every
 * `wallet` frame, so it moves while the page is open — the plan's caps, what expires
 * next, and "Buy credits" for an owner or admin.
 */
export function BalanceCard() {
  const t = useTranslations('dashboard.wallet.balance');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const { canAdmin } = useRole();
  const stream = useDashboardLive();
  const wallet = useGetWallet(api, { staleTime: 15_000 });
  const pricing = useGetPricing(api, undefined, { staleTime: 5 * 60_000 });
  const flags = useGetFlags(api, { staleTime: 60_000 });
  const [buying, setBuying] = React.useState(false);
  const purchasesPaused = flags.data?.kill_switches.pause_purchases === true;
  const standardRate = pricing.data?.rates.standard_per_min ?? null;

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <Coins className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <LiveDot state={stream} />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {wallet.isPending ? (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : wallet.isError ? (
          <LoadError compact error={wallet.error} onRetry={() => void wallet.refetch()} />
        ) : (
          <>
            <div>
              <p
                data-testid="wallet-balance"
                aria-live="polite"
                className={cn('text-4xl font-semibold tabular-nums tracking-tight', balanceTone(wallet.data.balance, wallet.data.last_pack_credits) === 'danger' && 'text-danger')}
              >
                {formatCreditsValue(wallet.data.balance)} <span className="text-base font-normal text-muted-foreground">{t('credits')}</span>
              </p>
              {standardRate && wallet.data.balance > 0 ? <p className="mt-1 text-xs text-muted-foreground">{t('minutes', { minutes: formatNumber(wallet.data.balance / standardRate, 0) })}</p> : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {t('plan', { tier: tc(`shell.tier.${wallet.data.plan_tier}`), concurrency: wallet.data.concurrency_cap, kb: wallet.data.kb_allowance })}
            </p>
            <p className="text-sm">
              {wallet.data.expiring_next ? t('expiring', { credits: formatCreditsValue(wallet.data.expiring_next.credits), date: formatDate(wallet.data.expiring_next.expires_at, ws.workspace?.timezone) }) : t('nothingExpiring')}
            </p>
            {purchasesPaused ? <Alert variant="warning">{tc('dashboard.wallet.paused.banner')}</Alert> : null}
            {canAdmin ? (
              <div className="mt-auto">
                <Button onClick={() => setBuying(true)} disabled={purchasesPaused}>
                  <CreditCard /> {t('buy')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
      {canAdmin ? <BuyCreditsDialog open={buying} onOpenChange={setBuying} /> : null}
    </Card>
  );
}

/** "Buy credits" (spec p. 38): the W7 pack cards in a modal → Stripe Checkout, back to `/app/wallet`. */
function BuyCreditsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('dashboard.wallet.buy');
  const tc = useTranslations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" closeLabel={tc('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('body')}</DialogDescription>
        </DialogHeader>
        {open ? <PackageSelector compact /> : null}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Auto top-up

/**
 * §5.4 auto top-up (spec p. 38): on/off, pack, threshold (≥ 10), and the card from
 * Stripe. There is no card until a Checkout saved one, so "Add a card" opens the Stripe
 * Customer Portal; the API answers `NO_PAYMENT_METHOD` to an enable without one.
 */
export function AutoTopupCard({ wallet }: { wallet: WalletResponse }) {
  const t = useTranslations('dashboard.wallet.autoTopup');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const pricing = useGetPricing(api, ws.workspace?.country ? { region: ws.workspace.country } : undefined, { staleTime: 5 * 60_000 });
  const packs = React.useMemo(() => [...(pricing.data?.packs ?? [])].sort((a, b) => a.sort_order - b.sort_order), [pricing.data]);
  const current = wallet.auto_topup;
  const [enabled, setEnabled] = React.useState(current?.enabled ?? false);
  const [packId, setPackId] = React.useState<string | null>(current?.pack_id ?? null);
  const [threshold, setThreshold] = React.useState(current?.threshold !== null && current?.threshold !== undefined ? String(current.threshold) : '');
  const [fieldError, setFieldError] = React.useState<'pack' | 'threshold' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setEnabled(current?.enabled ?? false);
    setPackId(current?.pack_id ?? null);
    setThreshold(current?.threshold !== null && current?.threshold !== undefined ? String(current.threshold) : '');
  }, [current?.enabled, current?.pack_id, current?.threshold]);

  // Suggest a pack and §5.4's threshold the first time it is switched on.
  React.useEffect(() => {
    if (!enabled || packId || packs.length === 0) return;
    const pack = packs.find((p) => p.credits === wallet.last_pack_credits) ?? packs.find((p) => p.badge) ?? packs[0]!;
    setPackId(pack.id);
    if (!threshold && pricing.data) setThreshold(String(Math.max(10, Math.round((pack.credits * pricing.data.wallet_policy.auto_topup_threshold_pct) / 100))));
  }, [enabled, packId, packs, threshold, pricing.data, wallet.last_pack_credits]);

  const dirty = enabled !== (current?.enabled ?? false) || (enabled && (packId !== (current?.pack_id ?? null) || threshold !== String(current?.threshold ?? '')));
  const packName = packs.find((p) => p.id === current?.pack_id)?.name ?? current?.pack_id ?? '';

  async function save() {
    if (busy) return;
    const result = autoTopupBody({ enabled, packId, threshold });
    if (!result.ok) {
      setFieldError(result.field);
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      const saved = await updateAutoTopup(api, result.body);
      queryClient.setQueriesData<WalletResponse>({ queryKey: ['getWallet'] }, (old) => (old ? { ...old, auto_topup: saved } : old));
      track('auto_topup_saved', { enabled: saved.enabled });
      toast.success(t('saved'));
    } catch (e) {
      setError(errorMessage(e, tc));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t('title')}</CardTitle>
          <Badge variant={current?.enabled ? 'success' : 'outline'}>{current?.enabled ? t('on') : t('off')}</Badge>
        </div>
        <CardDescription>{current?.enabled ? t('summaryOn', { pack: packName, threshold: formatCreditsValue(current.threshold ?? 0) }) : t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <Field id="topup-enabled" label={t('enabled')}>
          <Switch id="topup-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
        </Field>
        {enabled ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="topup-pack" label={t('pack')} error={fieldError === 'pack' ? t('packError') : undefined}>
              <Select value={packId ?? ''} onValueChange={setPackId} disabled={busy || packs.length === 0}>
                <SelectTrigger id="topup-pack">
                  <SelectValue placeholder={t('packPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {packs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {formatMoney(p.price_cents, p.currency)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="topup-threshold" label={t('threshold')} description={t('thresholdHint')} error={fieldError === 'threshold' ? t('thresholdError') : undefined}>
              <Input id="topup-threshold" type="number" inputMode="numeric" min={10} step={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={busy} />
            </Field>
          </div>
        ) : null}
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t('card')}</span>
          {current?.card_last4 ? <span className="tabular-nums">{t('cardValue', { last4: current.card_last4 })}</span> : <span className="text-muted-foreground">{t('noCard')}</span>}
        </div>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <div className="mt-auto flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          {!current?.card_last4 ? <PortalButton label={t('addCard')} variant="outline" /> : null}
          <Button onClick={() => void save()} loading={busy} disabled={busy || !dirty}>
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Opens the Stripe Customer Portal (`POST /wallet/portal-session`); the API checks the return path. */
function PortalButton({ label, variant = 'primary' }: { label: string; variant?: 'primary' | 'outline' }) {
  const t = useTranslations('dashboard.wallet.payment');
  const tc = useTranslations();
  const api = useApi();
  const [busy, setBusy] = React.useState(false);
  async function open() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await createPortalSession(api, { return_path: '/app/wallet/' });
      track('payment_portal_opened');
      window.location.assign(res.url);
      // Stay busy: the page is being replaced.
    } catch (e) {
      toast.error(isApiError(e) && e.code === 'NO_PAYMENT_METHOD' ? t('needPurchase') : errorMessage(e, tc));
      setBusy(false);
    }
  }
  return (
    <Button variant={variant} onClick={() => void open()} loading={busy} disabled={busy}>
      {busy ? t('opening') : label} {busy ? null : <ExternalLink />}
    </Button>
  );
}

// ------------------------------------------------------------------ Payment methods

/** Spec p. 38: cards, billing address and tax ID live in the Stripe Customer Portal; the card on file is the one auto top-up uses. */
export function PaymentMethodsCard({ wallet }: { wallet: WalletResponse }) {
  const t = useTranslations('dashboard.wallet.payment');
  const last4 = wallet.auto_topup?.card_last4 ?? null;
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t('card')}</span>
          {last4 ? <span className="tabular-nums">•••• {last4}</span> : <span className="text-muted-foreground">{t('none')}</span>}
        </div>
        <div className="mt-auto">
          <PortalButton label={t('manage')} />
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ Expiring soon

/** Lots expiring within 60 days (spec p. 38, `GET /wallet/lots`). */
export function ExpiringCard() {
  const t = useTranslations('dashboard.wallet.expiring');
  const api = useApi();
  const ws = useWorkspace();
  const lots = useListCreditLots(api, { staleTime: 60_000 });
  const pricing = useGetPricing(api, undefined, { staleTime: 5 * 60_000 });
  const months = pricing.data?.wallet_policy.credit_expiry_months;
  const soon = React.useMemo(() => (lots.data ? expiringSoon(lots.data, new Date()) : []), [lots.data]);
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{months ? t('body', { months }) : t('bodyNoPolicy')}</CardDescription>
      </CardHeader>
      <CardContent>
        {lots.isPending ? (
          <Skeleton className="h-10 w-full" aria-busy />
        ) : lots.isError ? (
          <LoadError compact error={lots.error} onRetry={() => void lots.refetch()} />
        ) : soon.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {soon.map((lot) => (
              <li key={lot.id} className="py-2 text-sm tabular-nums first:pt-0 last:pb-0">
                {t('row', { credits: formatCreditsValue(lot.credits_remaining), date: formatDate(lot.expires_at, ws.workspace?.timezone) })}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ Usage chart

/** "Usage (30 days) — credits/day" (Figure 12): the D1 chart's bars on `GET /stats?range=30d`, credits only. */
export function UsageCard() {
  const t = useTranslations('dashboard.wallet.usage');
  const api = useApi();
  const stats = useGetStats(api, { range: '30d' }, { staleTime: 60_000 });
  const series = React.useMemo(() => (stats.data ? activitySeries(stats.data) : []), [stats.data]);
  const summary = usageSummary(series);
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4 text-primary" aria-hidden /> {t('title')}
          </CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </div>
        {stats.data && summary.total > 0 ? <p className="text-sm font-medium tabular-nums">{t('summary', { total: formatCreditsValue(summary.total), perDay: formatNumber(summary.perDay, 1) })}</p> : null}
      </CardHeader>
      <CardContent className="min-w-0">
        {stats.isPending ? (
          <Skeleton className="h-48 w-full" aria-busy />
        ) : stats.isError ? (
          <LoadError compact error={stats.error} onRetry={() => void stats.refetch()} />
        ) : summary.total === 0 ? (
          <EmptyState className="py-10" icon={<BarChart3 />} title={t('empty')} description={t('emptyHint')} />
        ) : (
          <ActivityBars series={series} metric="credits" label={t('subtitle')} />
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ Ledger

/** The append-only ledger (spec p. 38): paginated, filtered by reason, each call row a link to D2. */
export function LedgerCard() {
  const t = useTranslations('dashboard.wallet.ledger');
  const api = useApi();
  const ws = useWorkspace();
  const [reason, setReason] = React.useState<LedgerReason | 'all'>('all');
  const pager = useCursorPager();
  const ledger = useListLedger(api, { limit: 25, ...(reason !== 'all' ? { reason } : {}), ...(pager.cursor ? { cursor: pager.cursor } : {}) }, { staleTime: 15_000 });

  const columns: Array<DataColumn<LedgerEntryResponse>> = [
    { key: 'date', header: t('columns.date'), card: 'subtitle', cell: (e) => <span className="whitespace-nowrap tabular-nums">{formatDateTime(e.created_at, ws.workspace?.timezone)}</span> },
    { key: 'type', header: t('columns.type'), card: 'title', cell: (e) => t(`reason.${e.reason}`) },
    {
      key: 'description',
      header: t('columns.description'),
      cell: (e) => {
        const href = ledgerLink(e);
        return href ? (
          <Link href={href} className="text-primary underline-offset-4 hover:underline">
            {t('viewCall')}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t(`describe.${e.reason}`)}</span>
        );
      },
    },
    {
      key: 'amount',
      header: t('columns.amount'),
      align: 'right',
      card: 'badge',
      cell: (e) => <span className={cn('font-medium tabular-nums', e.delta > 0 ? 'text-success-emphasis' : 'text-foreground')}>{`${e.delta > 0 ? '+' : ''}${formatCreditsValue(e.delta)}`}</span>,
    },
    { key: 'balance', header: t('columns.balance'), align: 'right', cell: (e) => <span className="tabular-nums">{formatCreditsValue(e.balance_after)}</span> },
  ];

  const page = ledger.data;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="size-4 text-primary" aria-hidden /> {t('title')}
          </CardTitle>
          <CardDescription>{t('body')}</CardDescription>
        </div>
        <div className="w-full sm:w-48">
          <Select
            value={reason}
            onValueChange={(v) => {
              setReason(v as LedgerReason | 'all');
              pager.reset();
            }}
          >
            <SelectTrigger aria-label={t('filter')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('all')}</SelectItem>
              {LEDGER_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(`reason.${r}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {ledger.isPending ? (
          <Skeleton className="h-40 w-full" aria-busy />
        ) : ledger.isError ? (
          <LoadError compact error={ledger.error} onRetry={() => void ledger.refetch()} />
        ) : !page || page.items.length === 0 ? (
          <EmptyState className="py-8" icon={<Receipt />} title={reason === 'all' ? t('empty') : t('emptyFiltered')} />
        ) : (
          <>
            <DataTable label={t('label')} rows={page.items} columns={columns} rowKey={(e) => e.id} />
            <Pager page={pager.page} hasPrevious={pager.hasPrevious} hasNext={Boolean(page.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(page.next_cursor)} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ Invoices

/** `GET /wallet/invoices`: the Stripe-hosted page and PDF for every invoice (spec p. 38). */
export function InvoicesCard() {
  const t = useTranslations('dashboard.wallet.invoices');
  const api = useApi();
  const ws = useWorkspace();
  const pager = useCursorPager();
  const invoices = useListInvoices(api, { limit: 10, ...(pager.cursor ? { cursor: pager.cursor } : {}) }, { staleTime: 60_000 });

  const columns: Array<DataColumn<InvoiceResponse>> = [
    { key: 'number', header: t('columns.number'), card: 'title', cell: (i) => <span className="font-medium">{i.number ?? t('noNumber')}</span> },
    { key: 'date', header: t('columns.date'), card: 'subtitle', cell: (i) => formatDate(i.finalized_at ?? i.created_at, ws.workspace?.timezone) },
    { key: 'amount', header: t('columns.amount'), align: 'right', cell: (i) => <span className="tabular-nums">{formatMoney(i.amount_cents, i.currency)}</span> },
    {
      key: 'status',
      header: t('columns.status'),
      card: 'badge',
      cell: (i) => <Badge variant={i.status === 'paid' ? 'success' : i.status === 'payment_failed' || i.status === 'uncollectible' ? 'danger' : i.status === 'open' ? 'warning' : 'outline'}>{t(`status.${i.status}`)}</Badge>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      card: 'actions',
      align: 'right',
      cell: (i) => (
        <div className="flex w-full justify-end gap-2">
          {i.hosted_url ? (
            <Button variant="outline" size="sm" className="flex-1 sm:flex-none" asChild>
              <a href={i.hosted_url} target="_blank" rel="noopener noreferrer">
                {t('view')} <ExternalLink />
              </a>
            </Button>
          ) : null}
          {i.pdf_url ? (
            <Button variant="ghost" size="sm" className="flex-1 sm:flex-none" asChild>
              <a href={i.pdf_url} target="_blank" rel="noopener noreferrer">
                <FileText /> {t('pdf')}
              </a>
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const page = invoices.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {invoices.isPending ? (
          <Skeleton className="h-24 w-full" aria-busy />
        ) : invoices.isError ? (
          <LoadError compact error={invoices.error} onRetry={() => void invoices.refetch()} />
        ) : !page || page.items.length === 0 ? (
          <EmptyState className="py-8" icon={<FileText />} title={t('empty')} />
        ) : (
          <>
            <DataTable label={t('label')} rows={page.items} columns={columns} rowKey={(i) => i.id} />
            <Pager page={pager.page} hasPrevious={pager.hasPrevious} hasNext={Boolean(page.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(page.next_cursor)} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
