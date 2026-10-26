'use client';

import { Button } from '@portal/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import * as React from 'react';
import { useAuth } from '@/src/auth/auth-provider';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { RedirectIfSignedIn } from '@/src/guards/guards';
import { readQuery } from '@/src/lib/query-string';
import { routes, safeNext, withNext } from '@/src/routes';

/** A1 — Sign up. `screen_hint=signup` opens Universal Login on its registration tab. */
export default function SignupPage() {
  return (
    <RedirectIfSignedIn>
      <SignupInner />
    </RedirectIfSignedIn>
  );
}

function SignupInner() {
  const t = useTranslations();
  const auth = useAuth();
  const [busy, setBusy] = React.useState(false);
  // "Sign in" keeps the return path as well (BUG-008, QA-003).
  const [next, setNext] = React.useState('');

  React.useEffect(() => {
    setNext(safeNext(readQuery().get('next'), ''));
  }, []);

  async function go() {
    setBusy(true);
    try {
      await auth.login({ screenHint: 'signup', returnTo: safeNext(readQuery().get('next'), routes.root) });
    } catch {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t('auth.signup.title')}
      subtitle={t('auth.signup.subtitle')}
      footer={
        <>
          {t('auth.signup.haveAccount')}{' '}
          <Link href={withNext(routes.login, next)} className="font-medium text-primary hover:underline">
            {t('auth.signup.signIn')}
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Button size="lg" onClick={go} loading={busy} disabled={!auth.configured} className="w-full">
          {t('auth.signup.cta')}
        </Button>
        <p className="text-center text-xs text-muted-foreground">{t('auth.signup.terms')}</p>
      </div>
    </AuthLayout>
  );
}
