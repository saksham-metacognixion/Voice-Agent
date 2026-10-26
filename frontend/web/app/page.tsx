'use client';

import { PageLoader, ErrorState, Button } from '@portal/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useAuth } from '@/src/auth/auth-provider';
import { pendingInvite } from '@/src/auth/pending-invite';
import { useSessionGate } from '@/src/guards/session-gate';
import { errorMessage } from '@/src/lib/errors';
import { routes, signedInDestination } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * `/` is two things: the Auth0 redirect target (`?code=&state=`, handled by AuthProvider
 * before this renders) and the front door. It never shows content — it works out where the
 * person belongs (§6.4) and goes there — or, straight after a sign-in that carried a
 * return path (`/login?next=`, an invite link, A5's enrolment), back to that path (QA-001)
 * — or, failing that, to an invite opened before signing in (`pendingInvite`, BUG-008).
 */
export default function RootPage() {
  const auth = useAuth();
  const gate = useSessionGate('/');
  const ws = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations();

  // An invite opened before signing in, when the sign-in did not carry it back itself —
  // the confirmation link in another tab, or a sign-up begun on Auth0's own tab
  // (BUG-008). Read once, after mount: undefined until then, so the gate cannot send an
  // invitee to create a workspace before it is known.
  const [pending, setPending] = React.useState<string | null | undefined>(undefined);
  React.useEffect(() => setPending(pendingInvite.peek()), []);

  // Only while the address is still `/`. Once the router has left for the return path,
  // `returnTo` is cleared; this page must not answer that by running the gate's redirect
  // on top of the navigation it just started (QA-001).
  const here = pathname === routes.root;
  const gateDestination = gate.ready ? gate.destination : null;
  const target =
    !here || pending === undefined
      ? null
      : auth.status === 'authenticated'
        ? signedInDestination(auth.returnTo ?? pending, gateDestination)
        : gateDestination;

  React.useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

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
  // Signed in, but the workspaces could not be read: nowhere to send them yet. Say so and
  // offer a retry instead of a spinner that never ends (QA-012).
  if (here && pending !== undefined && !target && gate.failed) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <ErrorState
          title={t('errors.loadFailed')}
          description={errorMessage((gate.failed === 'workspace' ? ws.workspaceError : null) ?? new Error(t('errors.default')), t)}
          action={
            <Button onClick={() => void (gate.failed === 'workspace' ? ws.refetchWorkspace() : ws.refetchMemberships())}>{t('common.retry')}</Button>
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
