'use client';

import { brief as briefSchema, faqPair, handoffRule, type Brief } from '@portal/schemas';
import { Alert, Badge, Button, Field, Input, RadioCard, RadioGroup, TagInput, Textarea, cn } from '@portal/ui';
import { AlertCircle, Check, Cloud, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { BriefDocuments } from '@/src/components/wizard/brief-documents';
import { FaqEditor, HandoffRulesEditor, PersonalityEditor } from '@/src/components/wizard/brief-editors';
import { HoursEditor } from '@/src/components/wizard/hours-editor';
import { errorMessage } from '@/src/lib/errors';
import type { BriefPlaceholders } from '@/src/components/wizard/template-context';
import type { SaveState } from '@/src/wizard/use-brief-autosave';

/**
 * The 13 fields of `brief` (spec pp. 17–18) as one form body, shared by W2 and the D3
 * Brief tab so the wizard and the dashboard cannot drift on a field, a hint or a limit.
 * The page owns the `useForm` (and the autosave, generation and navigation around it);
 * this renders the sections and reports the errors the page hands it.
 */
export function BriefFields({ form, busy, fieldErrors, placeholders = {}, agentId = null }: { form: UseFormReturn<Brief>; busy: boolean; fieldErrors: Record<string, string>; placeholders?: BriefPlaceholders; agentId?: string | null }) {
  const t = useTranslations();
  const tw = useTranslations('wizard.w2');
  const tf = useTranslations('wizard.w2.fields');
  // The template's own example for the agent's industry (W1) beats the generic copy, so
  // a restaurant is not shown a dental practice as the model answer.
  const ph = (field: keyof BriefPlaceholders) => placeholders[field] ?? tf(`${field}.placeholder`);
  const values = form.watch();
  const err = form.formState.errors;
  const fe = fieldErrors;
  const msg = (field: keyof Brief, fallback?: string) => fe[field] ?? (err[field]?.message as string | undefined) ?? fallback;

  return (
    <form className="flex flex-col gap-10" onSubmit={(e) => e.preventDefault()} noValidate>
      <Section title={tw('sections.basics')}>
        <Field id="about_business" label={tf('about_business.label')} required description={tf('about_business.hint')} addon={<Counter value={values.about_business} max={1000} min={20} />} error={msg('about_business', err.about_business ? t('validation.min', { min: 20 }) : undefined)}>
          <Textarea id="about_business" rows={4} maxLength={1000} disabled={busy} placeholder={ph('about_business')} invalid={Boolean(err.about_business || fe.about_business)} {...form.register('about_business')} />
        </Field>
        <Field id="goal" label={tf('goal.label')} required description={tf('goal.hint')} addon={<Counter value={values.goal} max={800} min={20} />} error={msg('goal')}>
          <Textarea id="goal" rows={3} maxLength={800} disabled={busy} placeholder={ph('goal')} invalid={Boolean(err.goal || fe.goal)} {...form.register('goal')} />
        </Field>
        <Field id="agent_name" label={tf('agent_name.label')} description={tf('agent_name.hint')} error={msg('agent_name', err.agent_name ? t('validation.agentName') : undefined)}>
          <Input id="agent_name" maxLength={30} disabled={busy} placeholder={tf('agent_name.placeholder')} invalid={Boolean(err.agent_name)} className="sm:max-w-xs" {...form.register('agent_name', { setValueAs: (v: string) => (v?.trim() ? v : undefined) })} />
        </Field>
      </Section>

      {/* Right after the basics: a menu or price list — often a photo — is the first thing a
          restaurant or salon wants to hand over, and under the details it went unseen. */}
      <Section title={tw('sections.documents')}>
        <Field label={tf('documents.label')} description={tf('documents.hint')} error={msg('documents')}>
          <Controller control={form.control} name="documents" render={({ field }) => <BriefDocuments agentId={agentId} value={field.value ?? []} onChange={field.onChange} disabled={busy} />} />
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
          <Controller control={form.control} name="services" render={({ field }) => <TagInput id="services" value={field.value} onChange={field.onChange} max={30} maxLength={60} disabled={busy} placeholder={ph('services')} removeLabel={t('common.remove')} />} />
        </Field>
        <Field id="pricing" label={tf('pricing.label')} description={tf('pricing.hint')} addon={<Counter value={values.pricing} max={500} />} error={msg('pricing')}>
          <Textarea id="pricing" rows={2} maxLength={500} disabled={busy} placeholder={ph('pricing')} {...form.register('pricing', { setValueAs: (v: string) => (v?.trim() ? v : undefined) })} />
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
    <span className={cn('tabular-nums', short && 'text-warning-emphasis', n > max && 'text-danger')}>
      {n}/{max}
    </span>
  );
}

/** The autosave's state as a badge: dirty, saving, saved, or the error with a retry. */
export function SaveIndicator({ state, error, onRetry }: { state: SaveState; error: unknown; onRetry: () => void }) {
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

/**
 * What the autosave may send. A row the person just added (an empty FAQ, a handoff rule
 * without its number) is not storable yet, so it stays on the screen and out of the
 * PATCH until it is complete; any other field the at-rest schema refuses (a one-letter
 * agent name) is left out the same way. The form's own resolver shows the errors.
 */
export function storableBrief(value: unknown): Brief | null {
  const v = { ...(value as Record<string, unknown>) };
  if (Array.isArray(v.faqs)) v.faqs = v.faqs.filter((row) => faqPair.safeParse(row).success);
  if (Array.isArray(v.handoff_rules)) v.handoff_rules = v.handoff_rules.filter((row) => handoffRule.safeParse(row).success);
  const first = briefSchema.safeParse(v);
  if (first.success) return first.data;
  const refused = new Set(first.error.issues.map((issue) => String(issue.path[0])));
  for (const key of refused) delete v[key];
  const second = briefSchema.safeParse(v);
  if (!second.success) return null;
  // Drop them again after the parse, or a defaulted field (`faqs: []`) would be sent as a wipe.
  const out = second.data as Record<string, unknown>;
  for (const key of refused) delete out[key];
  return out as Brief;
}
