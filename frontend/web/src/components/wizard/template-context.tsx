'use client';

import { useApi, useListTemplates } from '@portal/api-client';
import type { AgentSummary, TemplateSummary } from '@portal/schemas';
import { Badge, cn } from '@portal/ui';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { exampleTextFor } from '@/src/wizard/template-fit';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * What the agent was built for, wherever the customer is editing it. The category is
 * `agents.template_id` (stored on W1, immutable after) plus the W1 industry; the business
 * is the workspace. Shown on W2/W4 and in the D3 header so a Restaurant agent for
 * "Bright Dental" reads as exactly that, on every screen, after every reload.
 */
export function TemplateBadge({ agent, className }: { agent: Pick<AgentSummary, 'template_id' | 'industry'>; className?: string }) {
  const ta = useTranslations('dashboard.agents');
  const label = agent.template_id ? ta(`templates.${agent.template_id}`) : ta('templates.custom');
  return (
    <Badge variant="primary" className={cn('capitalize', className)} data-testid="template-badge">
      {label}
      {agent.industry ? ` · ${agent.industry}` : ''}
    </Badge>
  );
}

export function AgentContextBanner({ agent, className }: { agent: Pick<AgentSummary, 'template_id' | 'industry' | 'name'>; className?: string }) {
  const t = useTranslations('wizard.context');
  const ta = useTranslations('dashboard.agents');
  const ws = useWorkspace();
  const template = agent.template_id ? ta(`templates.${agent.template_id}`) : ta('templates.custom');
  return (
    <p className={cn('flex flex-wrap items-center gap-2 text-sm text-muted-foreground', className)} data-testid="agent-context">
      <span>{t('building', { template, business: ws.workspace?.name ?? '' })}</span>
      <TemplateBadge agent={agent} />
    </p>
  );
}

/**
 * The template the agent was created from, for the W2 placeholder copy. Cached five
 * minutes like W1's list; null while loading or when the template is gone.
 */
export function useAgentTemplate(agent: Pick<AgentSummary, 'template_id'> | null | undefined): TemplateSummary | null {
  const api = useApi();
  const templates = useListTemplates(api, { staleTime: 5 * 60_000, enabled: Boolean(agent?.template_id) });
  return React.useMemo(() => templates.data?.find((tpl) => tpl.id === agent?.template_id) ?? null, [templates.data, agent?.template_id]);
}

/** Placeholder copy for the W2 fields, from the template's own examples for this industry. */
export function useBriefPlaceholders(agent: Pick<AgentSummary, 'template_id' | 'industry'> | null | undefined): BriefPlaceholders {
  const template = useAgentTemplate(agent);
  const tt = useTranslations('wizard.w2.templateCopy');
  return React.useMemo(() => {
    const out: BriefPlaceholders = {};
    const about = exampleTextFor(template, agent?.industry);
    if (about) out.about_business = about;
    if (agent?.template_id === 'restaurant') {
      out.goal = tt('restaurant.goal');
      out.services = tt('restaurant.services');
      out.pricing = tt('restaurant.pricing');
    }
    return out;
  }, [template, agent?.industry, agent?.template_id, tt]);
}

export type BriefPlaceholders = Partial<Record<'about_business' | 'goal' | 'services' | 'pricing', string>>;
