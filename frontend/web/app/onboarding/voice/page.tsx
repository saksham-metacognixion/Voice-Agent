'use client';

import { useApi, useGetAgent } from '@portal/api-client';
import type { AgentDetail } from '@portal/schemas';
import { Button, ErrorState, PageLoader } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { VoiceSettings, type VoiceSettingsState } from '@/src/components/wizard/voice-settings';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { routes } from '@/src/routes';
import { useAdvanceOnboarding, useOnboardingAgent } from '@/src/wizard/use-onboarding-agent';

/**
 * W3 — Choose a voice and languages. Every choice is a `PATCH /agents/:id/draft` onto the
 * draft version's settings (nothing goes live until publish, ADR 0012); picking a Premium
 * voice moves the draft to the Premium tier. Continue → onboarding_step 4.
 *
 * The main language ranks the list rather than cutting it: every voice reads every
 * language we offer, so the ones that sound native come first and the rest follow under
 * their own heading (`native` on the response, `voice-languages.ts` on the API side).
 *
 * The sample is a recording, not the agent: there is no text-to-speech route to speak the
 * customer's own greeting with (ADR 0003 §9), so W3 says where they will hear it instead
 * of pretending. Speed is applied to the playback so that dial can at least be heard.
 */
export default function VoicePage() {
  return (
    <OnboardingStepGuard step={3}>
      <VoiceLoader />
    </OnboardingStepGuard>
  );
}

function VoiceLoader() {
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
  return <VoiceInner key={detail.data.id} agent={detail.data} />;
}

function VoiceInner({ agent }: { agent: AgentDetail }) {
  const tw = useTranslations('wizard.w3');
  const router = useRouter();
  const advance = useAdvanceOnboarding();
  const [state, setState] = React.useState<VoiceSettingsState>({ voiceId: agent.draft?.settings.voice_id ?? null, saving: false });

  async function next() {
    if (!state.voiceId) return;
    await advance(4, 'voice');
    router.push(routes.onboarding.knowledge);
  }

  return (
    <>
      <WizardHeading
        title={tw('title')}
        subtitle={tw('subtitle')}
        aside={
          <Button size="lg" onClick={() => void next()} disabled={!state.voiceId || state.saving} loading={state.saving}>
            {state.saving ? tw('saving') : tw('continue')} {state.saving ? null : <ArrowRight />}
          </Button>
        }
      />
      <VoiceSettings agent={agent} onStateChange={setState} />
    </>
  );
}
