'use client';

import { Alert, Button } from '@portal/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import * as React from 'react';
import { useAuth } from '@/src/auth/auth-provider';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { RedirectIfSignedIn } from '@/src/guards/guards';
import { readQuery } from '@/src/lib/query-string';
import { routes, safeNext } from '@/src/routes';

/** A2 — Login. Universal Login does the form; this page carries `next` through and shows errors. */
export default function LoginPage() {
  return (
    <RedirectIfSignedIn>
      <LoginInner />
    </RedirectIfSignedIn>
  );
}

function LoginInner() {
  const t = useTranslations();
  const auth = useAuth();
  const [busy, setBusy] = React.useState(false);
  const [reason, setReason] = React.useState<string | null>(null);

  React.useEffect(() => {
    setReason(readQuery().get('reason'));
  }, []);

  async function go() {
    setBusy(true);
    try {
      await auth.login({ returnTo: safeNext(readQuery().get('next'), routes.root) });
    } catch {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t('auth.login.title')}
      subtitle={t('auth.login.subtitle')}
      footer={
        <>
          {t('auth.login.noAccount')}{' '}
          <Link href={routes.signup} className="font-medium text-primary hover:underline">
            {t('auth.login.createAccount')}
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {reason === 'expired' ? <Alert variant="warning">{t('auth.login.sessionExpired')}</Alert> : null}
        {auth.error ? (
          <Alert variant="danger" title={t('auth.login.failed')}>
            {t('auth.login.failedHint', { reason: auth.error })}
          </Alert>
        ) : null}
        <Button size="lg" onClick={go} loading={busy} disabled={!auth.configured} className="w-full">
          {busy ? t('auth.login.redirecting') : t('auth.login.cta')}
        </Button>
        <Link href={routes.forgotPassword} className="text-center text-sm text-muted-foreground hover:text-foreground hover:underline">
          {t('auth.login.forgot')}
        </Link>
      </div>
    </AuthLayout>
  );
}
