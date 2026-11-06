'use client';

import { isApiError, useApi, useGetPricing, useGetWallet, useListAgentVersions } from '@portal/api-client';
import type { AgentDetail } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner, cn } from '@portal/ui';
import { Mic, PhoneOff } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { CallMyPhone } from './call-my-phone';
import { LeaveCallPrompt } from './leave-call-prompt';
import { detectBrowser } from '@/src/wizard/browser-help';
import { formatCredits } from '@/src/wizard/plan-gates';
import { canTransfer, needsPhoneTransfer } from '@/src/wizard/test-scenarios';
import { resolveTestVersion, testableVersions } from '@/src/wizard/test-versions';
import { useTestCall, type TestCallFailure } from '@/src/wizard/use-test-call';
import { PRICING_STALE_MS } from '@/src/lib/pricing';

/**
 * W5 TestCallPanel (§12.3, §12.4): talk to the draft in the browser. Microphone, one
 * start/stop control, the live transcript, the timer against the call's ceiling, and
 * the credits — the rate for this draft's tier, the balance, and a running estimate.
 * The estimate is labelled as one: the charge itself is computed server-side from
 * `call_ended` and shows on the after-call card.
 *
 * Spec W5 "Version selector" (QA-082): the newest draft by default, or any version the
 * API will ring — the draft and every version that was published (`testableVersions`).
 * The browser test and "Call my phone" both use the version picked here.
 */
export interface TestCallPanelProps {
  agent: AgentDetail;
  onEnded: (callId: string) => void;
  /**
   * §8 W5 "balance 0 during trial → 'You've used your free test minutes — activate to
   * keep testing' with CTA": where that button goes (W6 in the wizard, the wallet on D3).
   */
  outOfCredits: { href: string; label: string };
}

export function TestCallPanel({ agent, onEnded, outOfCredits }: TestCallPanelProps) {
  const tt = useTranslations('wizard.w5.call');
  const t = useTranslations();
  const api = useApi();
  const draft = agent.draft;
  const versions = useListAgentVersions(api, { id: agent.id }, { staleTime: 10_000 });
  const { refetch: refetchVersions } = versions;
  const options = React.useMemo(() => testableVersions(versions.data ?? []), [versions.data]);
  const [picked, setPicked] = React.useState<number | null>(null);
  // A new draft (Improve, a regenerate) is what the customer wants to hear next: the pick
  // follows it, and the list is re-read so it is on offer.
  React.useEffect(() => {
    setPicked(null);
    void refetchVersions();
  }, [draft?.version_no, refetchVersions]);
  const versionNo = resolveTestVersion(options, picked, draft?.version_no ?? null);
  const testingDraft = versionNo !== null && versionNo === draft?.version_no;
  const { state, start, end } = useTestCall(agent.id, versionNo);
  const wallet = useGetWallet(api, { staleTime: 15_000 });
  const pricing = useGetPricing(api, undefined, { staleTime: PRICING_STALE_MS });
  const transcriptEnd = React.useRef<HTMLDivElement>(null);
  const reported = React.useRef<string | null>(null);

  // The tier the picked version runs on, where the page has its settings; the mint's own
  // rate replaces this estimate as soon as a call starts.
  const tier = (testingDraft ? draft?.settings.tier : versionNo === agent.published?.version_no ? agent.published?.settings.tier : undefined) ?? agent.tier;
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
  const onTrial = wallet.data ? wallet.data.last_pack_credits == null : false;
  const transfers = canTransfer(draft?.brief);
  // §8 W5 "Scenario chips: clicking shows 'Try saying: …'": the chips, and the one whose hint is open.
  const scenarios = React.useMemo(() => (draft?.scenarios ?? []).slice(0, 5), [draft?.scenarios]);
  const [hint, setHint] = React.useState<number | null>(null);
  React.useEffect(() => setHint(null), [draft?.version_no]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{tt('title')}</CardTitle>
          <StatusPill status={state.status} agentTalking={state.agentTalking} />
        </div>
        <CardDescription>
          {/* Another version picked (QA-082): say which, and what callers reach meanwhile. */}
          {versionNo !== null && !testingDraft
            ? versionNo === agent.published_version
              ? tt('subtitleTestingLive', { version: versionNo })
              : tt('subtitleEarlier', { version: versionNo, live: agent.published_version ?? '–' })
            : /* Paused first: a paused agent answers no calls, live version or not (QA-073). */
              agent.status === 'paused'
              ? tt('subtitlePaused', { version: draft?.version_no ?? '–' })
              : agent.published_version
                ? tt('subtitleLive', { version: draft?.version_no ?? '–', live: agent.published_version })
                : tt('subtitle', { version: draft?.version_no ?? '–' })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {options.length > 1 && versionNo !== null ? (
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <label htmlFor={`test-version-${agent.id}`} className="text-sm font-medium">
              {tt('version')}
            </label>
            <Select
              value={String(versionNo)}
              disabled={inCall || busy}
              onValueChange={(v) => {
                const no = Number(v);
                setPicked(no);
                track('test_version_selected', { agent_id: agent.id, version_no: no, latest: no === draft?.version_no });
              }}
            >
              <SelectTrigger id={`test-version-${agent.id}`} className="sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.version_no} value={String(o.version_no)}>
                    {tt(`versionKind.${o.kind}`, { n: o.version_no })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

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
        {noCredits && !inCall ? (
          <Alert
            variant="warning"
            title={onTrial ? tt('trialUsedTitle') : t('errors.NO_CREDITS')}
            actions={
              <Button size="sm" asChild>
                <Link href={outOfCredits.href} data-testid="out-of-credits-cta">
                  {outOfCredits.label}
                </Link>
              </Button>
            }
          >
            {onTrial ? tt('trialUsedBody') : tt('noCreditsHint')}
          </Alert>
        ) : null}
        <LeaveCallPrompt live={inCall} hangUp={end} />

        <div className="flex flex-wrap items-center gap-3">
          {inCall ? (
            <Button size="lg" variant="danger" onClick={end}>
              <PhoneOff /> {tt('end')}
            </Button>
          ) : (
            <Button size="lg" onClick={() => void start()} disabled={busy || versionNo === null || noCredits} loading={busy}>
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
        {wallet.data?.last_pack_credits != null && versionNo !== null ? <CallMyPhone agentId={agent.id} versionNo={versionNo} onPlaced={onEnded} /> : null}

        {/* A browser call has no phone line: a transfer to staff cannot complete here (BUG-006). */}
        {transfers ? <p className="text-xs text-muted-foreground">{tt('transferNote')}</p> : null}

        {scenarios.length && draft ? (
          <div className="flex flex-col gap-2">
            <p id={`scenarios-${agent.id}`} className="text-xs font-medium text-muted-foreground">
              {tt('tryThese')}
            </p>
            {/* Chips, not a list: the hint is read one at a time, so a phone screen is not five quotes long. */}
            <ul className="flex flex-wrap gap-2" aria-labelledby={`scenarios-${agent.id}`}>
              {scenarios.map((s, i) => (
                <li key={s.title}>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                      hint === i ? 'border-primary bg-accent/60 text-accent-foreground' : 'border-border bg-card hover:border-primary/40',
                    )}
                    aria-pressed={hint === i}
                    aria-controls={`scenario-hint-${agent.id}`}
                    data-testid="scenario-chip"
                    onClick={() => {
                      setHint((cur) => (cur === i ? null : i));
                      track('scenario_chip_opened', { agent_id: agent.id, index: i });
                    }}
                  >
                    {s.title}
                    {needsPhoneTransfer(s, draft.brief) ? <Badge variant="outline">{tt('phoneOnly')}</Badge> : null}
                  </button>
                </li>
              ))}
            </ul>
            <p id={`scenario-hint-${agent.id}`} className={cn('rounded-md bg-muted px-3 py-2 text-sm', hint === null && 'text-muted-foreground')} aria-live="polite">
              {hint !== null && scenarios[hint] ? (
                <>
                  <span className="font-medium">{tt('trySaying')}</span> <span dir="auto">“{scenarios[hint].say_this}”</span>
                </>
              ) : (
                tt('pickScenario')
              )}
            </p>
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
  if (failure.kind === 'mic_denied') return <MicDeniedHelp />;
  if (failure.kind === 'mic_missing') return <Alert variant="danger" title={tt('micMissingTitle')}>{tt('micMissing')}</Alert>;
  if (failure.kind === 'api') {
    const title = isApiError(failure.error, 'NO_CREDITS') ? tt('noCreditsTitle') : tt('apiTitle');
    return <Alert variant="danger" title={title}>{errorMessage(failure.error, t)}</Alert>;
  }
  return <Alert variant="danger" title={tt('connectionTitle')}>{tt('connection')}</Alert>;
}

/**
 * §8 W5 "mic denied → inline instructions per browser": the steps for the browser in
 * use (Chrome, Edge, Safari, Firefox), from its user agent; anything else gets the
 * generic line. Steps are the catalogue's, so they read in the portal's language.
 */
function MicDeniedHelp() {
  const tt = useTranslations('wizard.w5.call.errors');
  const browser = React.useSyncExternalStore(
    () => () => undefined,
    () => detectBrowser(navigator.userAgent),
    () => 'other' as const,
  );
  const steps = tt.raw(`micHelp.${browser}`) as string[];
  return (
    <Alert variant="danger" title={tt('micDeniedTitle')}>
      <p>{tt('micDenied')}</p>
      <p className="mt-2 text-xs font-medium">{tt(`micHelpTitle.${browser}`)}</p>
      <ol className="mt-1 list-decimal space-y-0.5 ps-5 text-sm" data-testid="mic-help">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </Alert>
  );
}

function clock(totalS: number): string {
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
