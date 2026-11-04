'use client';

import { forgetRememberedDevices, useApi } from '@portal/api-client';
import { Alert, Badge, Button } from '@portal/ui';
import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { useAuth } from '@/src/auth/auth-provider';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { RequireAuth } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { readQuery } from '@/src/lib/query-string';
import { routes, safeNext } from '@/src/routes';

/**
 * A5 — MFA. Customer two-factor is opt-in (§6.2). Enrolment happens on Auth0: asking for
 * the multi-factor `acr_values` on a fresh sign-in makes Universal Login enrol an
 * authenticator app and challenge it; `amr` on the returned session then says `mfa`.
 *
 * ADR 0036: the same button is the step-up. An owner or admin of a workspace with money at
 * risk whose session did not pass a factor is sent here (`?next=` the page they were on)
 * by the shell's banner or by an `MFA_REQUIRED` answer; the step-up always asks for a
 * fresh code, never a remembered device. "Forget remembered devices" undoes A4's 30 days.
 */
export default function MfaPage() {
  return (
    <RequireAuth>
      <MfaInner />
    </RequireAuth>
  );
}

function MfaInner() {
  const t = useTranslations();
  const auth = useAuth();
  const api = useApi();
  const [busy, setBusy] = React.useState(false);
  const [forgetting, setForgetting] = React.useState(false);
  const [forgot, setForgot] = React.useState<{ ok: boolean; text: string } | null>(null);
  const on = auth.user?.mfa === true;
  // Where the step-up returns: the page that asked for it, else this page. Read after the
  // commit: the shell's "Verify now" is a client-side transition, and a render inside it
  // still sees the previous address (no `next` at all).
  const [next, setNext] = React.useState('');
  React.useEffect(() => {
    setNext(safeNext(readQuery().get('next'), ''));
  }, []);

  async function enrol() {
    setBusy(true);
    track(on ? 'mfa_step_up_started' : 'mfa_enrol_started');
    try {
      await auth.login({ requireMfa: true, returnTo: next || routes.mfa });
    } catch {
      setBusy(false);
    }
  }

  async function forget() {
    setForgetting(true);
    setForgot(null);
    try {
      await forgetRememberedDevices(api);
      setForgot({ ok: true, text: t('auth.mfa.forgetDone') });
    } catch (e) {
      setForgot({ ok: false, text: errorMessage(e, t) });
    } finally {
      setForgetting(false);
    }
  }

  return (
    <AuthLayout title={t('auth.mfa.title')} subtitle={t('auth.mfa.body')}>
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className={on ? 'size-5 text-success' : 'size-5 text-muted-foreground'} aria-hidden />
            <span className="text-sm font-medium">{t('auth.mfa.status')}</span>
          </div>
          <Badge variant={on ? 'success' : 'outline'}>{on ? t('auth.mfa.enabled') : t('auth.mfa.notEnabled')}</Badge>
        </div>
        {on && next ? (
          <>
            <Alert variant="warning">{t('auth.mfa.verifyHint')}</Alert>
            <Button size="lg" onClick={enrol} loading={busy} className="w-full">
              {t('auth.mfa.verifyNow')}
            </Button>
          </>
        ) : on ? (
          <Alert variant="success">{t('auth.mfa.done')}</Alert>
        ) : (
          <>
            <Button size="lg" onClick={enrol} loading={busy} className="w-full">
              {t('auth.mfa.enable')}
            </Button>
            <p className="text-center text-xs text-muted-foreground">{t('auth.mfa.verifying')}</p>
          </>
        )}
        {on ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
            <span className="text-sm font-medium">{t('auth.mfa.forgetTitle')}</span>
            <p className="text-xs text-muted-foreground">{t('auth.mfa.forgetBody')}</p>
            <p className="text-xs text-muted-foreground">{t('auth.mfa.rememberHint')}</p>
            {forgot ? <Alert variant={forgot.ok ? 'success' : 'danger'}>{forgot.text}</Alert> : null}
            <Button variant="outline" onClick={() => void forget()} loading={forgetting}>
              {t('auth.mfa.forget')}
            </Button>
          </div>
        ) : null}
        <Button variant="ghost" asChild>
          <a href={next || routes.app.settings}>{t('common.back')}</a>
        </Button>
      </div>
    </AuthLayout>
  );
}
