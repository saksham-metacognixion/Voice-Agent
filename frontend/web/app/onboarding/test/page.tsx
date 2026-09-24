'use client';

import type { AgentDetail } from '@portal/schemas';
import { Button } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { AfterCallCard } from '@/src/components/wizard/after-call-card';
import { OnboardingAgentLoader } from '@/src/components/wizard/agent-loader';
import { ImprovePanel } from '@/src/components/wizard/improve-panel';
import { TestCallPanel } from '@/src/components/wizard/test-call-panel';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { routes } from '@/src/routes';
import { useAdvanceOnboarding } from '@/src/wizard/use-onboarding-agent';

/**
 * W5 — Test and improve (§8, §12.3). Talk to the draft in the browser, read what the
 * call captured, say what to change, and test the new version. Test calls are paid from
 * the trial credits (§5.4: browser only). Continue → onboarding_step 6; a test call is
 * encouraged, not required.
 */
export default function TestPage() {
  return (
    <OnboardingStepGuard step={5}>
      <OnboardingAgentLoader>{(agent) => <TestInner agent={agent} />}</OnboardingAgentLoader>
    </OnboardingStepGuard>
  );
}

function TestInner({ agent }: { agent: AgentDetail }) {
  const tw = useTranslations('wizard.w5');
  const router = useRouter();
  const advance = useAdvanceOnboarding();
  const [lastCallId, setLastCallId] = React.useState<string | null>(null);
  const [leaving, setLeaving] = React.useState(false);

  async function next() {
    if (leaving) return;
    setLeaving(true);
    await advance(6, 'test');
    router.push(routes.onboarding.phone);
  }

  return (
    <>
      <WizardHeading
        title={tw('title')}
        subtitle={tw('subtitle')}
        aside={
          <Button size="lg" onClick={() => void next()} loading={leaving} disabled={leaving} variant={lastCallId ? 'primary' : 'outline'}>
            {tw('continue')} {leaving ? null : <ArrowRight />}
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex flex-col gap-6">
          <TestCallPanel agent={agent} onEnded={setLastCallId} />
          {lastCallId ? <AfterCallCard key={lastCallId} callId={lastCallId} agent={agent} /> : null}
        </div>
        <div className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
          <ImprovePanel agent={agent} />
        </div>
      </div>
    </>
  );
}
