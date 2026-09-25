'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { brief as briefSchema, briefReadyForGeneration, type AgentDetail, type Brief } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from '@portal/ui';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { BriefCard } from '@/src/components/wizard/brief-card';
import { BriefFields, SaveIndicator, storableBrief } from '@/src/components/wizard/brief-form';
import { useBriefPlaceholders } from '@/src/components/wizard/template-context';
import { errorMessage } from '@/src/lib/errors';
import { useBriefAutosave } from '@/src/wizard/use-brief-autosave';
import { useGeneration } from '@/src/wizard/use-generation';

/**
 * D3 Brief (spec p. 36): the W2 form on the agent's draft brief, autosaved into the
 * newest unpublished version (`PATCH /agents/:id/draft`, forking a frozen one — ADR 0012
 * §2), plus Regenerate (§13.3, a job with SSE + polling progress) to rewrite the script
 * from the edited brief. The generated brief card sits beside it.
 */
export function BriefTab({ agent, canEdit }: { agent: AgentDetail; canEdit: boolean }) {
  const t = useTranslations('dashboard.agents.brief');
  const tw = useTranslations('wizard.w2');
  const tc = useTranslations();
  const version = agent.draft ?? agent.published;
  const initial = React.useMemo(() => briefSchema.parse(version?.brief ?? {}), [version?.brief]);
  const autosave = useBriefAutosave(canEdit ? agent.id : null, initial);
  const generation = useGeneration(agent);
  const [genError, setGenError] = React.useState<string | null>(null);
  const placeholders = useBriefPlaceholders(agent);

  const form = useForm<Brief>({
    resolver: zodResolver(briefSchema) as unknown as Resolver<Brief>,
    defaultValues: initial,
    mode: 'onChange',
  });
  const values = form.watch();

  React.useEffect(() => {
    if (!canEdit) return;
    const sub = form.watch((v) => {
      const storable = storableBrief(v);
      if (storable) autosave.onChange(storable);
    });
    return () => sub.unsubscribe();
  }, [form, autosave, canEdit]);

  const ready = briefReadyForGeneration.safeParse(values).success;
  const busy = generation.active || !canEdit;

  async function regenerate() {
    setGenError(null);
    const valid = await form.trigger();
    if (!valid) {
      setGenError(tc('errors.VALIDATION_FAILED'));
      return;
    }
    try {
      await autosave.flush();
      await generation.start(version?.has_prompt ? 'regenerate' : 'generate');
    } catch (e) {
      setGenError(errorMessage(e, tc));
    }
  }

  const stagePct: Record<string, number> = { idle: 0, queued: 8, started: 25, writing: 65, done: 100, failed: 100 };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{canEdit ? t('hint', { n: version?.version_no ?? 1 }) : t('viewerHint')}</p>
          <SaveIndicator state={autosave.state} error={autosave.error} onRetry={autosave.retry} />
        </div>
        <BriefFields form={form} busy={busy} fieldErrors={autosave.fieldErrors} placeholders={placeholders} />
      </div>
      <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
        {canEdit ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" aria-hidden /> {t('regenerateTitle')}
              </CardTitle>
              <CardDescription>{t('regenerateBody')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {generation.active ? (
                <div className="flex flex-col gap-2" aria-live="polite">
                  <p className="text-sm font-medium">{tw(`stage.${generation.state.stage === 'idle' ? 'queued' : generation.state.stage}`)}</p>
                  <Progress value={stagePct[generation.state.stage] ?? 0} indeterminate={generation.state.stage === 'queued'} />
                  {generation.slow ? <p className="text-xs text-muted-foreground">{tw('slow')}</p> : null}
                </div>
              ) : null}
              {generation.state.stage === 'done' ? <Alert variant="success" title={tw('generatedTitle')}>{t('regenerated', { n: generation.state.versionNo ?? '' })}</Alert> : null}
              {generation.state.stage === 'failed' ? <Alert variant="danger" title={tw('failedTitle')}>{generation.state.reason ?? tw('failedBody')}</Alert> : null}
              {genError ? <Alert variant="danger">{genError}</Alert> : null}
              <Button onClick={() => void regenerate()} disabled={!ready || generation.active || autosave.state === 'saving'} loading={generation.active}>
                {version?.has_prompt ? tw('regenerate') : tw('generate')}
              </Button>
              {!ready ? <p className="text-xs text-muted-foreground">{tw('generateHint')}</p> : null}
            </CardContent>
          </Card>
        ) : null}
        <BriefCard brief={values} generated={generation.active ? null : version?.brief_card} agentName={values.agent_name ?? agent.name} />
      </aside>
    </div>
  );
}
