'use client';

import { Alert, Badge, Button } from '@portal/ui';
import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { useAuth } from '@/src/auth/auth-provider';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { RequireAuth } from '@/src/guards/guards';
import { routes } from '@/src/routes';

/**
 * A5 — MFA. Customer two-factor is opt-in (§6.2). Enrolment happens on Auth0: asking for
 * the multi-factor `acr_values` on a fresh sign-in makes Universal Login enrol an
 * authenticator app and challenge it; `amr` on the returned session then says `mfa`.
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
  const [busy, setBusy] = React.useState(false);
  const on = auth.user?.mfa === true;

  async function enrol() {
    setBusy(true);
    track('mfa_enrol_started');
    try {
      await auth.login({ requireMfa: true, returnTo: routes.mfa });
    } catch {
      setBusy(false);
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
        {on ? (
          <Alert variant="success">{t('auth.mfa.done')}</Alert>
        ) : (
          <>
            <Button size="lg" onClick={enrol} loading={busy} className="w-full">
              {t('auth.mfa.enable')}
            </Button>
            <p className="text-center text-xs text-muted-foreground">{t('auth.mfa.verifying')}</p>
          </>
        )}
        <Button variant="ghost" asChild>
          <a href={routes.app.settings}>{t('common.back')}</a>
        </Button>
      </div>
    </AuthLayout>
  );
}
