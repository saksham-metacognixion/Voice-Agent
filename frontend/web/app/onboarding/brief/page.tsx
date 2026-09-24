'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useApi, useGetAgent } from '@portal/api-client';
import { brief as briefSchema, briefReadyForGeneration, type Brief } from '@portal/schemas';
import { Button, ErrorState, PageLoader } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { track } from '@/src/analytics/posthog';
import { BriefCard } from '@/src/components/wizard/brief-card';
import { BriefFields, SaveIndicator, storableBrief } from '@/src/components/wizard/brief-form';
import { GeneratePanel } from '@/src/components/wizard/generate-panel';
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
  return <BriefForm key={detail.data.id} agentId={detail.data.id} initial={detail.data.draft.brief} />;
}

function BriefForm({ agentId, initial }: { agentId: string; initial: Brief }) {
  const t = useTranslations();
  const tw = useTranslations('wizard.w2');
  const api = useApi();
  const router = useRouter();
  const agent = useGetAgent(api, { id: agentId });
  const autosave = useBriefAutosave(agentId, initial);
  const generation = useGeneration(agent.data);
  const advance = useAdvanceOnboarding();
  const [genError, setGenError] = React.useState<string | null>(null);

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

  return (
    <>
      <WizardHeading
        title={tw('title')}
        subtitle={tw('hint')}
        aside={<SaveIndicator state={autosave.state} error={autosave.error} onRetry={autosave.retry} />}
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <BriefFields form={form} busy={busy} fieldErrors={autosave.fieldErrors} />
        <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
          <GeneratePanel
            agent={agent.data}
            generation={generation.state}
            slow={generation.slow}
            ready={ready}
            saving={autosave.state === 'saving'}
            onGenerate={(mode) => void generate(mode)}
            onContinue={() => void next()}
            error={genError}
          />
          <BriefCard brief={values} generated={generation.active ? null : agent.data?.draft?.brief_card} agentName={values.agent_name} />
        </aside>
      </div>
    </>
  );
}
