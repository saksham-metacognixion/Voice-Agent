'use client';

import { Alert, Button, Logo } from '@portal/ui';
import { ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { useAuth } from '@/src/auth/auth-provider';
import { RedirectIfSignedIn } from '@/src/guards/guards';
import { usePageTitle } from '@/src/components/shell/page-header';
import { missingConfig } from '@/src/config';
import { readQuery } from '@/src/lib/query-string';
import { routes, safeNext } from '@/src/routes';

export default function LoginPage() {
  usePageTitle('Sign in');
  return (
    <RedirectIfSignedIn>
      <LoginCard />
    </RedirectIfSignedIn>
  );
}

function LoginCard() {
  const auth = useAuth();
  const [busy, setBusy] = React.useState(false);
  const missing = missingConfig();

  async function signIn() {
    setBusy(true);
    try {
      await auth.login(safeNext(readQuery().get('next'), routes.overview));
    } catch {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-background p-6">
      <Logo variant="full" size="lg" />
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-lg border border-border bg-card p-6 shadow-card">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Staff console</h1>
          <p className="text-sm text-muted-foreground">Sign in with your staff Google Workspace account. A second factor is always required.</p>
        </div>
        {missing.length ? (
          <Alert variant="danger" title="Sign-in is not configured on this build">
            {missing.join(', ')} must be set at build time.
          </Alert>
        ) : null}
        {auth.error ? (
          <Alert variant="danger" title="Sign-in did not finish">
            {auth.error}
          </Alert>
        ) : null}
        <Button size="lg" onClick={() => void signIn()} loading={busy} disabled={missing.length > 0}>
          <ShieldCheck /> Sign in with staff account
        </Button>
      </div>
    </main>
  );
}
