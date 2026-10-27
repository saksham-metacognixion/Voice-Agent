'use client';

import { isApiError, useApi, useGetAgent, useGetCall, useUpdateCall } from '@portal/api-client';
import { roleAtLeast, type CallDetail } from '@portal/schemas';
import { Alert, Badge, Button, Separator, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton, Switch, Textarea, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { capturedFields, parseAnalysis } from '@/src/dashboard/analysis';
import { useServerCopy } from '@/src/i18n/server-copy';
import { PhoneCheckNote, PhoneSummaryNote } from '@/src/components/dashboard/phone-check';
import { Fact, LoadError } from '@/src/components/dashboard/query-states';
import { RecordingPlayer } from '@/src/components/dashboard/recording-player';
import { CallStatusBadge, SentimentBadge, TierBadge } from '@/src/components/dashboard/status-badges';
import { TranscriptView } from '@/src/components/dashboard/transcript-view';
import { errorMessage } from '@/src/lib/errors';
import { formatCreditsValue, formatDateTime, formatDuration, formatPhone } from '@/src/lib/format';
import { agentPath } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D2 call detail (spec p. 35), as a drawer over the list: summary, the captured fields,
 * the transcript, the recording and the facts, plus "mark handled" and a note
 * (`PATCH /calls/:id`). `GET /calls/:id` is re-read on every `call:{id}` frame by the
 * page's live hook, so a call still in progress fills in as it ends and is analysed.
 */
export function CallDrawer({ callId, onClose }: { callId: string | null; onClose: () => void }) {
  const t = useTranslations('dashboard.calls.detail');
  const tc = useTranslations();
  const api = useApi();
  const call = useGetCall(api, { id: callId ?? '' }, { enabled: Boolean(callId), staleTime: 5_000 });

  return (
    <Sheet open={Boolean(callId)} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full sm:w-[36rem] sm:max-w-[36rem]" closeLabel={tc('common.close')}>
        {call.isPending ? (
          <div className="flex flex-col gap-3" aria-busy>
            <SheetTitle className="sr-only">{t('title')}</SheetTitle>
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : call.isError ? (
          <>
            <SheetTitle>{t('title')}</SheetTitle>
            <LoadError error={call.error} onRetry={() => void call.refetch()} title={isApiError(call.error, 'NOT_FOUND') ? t('notFound') : undefined} />
          </>
        ) : (
          <CallBody call={call.data} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function CallBody({ call }: { call: CallDetail }) {
  const t = useTranslations('dashboard.calls.detail');
  const tl = useTranslations('dashboard.calls');
  const tc = useTranslations();
  const copy = useServerCopy();
  const api = useApi();
  const ws = useWorkspace();
  const timeZone = ws.workspace?.timezone;
  const canEdit = roleAtLeast(ws.workspace?.role ?? 'viewer', 'editor');
  const agent = useGetAgent(api, { id: call.agent_id ?? '' }, { enabled: Boolean(call.agent_id), staleTime: 60_000 });
  const analysis = parseAnalysis(call.analysis_json);
  const captured = capturedFields(analysis);
  const phoneChecks = new Map(call.captured_checks.map((c) => [c.field, c]));
  const fieldDefs = React.useMemo(() => {
    const defs = agent.data?.published?.analysis_fields ?? agent.data?.draft?.analysis_fields ?? [];
    return new Map(defs.map((f) => [f.name, f.description]));
  }, [agent.data]);
  const analysing = call.status === 'ended' || call.status === 'in_progress' || call.status === 'registered';
  const caller = call.channel === 'web' ? tl('browserTest') : formatPhone(call.from_number) === '–' ? tl('unknownCaller') : formatPhone(call.from_number);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1 pe-8">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle className="text-lg">{caller}</SheetTitle>
          <CallStatusBadge status={call.status} />
          {call.is_test ? <Badge variant="outline">{tl('test')}</Badge> : null}
        </div>
        <SheetDescription>
          {formatDateTime(call.started_at ?? call.created_at, timeZone, { seconds: true })}
          {agent.data ? (
            <>
              {' · '}
              <Link href={agentPath(agent.data.id)} className="inline-flex items-center gap-1 text-primary hover:underline">
                {agent.data.name} <ExternalLink className="size-3" aria-hidden />
              </Link>
            </>
          ) : null}
        </SheetDescription>
      </div>

      {call.status === 'missed' ? (
        <Alert variant="warning" title={t('missedTitle')}>
          {call.decline_reason ? tl(`declineReason.${call.decline_reason}`) : null}
        </Alert>
      ) : null}

      <HandledControls call={call} canEdit={canEdit} />

      <Section title={t('summary')}>
        {analysis?.call_summary ? (
          <p className="text-sm leading-relaxed">{analysis.call_summary}</p>
        ) : analysing ? (
          <p className="text-sm text-muted-foreground">{t('summaryPending')}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('summaryUnavailable')}</p>
        )}
        {analysis?.call_summary ? <PhoneSummaryNote checks={call.captured_checks} captured={t('captured')} /> : null}
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Fact label={t('sentiment')}>
            <SentimentBadge value={call.sentiment ?? analysis?.user_sentiment} />
          </Fact>
          {typeof analysis?.call_successful === 'boolean' ? <Fact label={t('outcome')}>{analysis.call_successful ? t('goalReached') : t('goalNotReached')}</Fact> : null}
          {analysis?.in_voicemail ? <Fact label={t('voicemail')}>{tc('wizard.w5.after.yes')}</Fact> : null}
        </dl>
      </Section>

      <Section title={t('captured')}>
        {captured.length ? (
          <dl className="divide-y divide-border rounded-lg border border-border text-sm">
            {captured.map(([name, value]) => (
              <div key={name} className="flex items-start justify-between gap-4 px-3 py-2">
                <dt className="text-muted-foreground" title={fieldDefs.get(name)}>
                  {copy.analysisField(name)}
                </dt>
                <dd className="text-end font-medium">
                  {displayValue(value, tc)}
                  <PhoneCheckNote check={phoneChecks.get(name)} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{analysing ? t('capturedPending') : t('capturedNone')}</p>
        )}
      </Section>

      <Section title={t('transcript')}>
        <TranscriptView json={call.transcript_json} text={call.transcript_text} agentName={agent.data?.name} />
      </Section>

      {canEdit ? (
        <Section title={t('recording')}>
          <RecordingPlayer callId={call.id} available={call.has_recording} />
        </Section>
      ) : null}

      {call.transfer ? <TransferSection transfer={call.transfer} /> : null}

      {call.knowledge ? <KnowledgeSection knowledge={call.knowledge} agentId={call.agent_id} /> : null}

      <Section title={t('details')}>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Fact label={t('duration')}>{formatDuration(call.duration_s)}</Fact>
          <Fact label={call.transfer_credits_charged !== null ? t('chargedAgentLeg') : t('charged')}>
            {call.credits_charged !== null ? tl('creditsShort', { n: formatCreditsValue(call.credits_charged) }) : analysing ? tc('wizard.w5.after.pending') : '–'}
          </Fact>
          {call.transfer_credits_charged !== null ? (
            <Fact label={t('chargedTotal')}>{tl('creditsShort', { n: formatCreditsValue((call.credits_charged ?? 0) + call.transfer_credits_charged) })}</Fact>
          ) : null}
          <Fact label={t('rate')}>{tl('perMin', { n: formatCreditsValue(call.rate) })}</Fact>
          <Fact label={t('tier')}>
            <TierBadge tier={call.tier} />
          </Fact>
          <Fact label={t('direction')}>{tl(`direction.${call.direction}`)}</Fact>
          <Fact label={t('channel')}>{tl(`channel.${call.channel}`)}</Fact>
          <Fact label={t('from')}>{formatPhone(call.from_number)}</Fact>
          <Fact label={t('to')}>{formatPhone(call.to_number)}</Fact>
          <Fact label={t('agentVersion')}>{call.agent_version !== null ? `v${call.agent_version}` : '–'}</Fact>
          <Fact label={t('started')}>{formatDateTime(call.started_at, timeZone, { seconds: true })}</Fact>
          <Fact label={t('ended')}>{formatDateTime(call.ended_at, timeZone, { seconds: true })}</Fact>
          <Fact label={t('disconnection')}>{call.disconnection_reason ? copy.disconnection(call.disconnection_reason) : '–'}</Fact>
        </dl>
        <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
          {t('callId')}: <span dir="ltr">{call.id}</span>
        </p>
      </Section>
    </div>
  );
}

/**
 * D16: the transferred leg — the part of the call after the agent handed the caller to a
 * person. It is billed on its own, at its own rate, from the moment the person answered.
 */
function TransferSection({ transfer }: { transfer: NonNullable<CallDetail['transfer']> }) {
  const t = useTranslations('dashboard.calls.detail.transfer');
  const tl = useTranslations('dashboard.calls');
  const timeZone = useWorkspace().workspace?.timezone;
  return (
    <Section title={t('title')}>
      <p className="text-sm text-muted-foreground">
        {transfer.status === 'cancelled'
          ? t('cancelledBody')
          : transfer.status === 'ended'
            ? t('endedBody', { rate: formatCreditsValue(transfer.rate ?? 0) })
            : t('liveBody')}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Fact label={t('status')}>
          <Badge variant={transfer.status === 'cancelled' ? 'outline' : 'default'}>{t(`statuses.${transfer.status}`)}</Badge>
        </Fact>
        {transfer.status !== 'cancelled' ? (
          <>
            <Fact label={t('duration')}>{transfer.duration_s !== null ? formatDuration(transfer.duration_s) : t('inProgress')}</Fact>
            <Fact label={t('charged')}>{transfer.credits_charged !== null ? tl('creditsShort', { n: formatCreditsValue(transfer.credits_charged) }) : t('inProgress')}</Fact>
            {transfer.rate !== null ? <Fact label={t('rate')}>{tl('perMin', { n: formatCreditsValue(transfer.rate) })}</Fact> : null}
            <Fact label={t('answered')}>{formatDateTime(transfer.bridged_at, timeZone, { seconds: true })}</Fact>
            <Fact label={t('ended')}>{transfer.ended_at ? formatDateTime(transfer.ended_at, timeZone, { seconds: true }) : t('inProgress')}</Fact>
          </>
        ) : null}
      </dl>
    </Section>
  );
}

/**
 * D16: what the agent looked up during the call. Look-ups are every time it consulted
 * what it knows; hits are the ones that found something; each source says how often it
 * answered. A call whose details could not be read still shows its count.
 */
function KnowledgeSection({ knowledge, agentId }: { knowledge: NonNullable<CallDetail['knowledge']>; agentId: string | null }) {
  const t = useTranslations('dashboard.calls.detail.knowledge');
  return (
    <Section title={t('title')}>
      <p className="text-sm">
        {knowledge.hits === null
          ? t('countOnly', { lookups: knowledge.lookups })
          : knowledge.hits === 0
            ? t('nothingFound', { lookups: knowledge.lookups })
            : t('summary', { lookups: knowledge.lookups, hits: knowledge.hits })}
      </p>
      {knowledge.sources.length ? (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border text-sm">
          {knowledge.sources.map((s, i) => (
            <li key={s.source_id ?? `${s.kind}-${i}`} className="flex items-center justify-between gap-4 px-3 py-2">
              <span className="min-w-0 truncate" dir="auto">
                {s.name && s.source_id && agentId ? (
                  <Link href={agentPath(agentId, 'knowledge')} className="text-primary hover:underline">
                    {s.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{s.kind === 'url' ? t('website') : t('removed')}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{t('sourceHits', { hits: s.hits })}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function HandledControls({ call, canEdit }: { call: CallDetail; canEdit: boolean }) {
  const t = useTranslations('dashboard.calls.detail');
  const tc = useTranslations();
  // The workspace's clock, like every other time in the drawer — not the browser's.
  const timeZone = useWorkspace().workspace?.timezone;
  const api = useApi();
  const queryClient = useQueryClient();
  const update = useUpdateCall(api);
  const [note, setNote] = React.useState(call.note ?? '');
  const [savingNote, setSavingNote] = React.useState(false);
  const [togglingHandled, setTogglingHandled] = React.useState(false);
  React.useEffect(() => setNote(call.note ?? ''), [call.id, call.note]);
  const noteDirty = note !== (call.note ?? '');

  async function patch(body: { handled?: boolean; note?: string | null }) {
    const updated = await update.mutateAsync({ params: { id: call.id }, body });
    queryClient.setQueryData(['getCall', { id: call.id }], updated);
    void queryClient.invalidateQueries({ queryKey: ['listCalls'] });
  }

  async function toggleHandled(handled: boolean) {
    setTogglingHandled(true);
    try {
      await patch({ handled });
      toast.success(handled ? t('markedHandled') : t('markedUnhandled'));
    } catch (e) {
      toast.error(errorMessage(e, tc));
    } finally {
      setTogglingHandled(false);
    }
  }

  async function saveNote() {
    setSavingNote(true);
    try {
      await patch({ note: note.trim() ? note.trim() : null });
      toast.success(t('noteSaved'));
    } catch (e) {
      toast.error(errorMessage(e, tc));
    } finally {
      setSavingNote(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{t('handled')}</p>
          <p className="text-xs text-muted-foreground">{call.handled_at ? t('handledAt', { when: formatDateTime(call.handled_at, timeZone) }) : t('handledHint')}</p>
        </div>
        <Switch checked={Boolean(call.handled_at)} disabled={!canEdit || togglingHandled} onCheckedChange={(v) => void toggleHandled(v)} aria-label={t('handled')} />
      </div>
      <Separator />
      <div className="flex flex-col gap-2">
        <label htmlFor="call-note" className="text-sm font-medium">
          {t('note')}
        </label>
        <Textarea id="call-note" rows={2} maxLength={2000} value={note} disabled={!canEdit} placeholder={canEdit ? t('notePlaceholder') : t('noteViewer')} onChange={(e) => setNote(e.target.value)} />
        {canEdit ? (
          <div className="flex justify-end">
            <Button size="sm" variant="outline" disabled={!noteDirty} loading={savingNote} onClick={() => void saveNote()}>
              {tc('common.save')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function displayValue(value: unknown, t: (key: string) => string): string {
  if (typeof value === 'boolean') return value ? t('wizard.w5.after.yes') : t('wizard.w5.after.no');
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '–';
  }
}
