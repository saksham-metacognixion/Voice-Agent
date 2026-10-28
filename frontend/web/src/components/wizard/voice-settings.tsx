'use client';

import { isApiError, useApi, useListVoices, useUpdateAgentDraft, type ApiClient } from '@portal/api-client';
import { agentDetail, type agentDraftPatch, type AgentDetail, type AgentLanguage, type VoiceResponse } from '@portal/schemas';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Button, Field, Slider, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import type { z } from 'zod';
import { track } from '@/src/analytics/posthog';
import { LanguagePicker } from '@/src/components/wizard/language-picker';
import { VoicePicker, type VoiceFilters } from '@/src/components/wizard/voice-picker';
import { errorMessage } from '@/src/lib/errors';
import { useBeforeUnload } from '@/src/lib/use-before-unload';
import { useDebouncedCallback } from '@/src/lib/use-debounced';
import { languageName, type LanguageChoice } from '@/src/wizard/languages';
import { scriptNeedsRewrite } from '@/src/wizard/script-language';
import { useGeneration } from '@/src/wizard/use-generation';

export interface VoiceSettingsState {
  voiceId: string | null;
  /** A save is in flight **or** waiting out its debounce — Continue must wait for both (QA-007). */
  saving: boolean;
}

/**
 * W3's body, shared with the D3 Voice tab: main language, "also speaks", the voice
 * picker and the two dials. Every choice is a `PATCH /agents/:id/draft` onto the draft
 * version's settings (nothing goes live until publish, ADR 0012); picking a Premium
 * voice moves the draft to the Premium tier.
 *
 * The main language ranks the list rather than cutting it: every voice reads every
 * language we offer, so the ones that sound native come first and the rest follow under
 * their own heading (`native` on the response, `voice-languages.ts` on the API side).
 *
 * The sample is a recording, not the agent: there is no text-to-speech route to speak the
 * customer's own greeting with (ADR 0003 §9), so the copy says where they will hear it
 * instead of pretending. Speed is applied to the playback so that dial can at least be heard.
 *
 * The dials save 600 ms after the last move. That pending save counts as saving (Continue
 * waits for it), is sent rather than dropped if the page goes away, and closing the tab
 * with it pending asks first (QA-007).
 *
 * The script is written on W2, before the language is chosen here. When the draft's
 * greeting is not in the main language (`scriptNeedsRewrite`, ADR 0027) the screen offers
 * to rewrite it from the brief in that language — the same regenerate W2 runs, which
 * reads the draft's settings. A rewrite in flight counts as saving too.
 */
export function VoiceSettings({ agent, disabled, onStateChange }: { agent: AgentDetail; disabled?: boolean; onStateChange?: (state: VoiceSettingsState) => void }) {
  const t = useTranslations();
  const tw = useTranslations('wizard.w3');
  const api = useApi();
  const queryClient = useQueryClient();
  const patch = useUpdateAgentDraft(api);
  const settings = agent.draft?.settings ?? agent.published?.settings;

  const [primary, setPrimary] = React.useState<AgentLanguage>(settings?.primary_language ?? 'en-US');
  const [languages, setLanguages] = React.useState<AgentLanguage[]>(settings?.languages ?? []);
  const [voiceId, setVoiceId] = React.useState<string | null>(settings?.voice_id ?? null);
  const [speed, setSpeed] = React.useState<number>(settings?.voice_speed ?? 1);
  const [temperature, setTemperature] = React.useState<number>(settings?.voice_temperature ?? 0.5);
  const [filters, setFilters] = React.useState<VoiceFilters>({ gender: '', tier: '', native: false, q: '' });
  const [q, setQ] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [tuningPending, setTuningPending] = React.useState(false);
  const inFlight = React.useRef(0);
  const debouncedQ = useDebouncedCallback((v: string) => setQ(v), 250);
  const generation = useGeneration(agent);

  const report = React.useRef(onStateChange);
  report.current = onStateChange;
  const busy = saving || tuningPending || generation.active;
  React.useEffect(() => {
    report.current?.({ voiceId, saving: busy });
  }, [voiceId, busy]);

  const voices = useListVoices(
    api,
    {
      // The full locale, not the base language: `fr-CA` puts a Quebec voice above a Paris
      // one, and both above the rest.
      lang: primary,
      ...(filters.gender ? { gender: filters.gender } : {}),
      ...(filters.tier ? { tier: filters.tier } : {}),
      ...(filters.native ? { native: 'true' as const } : {}),
      ...(q ? { q } : {}),
    },
    { staleTime: 5 * 60_000 },
  );
  // The picker's filters can hide the selected voice ("Native accents only" on an agent
  // whose voice has another accent), so the name never comes from the filtered list alone:
  // the voice last seen in any list is remembered, and failing that the unfiltered
  // catalogue (cached, fetched only when needed) is asked. The raw id is never shown.
  const listed = React.useMemo(() => voices.data?.items.find((v) => v.id === voiceId) ?? null, [voices.data, voiceId]);
  const [remembered, setRemembered] = React.useState<VoiceResponse | null>(null);
  React.useEffect(() => {
    if (listed) setRemembered(listed);
  }, [listed]);
  const known = listed ?? (remembered?.id === voiceId ? remembered : null);
  const catalogue = useListVoices(api, {}, { staleTime: 5 * 60_000, enabled: Boolean(voiceId) && !known && !voices.isPending });
  const selectedVoice = known ?? catalogue.data?.items.find((v) => v.id === voiceId) ?? null;

  /** `workspaceId` pins a deferred save to the workspace it was made in (QA-056). */
  async function save(body: Parameters<typeof patch.mutateAsync>[0]['body'], workspaceId?: string) {
    setError(null);
    inFlight.current += 1;
    setSaving(true);
    try {
      if (workspaceId) await updateAgentDraftIn(api, agent.id, body, workspaceId);
      else await patch.mutateAsync({ params: { id: agent.id }, body });
      await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] });
      void queryClient.invalidateQueries({ queryKey: ['listAgents'] });
    } catch (e) {
      const msg = errorMessage(e, t);
      setError(msg);
      toast.error(msg);
      throw e;
    } finally {
      // Saves can overlap (a voice pick while a dial save is out); "saving" ends with the last.
      inFlight.current -= 1;
      if (inFlight.current === 0) setSaving(false);
    }
  }

  /** Main language and "also speaks" move together, in one save (QA-011). */
  function onLanguageChange(next: LanguageChoice) {
    setPrimary(next.primary_language);
    setLanguages(next.languages);
    track('language_selected', { agent_id: agent.id, primary: next.primary_language, extra: next.languages.length });
    void save(next.primary_language === primary ? { languages: next.languages } : next).catch(() => undefined);
  }
  function onSelect(voice: VoiceResponse) {
    const previous = voiceId;
    setVoiceId(voice.id);
    setRemembered(voice);
    track('voice_selected', { agent_id: agent.id, voice_id: voice.id, tier: voice.tier });
    if (settings && voice.tier !== settings.tier) toast.info(tw('tierChange', { tier: t(`common.${voice.tier}`) }));
    void save({ voice_id: voice.id, tier: voice.tier }).catch(() => setVoiceId(previous));
  }
  // The unmount flush of a workspace switch runs after the new workspace is selected, so
  // the dial save carries the workspace it was dialled in (QA-056).
  const tuningWorkspace = React.useRef<string | null>(null);
  const saveTuning = useDebouncedCallback(
    (s: number, temp: number) => {
      setTuningPending(false);
      void save({ voice_speed: s, voice_temperature: temp }, tuningWorkspace.current ?? undefined).catch(() => undefined);
    },
    600,
    { flushOnUnmount: true },
  );
  const tune = (s: number, temp: number) => {
    tuningWorkspace.current = api.options.getWorkspaceId();
    setTuningPending(true);
    saveTuning.call(s, temp);
  };
  useBeforeUnload(busy, saveTuning.flush);
  const locked = Boolean(disabled) || saving || generation.active;
  // The draft's own language, not the picker's: the rewrite reads what was saved.
  const draftLanguage = agent.draft?.settings.primary_language ?? primary;
  const rewrite =
    Boolean(agent.draft?.has_prompt) && !disabled && (generation.active || scriptNeedsRewrite(agent.draft?.greeting, draftLanguage));
  const rewriteLanguage = languageName(draftLanguage);
  function onRewrite() {
    track('script_rewrite_clicked', { agent_id: agent.id, primary: draftLanguage });
    generation.start('regenerate').catch((e: unknown) => toast.error(errorMessage(e, t)));
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-8">
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <LanguagePicker primary={primary} languages={languages} onChange={onLanguageChange} disabled={locked} />
        {rewrite ? (
          <Alert
            variant={generation.state.stage === 'failed' ? 'danger' : 'warning'}
            title={tw('rewrite.title', { language: rewriteLanguage })}
            aria-live="polite"
            actions={
              generation.active ? null : (
                <Button size="sm" onClick={onRewrite} disabled={saving}>
                  {tw('rewrite.action', { language: rewriteLanguage })}
                </Button>
              )
            }
          >
            {generation.active
              ? tw('rewrite.running', { language: rewriteLanguage })
              : generation.state.stage === 'failed'
                ? tw('rewrite.failed')
                : tw('rewrite.body', { language: rewriteLanguage })}
          </Alert>
        ) : null}
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
            disabled={Boolean(disabled)}
            onPreview={(voice, kind) => track('voice_preview_played', { agent_id: agent.id, voice_id: voice.id, kind })}
            onPreviewError={(e) => toast.error(isApiError(e, 'RATE_LIMITED') ? tw('previewLimited') : tw('previewFailed'))}
          />
        )}
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
        <Card>
          <CardHeader>
            <CardTitle>{tw('selected')}</CardTitle>
            <CardDescription>{selectedVoice ? `${selectedVoice.name} · ${t(`common.${selectedVoice.tier}`)}` : voiceId ? tw('currentVoice') : tw('noneSelected')}</CardDescription>
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
                disabled={!voiceId || Boolean(disabled)}
                aria-label={tw('speed')}
                onValueChange={([v]) => {
                  const s = (v ?? 100) / 100;
                  setSpeed(s);
                  tune(s, temperature);
                }}
              />
            </Field>
            <Field label={tw('temperature')} addon={temperature.toFixed(2)} description={tw('temperatureHint')}>
              <Slider
                value={[Math.round(temperature * 100)]}
                min={0}
                max={100}
                step={5}
                disabled={!voiceId || Boolean(disabled)}
                aria-label={tw('temperature')}
                onValueChange={([v]) => {
                  const temp = (v ?? 50) / 100;
                  setTemperature(temp);
                  tune(speed, temp);
                }}
              />
            </Field>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function updateAgentDraftIn(api: ApiClient, agentId: string, body: z.input<typeof agentDraftPatch>, workspaceId: string) {
  return api.patch(`/agents/${encodeURIComponent(agentId)}/draft`, body, agentDetail, { workspaceId });
}
