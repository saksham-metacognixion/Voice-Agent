'use client';

import type { AgentDetail, CallDetail } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, Spinner } from '@portal/ui';
import { useTranslations } from 'next-intl';
import { useServerCopy } from '@/src/i18n/server-copy';
import { z } from 'zod';
import { errorMessage } from '@/src/lib/errors';
import { formatCredits } from '@/src/wizard/plan-gates';
import { useAfterCall } from '@/src/wizard/use-after-call';
import { PhoneCheckNote, PhoneSummaryNote } from '@/src/components/dashboard/phone-check';

/**
 * What `call_analyzed` stores in `calls.analysis_json` — the platform's post-call
 * analysis, read leniently: every field is optional and anything unexpected is ignored,
 * so a missing or oddly-typed field costs one line of the card, never the card.
 */
const analysis = z
  .object({
    call_summary: z.string().optional().catch(undefined),
    user_sentiment: z.string().optional().catch(undefined),
    call_successful: z.boolean().optional().catch(undefined),
    in_voicemail: z.boolean().optional().catch(undefined),
    custom_analysis_data: z.record(z.unknown()).optional().catch(undefined),
  })
  .passthrough();

/**
 * W5 after-call card (§12.4): duration, the real charge, the summary and the fields the
 * agent was asked to capture — all from `GET /calls/:id` once `call_analyzed` has filled
 * it. Until then it says it is waiting; if analysis never arrives, it says so and still
 * shows what `call_ended` recorded.
 */
export function AfterCallCard({ callId, agent }: { callId: string; agent: AgentDetail }) {
  const ta = useTranslations('wizard.w5.after');
  const t = useTranslations();
  const { stage, late, call, error, retry } = useAfterCall(callId, true);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{ta('title')}</CardTitle>
          {stage === 'analyzed' ? <Badge variant="success">{ta('ready')}</Badge> : stage === 'waiting' || stage === 'ended' ? <Badge variant="info"><Spinner className="size-3" /> {ta('analysing')}</Badge> : null}
        </div>
        <CardDescription>{ta('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {stage === 'error' ? (
          <Alert variant="danger" title={t('errors.loadFailed')} actions={<Button size="sm" variant="outline" onClick={retry}>{t('common.retry')}</Button>}>
            {errorMessage(error, t)}
          </Alert>
        ) : null}
        {!call ? (
          stage === 'unavailable' ? (
            <Alert variant="neutral">{ta('notRecorded')}</Alert>
          ) : (
            <div className="flex flex-col gap-2" aria-busy>
              {late ? <p className="text-sm text-muted-foreground">{ta('late')}</p> : null}
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-16 w-full" />
            </div>
          )
        ) : (
          <CallFacts call={call} agent={agent} stage={stage} late={late} />
        )}
      </CardContent>
    </Card>
  );
}

function CallFacts({ call, agent, stage, late }: { call: CallDetail; agent: AgentDetail; stage: string; late: boolean }) {
  const ta = useTranslations('wizard.w5.after');
  const copy = useServerCopy();
  const parsed = analysis.safeParse(call.analysis_json ?? {});
  const a = parsed.success ? parsed.data : null;
  const fieldDefs = new Map((agent.draft?.analysis_fields ?? []).map((f) => [f.name, f.description]));
  const custom = Object.entries(a?.custom_analysis_data ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const phoneChecks = new Map(call.captured_checks.map((c) => [c.field, c]));

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Fact label={ta('duration')} value={call.duration_s !== null ? ta('seconds', { s: call.duration_s }) : '–'} />
        <Fact label={ta('charged')} value={call.credits_charged !== null ? formatCredits(call.credits_charged) : ta('pending')} />
        {a?.user_sentiment ? <Fact label={ta('sentiment')} value={a.user_sentiment} /> : null}
        {typeof a?.call_successful === 'boolean' ? <Fact label={ta('outcome')} value={a.call_successful ? ta('successful') : ta('unsuccessful')} /> : null}
      </dl>

      {a?.call_summary ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{ta('summary')}</p>
          <p className="text-sm leading-relaxed">{a.call_summary}</p>
          <PhoneSummaryNote checks={call.captured_checks} captured={ta('captured')} />
        </div>
      ) : stage === 'analyzed' ? null : stage === 'unavailable' ? (
        <Alert variant="neutral">{ta('unavailable')}</Alert>
      ) : (
        <p className="text-sm text-muted-foreground">{ta(late ? 'late' : 'waiting')}</p>
      )}

      {custom.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{ta('captured')}</p>
          <dl className="divide-y divide-border rounded-lg border border-border text-sm">
            {custom.map(([name, value]) => (
              <div key={name} className="flex items-start justify-between gap-4 px-3 py-2">
                <dt className="text-muted-foreground" title={fieldDefs.get(name)}>
                  {copy.analysisField(name)}
                </dt>
                <dd className="text-end font-medium">
                  {display(value, ta)}
                  <PhoneCheckNote check={phoneChecks.get(name)} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {call.transcript_text ? (
        <details className="rounded-lg border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{ta('fullTranscript')}</summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed">{call.transcript_text}</pre>
        </details>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function display(value: unknown, ta: (key: string) => string): string {
  if (typeof value === 'boolean') return value ? ta('yes') : ta('no');
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '–';
  }
}
