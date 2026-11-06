'use client';

import { createCheckout, isApiError, useApi, useGetPricing } from '@portal/api-client';
import type { PricingResponse } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Field, RadioCard, RadioGroup, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch } from '@portal/ui';
import { CreditCard, Lock } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useServerCopy } from '@/src/i18n/server-copy';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { checkoutMarker } from '@/src/wizard/checkout-marker';
import { TOPUP_PERCENTS, defaultTopupPercent, packMinutes, topupThreshold, type TopupPercent } from '@/src/wizard/pack-minutes';
import { formatCredits, formatMoney } from '@/src/wizard/plan-gates';
import { useWorkspace } from '@/src/workspace/workspace-provider';
import { PRICING_STALE_MS } from '@/src/lib/pricing';
import { currentPathWithQuery } from '@/src/lib/query-string';
import { routes, withNext } from '@/src/routes';

type Pack = PricingResponse['packs'][number];

/**
 * W7 PackSelector (§5.2, §13.7). Packs, prices and caps come from `GET /pricing` — the
 * published pricing config — and nothing on this screen is a hard-coded number. "Pay"
 * asks the API for a Checkout session (`POST /wallet/checkout {pack_id, agent_id,
 * auto_topup}`), which creates the pending purchase, and the browser goes to Stripe's
 * hosted page. Whether it was paid is decided by the webhook, not by this page.
 *
 * D5 "Buy credits" uses the same selector without an agent: Stripe then returns to
 * `/app/wallet` instead of W7, and there is no activation to remember. `compact` lays the
 * packs out two across for a dialog.
 */
export function PackageSelector({ agentId, compact = false }: { agentId?: string; compact?: boolean }) {
  const t = useTranslations();
  const tp = useTranslations('wizard.w7.packs');
  const api = useApi();
  const ws = useWorkspace();
  const pricing = useGetPricing(api, ws.workspace?.country ? { region: ws.workspace.country } : undefined, { staleTime: PRICING_STALE_MS });
  const packs = React.useMemo(() => [...(pricing.data?.packs ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.price_cents - b.price_cents), [pricing.data]);
  const [packId, setPackId] = React.useState<string | null>(null);
  const [autoTopup, setAutoTopup] = React.useState<boolean | null>(null);
  // §8 W7 "threshold select (10%/20% of pack)" (Z-49): null until the policy says which to start on.
  const [topupPct, setTopupPct] = React.useState<TopupPercent | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [redirecting, setRedirecting] = React.useState(false);
  // ADR 0036: a first purchase over the §17 limit waits for staff; a purchase that puts
  // money at risk on a stored card asks an owner or admin for a second factor first.
  const [inReview, setInReview] = React.useState(false);
  const [needsMfa, setNeedsMfa] = React.useState(false);

  const canBuy = ws.workspace?.role === 'owner' || ws.workspace?.role === 'admin';
  const selected = packs.find((p) => p.id === packId) ?? null;
  const policy = pricing.data?.wallet_policy;
  const topupOn = autoTopup ?? policy?.auto_topup_default_on ?? false;
  // §5.4: the policy suggests a percentage of the pack (default 10); the API refuses a threshold below 10 credits.
  const pct = topupPct ?? defaultTopupPercent(policy?.auto_topup_threshold_pct);
  const threshold = selected && policy ? topupThreshold(selected.credits, pct) : null;

  // Preselect the pack the config badges (the "most popular" one), else the first.
  React.useEffect(() => {
    if (packId || packs.length === 0) return;
    setPackId((packs.find((p) => p.badge) ?? packs[0]!).id);
  }, [packs, packId]);

  async function pay() {
    if (!selected || redirecting || !canBuy) return;
    setError(null);
    setNeedsMfa(false);
    setRedirecting(true);
    try {
      const res = await createCheckout(api, {
        pack_id: selected.id,
        ...(agentId ? { agent_id: agentId } : {}),
        ...(threshold !== null ? { auto_topup: { enabled: topupOn, ...(topupOn ? { threshold } : {}) } } : {}),
      });
      if (res.status === 'in_review' || !res.checkout_url) {
        track('purchase_review_requested', { pack_id: selected.id });
        setInReview(true);
        setRedirecting(false);
        return;
      }
      if (agentId) checkoutMarker.set({ purchaseId: res.purchase_id, agentId, packId: selected.id, startedAt: Date.now() });
      track('pack_selected', { pack_id: selected.id, ...(agentId ? { agent_id: agentId } : {}), auto_topup: topupOn, auto_topup_pct: topupOn ? pct : null, from: agentId ? 'wizard' : 'wallet' });
      window.location.assign(res.checkout_url);
      // Stay in the redirecting state: the page is being replaced.
    } catch (e) {
      if (isApiError(e, 'MFA_REQUIRED')) setNeedsMfa(true);
      else setError(errorMessage(e, t));
      setRedirecting(false);
    }
  }

  if (pricing.isError) {
    return <ErrorState title={t('errors.loadFailed')} description={errorMessage(pricing.error, t)} action={<Button onClick={() => void pricing.refetch()}>{t('common.retry')}</Button>} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {!canBuy ? <Alert variant="warning" title={tp('roleTitle')}>{tp('roleBody')}</Alert> : null}

      {pricing.isPending ? (
        <div className={compact ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3 md:grid-cols-2'}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : packs.length === 0 ? (
        <Alert variant="warning">{tp('none')}</Alert>
      ) : (
        <RadioGroup value={packId ?? ''} onValueChange={setPackId} className={compact ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3 md:grid-cols-2'} aria-label={tp('label')} disabled={redirecting}>
          {packs.map((p) => (
            <RadioCard key={p.id} value={p.id} title={<PackTitle pack={p} />} description={<PackBody pack={p} rates={pricing.data?.rates ?? null} />} className="h-full" />
          ))}
        </RadioGroup>
      )}

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle>{tp('summaryTitle', { pack: selected.name })}</CardTitle>
            <CardDescription>
              {policy ? tp('summaryBody', { credits: formatCredits(selected.credits + selected.bonus_credits), months: policy.credit_expiry_months }) : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {threshold !== null ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
                <Field id="w7-topup" label={tp('topup')} description={tp('topupHint', { threshold: formatCredits(threshold), pack: selected.name })}>
                  <Switch id="w7-topup" checked={topupOn} onCheckedChange={setAutoTopup} disabled={redirecting} />
                </Field>
                {topupOn ? (
                  <Field id="w7-topup-pct" label={tp('topupWhen')} className="sm:w-72">
                    <Select value={String(pct)} onValueChange={(v) => setTopupPct(Number(v) as TopupPercent)} disabled={redirecting}>
                      <SelectTrigger id="w7-topup-pct">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TOPUP_PERCENTS.map((p) => (
                          <SelectItem key={p} value={String(p)}>
                            {tp('topupPct', { pct: p, credits: formatCredits(topupThreshold(selected.credits, p)) })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
              </div>
            ) : null}
            {error ? <Alert variant="danger">{error}</Alert> : null}
            {inReview ? <Alert variant="info" title={tp('reviewTitle')}>{tp('reviewBody')}</Alert> : null}
            {needsMfa ? (
              <Alert
                variant="warning"
                title={tp('mfaTitle')}
                actions={
                  <Button size="sm" asChild>
                    <Link href={withNext(routes.mfa, currentPathWithQuery())}>{tp('mfaAction')}</Link>
                  </Button>
                }
              >
                {tp('mfaBody')}
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={() => void pay()} disabled={!canBuy || redirecting || inReview} loading={redirecting}>
                {redirecting ? null : <CreditCard />} {redirecting ? tp('redirecting') : tp('pay', { price: formatMoney(selected.price_cents, selected.currency) })}
              </Button>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="size-3.5" aria-hidden /> {tp('secure')}
              </span>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function PackTitle({ pack }: { pack: Pack }) {
  const copy = useServerCopy();
  return (
    <span className="flex flex-wrap items-center gap-2">
      {pack.name}
      {pack.badge ? <Badge variant="primary">{copy.packText(pack.badge)}</Badge> : null}
    </span>
  );
}

function PackBody({ pack, rates }: { pack: Pack; rates: PricingResponse['rates'] | null }) {
  const tp = useTranslations('wizard.w7.packs');
  const copy = useServerCopy();
  // §8 W7 "≈150 min": whole minutes at the Standard rate, from the published config (Z-50 "Minutes per pack").
  const minutes = rates ? packMinutes(pack.credits + pack.bonus_credits, rates.standard_per_min) : null;
  const premiumMinutes = rates ? packMinutes(pack.credits + pack.bonus_credits, rates.premium_per_min) : null;
  return (
    <span className="mt-1 flex flex-col gap-1.5">
      <span className="text-xl font-semibold text-foreground">{formatMoney(pack.price_cents, pack.currency)}</span>
      <span>
        {tp('credits', { credits: formatCredits(pack.credits) })}
        {pack.bonus_credits ? ` · ${tp('bonus', { credits: formatCredits(pack.bonus_credits) })}` : ''}
      </span>
      {minutes !== null ? (
        <span className="text-foreground" data-testid="pack-minutes">
          {tp('minutes', { n: minutes })}
          {premiumMinutes !== null && premiumMinutes !== minutes ? ` · ${tp('minutesPremium', { n: premiumMinutes })}` : ''}
        </span>
      ) : null}
      <span>{tp('concurrency', { n: pack.concurrency_cap })}</span>
      <span>{pack.kb_allowance ? tp('knowledge', { n: pack.kb_allowance }) : tp('noKnowledge')}</span>
      {pack.description ? <span>{copy.packText(pack.description)}</span> : null}
    </span>
  );
}
