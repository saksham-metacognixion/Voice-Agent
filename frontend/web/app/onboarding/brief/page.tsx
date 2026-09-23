'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useApi, useGetAgent } from '@portal/api-client';
import { brief as briefSchema, briefReadyForGeneration, type Brief } from '@portal/schemas';
import { Alert, Badge, Button, ErrorState, Field, Input, PageLoader, RadioCard, RadioGroup, TagInput, Textarea, cn } from '@portal/ui';
import { AlertCircle, Check, Cloud, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { track } from '@/src/analytics/posthog';
import { BriefCard } from '@/src/components/wizard/brief-card';
import { FaqEditor, HandoffRulesEditor, PersonalityEditor } from '@/src/components/wizard/brief-editors';
import { GeneratePanel } from '@/src/components/wizard/generate-panel';
import { HoursEditor } from '@/src/components/wizard/hours-editor';
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
  const tf = useTranslations('wizard.w2.fields');
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
    const sub = form.watch((v) => autosave.onChange(briefSchema.parse(v)));
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

  const err = form.formState.errors;
  const fe = autosave.fieldErrors;
  const busy = generation.active;
  const msg = (field: keyof Brief, fallback?: string) => fe[field] ?? (err[field]?.message as string | undefined) ?? fallback;

  return (
    <>
      <WizardHeading
        title={tw('title')}
        subtitle={tw('hint')}
        aside={<SaveIndicator state={autosave.state} error={autosave.error} onRetry={autosave.retry} />}
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <form className="flex flex-col gap-10" onSubmit={(e) => e.preventDefault()} noValidate>
          <Section title={tw('sections.basics')}>
            <Field id="about_business" label={tf('about_business.label')} required description={tf('about_business.hint')} addon={<Counter value={values.about_business} max={1000} min={20} />} error={msg('about_business', err.about_business ? t('validation.min', { min: 20 }) : undefined)}>
              <Textarea id="about_business" rows={4} maxLength={1000} disabled={busy} placeholder={tf('about_business.placeholder')} invalid={Boolean(err.about_business || fe.about_business)} {...form.register('about_business')} />
            </Field>
            <Field id="goal" label={tf('goal.label')} required description={tf('goal.hint')} addon={<Counter value={values.goal} max={800} min={20} />} error={msg('goal')}>
              <Textarea id="goal" rows={3} maxLength={800} disabled={busy} placeholder={tf('goal.placeholder')} invalid={Boolean(err.goal || fe.goal)} {...form.register('goal')} />
            </Field>
            <Field id="agent_name" label={tf('agent_name.label')} description={tf('agent_name.hint')} error={msg('agent_name', err.agent_name ? t('validation.agentName') : undefined)}>
              <Input id="agent_name" maxLength={30} disabled={busy} placeholder={tf('agent_name.placeholder')} invalid={Boolean(err.agent_name)} className="sm:max-w-xs" {...form.register('agent_name', { setValueAs: (v: string) => (v?.trim() ? v : undefined) })} />
            </Field>
          </Section>

          <Section title={tw('sections.details')}>
            <Field label={tf('business_hours.label')} description={tf('business_hours.hint')} error={msg('business_hours')}>
              <Controller control={form.control} name="business_hours" render={({ field }) => <HoursEditor value={field.value} onChange={field.onChange} disabled={busy} />} />
            </Field>
            <Field id="address" label={tf('address.label')} description={tf('address.hint')} error={msg('address')}>
              <Input id="address" maxLength={200} disabled={busy} placeholder={tf('address.placeholder')} autoComplete="street-address" {...form.register('address', { setValueAs: (v: string) => (v?.trim() ? v : undefined) })} />
            </Field>
            <Field id="services" label={tf('services.label')} description={tf('services.hint')} error={msg('services')}>
              <Controller control={form.control} name="services" render={({ field }) => <TagInput id="services" value={field.value} onChange={field.onChange} max={30} maxLength={60} disabled={busy} placeholder={tf('services.placeholder')} removeLabel={t('common.remove')} />} />
            </Field>
            <Field id="pricing" label={tf('pricing.label')} description={tf('pricing.hint')} addon={<Counter value={values.pricing} max={500} />} error={msg('pricing')}>
              <Textarea id="pricing" rows={2} maxLength={500} disabled={busy} placeholder={tf('pricing.placeholder')} {...form.register('pricing', { setValueAs: (v: string) => (v?.trim() ? v : undefined) })} />
            </Field>
            <Field label={tf('faqs.label')} description={tf('faqs.hint')} error={msg('faqs')}>
              <Controller
                control={form.control}
                name="faqs"
                render={({ field }) => <FaqEditor value={field.value} onChange={field.onChange} disabled={busy} errors={(err.faqs as Array<{ question?: { message?: string }; answer?: { message?: string } }> | undefined)?.map((e) => (e ? { question: e.question?.message, answer: e.answer?.message } : undefined))} />}
              />
            </Field>
            <Field id="anything_else" label={tf('anything_else.label')} description={tf('anything_else.hint')} addon={<Counter value={values.anything_else} max={800} />} error={msg('anything_else')}>
              <Textarea id="anything_else" rows={3} maxLength={800} disabled={busy} placeholder={tf('anything_else.placeholder')} {...form.register('anything_else', { setValueAs: (v: string) => (v?.trim() ? v : undefined) })} />
            </Field>
          </Section>

          <Section title={tw('sections.rules')}>
            <Field id="never_do" label={tf('never_do.label')} description={tf('never_do.hint')} addon={<Counter value={values.never_do} max={500} />} error={msg('never_do')}>
              <Textarea id="never_do" rows={3} maxLength={500} disabled={busy} placeholder={tf('never_do.placeholder')} {...form.register('never_do', { setValueAs: (v: string) => (v?.trim() ? v : undefined) })} />
            </Field>
            <Field label={tf('handoff_rules.label')} description={tf('handoff_rules.hint')} error={msg('handoff_rules')}>
              <Controller
                control={form.control}
                name="handoff_rules"
                render={({ field }) => (
                  <HandoffRulesEditor
                    value={field.value}
                    onChange={field.onChange}
                    disabled={busy}
                    errors={(err.handoff_rules as Array<{ condition?: { message?: string }; transfer_number?: { message?: string } }> | undefined)?.map((e) =>
                      e ? { condition: e.condition?.message, transfer_number: e.transfer_number ? t('validation.transferNumber') : undefined } : undefined,
                    )}
                  />
                )}
              />
            </Field>
            <Field label={tf('ai_disclosure.label')} description={tf('ai_disclosure.hint')}>
              <Controller
                control={form.control}
                name="ai_disclosure"
                render={({ field }) => (
                  <RadioGroup value={field.value} onValueChange={field.onChange} disabled={busy} className="sm:grid-cols-3">
                    {(['always', 'if_asked', 'never_volunteer'] as const).map((opt) => (
                      <RadioCard key={opt} value={opt} title={tf(`ai_disclosure.${opt}.title`)} description={tf(`ai_disclosure.${opt}.body`)} />
                    ))}
                  </RadioGroup>
                )}
              />
            </Field>
          </Section>

          <Section title={tw('sections.personality')}>
            <Field label={tf('personality.label')} description={tf('personality.hint')}>
              <Controller control={form.control} name="personality" render={({ field }) => <PersonalityEditor value={field.value ?? { formality: 0.5, brevity: 0.5, energy: 0.5 }} onChange={field.onChange} disabled={busy} />} />
            </Field>
          </Section>
        </form>

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Counter({ value, max, min }: { value: string | undefined; max: number; min?: number }) {
  const n = value?.length ?? 0;
  const short = min !== undefined && n > 0 && n < min;
  return (
    <span className={cn('tabular-nums', short && 'text-warning-foreground dark:text-warning', n > max && 'text-danger')}>
      {n}/{max}
    </span>
  );
}

function SaveIndicator({ state, error, onRetry }: { state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'; error: unknown; onRetry: () => void }) {
  const t = useTranslations();
  if (state === 'idle') return null;
  if (state === 'error') {
    return (
      <Alert variant="danger" className="w-fit py-2" actions={<Button size="sm" variant="outline" onClick={onRetry}>{t('common.retry')}</Button>}>
        {t('common.saveFailed')}: {errorMessage(error, t)}
      </Alert>
    );
  }
  const Icon = state === 'saving' ? Loader2 : state === 'saved' ? Check : state === 'dirty' ? Cloud : AlertCircle;
  return (
    <Badge variant={state === 'saved' ? 'success' : 'outline'} className="h-7 gap-1.5 px-3" aria-live="polite">
      <Icon className={cn('size-3.5', state === 'saving' && 'animate-spin')} aria-hidden />
      {state === 'saving' ? t('common.saving') : state === 'saved' ? t('common.saved') : t('common.unsaved')}
    </Badge>
  );
}
