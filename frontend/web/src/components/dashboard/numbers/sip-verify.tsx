'use client';

import { verifyNumberSip, useApi } from '@portal/api-client';
import { sipVerifyRequest, type PhoneNumberResponse, type SipVerification, type SipVerifyRequest } from '@portal/schemas';
import { Alert, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime, formatPhone } from '@/src/lib/format';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D16 SIP re-verify on D4. `POST /numbers/:id/sip/verify` checks the trunk (and, with new
 * details, checks those first and keeps the old ones if they fail), so this component only
 * sends and shows: it never holds a stored credential, and a password typed here leaves
 * the form state as soon as the request settles.
 */
function useVerify(number: PhoneNumberResponse) {
  const api = useApi();
  const tc = useTranslations();
  const t = useTranslations('dashboard.numbers.sip.verify');
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const run = React.useCallback(
    async (body: SipVerifyRequest): Promise<{ ok: boolean; error?: string }> => {
      setBusy(true);
      try {
        const updated = await verifyNumberSip(api, { id: number.id }, body);
        queryClient.setQueryData(['getNumber', { id: number.id }], updated);
        queryClient.setQueriesData<PhoneNumberResponse[]>({ queryKey: ['listNumbers'] }, (list) => list?.map((n) => (n.id === updated.id ? updated : n)));
        const status = updated.sip?.verification?.status;
        if (status === 'verified') toast.success(t('toast.verified'));
        else if (status === 'warning') toast.warning(t('toast.warning'));
        else toast.error(t('toast.failed'));
        return { ok: status !== 'failed' };
      } catch (e) {
        const msg = errorMessage(e, tc);
        toast.error(msg);
        // A check another tab started: show it as running rather than as our failure.
        await queryClient.invalidateQueries({ queryKey: ['getNumber', { id: number.id }] });
        return { ok: false, error: msg };
      } finally {
        setBusy(false);
      }
    },
    [api, number.id, queryClient, t, tc],
  );
  return { run, busy };
}

export function SipVerifyPanel({ number, canAdmin }: { number: PhoneNumberResponse; canAdmin: boolean }) {
  const t = useTranslations('dashboard.numbers.sip.verify');
  const { run, busy } = useVerify(number);
  const [editing, setEditing] = React.useState(false);
  const verification = number.sip?.verification ?? null;
  const pending = busy || verification?.status === 'pending';

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t('title')}</p>
          <VerificationLine verification={pending ? { status: 'pending', checked_at: verification?.checked_at ?? null, reason: null, checks: null, credentials_updated: false } : verification} />
        </div>
        {canAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void run({})} loading={busy && !editing} disabled={pending}>
              <RefreshCw /> {t('check')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={pending}>
              <KeyRound /> {t('update')}
            </Button>
          </div>
        ) : null}
      </div>
      {verification && verification.status !== 'pending' && verification.reason && !pending ? (
        <Alert variant={verification.status === 'failed' ? 'danger' : 'warning'}>{t(`reasons.${verification.reason}`)}</Alert>
      ) : null}
      {!canAdmin ? <p className="text-xs text-muted-foreground">{t('adminOnly')}</p> : null}
      <UpdateCredentialsDialog number={number} open={editing} onOpenChange={setEditing} run={run} busy={busy} />
    </div>
  );
}

function VerificationLine({ verification }: { verification: SipVerification | null }) {
  const t = useTranslations('dashboard.numbers.sip.verify');
  const timeZone = useWorkspace().workspace?.timezone;
  if (!verification) return <p className="text-xs text-muted-foreground">{t('never')}</p>;
  const variant = verification.status === 'verified' ? 'success' : verification.status === 'failed' ? 'danger' : verification.status === 'warning' ? 'warning' : 'default';
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <Badge variant={variant}>{t(`status.${verification.status}`)}</Badge>
      {verification.status === 'pending' ? t('running') : verification.checked_at ? t('checkedAt', { when: formatDateTime(verification.checked_at, timeZone) }) : null}
      {verification.credentials_updated && verification.status !== 'pending' ? <span>{t('updated')}</span> : null}
    </p>
  );
}

/** New host, username or password — each optional, each checked before it replaces anything. */
function UpdateCredentialsDialog({
  number,
  open,
  onOpenChange,
  run,
  busy,
}: {
  number: PhoneNumberResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: (body: SipVerifyRequest) => Promise<{ ok: boolean; error?: string }>;
  busy: boolean;
}) {
  const t = useTranslations('dashboard.numbers.sip.verify.dialog');
  const tw = useTranslations('wizard.w6.fields');
  const tc = useTranslations();
  const [form, setForm] = React.useState({ host: '', username: '', password: '' });
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // The password never outlives the dialog.
    if (!open) setForm({ host: '', username: '', password: '' });
    setError(null);
  }, [open]);

  const body: SipVerifyRequest = {
    ...(form.host.trim() ? { host: form.host.trim() } : {}),
    ...(form.username.trim() ? { username: form.username.trim() } : {}),
    ...(form.password ? { password: form.password } : {}),
  };
  const parsed = sipVerifyRequest.safeParse(body);
  const hostError = !parsed.success && parsed.error.issues.some((i) => i.path[0] === 'host') ? tc('wizard.w6.errors.sipHost') : undefined;
  const empty = Object.keys(body).length === 0;

  async function submit() {
    if (busy || empty || !parsed.success) return;
    const result = await run(body);
    setForm((f) => ({ ...f, password: '' }));
    if (result.ok) onOpenChange(false);
    else setError(result.error ?? t('failed'));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent closeLabel={tc('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{number.e164 ? t('body', { number: formatPhone(number.e164) }) : t('bodyGeneric')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field id="sipv-host" label={tw('sipHost')} description={t('keepHint', { current: number.sip?.host ?? '–' })} error={hostError}>
            <Input id="sipv-host" dir="ltr" placeholder={number.sip?.host ?? 'sip.example.com'} value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} disabled={busy} />
          </Field>
          <Field id="sipv-user" label={tw('sipUsername')} description={t('keepBlank')}>
            <Input id="sipv-user" dir="ltr" autoComplete="off" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} disabled={busy} />
          </Field>
          <Field id="sipv-pass" label={tw('sipPassword')} description={t('keepBlank')}>
            <Input id="sipv-pass" type="password" dir="ltr" autoComplete="new-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} disabled={busy} />
          </Field>
          <p className="text-xs text-muted-foreground">{t('safety')}</p>
          {error ? <Alert variant="danger">{error}</Alert> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {tc('common.cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={busy || empty || !parsed.success}>
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
