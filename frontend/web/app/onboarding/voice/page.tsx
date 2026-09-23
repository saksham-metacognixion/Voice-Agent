'use client';

import { isApiError, useApi, useGetAgent, useListVoices, useUpdateAgentDraft } from '@portal/api-client';
import type { AgentDetail, RetellLanguage, VoiceResponse } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Field, PageLoader, Slider, toast } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { LanguagePicker } from '@/src/components/wizard/language-picker';
import { VoicePicker, type VoiceFilters } from '@/src/components/wizard/voice-picker';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { useDebouncedCallback } from '@/src/lib/use-debounced';
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
  const t = useTranslations();
  const tw = useTranslations('wizard.w3');
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const patch = useUpdateAgentDraft(api);
  const advance = useAdvanceOnboarding();
  const settings = agent.draft!.settings;

  const [primary, setPrimary] = React.useState<RetellLanguage>(settings.primary_language);
  const [languages, setLanguages] = React.useState<RetellLanguage[]>(settings.languages);
  const [voiceId, setVoiceId] = React.useState<string | null>(settings.voice_id);
  const [speed, setSpeed] = React.useState<number>(settings.voice_speed ?? 1);
  const [temperature, setTemperature] = React.useState<number>(settings.voice_temperature ?? 0.5);
  const [filters, setFilters] = React.useState<VoiceFilters>({ gender: '', tier: '', native: false, q: '' });
  const [q, setQ] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const debouncedQ = useDebouncedCallback((v: string) => setQ(v), 250);

  const voices = useListVoices(
    api,
    {
      // The full locale, not the base language: `fr-CA` puts a Quebec voice above a Paris
      // one, and both above the rest. `baseLanguage` was throwing that away.
      lang: primary,
      ...(filters.gender ? { gender: filters.gender } : {}),
      ...(filters.tier ? { tier: filters.tier } : {}),
      ...(filters.native ? { native: 'true' as const } : {}),
      ...(q ? { q } : {}),
    },
    { staleTime: 5 * 60_000 },
  );
  const selectedVoice = React.useMemo(() => voices.data?.items.find((v) => v.id === voiceId) ?? null, [voices.data, voiceId]);

  async function save(body: Parameters<typeof patch.mutateAsync>[0]['body']) {
    setError(null);
    setSaving(true);
    try {
      await patch.mutateAsync({ params: { id: agent.id }, body });
      await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] });
    } catch (e) {
      const msg = errorMessage(e, t);
      setError(msg);
      toast.error(msg);
      throw e;
    } finally {
      setSaving(false);
    }
  }

  function onPrimary(code: RetellLanguage) {
    setPrimary(code);
    const nextLangs = languages.filter((l) => l !== code);
    setLanguages(nextLangs);
    track('language_selected', { agent_id: agent.id, primary: code, extra: nextLangs.length });
    void save({ primary_language: code, languages: nextLangs }).catch(() => undefined);
  }
  function onLanguages(codes: RetellLanguage[]) {
    setLanguages(codes);
    track('language_selected', { agent_id: agent.id, primary, extra: codes.length });
    void save({ languages: codes }).catch(() => undefined);
  }
  function onSelect(voice: VoiceResponse) {
    const previous = voiceId;
    setVoiceId(voice.id);
    track('voice_selected', { agent_id: agent.id, voice_id: voice.id, tier: voice.tier });
    if (voice.tier !== settings.tier) toast.info(tw('tierChange', { tier: t(`common.${voice.tier}`) }));
    void save({ voice_id: voice.id, tier: voice.tier }).catch(() => setVoiceId(previous));
  }
  const saveTuning = useDebouncedCallback((s: number, temp: number) => void save({ voice_speed: s, voice_temperature: temp }).catch(() => undefined), 600);

  async function next() {
    if (!voiceId) return;
    await advance(4, 'voice');
    router.push(routes.onboarding.knowledge);
  }

  return (
    <>
      <WizardHeading
        title={tw('title')}
        subtitle={tw('subtitle')}
        aside={
          <Button size="lg" onClick={() => void next()} disabled={!voiceId || saving} loading={saving}>
            {saving ? tw('saving') : tw('continue')} {saving ? null : <ArrowRight />}
          </Button>
        }
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-8">
          {error ? <Alert variant="danger">{error}</Alert> : null}
          <LanguagePicker primary={primary} languages={languages} onPrimaryChange={onPrimary} onLanguagesChange={onLanguages} disabled={saving} />
          {voices.data?.stale ? <Alert variant="warning">{tw('stale')}</Alert> : null}
          {voices.isError ? (
            <ErrorState title={t('errors.loadFailed')} description={errorMessage(voices.error, t)} action={<Button onClick={() => void voices.refetch()}>{t('common.retry')}</Button>} />
          ) : (
            <VoicePicker
              voices={voices.data?.items ?? []}
              loading={voices.isPending}
              selectedId={voiceId}
              filters={filters}
              onFiltersChange={(f) => {
                setFilters(f);
                debouncedQ.call(f.q);
              }}
              onSelect={onSelect}
              language={primary}
              rate={speed}
              onPreview={(voice, kind) => track('voice_preview_played', { agent_id: agent.id, voice_id: voice.id, kind })}
              onPreviewError={(e) => toast.error(isApiError(e, 'RATE_LIMITED') ? tw('previewLimited') : tw('previewFailed'))}
            />
          )}
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>{tw('selected')}</CardTitle>
              <CardDescription>{selectedVoice ? `${selectedVoice.name} · ${t(`common.${selectedVoice.tier}`)}` : voiceId ? voiceId : tw('noneSelected')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <p className="text-xs text-muted-foreground">{tw('advancedHint')}</p>
              <p className="text-xs text-muted-foreground">{tw('sampleHint')}</p>
              <Field label={tw('speed')} addon={`${speed.toFixed(2)}×`}>
                <Slider
                  value={[Math.round(speed * 100)]}
                  min={80}
                  max={120}
                  step={5}
                  disabled={!voiceId}
                  aria-label={tw('speed')}
                  onValueChange={([v]) => {
                    const s = (v ?? 100) / 100;
                    setSpeed(s);
                    saveTuning.call(s, temperature);
                  }}
                />
              </Field>
              <Field label={tw('temperature')} addon={temperature.toFixed(2)} description={tw('temperatureHint')}>
                <Slider
                  value={[Math.round(temperature * 100)]}
                  min={0}
                  max={100}
                  step={5}
                  disabled={!voiceId}
                  aria-label={tw('temperature')}
                  onValueChange={([v]) => {
                    const temp = (v ?? 50) / 100;
                    setTemperature(temp);
                    saveTuning.call(speed, temp);
                  }}
                />
              </Field>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
