'use client';

import { createCheckout, useApi, useGetPricing } from '@portal/api-client';
import type { PricingResponse } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Field, RadioCard, RadioGroup, Skeleton, Switch } from '@portal/ui';
import { CreditCard, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useServerCopy } from '@/src/i18n/server-copy';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { checkoutMarker } from '@/src/wizard/checkout-marker';
import { formatCredits, formatMoney } from '@/src/wizard/plan-gates';
import { useWorkspace } from '@/src/workspace/workspace-provider';

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
  const pricing = useGetPricing(api, ws.workspace?.country ? { region: ws.workspace.country } : undefined, { staleTime: 60_000 });
  const packs = React.useMemo(() => [...(pricing.data?.packs ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.price_cents - b.price_cents), [pricing.data]);
  const [packId, setPackId] = React.useState<string | null>(null);
  const [autoTopup, setAutoTopup] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [redirecting, setRedirecting] = React.useState(false);

  const canBuy = ws.workspace?.role === 'owner' || ws.workspace?.role === 'admin';
  const selected = packs.find((p) => p.id === packId) ?? null;
  const policy = pricing.data?.wallet_policy;
  const topupOn = autoTopup ?? policy?.auto_topup_default_on ?? false;
  // §5.4: suggested at `auto_topup_threshold_pct` of the pack; the API refuses below 10.
  const threshold = selected && policy ? Math.max(10, Math.round((selected.credits * policy.auto_topup_threshold_pct) / 100)) : null;

  // Preselect the pack the config badges (the "most popular" one), else the first.
  React.useEffect(() => {
    if (packId || packs.length === 0) return;
    setPackId((packs.find((p) => p.badge) ?? packs[0]!).id);
  }, [packs, packId]);

  async function pay() {
    if (!selected || redirecting || !canBuy) return;
    setError(null);
    setRedirecting(true);
    try {
      const res = await createCheckout(api, {
        pack_id: selected.id,
        ...(agentId ? { agent_id: agentId } : {}),
        ...(threshold !== null ? { auto_topup: { enabled: topupOn, ...(topupOn ? { threshold } : {}) } } : {}),
      });
      if (agentId) checkoutMarker.set({ purchaseId: res.purchase_id, agentId, packId: selected.id, startedAt: Date.now() });
      track('pack_selected', { pack_id: selected.id, ...(agentId ? { agent_id: agentId } : {}), auto_topup: topupOn, from: agentId ? 'wizard' : 'wallet' });
      window.location.assign(res.checkout_url);
      // Stay in the redirecting state: the page is being replaced.
    } catch (e) {
      setError(errorMessage(e, t));
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
        <div className={compact ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3 md:grid-cols-2 xl:grid-cols-4'}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : packs.length === 0 ? (
        <Alert variant="warning">{tp('none')}</Alert>
      ) : (
        <RadioGroup value={packId ?? ''} onValueChange={setPackId} className={compact ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3 md:grid-cols-2 xl:grid-cols-4'} aria-label={tp('label')} disabled={redirecting}>
          {packs.map((p) => (
            <RadioCard key={p.id} value={p.id} title={<PackTitle pack={p} />} description={<PackBody pack={p} />} className="h-full" />
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
              <Field id="w7-topup" label={tp('topup')} description={tp('topupHint', { threshold: formatCredits(threshold), pack: selected.name })}>
                <Switch id="w7-topup" checked={topupOn} onCheckedChange={setAutoTopup} disabled={redirecting} />
              </Field>
            ) : null}
            {error ? <Alert variant="danger">{error}</Alert> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={() => void pay()} disabled={!canBuy || redirecting} loading={redirecting}>
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

function PackBody({ pack }: { pack: Pack }) {
  const tp = useTranslations('wizard.w7.packs');
  const copy = useServerCopy();
  return (
    <span className="mt-1 flex flex-col gap-1.5">
      <span className="text-xl font-semibold text-foreground">{formatMoney(pack.price_cents, pack.currency)}</span>
      <span>
        {tp('credits', { credits: formatCredits(pack.credits) })}
        {pack.bonus_credits ? ` · ${tp('bonus', { credits: formatCredits(pack.bonus_credits) })}` : ''}
      </span>
      <span>{tp('concurrency', { n: pack.concurrency_cap })}</span>
      <span>{pack.kb_allowance ? tp('knowledge', { n: pack.kb_allowance }) : tp('noKnowledge')}</span>
      {pack.description ? <span>{copy.packText(pack.description)}</span> : null}
    </span>
  );
}
