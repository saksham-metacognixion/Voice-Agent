'use client';

import type { AgentDetail } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Progress, cn } from '@portal/ui';
import { FileText, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { useServerCopy } from '@/src/i18n/server-copy';
import { STAGE_PCT, stageStates } from '@/src/wizard/generation-stages';
import type { GenerationState } from '@/src/wizard/use-generation';

export interface GeneratePanelProps {
  agent: AgentDetail | undefined;
  generation: GenerationState;
  /** The run has passed the point where it should have finished. */
  slow?: boolean;
  ready: boolean;
  saving: boolean;
  onGenerate: (mode: 'generate' | 'regenerate') => Promise<void> | void;
  /** Opens the script editor under the brief (W2 only; absent = no button). */
  onEditScript?: () => void;
  error: string | null;
}

/**
 * The right-hand column of W2: Generate, the progress, the result, Regenerate and "Edit
 * the script". Continue lives in the page's footer (§7.3: one primary button, bottom
 * right), so once a script exists nothing here is primary.
 */
export function GeneratePanel({ agent, generation, slow, ready, saving, onGenerate, onEditScript, error }: GeneratePanelProps) {
  const t = useTranslations('wizard.w2');
  const copy = useServerCopy();
  const active = generation.stage === 'queued' || generation.stage === 'started' || generation.stage === 'writing';
  const hasPrompt = Boolean(agent?.draft?.has_prompt);
  const generatedNow = generation.stage === 'done';
  const draft = agent?.draft;
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        {active ? (
          <div className="flex flex-col gap-3" aria-live="polite">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="size-4 animate-pulse text-primary motion-reduce:animate-none" aria-hidden />
              {t('generating')}
            </div>
            <Progress value={STAGE_PCT[generation.stage]} indeterminate={generation.stage === 'queued'} />
            <ol className="grid grid-cols-3 gap-1 text-[11px]" data-testid="generation-stages">
              {stageStates(generation.stage).map(({ key, state }, i) => (
                <li key={key} className={cn('flex items-center gap-1.5', state === 'pending' ? 'text-muted-foreground' : 'text-foreground')} data-state={state}>
                  <span className={cn('size-1.5 rounded-full', state === 'pending' ? 'bg-border' : 'bg-primary', state === 'running' && 'animate-pulse motion-reduce:animate-none')} aria-hidden />
                  {t(`stage.${key}`)}
                  <span className="sr-only">{i + 1}</span>
                </li>
              ))}
            </ol>
            {slow ? <p className="text-xs text-muted-foreground">{t('slow')}</p> : null}
          </div>
        ) : null}

        {generation.stage === 'failed' ? (
          <Alert variant="danger" title={t('failedTitle')}>
            {copy.sentence(generation.reason) ?? t('failedBody')}
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
                {onEditScript ? (
                  <Button variant="outline" onClick={onEditScript} data-testid="edit-script">
                    <FileText aria-hidden /> {t('editScript')}
                  </Button>
                ) : null}
                <Button variant="outline" onClick={() => setConfirmOpen(true)} disabled={!ready || saving} data-testid="regenerate">
                  <RefreshCw aria-hidden /> {t('regenerate')}
                </Button>
                <p className="text-xs text-muted-foreground">{t('editAfter')}</p>
                {/* §8 W2 "Regenerate … confirm dialog": nothing is rewritten until it is confirmed, and Cancel changes nothing. */}
                <ConfirmDialog
                  open={confirmOpen}
                  onOpenChange={setConfirmOpen}
                  title={t('regenerateConfirm.title')}
                  description={t('regenerateConfirm.body')}
                  consequences={[t('regenerateConfirm.keepsFeedback'), t('regenerateConfirm.replacesEdits')]}
                  confirmLabel={t('regenerate')}
                  destructive={false}
                  onConfirm={async () => {
                    await onGenerate('regenerate');
                  }}
                />
              </>
            ) : (
              <>
                <Button size="lg" onClick={() => void onGenerate('generate')} disabled={!ready || saving} loading={saving} data-testid="generate">
                  <Sparkles aria-hidden /> {t('generate')}
                </Button>
                {/* §8 W2 "generate button shows credits note": a generation is never metered. */}
                <p className="text-xs text-muted-foreground" data-testid="generate-free">
                  {t('free')}
                </p>
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
                • {copy.finding(f)}
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}
