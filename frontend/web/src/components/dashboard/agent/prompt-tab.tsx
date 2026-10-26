'use client';

import { isApiError, lintVersionPrompt, updateVersionPrompt, useApi } from '@portal/api-client';
import type { AgentDetail, LintFinding, LintResult } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Textarea, cn, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Info, Save, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { useDebouncedCallback } from '@/src/lib/use-debounced';
import { formatNumber } from '@/src/lib/format';
import { useServerCopy } from '@/src/i18n/server-copy';

const MIN_PROMPT = 50;
const MAX_PROMPT = 20_000;

/**
 * D3 Advanced prompt editor (§9.1, spec p. 36). Edits the **editable body** of the draft's
 * prompt — the §9.4 platform rules are appended server-side and are shown read-only
 * underneath; there is no request through which they can be changed. Every pause in
 * typing runs the §9.5 lint on the server (`POST …/versions/:v/lint`, the same function a
 * save and a publish run) and the findings point at the field they concern. Save is
 * `PUT …/versions/:v/prompt`: a **new immutable version** (`source: manual`) that becomes
 * the draft; the version it was based on is kept. Leaving with unsaved changes asks first.
 *
 * Also the W2 "script" section: the wizard hosts the same editor under the brief once a
 * script exists, and listens to `onDirtyChange` so Continue waits for a save.
 */
export function PromptTab({ agent, canEdit, onDirtyChange }: { agent: AgentDetail; canEdit: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const t = useTranslations('dashboard.agents.prompt');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const base = agent.draft ?? agent.published;
  const [prompt, setPrompt] = React.useState(base?.editable_prompt ?? '');
  const [greeting, setGreeting] = React.useState(base?.greeting ?? '');
  const [closing, setClosing] = React.useState(base?.closing ?? '');
  const [lint, setLint] = React.useState<LintResult | null>(base?.lint ?? null);
  const [linting, setLinting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const baseKey = `${base?.version_no}|${base?.editable_prompt}|${base?.greeting}|${base?.closing}`;

  // A new base version (a save, a regenerate elsewhere) resets the editor to it — but not
  // over unsaved typing: that would silently throw the person's work away.
  const dirtyRef = React.useRef(false);
  React.useEffect(() => {
    if (dirtyRef.current) return;
    setPrompt(base?.editable_prompt ?? '');
    setGreeting(base?.greeting ?? '');
    setClosing(base?.closing ?? '');
    setLint(base?.lint ?? null);
  }, [baseKey]);

  const dirty = Boolean(base) && (prompt !== (base?.editable_prompt ?? '') || greeting !== (base?.greeting ?? '') || closing !== (base?.closing ?? ''));
  dirtyRef.current = dirty;
  React.useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  React.useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  // Lint replies can land out of order: a slow reply for text that has since changed must
  // not overwrite the findings for the text on screen. Each request takes a number and
  // only the newest one's answer is shown; a save retires whatever is still in flight.
  const lintSeq = React.useRef(0);
  const runLint = React.useCallback(
    async (p: string, g: string) => {
      if (!base) return;
      const seq = ++lintSeq.current;
      setLinting(true);
      try {
        const result = await lintVersionPrompt(api, { id: agent.id, v: String(base.version_no) }, { prompt: p, greeting: g || null });
        if (seq === lintSeq.current) setLint(result);
      } catch {
        // A lint that did not answer is not a finding; the save re-lints anyway.
      } finally {
        if (seq === lintSeq.current) setLinting(false);
      }
    },
    [api, agent.id, base],
  );
  const debouncedLint = useDebouncedCallback((p: string, g: string) => void runLint(p, g), 700);

  function onPrompt(v: string) {
    setPrompt(v);
    debouncedLint.call(v, greeting);
  }
  function onGreeting(v: string) {
    setGreeting(v);
    debouncedLint.call(prompt, v);
  }

  const tooShort = prompt.trim().length < MIN_PROMPT;
  const tooLong = prompt.length > MAX_PROMPT;
  const errors = lint?.findings.filter((f) => f.severity === 'error') ?? [];
  const warnings = lint?.findings.filter((f) => f.severity === 'warning') ?? [];
  const fieldFindings = (field: string) => lint?.findings.filter((f) => f.field === field) ?? [];

  async function save() {
    if (!base || !dirty || tooShort || tooLong) return;
    setSaving(true);
    setError(null);
    debouncedLint.cancel();
    lintSeq.current += 1; // a reply still in flight is for the text being saved; the save's own lint wins
    setLinting(false);
    try {
      const version = await updateVersionPrompt(api, { id: agent.id, v: String(base.version_no) }, { prompt, ...(greeting.trim() ? { greeting: greeting.trim() } : {}), ...(closing.trim() ? { closing: closing.trim() } : {}) });
      dirtyRef.current = false;
      setLint(version.lint);
      track('prompt_saved', { agent_id: agent.id, version_no: version.version_no, base_version: base.version_no, chars: prompt.length });
      toast.success(t('saved', { n: version.version_no }));
      await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] });
      void queryClient.invalidateQueries({ queryKey: ['listAgentVersions', { id: agent.id }] });
      void queryClient.invalidateQueries({ queryKey: ['listAgents'] });
    } catch (e) {
      if (isApiError(e, 'LINT_FAILED')) setError(tc('errors.LINT_FAILED'));
      else setError(errorMessage(e, tc));
    } finally {
      setSaving(false);
    }
  }

  if (!base) return <Alert variant="warning">{t('noVersion')}</Alert>;
  if (!base.has_prompt && !base.editable_prompt) return <Alert variant="warning">{t('noPrompt')}</Alert>;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{canEdit ? t('hint', { n: base.version_no }) : t('viewerHint', { n: base.version_no })}</p>
          <div className="flex items-center gap-2">
            {dirty ? <Badge variant="warning">{tc('common.unsaved')}</Badge> : null}
            {canEdit ? (
              <Button onClick={() => void save()} disabled={!dirty || tooShort || tooLong} loading={saving}>
                <Save /> {t('save')}
              </Button>
            ) : null}
          </div>
        </div>
        {error ? <Alert variant="danger">{error}</Alert> : null}

        <Field id="prompt-greeting" label={t('greeting')} description={t('greetingHint')} error={fieldFindings('greeting').map((f) => f.message).join(' ') || undefined}>
          <Input id="prompt-greeting" value={greeting} maxLength={500} disabled={!canEdit} onChange={(e) => onGreeting(e.target.value)} invalid={fieldFindings('greeting').some((f) => f.severity === 'error')} />
        </Field>

        <Field
          id="prompt-body"
          label={t('prompt')}
          description={t('promptHint')}
          addon={<span className={cn('tabular-nums', (tooShort || tooLong) && 'text-danger')}>{formatNumber(prompt.length, 0)} / {formatNumber(MAX_PROMPT, 0)}</span>}
          error={tooShort ? t('tooShort', { min: MIN_PROMPT }) : tooLong ? t('tooLong') : undefined}
        >
          <Textarea
            id="prompt-body"
            // The script is in the agent's language, not necessarily the portal's.
            dir="auto"
            value={prompt}
            rows={22}
            disabled={!canEdit}
            spellCheck={false}
            onChange={(e) => onPrompt(e.target.value)}
            invalid={fieldFindings('prompt').some((f) => f.severity === 'error')}
            className="min-h-[24rem] resize-y font-mono text-[13px] leading-relaxed"
          />
        </Field>

        <Field id="prompt-closing" label={t('closing')} description={t('closingHint')} optional optionalLabel={tc('common.optional')}>
          <Input id="prompt-closing" value={closing} maxLength={500} disabled={!canEdit} onChange={(e) => setClosing(e.target.value)} />
        </Field>

        <details className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">{t('guardrails')}</summary>
          <p className="mt-1 text-xs text-muted-foreground">{t('guardrailsHint')}</p>
          <pre dir="auto" className="mt-3 whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">{guardrailBlock(base.prompt_text, base.editable_prompt)}</pre>
        </details>
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {t('lintTitle')} {linting ? <Badge variant="outline">{t('linting')}</Badge> : null}
            </CardTitle>
            <CardDescription>{t('lintHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!lint ? (
              <p className="text-sm text-muted-foreground">{t('lintNone')}</p>
            ) : lint.findings.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-success-emphasis">
                <CheckCircle2 className="size-4" aria-hidden /> {t('lintClean')}
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{lint.publishable ? t('publishable') : t('notPublishable')}</p>
                <ul className="flex flex-col gap-2">
                  {[...errors, ...warnings].map((f, i) => (
                    <Finding key={`${f.rule}-${i}`} finding={f} />
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2 p-4 text-xs text-muted-foreground">
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t('versionNote')}
            </p>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function Finding({ finding }: { finding: LintFinding }) {
  const t = useTranslations('dashboard.agents.prompt');
  const copy = useServerCopy();
  const isError = finding.severity === 'error';
  const Icon = isError ? XCircle : AlertTriangle;
  return (
    <li className={cn('flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm', isError ? 'border-danger/30 bg-danger/5' : 'border-warning/40 bg-warning/10')}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', isError ? 'text-danger' : 'text-warning-emphasis')} aria-hidden />
      <div className="min-w-0">
        <p className="leading-snug">{copy.finding(finding)}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {t(`rules.${finding.rule}`)}
          {finding.field ? ` · ${t('field', { field: finding.field })}` : ''}
        </p>
      </div>
    </li>
  );
}

/** The §9.4 block: whatever the full prompt has that the editable body does not. */
function guardrailBlock(full: string | null, editable: string | null): string {
  if (!full) return '';
  if (!editable) return full;
  const idx = full.indexOf(editable.trim());
  if (idx < 0) return full;
  return `${full.slice(0, idx)}${full.slice(idx + editable.trim().length)}`.trim();
}
