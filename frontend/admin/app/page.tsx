'use client';

import { PageLoader } from '@portal/ui';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useAuth } from '@/src/auth/auth-provider';
import { readQuery } from '@/src/lib/query-string';
import { routes, safeNext, withNext } from '@/src/routes';

/**
 * `/` is the Auth0 callback (the provider consumes `?code=&state=` and rewrites the URL
 * to `appState.returnTo`) and the front door: a signed-in person goes to the overview,
 * anyone else to /login. Nothing is rendered here but a loader.
 */
export default function Root() {
  const auth = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (auth.status === 'loading') return;
    const next = safeNext(readQuery().get('next'), routes.overview);
    if (auth.status === 'authenticated') router.replace(next);
    else router.replace(withNext(routes.login, next === routes.overview ? null : next));
  }, [auth.status, router]);

  return <PageLoader label="Loading" />;
}
