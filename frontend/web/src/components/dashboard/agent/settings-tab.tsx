'use client';

import { useApi, useUpdateAgentDraft } from '@portal/api-client';
import type { AgentDetail, AgentTier } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, RadioCard, RadioGroup, Slider, Switch, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { formatDuration } from '@/src/lib/format';
import { usePlanGate } from '@/src/dashboard/use-plan-gate';
import { routes, settingsPath } from '@/src/routes';
import { DeleteAgentDialog, useAgentActions } from './agent-actions';

/**
 * D3 Settings (spec p. 36). Name and industry are labels on the agent; tier, the call
 * ceiling and recording are `agentSettings` on the **draft version** and go live at the
 * next publish (ADR 0012 — the live copy on `agents` is what bills). Pause, resume and
 * delete are owner/admin; delete is refused while a number points at the agent.
 */
export function SettingsTab({ agent, canEdit, canAdmin }: { agent: AgentDetail; canEdit: boolean; canAdmin: boolean }) {
  const t = useTranslations('dashboard.agents.settings');
  const tc = useTranslations();
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const patch = useUpdateAgentDraft(api);
  const actions = useAgentActions();
  const settings = agent.draft?.settings;

  const [name, setName] = React.useState(agent.name);
  const [industry, setIndustry] = React.useState(agent.industry ?? '');
  const [tier, setTier] = React.useState<AgentTier>(settings?.tier ?? agent.tier);
  const [maxS, setMaxS] = React.useState(settings?.max_call_duration_s ?? agent.max_call_duration_s);
  const [recording, setRecording] = React.useState(settings?.recording_enabled ?? agent.recording_enabled);
  const [denoise, setDenoise] = React.useState(settings?.denoise ?? false);
  const [pii, setPii] = React.useState(settings?.pii_removal ?? false);
  const denoiseGate = usePlanGate('denoise');
  const piiGate = usePlanGate('pii_removal');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const dirty = name.trim() !== agent.name || (industry.trim() || '') !== (agent.industry ?? '') || (settings ? tier !== settings.tier || maxS !== settings.max_call_duration_s || recording !== settings.recording_enabled || denoise !== settings.denoise || pii !== settings.pii_removal : false);

  async function save() {
    setError(null);
    try {
      await patch.mutateAsync({
        params: { id: agent.id },
        body: {
          ...(name.trim() !== agent.name ? { name: name.trim() } : {}),
          ...(industry.trim() && industry.trim() !== agent.industry ? { industry: industry.trim() } : {}),
          ...(settings && tier !== settings.tier ? { tier } : {}),
          ...(settings && maxS !== settings.max_call_duration_s ? { max_call_duration_s: maxS } : {}),
          ...(settings && recording !== settings.recording_enabled ? { recording_enabled: recording } : {}),
          ...(settings && denoise !== settings.denoise ? { denoise } : {}),
          ...(settings && pii !== settings.pii_removal ? { pii_removal: pii } : {}),
        },
      });
      await refresh();
      toast.success(t('saved'));
      track('agent_settings_saved', { agent_id: agent.id });
    } catch (e) {
      setError(errorMessage(e, tc));
    }
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] });
    void queryClient.invalidateQueries({ queryKey: ['listAgents'] });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('general')}</CardTitle>
            <CardDescription>{t('generalHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {error ? <Alert variant="danger">{error}</Alert> : null}
            <Field id="agent-name" label={t('name')} description={t('nameHint')}>
              <Input id="agent-name" value={name} maxLength={60} minLength={2} disabled={!canEdit} onChange={(e) => setName(e.target.value)} className="sm:max-w-sm" />
            </Field>
            <Field id="agent-industry" label={t('industry')} optional optionalLabel={tc('common.optional')}>
              <Input id="agent-industry" value={industry} maxLength={60} disabled={!canEdit} onChange={(e) => setIndustry(e.target.value)} className="sm:max-w-sm" />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('calls')}</CardTitle>
            <CardDescription>{t('callsHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <Field label={t('tier')} description={t('tierHint')}>
              <RadioGroup value={tier} onValueChange={(v) => setTier(v as AgentTier)} disabled={!canEdit || !settings} className="sm:grid-cols-2">
                <RadioCard value="standard" title={tc('common.standard')} description={t('standardBody', { rate: tc('common.standardRate') })} />
                <RadioCard value="premium" title={tc('common.premium')} description={t('premiumBody', { rate: tc('common.premiumRate') })} />
              </RadioGroup>
            </Field>
            <Field label={t('maxDuration')} description={t('maxDurationHint')} addon={formatDuration(maxS)}>
              <Slider value={[maxS]} min={180} max={1_800} step={60} disabled={!canEdit || !settings} aria-label={t('maxDuration')} onValueChange={([v]) => setMaxS(v ?? 600)} />
            </Field>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{t('recording')}</p>
                <p className="text-xs text-muted-foreground">{t('recordingHint')}</p>
              </div>
              <Switch checked={recording} disabled={!canEdit || !settings} onCheckedChange={setRecording} aria-label={t('recording')} />
            </div>
            {/* QA-079: the two plan-gated add-ons. Locked, a switch that is on can still be
                turned off — the API refuses only turning one on. */}
            <AddOnSwitch label={t('denoise')} hint={t('denoiseHint')} checked={denoise} onChange={setDenoise} disabled={!canEdit || !settings} locked={denoiseGate.locked} packName={denoiseGate.packName} />
            <AddOnSwitch label={t('pii')} hint={t('piiHint')} checked={pii} onChange={setPii} disabled={!canEdit || !settings} locked={piiGate.locked} packName={piiGate.packName} />
            <p className="text-xs text-muted-foreground">
              {t.rich('voicemail', { link: (chunks) => <Link href={settingsPath('outbound')} className="text-accent-foreground underline underline-offset-2">{chunks}</Link> })}
            </p>
            {settings && agent.published ? (
              <p className="text-xs text-muted-foreground">
                {t('liveNow', { tier: agent.tier === 'premium' ? tc('common.premium') : tc('common.standard'), duration: formatDuration(agent.max_call_duration_s), recording: agent.recording_enabled ? t('on') : t('off') })}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {canEdit ? (
          <div className="flex justify-end">
            <Button onClick={() => void save()} disabled={!dirty || name.trim().length < 2} loading={patch.isPending}>
              {tc('common.save')}
            </Button>
          </div>
        ) : null}
      </div>

      <aside className="flex flex-col gap-4">
        <Card className="border-danger/30">
          <CardHeader>
            <CardTitle>{t('danger')}</CardTitle>
            <CardDescription>{t('dangerHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {agent.status !== 'draft' ? (
              <div className="flex flex-col gap-1">
                <Button variant="outline" disabled={!canAdmin} loading={actions.pausing} onClick={() => void actions.togglePause(agent)}>
                  {agent.status === 'paused' ? t('resume') : t('pause')}
                </Button>
                <p className="text-xs text-muted-foreground">{agent.status === 'paused' ? t('resumeHint') : t('pauseHint')}</p>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <Button variant="danger" disabled={!canAdmin || agent.numbers_attached > 0} onClick={() => setConfirmDelete(true)}>
                {t('delete')}
              </Button>
              <p className="text-xs text-muted-foreground">{agent.numbers_attached > 0 ? t('inUse') : t('deleteHint')}</p>
            </div>
            {!canAdmin ? <p className="text-xs text-muted-foreground">{t('adminOnly')}</p> : null}
          </CardContent>
        </Card>
      </aside>

      <DeleteAgentDialog agent={agent} open={confirmDelete} onOpenChange={setConfirmDelete} onDeleted={() => router.replace(routes.app.agents)} />
    </div>
  );
}

/** A plan-gated switch (QA-079): the gate's pack named underneath while it is locked. */
function AddOnSwitch({ label, hint, checked, onChange, disabled, locked, packName }: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void; disabled: boolean; locked: boolean; packName: string | null }) {
  const tg = useTranslations('dashboard.planGate');
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {locked ? <p className="text-xs text-muted-foreground">{packName ? tg('lockedPack', { pack: packName }) : tg('lockedGeneric')}</p> : null}
      </div>
      <Switch checked={checked} disabled={disabled || (locked && !checked)} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}
