'use client';

import { isApiError, useApi, useGetPricing, useGetReadiness, useListCalls } from '@portal/api-client';
import type { CallSummary, Carrier } from '@portal/schemas';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, cn } from '@portal/ui';
import { Activity, BookOpen, ExternalLink, Network, PhoneForwarded, PhoneIncoming, Receipt, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { ContactSupportCard, MyTicketsCard } from '@/src/components/dashboard/support-tickets';
import { CarrierForwardingGuide } from '@/src/components/wizard/carrier-forwarding-guide';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { config } from '@/src/config';
import { formatDateTime, formatNumber, formatPhone, formatTime } from '@/src/lib/format';
import { callPath, routes } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D7 Help (spec p. 39): the forwarding, SIP and billing guides — each built from what
 * the API already serves (the carrier codes, the published pricing), so a guide cannot
 * disagree with the product — a "Contact support" form and "My tickets" (D13, built-in
 * tickets), "Report a call", and the service status
 * from the API's own readiness probe. There is no chat vendor or status-page vendor yet
 * (§20 item 10): support is email, and an external status page is linked only when the
 * build sets `NEXT_PUBLIC_STATUS_PAGE_URL`.
 */
export default function HelpPage() {
  const t = useTranslations('dashboard.help');
  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <BookOpen className="size-5 text-primary" aria-hidden /> {t('guidesTitle')}
          </h2>
          <ForwardingGuideCard />
          <SipGuideCard />
          <BillingGuideCard />
          <MyTicketsCard />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <StatusCard />
          <ContactSupportCard />
          <ReportCallCard />
        </div>
      </div>
    </>
  );
}

function ForwardingGuideCard() {
  const t = useTranslations('dashboard.help.guides.forwarding');
  const [carrier, setCarrier] = React.useState<Carrier>('other');
  return (
    <Card id="forwarding">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PhoneForwarded className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent>
        <CarrierForwardingGuide carrier={carrier} onCarrierChange={setCarrier} />
      </CardContent>
    </Card>
  );
}

function SipGuideCard() {
  const t = useTranslations('dashboard.help.guides.sip');
  const { canAdmin } = useRole();
  const steps = t.raw('steps') as string[];
  return (
    <Card id="sip">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {canAdmin ? (
          <div>
            <Button variant="outline" size="sm" asChild>
              <Link href={routes.app.numbers}>{t('cta')}</Link>
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The billing FAQ, every number from `GET /pricing` — the published config, never a constant here. */
function BillingGuideCard() {
  const t = useTranslations('dashboard.help');
  const api = useApi();
  const pricing = useGetPricing(api, undefined, { staleTime: 5 * 60_000 });
  const p = pricing.data;
  return (
    <Card id="billing">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="size-4 text-primary" aria-hidden /> {t('guides.billing.title')}
        </CardTitle>
        <CardDescription>{t('guides.billing.body')}</CardDescription>
      </CardHeader>
      <CardContent>
        {pricing.isPending ? (
          <Skeleton className="h-24 w-full" aria-busy />
        ) : !p ? (
          <p className="text-sm text-muted-foreground">{t('faqUnavailable')}</p>
        ) : (
          <ul className="list-disc space-y-1.5 pl-5 text-sm">
            <li>{t('faq.rate', { standard: formatNumber(p.rates.standard_per_min), premium: formatNumber(p.rates.premium_per_min) })}</li>
            <li>{t('faq.missed')}</li>
            <li>{t('faq.expiry', { months: p.wallet_policy.credit_expiry_months })}</li>
            <li>{t('faq.rental', { credits: formatNumber(p.recurring.number_rental_credits) })}</li>
            <li>{t('faq.grace', { grace: formatNumber(p.wallet_policy.grace_overdraft_credits) })}</li>
            <li>{t('faq.refund')}</li>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * `GET /health/ready`: the database and cache behind answering calls, and the worker
 * behind numbers, emails and agent writing. It answers 503 when degraded, which the
 * client surfaces as an error — that is a status, not a failure to show one.
 */
function StatusCard() {
  const t = useTranslations('dashboard.help.status');
  const th = useTranslations('dashboard.help');
  const api = useApi();
  // No retry: a 503 is the answer this card exists to show, and the client's default
  // backoff would keep it on a skeleton for seconds while it re-asks.
  const ready = useGetReadiness(api, { staleTime: 30_000, refetchInterval: 60_000, retry: false });
  const degradedByStatus = ready.isError && isApiError(ready.error) && ready.error.status === 503;
  const data = ready.data;
  // A 503 carries no parsed body, so it says "degraded" without saying which part.
  const callsUp = data ? data.checks.postgres.ok && data.checks.redis.ok : null;
  const backgroundUp = data ? data.checks.worker.ok : null;
  const overall = ready.isPending ? null : data ? (data.status === 'ready' ? 'ok' : 'degraded') : degradedByStatus ? 'degraded' : 'unknown';

  return (
    <Card id="status">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4 text-primary" aria-hidden /> {th('statusTitle')}
        </CardTitle>
        <Button variant="ghost" size="icon-sm" onClick={() => void ready.refetch()} disabled={ready.isFetching} aria-label={t('refresh')}>
          <RefreshCw className={cn(ready.isFetching && 'animate-spin')} />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {overall === null ? (
          <Skeleton className="h-16 w-full" aria-busy />
        ) : (
          <>
            <p className="flex items-center gap-2 text-sm font-medium" role="status">
              <span className={cn('size-2.5 rounded-full', overall === 'ok' ? 'bg-success' : overall === 'degraded' ? 'bg-warning' : 'bg-muted-foreground')} aria-hidden />
              {t(overall)}
            </p>
            {callsUp !== null || backgroundUp !== null ? (
              <ul className="flex flex-col gap-2 text-sm">
                <StatusRow label={t('calls')} up={callsUp} />
                <StatusRow label={t('background')} up={backgroundUp} />
              </ul>
            ) : null}
            {data ? <p className="text-xs text-muted-foreground">{t('checked', { time: formatTime(data.time) })}</p> : null}
          </>
        )}
        {config.support.statusPageUrl ? (
          <Button variant="outline" size="sm" asChild>
            <a href={config.support.statusPageUrl} target="_blank" rel="noopener noreferrer">
              {t('page')} <ExternalLink />
            </a>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusRow({ label, up }: { label: string; up: boolean | null }) {
  const t = useTranslations('dashboard.help.status');
  return (
    <li className="flex items-start justify-between gap-3">
      <span className="min-w-0">{label}</span>
      {up === null ? <span className="text-muted-foreground">–</span> : <Badge variant={up ? 'success' : 'warning'}>{up ? t('up') : t('down')}</Badge>}
    </li>
  );
}

/** "Report a call" (spec p. 39): pick one of the latest calls; the email carries its id and time so support can find it. */
function ReportCallCard() {
  const t = useTranslations('dashboard.help');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const calls = useListCalls(api, { limit: 5, sort: 'started_at', order: 'desc' }, { staleTime: 30_000 });
  const tz = ws.workspace?.timezone;

  const mailto = (c: CallSummary) => {
    const when = formatDateTime(c.started_at ?? c.created_at, tz);
    const caller = c.channel === 'web' ? tc('dashboard.calls.browserTest') : c.from_number ? formatPhone(c.from_number) : tc('dashboard.calls.unknownCaller');
    const body = `${t('reportLine', { id: c.id, when, caller })}\n\n${t('reportPrompt')}\n`;
    return `mailto:${config.support.email}?subject=${encodeURIComponent(t('reportSubject', { id: c.id }))}&body=${encodeURIComponent(body)}`;
  };

  return (
    <Card id="report">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PhoneIncoming className="size-4 text-primary" aria-hidden /> {t('reportTitle')}
        </CardTitle>
        <CardDescription>{t('reportBody')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {calls.isPending ? (
          <Skeleton className="h-24 w-full" aria-busy />
        ) : calls.isError || !calls.data || calls.data.items.length === 0 ? (
          <EmptyState className="py-6" icon={<PhoneIncoming />} title={t('reportEmpty')} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {calls.data.items.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <Link href={callPath(c.id)} className="flex min-w-0 flex-col text-sm hover:underline">
                  <span className="truncate font-medium tabular-nums">{c.channel === 'web' ? tc('dashboard.calls.browserTest') : c.from_number ? formatPhone(c.from_number) : tc('dashboard.calls.unknownCaller')}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(c.started_at ?? c.created_at, tz)}</span>
                </Link>
                <Button variant="outline" size="sm" asChild>
                  <a href={mailto(c)} onClick={() => track('call_reported')}>
                    {t('report')}
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="link" size="sm" className="self-start" asChild>
          <Link href={routes.app.calls}>{t('allCalls')}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
