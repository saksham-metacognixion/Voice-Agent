'use client';

import type { AgentDetail } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Progress, cn } from '@portal/ui';
import { ArrowRight, FileText, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { GenerationState } from '@/src/wizard/use-generation';

export interface GeneratePanelProps {
  agent: AgentDetail | undefined;
  generation: GenerationState;
  /** The run has passed the point where it should have finished. */
  slow?: boolean;
  ready: boolean;
  saving: boolean;
  onGenerate: (mode: 'generate' | 'regenerate') => void;
  onContinue: () => void;
  /** Opens the script editor under the brief (W2 only; absent = no button). */
  onEditScript?: () => void;
  /** The script editor holds unsaved edits: Continue waits for a save. */
  scriptDirty?: boolean;
  error: string | null;
}

const STAGE_PCT: Record<GenerationState['stage'], number> = { idle: 0, queued: 8, started: 25, writing: 65, done: 100, failed: 100 };

/** The right-hand column of W2: the Generate button, the progress, the result. */
export function GeneratePanel({ agent, generation, slow, ready, saving, onGenerate, onContinue, onEditScript, scriptDirty = false, error }: GeneratePanelProps) {
  const t = useTranslations('wizard.w2');
  const active = generation.stage === 'queued' || generation.stage === 'started' || generation.stage === 'writing';
  const hasPrompt = Boolean(agent?.draft?.has_prompt);
  const generatedNow = generation.stage === 'done';
  const draft = agent?.draft;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        {active ? (
          <div className="flex flex-col gap-3" aria-live="polite">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="size-4 animate-pulse text-primary" aria-hidden />
              {t('generating')}
            </div>
            <Progress value={STAGE_PCT[generation.stage]} indeterminate={generation.stage === 'queued'} />
            <ol className="grid grid-cols-3 gap-1 text-[11px]">
              {(['started', 'writing', 'done'] as const).map((s, i) => {
                const reached = STAGE_PCT[generation.stage] >= STAGE_PCT[s] || (s === 'started' && generation.stage !== 'queued');
                return (
                  <li key={s} className={cn('flex items-center gap-1.5', reached ? 'text-foreground' : 'text-muted-foreground')}>
                    <span className={cn('size-1.5 rounded-full', reached ? 'bg-primary' : 'bg-border')} aria-hidden />
                    {t(`stage.${s}`)}
                    <span className="sr-only">{i + 1}</span>
                  </li>
                );
              })}
            </ol>
            {slow ? <p className="text-xs text-muted-foreground">{t('slow')}</p> : null}
          </div>
        ) : null}

        {generation.stage === 'failed' ? (
          <Alert variant="danger" title={t('failedTitle')}>
            {generation.reason ?? t('failedBody')}
          </Alert>
        ) : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}

        {(generatedNow || (hasPrompt && !active)) && draft ? (
          <Alert variant="success" title={t('generatedTitle')}>
            {t('generatedBody', { version: draft.version_no })}
          </Alert>
        ) : null}

        {!active ? (
          <div className="flex flex-col gap-2">
            {hasPrompt ? (
              <>
                <Button size="lg" onClick={onContinue} disabled={scriptDirty}>
                  {t('continue')} <ArrowRight />
                </Button>
                {scriptDirty ? <p className="text-xs text-warning-emphasis">{t('scriptUnsaved')}</p> : null}
                {onEditScript ? (
                  <Button variant="outline" onClick={onEditScript} data-testid="edit-script">
                    <FileText /> {t('editScript')}
                  </Button>
                ) : null}
                <Button variant="outline" onClick={() => onGenerate('regenerate')} disabled={!ready || saving}>
                  <RefreshCw /> {t('regenerate')}
                </Button>
                <p className="text-xs text-muted-foreground">{t('editAfter')}</p>
              </>
            ) : (
              <>
                <Button size="lg" onClick={() => onGenerate('generate')} disabled={!ready || saving} loading={saving}>
                  <Sparkles /> {t('generate')}
                </Button>
                {!ready ? <p className="text-xs text-muted-foreground">{t('generateHint')}</p> : null}
              </>
            )}
          </div>
        ) : null}
      </CardContent>

      {draft?.scenarios && draft.scenarios.length > 0 && !active ? (
        <>
          <CardHeader className="pt-0">
            <CardTitle className="text-sm">{t('scenarios')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pt-3">
            {draft.scenarios.slice(0, 3).map((s, i) => (
              <div key={i} className="rounded-md border border-border bg-muted/40 p-3 text-sm">
                <p className="font-medium">{s.title}</p>
                <p className="mt-1 text-muted-foreground">“{s.say_this}”</p>
              </div>
            ))}
          </CardContent>
        </>
      ) : null}

      {draft?.lint && draft.lint.findings.length > 0 && !active ? (
        <CardContent className="pt-0">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('warnings')}</p>
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {draft.lint.findings.slice(0, 5).map((f, i) => (
              <li key={i} className={cn(f.severity === 'error' && 'text-danger')}>
                • {f.message}
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}
