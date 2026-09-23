'use client';

import { PageLoader, ErrorState, Button } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useAuth } from '@/src/auth/auth-provider';
import { useSessionGate } from '@/src/guards/session-gate';
import { routes } from '@/src/routes';

/**
 * `/` is two things: the Auth0 redirect target (`?code=&state=`, handled by AuthProvider
 * before this renders) and the front door. It never shows content — it works out where the
 * person belongs (§6.4) and goes there.
 */
export default function RootPage() {
  const auth = useAuth();
  const gate = useSessionGate('/');
  const router = useRouter();
  const t = useTranslations();

  React.useEffect(() => {
    if (gate.ready && gate.destination) router.replace(gate.destination);
  }, [gate.ready, gate.destination, router]);

  if (auth.error && auth.status === 'anonymous') {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <ErrorState
          title={t('auth.callback.error')}
          description={auth.error}
          action={
            <Button onClick={() => router.replace(routes.login)}>{t('auth.callback.retry')}</Button>
          }
        />
      </main>
    );
  }
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <PageLoader label={auth.status === 'loading' ? t('auth.callback.title') : t('common.loading')} />
    </main>
  );
}
