'use client';

import { useApi, useCreateAgent, useListTemplates } from '@portal/api-client';
import type { TemplateId } from '@portal/schemas';
import { Alert, Button, EmptyState, ErrorState, Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { track } from '@/src/analytics/posthog';
import { TemplatePicker, TemplatePickerSkeleton } from '@/src/components/wizard/template-picker';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { routes } from '@/src/routes';
import { industriesOf, industryConflicts } from '@/src/wizard/template-fit';
import { useAdvanceOnboarding, useOnboardingAgent } from '@/src/wizard/use-onboarding-agent';

/**
 * W1 — Choose what your agent does. `POST /agents {template_id, industry}` creates the
 * agent and its v1 draft pre-filled from the template (§9.2), then onboarding_step → 2.
 * Coming back with an agent already created: Continue keeps it; picking another template
 * makes a new agent (the old one stays in D3).
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
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const templates = useListTemplates(api, { staleTime: 5 * 60_000 });
  const { agent, query: agentQuery } = useOnboardingAgent();
  const create = useCreateAgent(api);
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

  const industries = React.useMemo(() => {
    const set = new Set<string>();
    for (const tpl of templates.data ?? []) for (const tag of tpl.industry_tags) if (tag !== 'generic') set.add(tag);
    return [...set].sort();
  }, [templates.data]);

  const keepExisting = agent && selected === agent.template_id;
  const busy = create.isPending;

  // The chosen industry against the chosen template. A mismatch — Restaurant for a
  // dental practice — is said out loud with the template that would fit, and left to
  // the person: nothing is guessed from a business name and nothing is refused.
  const selectedTemplate = templates.data?.find((x) => x.id === selected) ?? null;
  const conflict = industryConflicts(selectedTemplate, industry);
  const fitting = React.useMemo(() => {
    if (!conflict || !industry) return [];
    return (templates.data ?? []).filter((tpl) => tpl.id !== selected && tpl.industry_tags.includes(industry)).map((tpl) => tpl.name);
  }, [conflict, industry, templates.data, selected]);

  async function next() {
    if (!selected) return;
    setError(null);
    try {
      if (keepExisting) {
        track('template_selected', { template_id: selected, industry: industry || null, reused: true });
      } else {
        const created = await create.mutateAsync({ body: { template_id: selected, ...(industry ? { industry } : {}) } });
        track('template_selected', { template_id: selected, industry: industry || null, reused: false, agent_id: created.id });
        await queryClient.invalidateQueries({ queryKey: ['listAgents'] });
      }
      await advance(2, 'template');
      router.push(routes.onboarding.brief);
    } catch (e) {
      setError(errorMessage(e, t));
    }
  }

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
                {t('wizard.w1.existing', { template: templates.data.find((x) => x.id === agent.template_id)?.name ?? agent.name })}
              </Alert>
            ) : null}
            <TemplatePicker templates={templates.data} selected={selected} onSelect={(id) => setSelected(id as TemplateId)} disabled={busy} />
          </>
        )}

        {agentQuery.isError ? <Alert variant="warning">{errorMessage(agentQuery.error, t)}</Alert> : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {conflict && selectedTemplate ? (
          <Alert variant="warning" title={t('wizard.w1.conflictTitle')} data-testid="template-conflict">
            {t('wizard.w1.conflictBody', { template: selectedTemplate.name, industries: industriesOf(selectedTemplate).join(', '), industry })}
            {fitting.length ? ` ${t('wizard.w1.conflictSuggest', { industry, templates: fitting.join(', ') })}` : ''}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-card sm:flex-row sm:items-end sm:justify-between">
          <Field id="industry" label={t('wizard.w1.industry')} description={t('wizard.w1.industryHint')} className="w-full sm:max-w-xs">
            <Select value={industry || '__none'} onValueChange={(v) => setIndustry(v === '__none' ? '' : v)} disabled={busy}>
              <SelectTrigger id="industry">
                <SelectValue placeholder={t('wizard.w1.industryPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">{t('wizard.w1.industryOther')}</SelectItem>
                {industries.map((i) => (
                  <SelectItem key={i} value={i} className="capitalize">
                    {i}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button size="lg" onClick={next} disabled={!selected} loading={busy}>
            {busy ? t('wizard.w1.creating') : agent && !keepExisting ? t('wizard.w1.startOver') : t('wizard.w1.continue')}
            {busy ? null : <ArrowRight />}
          </Button>
        </div>
        {selected && templates.data?.find((x) => x.id === selected)?.default_tier === 'premium' ? (
          <p className="text-xs text-muted-foreground">{t('wizard.w1.premiumHint')}</p>
        ) : null}
      </div>
    </>
  );
}
