'use client';

import { isApiError, useApi, useDeleteAgent, usePauseAgent, useResumeAgent, useUpdateAgentDraft } from '@portal/api-client';
import type { AgentDetail, AgentTier } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, RadioCard, RadioGroup, Slider, Switch, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { formatDuration } from '@/src/lib/format';
import { routes } from '@/src/routes';

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
  const pause = usePauseAgent(api);
  const resume = useResumeAgent(api);
  const remove = useDeleteAgent(api);
  const settings = agent.draft?.settings;

  const [name, setName] = React.useState(agent.name);
  const [industry, setIndustry] = React.useState(agent.industry ?? '');
  const [tier, setTier] = React.useState<AgentTier>(settings?.tier ?? agent.tier);
  const [maxS, setMaxS] = React.useState(settings?.max_call_duration_s ?? agent.max_call_duration_s);
  const [recording, setRecording] = React.useState(settings?.recording_enabled ?? agent.recording_enabled);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const dirty = name.trim() !== agent.name || (industry.trim() || '') !== (agent.industry ?? '') || (settings ? tier !== settings.tier || maxS !== settings.max_call_duration_s || recording !== settings.recording_enabled : false);

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

  async function togglePause() {
    try {
      if (agent.status === 'paused') await resume.mutateAsync({ params: { id: agent.id } });
      else await pause.mutateAsync({ params: { id: agent.id } });
      await refresh();
      toast.success(agent.status === 'paused' ? t('resumed') : t('paused'));
    } catch (e) {
      toast.error(errorMessage(e, tc));
    }
  }

  async function doDelete() {
    try {
      await remove.mutateAsync({ params: { id: agent.id } });
      track('agent_deleted', { agent_id: agent.id });
      toast.success(t('deleted'));
      await queryClient.invalidateQueries({ queryKey: ['listAgents'] });
      router.replace(routes.app.agents);
    } catch (e) {
      setConfirmDelete(false);
      toast.error(isApiError(e, 'AGENT_IN_USE') ? t('inUse') : errorMessage(e, tc));
    }
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
                <Button variant="outline" disabled={!canAdmin} loading={pause.isPending || resume.isPending} onClick={() => void togglePause()}>
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

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle', { name: agent.name })}</DialogTitle>
            <DialogDescription>{t('deleteBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {tc('common.cancel')}
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => void doDelete()}>
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
