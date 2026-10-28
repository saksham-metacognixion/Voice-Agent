'use client';

import { isApiError, useApi, useGetPricing, useGetWallet } from '@portal/api-client';
import type { AgentDetail } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Spinner, cn } from '@portal/ui';
import { Mic, PhoneOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';
import { CallMyPhone } from './call-my-phone';
import { formatCredits } from '@/src/wizard/plan-gates';
import { canTransfer, needsPhoneTransfer } from '@/src/wizard/test-scenarios';
import { useTestCall, type TestCallFailure } from '@/src/wizard/use-test-call';
import { PRICING_STALE_MS } from '@/src/lib/pricing';

/**
 * W5 TestCallPanel (§12.3, §12.4): talk to the draft in the browser. Microphone, one
 * start/stop control, the live transcript, the timer against the call's ceiling, and
 * the credits — the rate for this draft's tier, the balance, and a running estimate.
 * The estimate is labelled as one: the charge itself is computed server-side from
 * `call_ended` and shows on the after-call card.
 */
export function TestCallPanel({ agent, onEnded }: { agent: AgentDetail; onEnded: (callId: string) => void }) {
  const tt = useTranslations('wizard.w5.call');
  const t = useTranslations();
  const api = useApi();
  const draft = agent.draft;
  const { state, start, end } = useTestCall(agent.id, draft?.version_no ?? null);
  const wallet = useGetWallet(api, { staleTime: 15_000 });
  const pricing = useGetPricing(api, undefined, { staleTime: PRICING_STALE_MS });
  const transcriptEnd = React.useRef<HTMLDivElement>(null);
  const reported = React.useRef<string | null>(null);

  const tier = draft?.settings.tier ?? agent.tier;
  const rate = state.mint?.rate ?? (pricing.data ? (tier === 'premium' ? pricing.data.rates.premium_per_min : pricing.data.rates.standard_per_min) : null);
  const balance = state.mint?.balance ?? wallet.data?.balance ?? null;
  const used = rate !== null ? Math.round(((state.elapsedS / 60) * rate) * 100) / 100 : null;
  const inCall = state.status === 'live';
  const busy = state.status === 'mic' || state.status === 'connecting';

  React.useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [state.transcript]);

  // Hand the call to the after-call card once, when it ends having connected.
  React.useEffect(() => {
    if ((state.status === 'ended' || state.status === 'failed') && state.callId && state.elapsedS > 0 && reported.current !== state.callId) {
      reported.current = state.callId;
      onEnded(state.callId);
    }
  }, [state.status, state.callId, state.elapsedS, onEnded]);

  const noCredits = balance !== null && balance <= 0;
  const transfers = canTransfer(draft?.brief);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{tt('title')}</CardTitle>
          <StatusPill status={state.status} agentTalking={state.agentTalking} />
        </div>
        <CardDescription>
          {/* Paused first: a paused agent answers no calls, live version or not (QA-073). */}
          {agent.status === 'paused'
            ? tt('subtitlePaused', { version: draft?.version_no ?? '–' })
            : agent.published_version
              ? tt('subtitleLive', { version: draft?.version_no ?? '–', live: agent.published_version })
              : tt('subtitle', { version: draft?.version_no ?? '–' })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <dl className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-muted/40 p-3 text-center">
          <Stat label={tt('timer')} value={`${clock(state.elapsedS)}${state.mint ? ` / ${clock(state.mint.max_call_duration_s)}` : ''}`} live={inCall} />
          <Stat label={tt('rate')} value={rate !== null ? tt('perMin', { credits: formatCredits(rate) }) : '–'} />
          <Stat
            label={inCall || state.status === 'ended' ? tt('used') : tt('balance')}
            value={inCall || state.status === 'ended' ? (used !== null ? `≈ ${formatCredits(used)}` : '–') : balance !== null ? formatCredits(balance) : '–'}
            hint={inCall && balance !== null && used !== null ? tt('left', { credits: formatCredits(Math.max(0, balance - used)) }) : undefined}
          />
        </dl>

        {state.failure ? <FailureAlert failure={state.failure} /> : null}
        {noCredits && !inCall ? <Alert variant="warning">{t('errors.NO_CREDITS')} {tt('noCreditsHint')}</Alert> : null}

        <div className="flex flex-wrap items-center gap-3">
          {inCall ? (
            <Button size="lg" variant="danger" onClick={end}>
              <PhoneOff /> {tt('end')}
            </Button>
          ) : (
            <Button size="lg" onClick={() => void start()} disabled={busy || !draft || noCredits} loading={busy}>
              {busy ? null : <Mic />} {state.status === 'mic' ? tt('askingMic') : state.status === 'connecting' ? tt('connecting') : state.status === 'ended' || state.status === 'failed' ? tt('again') : tt('start')}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">{tt('micHint')}</p>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">{tt('transcript')}</p>
          <div className="max-h-72 min-h-32 overflow-y-auto rounded-lg border border-border bg-background p-3 text-sm" aria-live="polite" aria-label={tt('transcript')}>
            {state.transcript.length === 0 ? (
              <p className="text-muted-foreground">{inCall ? tt('listening') : tt('transcriptEmpty')}</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {state.transcript.map((line, i) => (
                  <li key={i} className={cn('flex flex-col gap-0.5', line.role === 'user' && 'items-end text-end')}>
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{line.role === 'agent' ? tt('agent') : tt('you')}</span>
                    <span dir="auto" className={cn('max-w-[85%] rounded-lg px-3 py-2', line.role === 'agent' ? 'bg-muted' : 'bg-primary/12')}>{line.content}</span>
                  </li>
                ))}
              </ol>
            )}
            <div ref={transcriptEnd} />
          </div>
        </div>

        {/* D17: hidden until the first pack — the trial is browser test calls only (§5.4). */}
        {wallet.data?.last_pack_credits != null && draft ? <CallMyPhone agentId={agent.id} versionNo={draft.version_no} onPlaced={onEnded} /> : null}

        {/* A browser call has no phone line: a transfer to staff cannot complete here (BUG-006). */}
        {transfers ? <p className="text-xs text-muted-foreground">{tt('transferNote')}</p> : null}

        {draft?.scenarios?.length ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">{tt('tryThese')}</p>
            <ul className="flex flex-col gap-1.5 text-sm">
              {draft.scenarios.slice(0, 4).map((s) => (
                <li key={s.title} className="rounded-md border border-border px-3 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.title}</span>
                    {needsPhoneTransfer(s, draft.brief) ? <Badge variant="outline">{tt('phoneOnly')}</Badge> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">“{s.say_this}”</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusPill({ status, agentTalking }: { status: string; agentTalking: boolean }) {
  const tt = useTranslations('wizard.w5.call.status');
  if (status === 'live') return <Badge variant="success">{agentTalking ? tt('agentTalking') : tt('live')}</Badge>;
  if (status === 'mic' || status === 'connecting')
    return (
      <Badge variant="info">
        <Spinner className="size-3" /> {tt('connecting')}
      </Badge>
    );
  if (status === 'ended') return <Badge>{tt('ended')}</Badge>;
  if (status === 'failed') return <Badge variant="danger">{tt('failed')}</Badge>;
  return <Badge variant="outline">{tt('idle')}</Badge>;
}

function Stat({ label, value, hint, live }: { label: string; value: string; hint?: string; live?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('truncate text-base font-semibold tabular-nums', live && 'text-primary')} aria-live={live ? 'off' : undefined}>
        {value}
      </dd>
      {hint ? <dd className="truncate text-[11px] text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

function FailureAlert({ failure }: { failure: TestCallFailure }) {
  const t = useTranslations();
  const tt = useTranslations('wizard.w5.call.errors');
  if (failure.kind === 'mic_denied') return <Alert variant="danger" title={tt('micDeniedTitle')}>{tt('micDenied')}</Alert>;
  if (failure.kind === 'mic_missing') return <Alert variant="danger" title={tt('micMissingTitle')}>{tt('micMissing')}</Alert>;
  if (failure.kind === 'api') {
    const title = isApiError(failure.error, 'NO_CREDITS') ? tt('noCreditsTitle') : tt('apiTitle');
    return <Alert variant="danger" title={title}>{errorMessage(failure.error, t)}</Alert>;
  }
  return <Alert variant="danger" title={tt('connectionTitle')}>{tt('connection')}</Alert>;
}

function clock(totalS: number): string {
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
