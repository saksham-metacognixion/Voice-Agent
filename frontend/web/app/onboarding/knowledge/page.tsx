'use client';

import { useApi, useGetFlags, useGetPricing } from '@portal/api-client';
import { knowledgeRolesFor, type AgentDetail } from '@portal/schemas';
import { Alert, Button, Skeleton } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { OnboardingAgentLoader } from '@/src/components/wizard/agent-loader';
import { KnowledgeSources } from '@/src/components/wizard/knowledge-sources';
import { MenuUpload } from '@/src/components/wizard/menu-upload';
import { AgentContextBanner } from '@/src/components/wizard/template-context';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { routes } from '@/src/routes';
import { cheapestPackWith } from '@/src/wizard/plan-gates';
import { useAdvanceOnboarding } from '@/src/wizard/use-onboarding-agent';

/**
 * W4 — What your agent knows. Optional: a customer can continue with nothing added.
 * Sources need the `knowledge_base` plan gate (§5.2: Starter includes none), which a
 * trial workspace does not have — so before a purchase the form is shown locked, with
 * the pack that unlocks it named from `GET /pricing`, and Continue reads "Skip for now".
 * Continue → onboarding_step 5.
 */
export default function KnowledgePage() {
  return (
    <OnboardingStepGuard step={4}>
      <OnboardingAgentLoader>{(agent) => <KnowledgeInner agent={agent} />}</OnboardingAgentLoader>
    </OnboardingStepGuard>
  );
}

function KnowledgeInner({ agent }: { agent: AgentDetail }) {
  const tk = useTranslations('wizard.w4');
  const api = useApi();
  const router = useRouter();
  const advance = useAdvanceOnboarding();
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
    await advance(5, 'knowledge');
    router.push(routes.onboarding.test);
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
          <p>{tk('asideLive')}</p>
        </aside>
      </div>
    </>
  );
}
