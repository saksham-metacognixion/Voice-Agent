'use client';

import { updateNumber, useApi, useGetAgentActivation, useGetNumber } from '@portal/api-client';
import type { AgentDetail, PhoneNumberResponse } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, PageLoader, toast } from '@portal/ui';
import { ArrowRight, Copy, PartyPopper, Phone, PhoneCall } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { OnboardingAgentLoader } from '@/src/components/wizard/agent-loader';
import { CarrierForwardingGuide } from '@/src/components/wizard/carrier-forwarding-guide';
import { CopyButton } from '@/src/components/wizard/copy-button';
import { NextStepsChecklist } from '@/src/components/wizard/next-steps-checklist';
import { SipSetupGuide } from '@/src/components/wizard/sip-setup-guide';
import { areaCodeSubstitute } from '@/src/dashboard/numbers-view';
import { LiveGuard } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { formatPhone } from '@/src/lib/format';
import { routes } from '@/src/routes';

/**
 * `/onboarding/live` — W7b, the end of the 15-minute promise. Guarded on
 * `onboarding_completed_at` (written by the activation job's `mark_live`), and every fact
 * on it — the number, the forwarding state, the SIP details, the next steps — is read
 * back from the API, so a refresh shows the same screen and never restarts anything.
 * The number can be copied and (on a phone) called; Option B gets the carrier guide and
 * "I've set up forwarding"; Option C the trunk instructions; everyone the next steps.
 */
export default function LivePage() {
  return (
    <LiveGuard>
      <OnboardingAgentLoader>{(agent) => <LiveInner agent={agent} />}</OnboardingAgentLoader>
    </LiveGuard>
  );
}

function LiveInner({ agent }: { agent: AgentDetail }) {
  const t = useTranslations();
  const tl = useTranslations('wizard.live');
  const api = useApi();
  const activation = useGetAgentActivation(api, { id: agent.id }, { staleTime: 30_000 });
  const numberId = activation.data?.number_id ?? null;
  const number = useGetNumber(api, { id: numberId ?? '' }, { enabled: Boolean(numberId), staleTime: 30_000 });

  React.useEffect(() => {
    track('onboarding_live_viewed', { agent_id: agent.id });
  }, [agent.id]);

  if (activation.isPending) return <PageLoader label={t('common.loading')} />;
  const e164 = number.data?.e164 ?? activation.data?.e164 ?? null;
  const substitute = number.data ? areaCodeSubstitute(number.data) : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success [&_svg]:size-7">
          <PartyPopper aria-hidden />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{tl('title', { name: agent.name })}</h1>
        <p className="max-w-xl text-sm text-muted-foreground sm:text-base">{tl('subtitle')}</p>
      </div>

      {activation.isError ? (
        <ErrorState title={t('errors.loadFailed')} description={errorMessage(activation.error, t)} action={<Button onClick={() => void activation.refetch()}>{t('common.retry')}</Button>} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Phone className="size-4" aria-hidden /> {tl('numberTitle')}
            </CardTitle>
            <CardDescription>{e164 ? tl('numberBody') : tl('numberPending')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {e164 ? (
              <div className="flex flex-col gap-3">
                {/* §8 W7b "Big number display with Copy and Call it now" (Z-53). */}
                <p className="text-3xl font-semibold tabular-nums tracking-tight text-primary" dir="ltr" data-testid="live-number">
                  {formatPhone(e164)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <CopyButton text={e164} label={tl('copy')} copied={tl('copied')} failed={tl('copyFailed')} icon={<Copy />} variant="outline" data-testid="copy-number" onCopied={() => track('live_number_copied', { agent_id: agent.id })} />
                  <Button variant="outline" asChild>
                    <a href={`tel:${e164}`} data-testid="call-number">
                      <PhoneCall aria-hidden /> {tl('callNow')}
                    </a>
                  </Button>
                </div>
              </div>
            ) : null}
            {substitute ? <Alert variant="neutral">{tl('areaCodeNote', substitute)}</Alert> : null}
            {number.isError ? <Alert variant="warning">{errorMessage(number.error, t)}</Alert> : null}
            {number.data?.forwarding ? <Forwarding number={number.data} /> : null}
            {number.data?.kind === 'sip' ? <SipSetupGuide number={number.data} /> : null}
          </CardContent>
        </Card>
      )}

      {!activation.isError ? <NextStepsChecklist agent={agent} number={number.data} /> : null}

      <div className="flex flex-wrap justify-center gap-3">
        <Button size="lg" asChild>
          <Link href={routes.app.home}>
            {tl('dashboard')} <ArrowRight />
          </Link>
        </Button>
        <Button size="lg" variant="outline" asChild>
          <Link href={routes.app.calls}>{tl('calls')}</Link>
        </Button>
      </div>
    </div>
  );
}

/** Option B: the new number answers now; the customer's own line reaches it once they forward. */
function Forwarding({ number }: { number: PhoneNumberResponse }) {
  const t = useTranslations();
  const tl = useTranslations('wizard.live.forwarding');
  const api = useApi();
  const queryClient = useQueryClient();
  const [saving, setSaving] = React.useState(false);
  const forwarding = number.forwarding!;

  async function confirm() {
    if (saving) return;
    setSaving(true);
    try {
      await updateNumber(api, { id: number.id }, { forwarding_confirmed: true });
      await queryClient.invalidateQueries({ queryKey: ['getNumber', { id: number.id }] });
      track('forwarding_confirmed', { number_id: number.id });
      toast.success(tl('confirmed'));
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setSaving(false);
    }
  }

  if (forwarding.status === 'ready') return <Alert variant="success">{tl('ready', { from: formatPhone(forwarding.from) })}</Alert>;
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="info" title={tl('title', { from: formatPhone(forwarding.from) })}>
        {tl('body', { to: number.e164 ? formatPhone(number.e164) : '' })}
        {/* The W6 forward mode: which of the carrier's codes applies (always vs. busy / no answer). */}
        {forwarding.mode ? <p className="mt-1">{tl(`mode.${forwarding.mode}`)}</p> : null}
      </Alert>
      <CarrierForwardingGuide carrier={forwarding.carrier ?? 'other'} />
      <div>
        <Button onClick={() => void confirm()} loading={saving} disabled={saving} data-testid="forwarding-confirm">
          {tl('confirm')}
        </Button>
      </div>
    </div>
  );
}
