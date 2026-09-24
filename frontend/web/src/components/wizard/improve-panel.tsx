'use client';

import { feedbackRequest, type AgentDetail } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Progress, Textarea } from '@portal/ui';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';
import { useFeedback } from '@/src/wizard/use-feedback';

const MIN = feedbackRequest.shape.text.minLength ?? 10;
const MAX = feedbackRequest.shape.text.maxLength ?? 500;

/**
 * W5 ImprovePanel (§9.6, §13.5): "tell us what to change" in plain words → a new draft
 * version. The patch is always against the current draft (`base_version`), so two tabs
 * cannot silently patch different bases. When the request would break a platform rule
 * the job still succeeds with no changes, and the panel shows the explanation instead
 * of pretending something changed.
 */
export function ImprovePanel({ agent }: { agent: AgentDetail }) {
  const ti = useTranslations('wizard.w5.improve');
  const t = useTranslations();
  const { state, working, submit, reset } = useFeedback(agent.id);
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const draft = agent.draft;
  const trimmed = text.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (working || trimmed.length < MIN) return;
    setError(null);
    try {
      await submit(trimmed, draft?.version_no ?? null);
      setText('');
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  // The draft is re-read when the job ends; its version number and change list are what
  // the customer sees, not what the frame claimed.
  const applied = state.stage === 'done' && !state.refused && draft && (state.versionNo === null || draft.version_no >= state.versionNo);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ti('title')}</CardTitle>
        <CardDescription>{ti('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)} noValidate>
          <Field id="w5-feedback" label={ti('label')} addon={`${trimmed.length} / ${MAX}`} error={tooShort ? ti('tooShort', { min: MIN }) : undefined}>
            <Textarea
              id="w5-feedback"
              rows={4}
              maxLength={MAX}
              placeholder={ti('placeholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={working}
            />
          </Field>
          <div>
            <Button type="submit" disabled={working || trimmed.length < MIN} loading={working}>
              {working ? null : <Sparkles />} {working ? ti('working') : ti('submit')}
            </Button>
          </div>
        </form>

        {working ? (
          <div className="flex flex-col gap-2" aria-live="polite">
            <Progress indeterminate aria-label={ti('working')} />
            <p className="text-xs text-muted-foreground">{ti('workingHint')}</p>
          </div>
        ) : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {state.stage === 'failed' ? (
          <Alert variant="danger" title={ti('failedTitle')} actions={<Button size="sm" variant="outline" onClick={reset}>{t('common.close')}</Button>}>
            {state.message ?? ti('failedBody')}
          </Alert>
        ) : null}
        {state.stage === 'done' && state.refused ? (
          <Alert variant="warning" title={ti('refusedTitle')} actions={<Button size="sm" variant="outline" onClick={reset}>{t('common.close')}</Button>}>
            {state.message ?? ti('refusedBody')}
          </Alert>
        ) : null}
        {applied ? (
          <Alert variant="success" title={ti('doneTitle', { version: draft.version_no })} actions={<Button size="sm" variant="outline" onClick={reset}>{t('common.close')}</Button>}>
            {draft.changes?.length ? (
              <ul className="list-disc pl-4">
                {draft.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              ti('doneBody')
            )}
            <p className="mt-1">{ti('testAgain')}</p>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
