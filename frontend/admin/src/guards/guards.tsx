'use client';

import { isApiError } from '@portal/api-client';
import { Button, ErrorState, Logo, PageLoader } from '@portal/ui';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useAuth } from '../auth/auth-provider';
import { errorMessage } from '../lib/errors';
import { currentPathWithQuery } from '../lib/query-string';
import { routes, withNext } from '../routes';
import { StaffProvider, useStaffMe } from '../staff/staff-provider';

/**
 * The route guards. Nothing protected is painted before the decision.
 *
 * `RequireStaff` = signed in AND `GET /admin/me` answered. A `MFA_REQUIRED` or
 * `STAFF_ONLY` answer renders a full-page state with a sign-out button — never the shell —
 * because the person cannot get past it by navigating.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (auth.status === 'anonymous') router.replace(withNext(routes.login, currentPathWithQuery()));
  }, [auth.status, router]);

  if (!auth.configured) return <ConfigMissing />;
  if (auth.status !== 'authenticated') return <PageLoader label="Loading" />;
  return <>{children}</>;
}

export function RequireStaff({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <StaffGate>{children}</StaffGate>
    </RequireAuth>
  );
}

function StaffGate({ children }: { children: React.ReactNode }) {
  const me = useStaffMe();
  const auth = useAuth();

  if (me.isPending && !me.data) return <PageLoader label="Checking your staff access" />;
  if (me.isError && !me.data) {
    const e = me.error;
    if (isApiError(e, 'MFA_REQUIRED')) {
      return (
        <FullPage
          title="This console needs a second factor"
          description="Your sign-in did not include a second factor. Sign out, then sign in again and complete the authenticator step."
          action={<Button onClick={() => void auth.logout()}>Sign out</Button>}
        />
      );
    }
    if (isApiError(e, 'STAFF_ONLY') || isApiError(e, 'FORBIDDEN_ROLE') || (isApiError(e) && e.status === 403)) {
      return (
        <FullPage
          title="No staff access"
          description={`${auth.user?.email ?? 'This account'} is not a staff member of this console.`}
          action={<Button onClick={() => void auth.logout()}>Sign out</Button>}
        />
      );
    }
    return (
      <FullPage
        title="Could not load your staff profile"
        description={errorMessage(e)}
        action={
          <div className="flex gap-2">
            <Button onClick={() => void me.refetch()}>Retry</Button>
            <Button variant="outline" onClick={() => void auth.logout()}>
              Sign out
            </Button>
          </div>
        }
      />
    );
  }
  if (!me.data) return <PageLoader label="Loading" />;
  return (
    <StaffProvider me={me.data} refetch={me.refetch}>
      {children}
    </StaffProvider>
  );
}

/** The opposite guard, for /login: a signed-in person goes to the overview. */
export function RedirectIfSignedIn({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const signedIn = auth.status === 'authenticated';

  React.useEffect(() => {
    if (signedIn) router.replace(routes.overview);
  }, [signedIn, router]);

  if (auth.status === 'loading' || signedIn) return <PageLoader label="Loading" />;
  return <>{children}</>;
}

function FullPage({ title, description, action }: { title: string; description: string; action: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-6">
      <Logo />
      <div className="w-full max-w-md">
        <ErrorState title={title} description={description} action={action} />
      </div>
    </div>
  );
}

function ConfigMissing() {
  return (
    <div className="p-6">
      <ErrorState
        title="Sign-in is not configured on this build"
        description="NEXT_PUBLIC_AUTH0_DOMAIN, NEXT_PUBLIC_AUTH0_CLIENT_ID and NEXT_PUBLIC_AUTH0_AUDIENCE must be set at build time (from ADMIN_AUTH0_* in the root .env)."
      />
    </div>
  );
}
