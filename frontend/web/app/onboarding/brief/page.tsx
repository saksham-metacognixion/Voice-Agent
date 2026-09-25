'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useApi, useGetAgent } from '@portal/api-client';
import { brief as briefSchema, briefReadyForGeneration, type AgentSummary, type Brief } from '@portal/schemas';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, PageLoader } from '@portal/ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { track } from '@/src/analytics/posthog';
import { PromptTab } from '@/src/components/dashboard/agent/prompt-tab';
import { BriefCard } from '@/src/components/wizard/brief-card';
import { BriefFields, SaveIndicator, storableBrief } from '@/src/components/wizard/brief-form';
import { GeneratePanel } from '@/src/components/wizard/generate-panel';
import { AgentContextBanner, useBriefPlaceholders } from '@/src/components/wizard/template-context';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { routes } from '@/src/routes';
import { useAdvanceOnboarding, useOnboardingAgent } from '@/src/wizard/use-onboarding-agent';
import { useBriefAutosave } from '@/src/wizard/use-brief-autosave';
import { useGeneration } from '@/src/wizard/use-generation';

/**
 * W2 — Tell us about your business. The 13 fields of `brief` (spec pp. 17–18), autosaved
 * 1.5 s after the last edit into the newest unpublished version, the BriefCard preview,
 * and Generate (§13.3) with SSE + polling progress. Generate is disabled until fields 1
 * and 2 are valid (`briefReadyForGeneration`).
 *
 * Once a script exists the page also hosts the D3 Advanced editor (`PromptTab`) under the
 * brief — "Edit the script" in the Generate panel opens it — so the generated script can
 * be read and edited like a document on the first screen, without leaving the wizard.
 * A save there is the same `PUT …/versions/:v/prompt` (a new immutable version); Continue
 * waits while the editor holds unsaved edits.
 */
export default function BriefPage() {
  return (
    <OnboardingStepGuard step={2}>
      <BriefLoader />
    </OnboardingStepGuard>
  );
}

function BriefLoader() {
  const t = useTranslations();
  const api = useApi();
  const router = useRouter();
  const { agent: summary, query } = useOnboardingAgent();
  const detail = useGetAgent(api, { id: summary?.id ?? '' }, { enabled: Boolean(summary?.id) });

  React.useEffect(() => {
    if (summary === null) router.replace(routes.onboarding.template);
  }, [summary, router]);

  if (query.isError) return <ErrorState title={t('errors.loadFailed')} description={errorMessage(query.error, t)} action={<Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>} />;
  if (detail.isError) return <ErrorState title={t('errors.loadFailed')} description={errorMessage(detail.error, t)} action={<Button onClick={() => void detail.refetch()}>{t('common.retry')}</Button>} />;
  if (!summary || !detail.data?.draft) return <PageLoader label={t('common.loading')} />;
  return <BriefForm key={detail.data.id} agentId={detail.data.id} initial={detail.data.draft.brief} context={detail.data} />;
}

function BriefForm({ agentId, initial, context }: { agentId: string; initial: Brief; context: AgentSummary }) {
  const t = useTranslations();
  const tw = useTranslations('wizard.w2');
  const api = useApi();
  const router = useRouter();
  const agent = useGetAgent(api, { id: agentId });
  const autosave = useBriefAutosave(agentId, initial);
  const generation = useGeneration(agent.data);
  const advance = useAdvanceOnboarding();
  const [genError, setGenError] = React.useState<string | null>(null);
  const [scriptOpen, setScriptOpen] = React.useState(false);
  const [scriptDirty, setScriptDirty] = React.useState(false);
  const scriptRef = React.useRef<HTMLElement>(null);
  const placeholders = useBriefPlaceholders(agent.data ?? context);

  const form = useForm<Brief>({
    // `brief` has defaults, so its input type is looser than `Brief`; the form always holds the parsed shape.
    resolver: zodResolver(briefSchema) as unknown as Resolver<Brief>,
    defaultValues: briefSchema.parse(initial),
    mode: 'onChange',
  });
  const values = form.watch();

  // Autosave on every change (debounced inside the hook).
  React.useEffect(() => {
    const sub = form.watch((v) => {
      const storable = storableBrief(v);
      if (storable) autosave.onChange(storable);
    });
    return () => sub.unsubscribe();
  }, [form, autosave]);

  const ready = briefReadyForGeneration.safeParse(values).success;
  const readyTracked = React.useRef(false);
  React.useEffect(() => {
    if (ready && !readyTracked.current) {
      readyTracked.current = true;
      track('brief_completed', { agent_id: agentId });
    }
  }, [ready, agentId]);

  async function generate(mode: 'generate' | 'regenerate') {
    setGenError(null);
    const valid = await form.trigger();
    if (!valid) {
      setGenError(t('errors.VALIDATION_FAILED'));
      return;
    }
    try {
      await autosave.flush();
      await generation.start(mode);
    } catch (e) {
      setGenError(errorMessage(e, t));
    }
  }

  React.useEffect(() => {
    if (generation.state.stage === 'done') void advance(3, 'brief');
  }, [generation.state.stage, advance]);

  async function next() {
    await autosave.flush();
    await advance(3, 'brief');
    router.push(routes.onboarding.voice);
  }

  const busy = generation.active;
  const hasScript = Boolean(agent.data?.draft?.has_prompt);

  function openScript() {
    setScriptOpen(true);
    track('script_editor_opened', { agent_id: agentId });
    // The section mounts on the next paint; scroll once it is there.
    requestAnimationFrame(() => scriptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  return (
    <>
      <WizardHeading
        title={tw('title')}
        subtitle={
          <>
            {tw('hint')}
            <AgentContextBanner agent={agent.data ?? context} className="mt-2" />
          </>
        }
        aside={<SaveIndicator state={autosave.state} error={autosave.error} onRetry={autosave.retry} />}
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <BriefFields form={form} busy={busy} fieldErrors={autosave.fieldErrors} placeholders={placeholders} />
        <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
          <GeneratePanel
            agent={agent.data}
            generation={generation.state}
            slow={generation.slow}
            ready={ready}
            saving={autosave.state === 'saving'}
            onGenerate={(mode) => void generate(mode)}
            onContinue={() => void next()}
            onEditScript={hasScript ? openScript : undefined}
            scriptDirty={scriptDirty}
            error={genError}
          />
          <BriefCard brief={values} generated={generation.active ? null : agent.data?.draft?.brief_card} agentName={values.agent_name} />
        </aside>
      </div>

      {hasScript && agent.data && !busy ? (
        <section ref={scriptRef} id="script" className="mt-10 scroll-mt-24" aria-labelledby="script-title" data-testid="script-section">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle id="script-title">{tw('script.title')}</CardTitle>
                <CardDescription className="mt-1">{tw('script.hint')}</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => setScriptOpen((o) => !o)} aria-expanded={scriptOpen} aria-controls="script-editor">
                {scriptOpen ? <ChevronUp /> : <ChevronDown />} {scriptOpen ? tw('script.hide') : tw('script.show')}
              </Button>
            </CardHeader>
            {/* Stays mounted while hidden so "Hide the script" does not throw unsaved edits away. */}
            <CardContent id="script-editor" className={scriptOpen ? 'flex flex-col gap-4' : 'hidden'} hidden={!scriptOpen}>
              <PromptTab agent={agent.data} canEdit onDirtyChange={setScriptDirty} />
              <p className="text-xs text-muted-foreground">{tw('script.regenerateNote')}</p>
            </CardContent>
          </Card>
        </section>
      ) : null}
    </>
  );
}
