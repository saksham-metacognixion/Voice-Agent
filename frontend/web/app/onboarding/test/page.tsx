'use client';

import type { AgentDetail } from '@portal/schemas';
import { Button, Checkbox } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
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
 * the trial credits (§5.4: browser only). Continue → onboarding_step 6.
 *
 * Spec W5 "Happiness checkbox" (QA-082): Continue waits for "I'm happy with how my agent
 * sounds". It is a soft gate — "Skip testing" continues after a warning — so a test call
 * is encouraged, never required. Both ways out are counted (`w5_happy` / `w5_skipped`,
 * the agent id and how many test calls this visit made, nothing else).
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
  const [happy, setHappy] = React.useState(false);
  const [skipOpen, setSkipOpen] = React.useState(false);
  const calls = React.useRef(new Set<string>());

  const onEnded = React.useCallback((callId: string) => {
    calls.current.add(callId);
    setLastCallId(callId);
  }, []);

  async function next(how: 'happy' | 'skipped') {
    if (leaving) return;
    setLeaving(true);
    track(how === 'happy' ? 'w5_happy' : 'w5_skipped', { agent_id: agent.id, test_calls: calls.current.size });
    await advance(6, 'test');
    router.push(routes.onboarding.phone);
  }

  return (
    <>
      <WizardHeading
        title={tw('title')}
        subtitle={tw('subtitle')}
        aside={
          <div className="flex flex-col gap-2 sm:items-end">
            <label htmlFor="w5-happy" className="flex items-center gap-2 text-sm font-medium">
              <Checkbox id="w5-happy" checked={happy} disabled={leaving} onCheckedChange={(v) => setHappy(v === true)} />
              {tw('happy')}
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="link" size="sm" className="px-0" disabled={leaving} onClick={() => setSkipOpen(true)}>
                {tw('skip')}
              </Button>
              <Button size="lg" onClick={() => void next('happy')} loading={leaving} disabled={leaving || !happy} aria-describedby={happy ? undefined : 'w5-happy-hint'}>
                {tw('continue')} {leaving ? null : <ArrowRight />}
              </Button>
            </div>
            {happy ? null : (
              <p id="w5-happy-hint" className="text-xs text-muted-foreground">
                {tw('happyHint')}
              </p>
            )}
          </div>
        }
      />
      <ConfirmDialog
        open={skipOpen}
        onOpenChange={setSkipOpen}
        title={tw('skipTitle')}
        description={tw('skipBody')}
        confirmLabel={tw('skipConfirm')}
        destructive={false}
        onConfirm={() => next('skipped')}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex flex-col gap-6">
          <TestCallPanel agent={agent} onEnded={onEnded} />
          {lastCallId ? <AfterCallCard key={lastCallId} callId={lastCallId} agent={agent} /> : null}
        </div>
        <div className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
          <ImprovePanel agent={agent} />
        </div>
      </div>
    </>
  );
}
