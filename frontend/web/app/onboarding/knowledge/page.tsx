'use client';

import { useApi, useGetFlags, useGetPricing } from '@portal/api-client';
import { knowledgeRolesFor, type AgentDetail } from '@portal/schemas';
import { Alert, Button, Skeleton } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { OnboardingAgentLoader } from '@/src/components/wizard/agent-loader';
import { KnowledgeSources } from '@/src/components/wizard/knowledge-sources';
import { MenuUpload } from '@/src/components/wizard/menu-upload';
import { AgentContextBanner } from '@/src/components/wizard/template-context';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { LiveGuard } from '@/src/guards/guards';
import { routes } from '@/src/routes';
import { cheapestPackWith } from '@/src/wizard/plan-gates';

/**
 * W4 — What your agent knows, **after payment** (ADR 0024). Sources need the
 * `knowledge_base` plan gate (§5.2: Starter includes none), which a trial workspace never
 * has, so asking before W7 only ever showed a locked form. It is now the first page once
 * the activation is live, behind `LiveGuard`: the pack is bought and the gate is whatever
 * that pack says. A pack without it still shows the form locked, naming the pack that
 * unlocks it. A source added here reaches the live agent on its own — the knowledge
 * worker republishes when it attaches a knowledge base to a live agent. Optional:
 * Continue (or "Skip for now") → `/onboarding/live`. The onboarding step is not touched;
 * `mark_live` already finished it.
 */
export default function KnowledgePage() {
  return (
    <LiveGuard>
      <OnboardingAgentLoader>{(agent) => <KnowledgeInner agent={agent} />}</OnboardingAgentLoader>
    </LiveGuard>
  );
}

function KnowledgeInner({ agent }: { agent: AgentDetail }) {
  const t = useTranslations();
  const tk = useTranslations('wizard.w4');
  const api = useApi();
  const router = useRouter();
  const flags = useGetFlags(api, { staleTime: 60_000 });
  const pricing = useGetPricing(api, undefined, { staleTime: 5 * 60_000 });
  const [leaving, setLeaving] = React.useState(false);

  // An unreadable /flags is not a reason to lock the form: the API enforces the gate and
  // answers PLAN_LIMIT, which the form shows.
  const locked = flags.data ? !flags.data.gates.knowledge_base : false;
  const unlock = cheapestPackWith(pricing.data, 'knowledge_base');

  async function next() {
    if (leaving) return;
    setLeaving(true);
    track('onboarding_step_completed', { step: 'knowledge', step_no: null });
    router.push(routes.onboarding.live);
  }

  return (
    <>
      <WizardHeading
        title={tk('title')}
        subtitle={
          <>
            {tk('subtitle')}
            <AgentContextBanner agent={agent} className="mt-2" />
          </>
        }
        aside={
          <Button size="lg" onClick={() => void next()} loading={leaving} disabled={leaving} variant={locked ? 'outline' : 'primary'}>
            {locked ? tk('skip') : tk('continue')} {leaving ? null : <ArrowRight />}
          </Button>
        }
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-4">
          {flags.isPending ? <Skeleton className="h-14 w-full" /> : null}
          {locked ? (
            <Alert variant="info" title={tk('lockedTitle')}>
              {unlock ? tk('lockedBody', { pack: unlock.name }) : tk('lockedBodyGeneric')}
            </Alert>
          ) : null}
          {knowledgeRolesFor(agent).includes('menu') ? <MenuUpload agentId={agent.id} locked={locked} published={Boolean(agent.published_version)} /> : null}
          <KnowledgeSources agentId={agent.id} locked={locked} />
        </div>
        <aside className="flex flex-col gap-3 text-sm text-muted-foreground lg:sticky lg:top-24 lg:self-start">
          <p className="font-medium text-foreground">{tk('asideTitle')}</p>
          <p>{tk('asideBody')}</p>
          <p>{t('dashboard.agents.knowledge.publishedHint')}</p>
        </aside>
      </div>
    </>
  );
}
