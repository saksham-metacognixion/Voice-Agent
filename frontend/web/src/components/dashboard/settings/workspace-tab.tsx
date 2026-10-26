'use client';

import { updateWorkspace, useApi } from '@portal/api-client';
import { updateWorkspaceRequest, type BusinessHours, type UpdateWorkspaceRequest, type WorkspaceResponse } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, ThemeSegment, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { LanguageSegment } from '@/src/components/shell/language-switcher';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { HoursEditor } from '@/src/components/wizard/hours-editor';
import { countryName as nameOfCountry, timezoneLabel, timezones } from '@/src/lib/countries';
import { errorMessage } from '@/src/lib/errors';
import { useRole } from '@/src/workspace/use-role';

const DEFAULT_HOURS: BusinessHours = {
  days: { mon: [{ open: '09:00', close: '17:00' }], tue: [{ open: '09:00', close: '17:00' }], wed: [{ open: '09:00', close: '17:00' }], thu: [{ open: '09:00', close: '17:00' }], fri: [{ open: '09:00', close: '17:00' }] },
  closed_dates: [],
};

/**
 * D6 Workspace (spec p. 39): business name, country (fixed), time zone, website and the
 * default business hours every "during business hours" number follows. `PATCH /workspace`
 * is owner/admin; everyone else reads the same form disabled. Appearance is per device
 * and open to every role.
 */
export function WorkspaceTab({ workspace }: { workspace: WorkspaceResponse }) {
  const t = useTranslations('dashboard.settings');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const { canAdmin } = useRole();
  const [name, setName] = React.useState(workspace.name);
  const [timezone, setTimezone] = React.useState(workspace.timezone);
  const [website, setWebsite] = React.useState(workspace.website ?? '');
  const [hasHours, setHasHours] = React.useState(Boolean(workspace.business_hours));
  const [hours, setHours] = React.useState<BusinessHours | undefined>(workspace.business_hours ?? DEFAULT_HOURS);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const zones = React.useMemo(() => {
    const all = timezones();
    return all.includes(workspace.timezone) ? all : [workspace.timezone, ...all];
  }, [workspace.timezone]);

  React.useEffect(() => {
    setName(workspace.name);
    setTimezone(workspace.timezone);
    setWebsite(workspace.website ?? '');
    setHasHours(Boolean(workspace.business_hours));
    setHours(workspace.business_hours ?? DEFAULT_HOURS);
  }, [workspace]);

  const patch: UpdateWorkspaceRequest = {};
  if (name.trim() !== workspace.name) patch.name = name.trim();
  if (timezone !== workspace.timezone) patch.timezone = timezone;
  if ((website.trim() || null) !== workspace.website) patch.website = website.trim() || null;
  const nextHours = hasHours ? (hours ?? null) : null;
  if (JSON.stringify(nextHours) !== JSON.stringify(workspace.business_hours)) patch.business_hours = nextHours;
  const dirty = Object.keys(patch).length > 0;

  async function save() {
    if (busy || !dirty) return;
    const parsed = updateWorkspaceRequest.safeParse(patch);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        next[field] = field === 'website' ? t('ws.websiteError') : field === 'name' ? t('ws.nameError') : tc('errors.VALIDATION_FAILED');
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setError(null);
    setBusy(true);
    try {
      const updated = await updateWorkspace(api, parsed.data);
      queryClient.setQueryData(['getWorkspace'], updated);
      await queryClient.invalidateQueries({ queryKey: ['listMyWorkspaces'] });
      track('workspace_settings_saved', { fields: Object.keys(parsed.data).length });
      toast.success(t('saved'));
    } catch (e) {
      setError(errorMessage(e, tc));
    } finally {
      setBusy(false);
    }
  }

  const disabled = !canAdmin || busy;
  const countryName = workspace.country ? nameOfCountry(workspace.country) : '';
  const themeLabels = { light: tc('common.theme.light'), dark: tc('common.theme.dark'), system: tc('common.theme.system'), toggle: tc('common.theme.toggle') };

  return (
    <div className="flex flex-col gap-6">
      {!canAdmin ? <Alert variant="neutral">{t('adminOnly')}</Alert> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('ws.title')}</CardTitle>
          <CardDescription>{t('ws.body')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <Field id="ws-name" label={t('ws.name')} error={errors.name}>
            <Input id="ws-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={disabled} />
          </Field>
          <Field id="ws-country" label={t('ws.country')} description={t('ws.countryHint')}>
            <Input id="ws-country" value={countryName} disabled readOnly />
          </Field>
          <Field id="ws-timezone" label={t('ws.timezone')} description={t('ws.timezoneHint')}>
            <Select value={timezone} onValueChange={setTimezone} disabled={disabled}>
              <SelectTrigger id="ws-timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {timezoneLabel(z)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="ws-website" label={t('ws.website')} optional optionalLabel={tc('common.optional')} error={errors.website}>
            <Input id="ws-website" type="url" inputMode="url" placeholder="https://example.com" value={website} onChange={(e) => setWebsite(e.target.value)} disabled={disabled} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('ws.hoursTitle')}</CardTitle>
          <CardDescription>{t('ws.hoursBody')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field id="ws-hours-on" label={t('ws.hoursClear')}>
            <Switch id="ws-hours-on" checked={!hasHours} onCheckedChange={(v) => setHasHours(!v)} disabled={disabled} />
          </Field>
          {hasHours ? <HoursEditor value={hours} onChange={setHours} disabled={disabled} /> : null}
          {error ? <Alert variant="danger">{error}</Alert> : null}
          {canAdmin ? (
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
              {dirty && !busy ? <span className="text-xs text-muted-foreground">{tc('common.unsavedChanges')}</span> : null}
              <Button onClick={() => void save()} loading={busy} disabled={busy || !dirty}>
                {t('ws.save')}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('theme')}</CardTitle>
          <CardDescription>{t('themeHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ThemeSegment labels={themeLabels} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('language')}</CardTitle>
          <CardDescription>{t('languageHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <LanguageSegment />
        </CardContent>
      </Card>
    </div>
  );
}
