'use client';

import { Alert, Button } from '@portal/ui';
import { MailCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useAuth } from '@/src/auth/auth-provider';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { RequireAuth } from '@/src/guards/guards';
import { routes } from '@/src/routes';

/**
 * A3 — Verify email. The claim on the token gates the API (`403 EMAIL_UNVERIFIED`), so
 * "I have confirmed it" re-mints the session to pick up the new claim, then moves on.
 */
export default function VerifyEmailPage() {
  return (
    <RequireAuth>
      <VerifyInner />
    </RequireAuth>
  );
}

function VerifyInner() {
  const t = useTranslations();
  const auth = useAuth();
  const router = useRouter();
  const [checking, setChecking] = React.useState(false);
  const [still, setStill] = React.useState(false);

  React.useEffect(() => {
    if (auth.user?.emailVerified) router.replace(routes.root);
  }, [auth.user?.emailVerified, router]);

  async function check() {
    setChecking(true);
    setStill(false);
    const fresh = await auth.refresh();
    setChecking(false);
    if (fresh?.emailVerified) router.replace(routes.root);
    else setStill(true);
  }

  return (
    <AuthLayout title={t('auth.verify.title')}>
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3 rounded-lg bg-accent/60 p-4 text-sm">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <p>{auth.user?.email ? t('auth.verify.body', { email: auth.user.email }) : t('auth.verify.bodyNoEmail')}</p>
        </div>
        {still ? <Alert variant="warning">{t('auth.verify.stillUnverified')}</Alert> : null}
        <Button size="lg" onClick={check} loading={checking} className="w-full">
          {checking ? t('auth.verify.checking') : t('auth.verify.check')}
        </Button>
        <p className="text-center text-xs text-muted-foreground">{t('auth.verify.spam')}</p>
        <Button variant="ghost" onClick={() => void auth.logout()}>
          {t('auth.verify.useAnother')}
        </Button>
      </div>
    </AuthLayout>
  );
}
