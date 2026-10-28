'use client';

import { endSession, updateNotificationSettings, updateWorkspace, useApi, useGetNotificationSettings, useListSessions } from '@portal/api-client';
import type { AccountSession, NewMessageMode, NotificationSettingsResponse, WorkspaceResponse } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, RadioCard, RadioGroup, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, Textarea, toast } from '@portal/ui';
import { KeyRound, LogOut, Mail, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { requestPasswordReset, useAuth } from '@/src/auth/auth-provider';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { LoadError } from '@/src/components/dashboard/query-states';
import { usePlanGate } from '@/src/dashboard/use-plan-gate';
import { DataRequestsCards } from '@/src/components/dashboard/settings/data-requests';
import { sessionDevice } from '@/src/dashboard/session-device';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime } from '@/src/lib/format';
import { routes } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';

const MODES: NewMessageMode[] = ['instant', 'daily', 'off'];

/**
 * D6 Notifications (spec p. 39), the caller's own row (`PATCH
 * /workspace/notification-settings`, any member). Offers what the backend actually
 * sends: message emails (instant or the daily digest) and low-balance emails. SMS and the
 * weekly summary are stored columns with no sender yet, so they are not offered.
 */
export function NotificationsTab() {
  const t = useTranslations('dashboard.settings.notifications');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const settings = useGetNotificationSettings(api, { staleTime: 60_000 });
  const [mode, setMode] = React.useState<NewMessageMode>('instant');
  const [lowBalance, setLowBalance] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!settings.data) return;
    setMode(settings.data.new_message);
    setLowBalance(settings.data.low_balance_email);
  }, [settings.data]);

  if (settings.isPending) return <Skeleton className="h-48 w-full" aria-busy />;
  if (settings.isError) return <LoadError error={settings.error} onRetry={() => void settings.refetch()} />;

  const dirty = mode !== settings.data.new_message || lowBalance !== settings.data.low_balance_email || settings.data.is_default;

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await updateNotificationSettings(api, { new_message: mode, low_balance_email: lowBalance });
      queryClient.setQueryData<NotificationSettingsResponse>(['getNotificationSettings'], saved);
      track('notification_settings_saved', { new_message: saved.new_message, low_balance_email: saved.low_balance_email });
      toast.success(tc('dashboard.settings.saved'));
    } catch (e) {
      setError(errorMessage(e, tc));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {settings.data.is_default ? <Alert variant="neutral">{t('defaultNote')}</Alert> : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('newMessage')}</legend>
          <p className="text-xs text-muted-foreground">{t('newMessageHint')}</p>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as NewMessageMode)} className="grid gap-2 sm:grid-cols-3" disabled={busy} aria-label={t('newMessage')}>
            {MODES.map((m) => (
              <RadioCard key={m} value={m} title={t(`modes.${m}`)} />
            ))}
          </RadioGroup>
        </fieldset>
        <Field id="notif-low" label={t('lowBalance')} description={t('lowBalanceHint')}>
          <Switch id="notif-low" checked={lowBalance} onCheckedChange={setLowBalance} disabled={busy} />
        </Field>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <div className="flex justify-end border-t border-border pt-4">
          <Button onClick={() => void save()} loading={busy} disabled={busy || !dirty}>
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * D6 Security (spec p. 39), all through the identity provider: two-step verification
 * (A5), a password reset email (A6's `dbconnections/change_password`), and signing out.
 * The provider holds sessions, so there is no session list here to revoke from.
 */
export function SecurityTab() {
  const t = useTranslations('dashboard.settings.sec');
  const tc = useTranslations();
  const auth = useAuth();
  const mfaOn = auth.user?.mfa === true;
  const email = auth.user?.email ?? null;
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function reset() {
    if (!email || sending) return;
    setSending(true);
    try {
      await requestPasswordReset(email);
      track('password_reset_requested', { from: 'settings' });
      setSent(true);
    } catch (e) {
      toast.error(errorMessage(e, tc));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" aria-hidden /> {t('mfaTitle')}
            </CardTitle>
            <Badge variant={mfaOn ? 'success' : 'outline'}>{mfaOn ? tc('auth.mfa.enabled') : tc('auth.mfa.notEnabled')}</Badge>
          </div>
          <CardDescription>{mfaOn ? tc('auth.mfa.onHint') : tc('auth.mfa.body')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link href={routes.mfa}>
              <ShieldCheck /> {tc('auth.mfa.title')}
            </Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden /> {t('passwordTitle')}
          </CardTitle>
          <CardDescription>{t('passwordBody')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {sent && email ? <Alert variant="success">{t('passwordSent', { email })}</Alert> : null}
          <div>
            <Button variant="outline" onClick={() => void reset()} loading={sending} disabled={!email || sending || sent}>
              {t('passwordButton')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('passwordSocial')}</p>
        </CardContent>
      </Card>
      <SessionsCard />
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LogOut className="size-4 text-primary" aria-hidden /> {t('signOutTitle')}
          </CardTitle>
          <CardDescription>{t('signOutBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void auth.logout()}>
            <LogOut /> {t('signOut')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * §6.2 "where you are signed in": the person's own sessions on the identity provider, this
 * device first and marked, each other one with a sign-out. Sessions are the person's, not
 * the workspace's, so every role sees the card. Unavailable (a dev box) is said, not hidden.
 */
function SessionsCard() {
  const t = useTranslations('dashboard.settings.sec');
  const api = useApi();
  const auth = useAuth();
  const queryClient = useQueryClient();
  // A staff view-as tab is not the owner's browser: the API refuses it, so the card is not shown at all.
  const sessions = useListSessions(api, { enabled: !auth.impersonating });
  const [ending, setEnding] = React.useState<AccountSession | null>(null);
  const current = auth.user?.sessionId ?? null;

  const label = (s: AccountSession) => {
    const d = sessionDevice(s.user_agent);
    if (d.browser && d.os) return t('device', { browser: d.browser, os: d.os });
    return d.browser ?? d.os ?? t('deviceUnknown');
  };
  const rows = [...(sessions.data?.sessions ?? [])].sort((a, b) => Number(b.id === current) - Number(a.id === current) || (b.last_active_at ?? '').localeCompare(a.last_active_at ?? ''));

  async function end() {
    if (!ending) return;
    await endSession(api, { id: ending.id });
    track('session_ended', {});
    await queryClient.invalidateQueries({ queryKey: ['listSessions'] });
    toast.success(t('ended'), { description: t('endWindow') });
  }

  if (auth.impersonating) return null;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="size-4 text-primary" aria-hidden /> {t('sessionsTitle')}
        </CardTitle>
        <CardDescription>{t('sessionsBody')}</CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.isPending ? (
          <Skeleton className="h-24" />
        ) : sessions.isError ? (
          <LoadError error={sessions.error} onRetry={() => void sessions.refetch()} />
        ) : !sessions.data.available ? (
          <p className="text-sm text-muted-foreground">{t('sessionsUnavailable')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('sessionsNone')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {label(s)}
                    {s.id === current ? <Badge variant="success">{t('thisDevice')}</Badge> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {s.last_active_at ? t('lastActive', { when: formatDateTime(s.last_active_at) }) : null}
                    {s.last_active_at && s.ip ? ' · ' : null}
                    {s.ip ? <span dir="ltr">{t('ip', { ip: s.ip })}</span> : null}
                  </span>
                </div>
                {s.id === current ? null : (
                  <Button variant="outline" size="sm" onClick={() => setEnding(s)}>
                    {t('endSession')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={Boolean(ending)}
        onOpenChange={(open) => (open ? undefined : setEnding(null))}
        title={ending ? t('endTitle', { device: label(ending) }) : ''}
        description={t('endBody')}
        consequences={[t('endWindow')]}
        confirmLabel={t('endConfirm')}
        onConfirm={end}
      />
    </Card>
  );
}

/** §17 retention choices from the spec (30/90/365), plus whatever the workspace already has. */
const RETENTION = [30, 90, 365];

/**
 * D6 Data & privacy (spec p. 39): the recording default for new agents and the retention
 * window, both `PATCH /workspace` (owner/admin). Since QA-081 also the PII-removal default
 * for new agents (plan gate `pii_removal`) and the recording notice a recording agent
 * says before its greeting — ours in the agent's language, or the business's own line.
 * The notice is added at the platform sync, so it reaches a live agent at its next
 * publish. "Export all data" and "Delete workspace" are `DataRequestsCards` (QA-081):
 * the export a zip streamed by the API, the deletion a request staff carry out as the
 * §17 anonymisation job — the owner asks, with the workspace name typed.
 */
export function PrivacyTab({ workspace }: { workspace: WorkspaceResponse }) {
  const t = useTranslations('dashboard.settings.privacy');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const { canAdmin } = useRole();
  const [recording, setRecording] = React.useState(workspace.recording_default);
  const [retention, setRetention] = React.useState(workspace.retention_days);
  const [piiDefault, setPiiDefault] = React.useState(workspace.pii_removal_default);
  const [notice, setNotice] = React.useState(workspace.recording_notice);
  const [noticeText, setNoticeText] = React.useState(workspace.recording_notice_text ?? '');
  const piiGate = usePlanGate('pii_removal');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setRecording(workspace.recording_default);
    setRetention(workspace.retention_days);
    setPiiDefault(workspace.pii_removal_default);
    setNotice(workspace.recording_notice);
    setNoticeText(workspace.recording_notice_text ?? '');
  }, [workspace.recording_default, workspace.retention_days, workspace.pii_removal_default, workspace.recording_notice, workspace.recording_notice_text]);

  const options = RETENTION.includes(workspace.retention_days) ? RETENTION : [...RETENTION, workspace.retention_days].sort((a, b) => a - b);
  const noticeChanged = noticeText.trim() !== (workspace.recording_notice_text ?? '');
  const dirty =
    recording !== workspace.recording_default ||
    retention !== workspace.retention_days ||
    piiDefault !== workspace.pii_removal_default ||
    notice !== workspace.recording_notice ||
    noticeChanged;

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateWorkspace(api, {
        ...(recording !== workspace.recording_default ? { recording_default: recording } : {}),
        ...(retention !== workspace.retention_days ? { retention_days: retention } : {}),
        ...(piiDefault !== workspace.pii_removal_default ? { pii_removal_default: piiDefault } : {}),
        ...(notice !== workspace.recording_notice ? { recording_notice: notice } : {}),
        ...(noticeChanged ? { recording_notice_text: noticeText.trim() || null } : {}),
      });
      queryClient.setQueryData(['getWorkspace'], updated);
      track('workspace_settings_saved', { fields: 1 });
      toast.success(tc('dashboard.settings.saved'));
    } catch (e) {
      setError(errorMessage(e, tc));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {!canAdmin ? <Alert variant="neutral">{tc('dashboard.settings.adminOnly')}</Alert> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('recordingTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Field id="privacy-recording" label={t('recording')} description={t('recordingHint')}>
            <Switch id="privacy-recording" checked={recording} onCheckedChange={setRecording} disabled={!canAdmin || busy} />
          </Field>
          <Field id="privacy-notice" label={t('notice')} description={t('noticeHint')}>
            <Switch id="privacy-notice" checked={notice} onCheckedChange={setNotice} disabled={!canAdmin || busy} />
          </Field>
          {notice ? (
            <Field id="privacy-notice-text" label={t('noticeText')} description={t('noticeTextHint')} optional optionalLabel={tc('common.optional')}>
              <Textarea id="privacy-notice-text" value={noticeText} maxLength={200} rows={2} dir="auto" placeholder={t('noticePlaceholder')} onChange={(e) => setNoticeText(e.target.value)} disabled={!canAdmin || busy} />
            </Field>
          ) : null}
          <Field
            id="privacy-pii"
            label={t('pii')}
            description={piiGate.locked ? `${t('piiHint')} ${piiGate.packName ? tc('dashboard.planGate.lockedPack', { pack: piiGate.packName }) : tc('dashboard.planGate.lockedGeneric')}` : t('piiHint')}
          >
            <Switch id="privacy-pii" checked={piiDefault} onCheckedChange={setPiiDefault} disabled={!canAdmin || busy || (piiGate.locked && !piiDefault)} />
          </Field>
          <Field id="privacy-retention" label={t('retention')} description={t('retentionHint')} className="sm:max-w-xs">
            <Select value={String(retention)} onValueChange={(v) => setRetention(Number(v))} disabled={!canAdmin || busy}>
              <SelectTrigger id="privacy-retention">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {t('days', { n: d })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {error ? <Alert variant="danger">{error}</Alert> : null}
          {canAdmin ? (
            <div className="flex justify-end border-t border-border pt-4">
              <Button onClick={() => void save()} loading={busy} disabled={busy || !dirty}>
                {t('save')}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <DataRequestsCards workspace={workspace} />
    </div>
  );
}
