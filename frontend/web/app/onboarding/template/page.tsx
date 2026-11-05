'use client';

import { useApi, useCreateAgent, useListTemplates, useUpdateAgentDraft } from '@portal/api-client';
import { INDUSTRY_GROUPS, type TemplateId } from '@portal/schemas';
import { Alert, Button, Combobox, EmptyState, ErrorState, Field, type ComboboxGroup } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useServerCopy } from '@/src/i18n/server-copy';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { track } from '@/src/analytics/posthog';
import { TemplatePicker, TemplatePickerSkeleton } from '@/src/components/wizard/template-picker';
import { useWizardExit } from '@/src/components/wizard/wizard-exit';
import { WizardFooter, WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { useLocaleChoice } from '@/src/i18n/locale-provider';
import { errorMessage } from '@/src/lib/errors';
import { routes } from '@/src/routes';
import { startingLanguage } from '@/src/wizard/languages';
import { industriesOf, industryConflicts } from '@/src/wizard/template-fit';
import { useAdvanceOnboarding, useOnboardingAgent } from '@/src/wizard/use-onboarding-agent';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * W1 — Choose what your agent does. `POST /agents {template_id, industry}` creates the
 * agent and its v1 draft pre-filled from the template (§9.2), then onboarding_step → 2.
 * Coming back with an agent already created: Continue keeps it — saving a changed
 * industry onto it with `PATCH /agents/:id/draft {industry}` (QA-015) — and picking
 * another template makes a new agent (the old one stays in D3).
 *
 * The industry is the §8 "searchable select (≈ 40 options)": the catalogue is
 * `INDUSTRY_GROUPS` in `@portal/schemas` (ADR 0039), shown in the reader's language.
 *
 * The agent's main language starts from the workspace country (W3 "default: from
 * workspace country", `defaultAgentLanguage`); a Canadian business using the portal in
 * French starts on `fr-CA` instead, since the platform has no `en-CA` (ADR 0003 §6).
 */
export default function TemplatePage() {
  return (
    <OnboardingStepGuard step={1}>
      <TemplateInner />
    </OnboardingStepGuard>
  );
}

function TemplateInner() {
  const t = useTranslations();
  const copy = useServerCopy();
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const ws = useWorkspace();
  const { locale } = useLocaleChoice();
  const templates = useListTemplates(api, { staleTime: 5 * 60_000 });
  const { agent, query: agentQuery } = useOnboardingAgent();
  const create = useCreateAgent(api);
  const patchDraft = useUpdateAgentDraft(api);
  const advance = useAdvanceOnboarding();

  const [selected, setSelected] = React.useState<TemplateId | null>(null);
  const [industry, setIndustry] = React.useState<string>('');
  const [error, setError] = React.useState<string | null>(null);

  // Restore the previous choice once the existing agent is known.
  React.useEffect(() => {
    if (agent && selected === null) {
      setSelected(agent.template_id);
      setIndustry(agent.industry ?? '');
    }
  }, [agent, selected]);

  // The catalogue in the reader's language, grouped; an industry an older agent carries
  // that is not in it (a template tag of its own) is appended so the pick is still shown.
  const industryGroups = React.useMemo<ComboboxGroup[]>(() => {
    const groups: ComboboxGroup[] = INDUSTRY_GROUPS.map((group) => ({
      key: group.key,
      label: t(`wizard.w1.industryGroups.${group.key}`),
      options: group.industries.map((slug) => ({ value: slug, label: copy.industry(slug), keywords: [slug.replace(/_/g, ' ')] })),
    }));
    if (industry && !groups.some((g) => g.options.some((o) => o.value === industry))) {
      groups.push({ key: 'other', label: '', options: [{ value: industry, label: copy.industry(industry) }] });
    }
    return groups;
  }, [t, copy, industry]);

  const keepExisting = agent && selected === agent.template_id;
  const busy = create.isPending || patchDraft.isPending;

  // The chosen industry against the chosen template. A mismatch — Restaurant for a
  // dental practice — is said out loud with the template that would fit, and left to
  // the person: nothing is guessed from a business name and nothing is refused.
  const selectedTemplate = templates.data?.find((x) => x.id === selected) ?? null;
  // The agent's own template, named in the reader's language (QA-059).
  const existing = agent ? templates.data?.find((x) => x.id === agent.template_id) : undefined;
  const conflict = industryConflicts(selectedTemplate, industry);
  const fitting = React.useMemo(() => {
    if (!conflict || !industry) return [];
    return (templates.data ?? []).filter((tpl) => tpl.id !== selected && tpl.industry_tags.includes(industry)).map((tpl) => copy.templateName(tpl));
  }, [conflict, industry, templates.data, selected, copy]);

  /** Creates the agent, or writes a changed industry onto the one that exists. */
  async function save(): Promise<boolean> {
    if (!selected) return false;
    if (keepExisting) {
      // The industry is the agent's category (ADR 0020 §1): W2's placeholders and the
      // restaurant menu read it, so a change made here has to reach the agent.
      if ((agent.industry ?? '') !== industry) {
        await patchDraft.mutateAsync({ params: { id: agent.id }, body: { industry: industry || null } });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['listAgents'] }),
          queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] }),
        ]);
      }
      track('template_selected', { template_id: selected, industry: industry || null, reused: true });
    } else {
      const created = await create.mutateAsync({
        body: { template_id: selected, ...(industry ? { industry } : {}), primary_language: startingLanguage(ws.workspace?.country, locale) },
      });
      track('template_selected', { template_id: selected, industry: industry || null, reused: false, agent_id: created.id });
      await queryClient.invalidateQueries({ queryKey: ['listAgents'] });
    }
    return true;
  }

  async function next() {
    setError(null);
    try {
      if (!(await save())) return;
      await advance(2, 'template');
      router.push(routes.onboarding.brief);
    } catch (e) {
      setError(errorMessage(e, t));
    }
  }

  // "Save and exit" keeps the pick: the agent is created from it, as Continue would.
  useWizardExit(
    selected
      ? async () => {
          await save();
          await advance(2, 'template');
        }
      : null,
    busy,
  );

  return (
    <>
      <WizardHeading title={t('wizard.w1.title')} subtitle={t('wizard.w1.subtitle')} />
      <div className="flex flex-col gap-6">
        {templates.isPending || agent === undefined ? (
          <TemplatePickerSkeleton />
        ) : templates.isError ? (
          <ErrorState title={t('errors.loadFailed')} description={errorMessage(templates.error, t)} action={<Button onClick={() => void templates.refetch()}>{t('common.retry')}</Button>} />
        ) : templates.data.length === 0 ? (
          <EmptyState title={t('wizard.w1.empty')} />
        ) : (
          <>
            {agent ? (
              <Alert variant="neutral">
                {t('wizard.w1.existing', { template: existing ? copy.templateName(existing) : agent.name })}
              </Alert>
            ) : null}
            <TemplatePicker templates={templates.data} selected={selected} onSelect={(id) => setSelected(id as TemplateId)} disabled={busy} />
          </>
        )}

        {agentQuery.isError ? <Alert variant="warning">{errorMessage(agentQuery.error, t)}</Alert> : null}
        {conflict && selectedTemplate ? (
          <Alert variant="warning" title={t('wizard.w1.conflictTitle')} data-testid="template-conflict">
            {t('wizard.w1.conflictBody', { template: copy.templateName(selectedTemplate), industries: industriesOf(selectedTemplate).map(copy.industry).join(t('common.listSeparator')), industry: copy.industry(industry) })}
            {fitting.length ? ` ${t('wizard.w1.conflictSuggest', { industry: copy.industry(industry), templates: fitting.join(t('common.listSeparator')) })}` : ''}
          </Alert>
        ) : null}

        <div className="rounded-lg border border-border bg-card p-5 shadow-card">
          <Field id="industry" label={t('wizard.w1.industry')} description={t('wizard.w1.industryHint')} optional optionalLabel={t('common.optional')} className="w-full sm:max-w-sm">
            <Combobox
              id="industry"
              value={industry || null}
              onValueChange={(v) => setIndustry(v ?? '')}
              options={industryGroups}
              placeholder={t('wizard.w1.industryPlaceholder')}
              searchPlaceholder={t('wizard.w1.industrySearch')}
              emptyLabel={t('wizard.w1.industryEmpty')}
              clearLabel={t('wizard.w1.industryOther')}
              disabled={busy}
            />
          </Field>
          {selected && templates.data?.find((x) => x.id === selected)?.default_tier === 'premium' ? (
            <p className="mt-3 text-xs text-muted-foreground">{t('wizard.w1.premiumHint')}</p>
          ) : null}
        </div>
        {error ? <Alert variant="danger">{error}</Alert> : null}
      </div>

      <WizardFooter note={selected ? undefined : t('wizard.w1.pickFirst')}>
        <Button size="lg" onClick={() => void next()} disabled={!selected} loading={busy} data-testid="wizard-continue">
          {busy ? t('wizard.w1.creating') : agent && !keepExisting ? t('wizard.w1.startOver') : t('wizard.w1.continue')}
          {busy ? null : <ArrowRight aria-hidden />}
        </Button>
      </WizardFooter>
    </>
  );
}
