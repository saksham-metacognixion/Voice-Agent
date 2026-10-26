'use client';

import { Button, ErrorState, PageLoader } from '@portal/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useAuth } from '../auth/auth-provider';
import { currentPathWithQuery, readQuery } from '../lib/query-string';
import { errorMessage } from '../lib/errors';
import { routes, samePath, signedInDestination, stepAllowed, stepPath, withNext } from '../routes';
import { useWorkspace } from '../workspace/workspace-provider';
import { useSessionGate } from './session-gate';

/**
 * The route guards. Each one renders a loader until the state it needs is known, redirects
 * when the person does not belong here, and otherwise renders its children. Nothing
 * protected is painted before the decision.
 */

/** Signed in, or off to /login?next=. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const t = useTranslations();

  React.useEffect(() => {
    if (auth.status === 'anonymous') router.replace(withNext(routes.login, currentPathWithQuery()));
  }, [auth.status, router]);

  if (!auth.configured) return <ConfigMissing />;
  if (auth.status !== 'authenticated') return <PageLoader label={t('common.loading')} />;
  return <>{children}</>;
}

/**
 * Signed in AND email confirmed (A3). The page asked for rides along as `?next=`, so a
 * new account opening an invite link comes back to it once confirmed instead of being
 * sent to create a workspace (BUG-008, QA-002).
 */
export function RequireVerified({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const t = useTranslations();
  const unverified = auth.status === 'authenticated' && !auth.user?.emailVerified;

  React.useEffect(() => {
    if (unverified) router.replace(withNext(routes.verifyEmail, currentPathWithQuery()));
  }, [unverified, router]);

  return <RequireAuth>{unverified ? <PageLoader label={t('common.loading')} /> : children}</RequireAuth>;
}

/** Verified AND an active workspace, else the setup page or the switcher. */
export function RequireWorkspace({ children }: { children: React.ReactNode }) {
  return (
    <RequireVerified>
      <WorkspaceGate>{children}</WorkspaceGate>
    </RequireVerified>
  );
}

function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const ws = useWorkspace();
  const router = useRouter();
  const t = useTranslations();
  const destination = ws.status === 'ready' ? (ws.memberships.length === 0 ? 'setup' : !ws.active ? 'select' : null) : null;

  React.useEffect(() => {
    if (destination === 'setup') router.replace(routes.setupWorkspace);
    // The switcher carries the page asked for (QA-001), so a deep link opened on a browser
    // that has not chosen a workspace continues there once one is picked. Read here, after
    // the commit: a render inside a router transition still sees the previous address.
    else if (destination === 'select') router.replace(withNext(routes.selectWorkspace, currentPathWithQuery()));
  }, [destination, router]);

  if (ws.status === 'error') {
    return (
      <div className="p-6">
        <ErrorState
          title={t('errors.loadFailed')}
          description={errorMessage(ws.workspaceError ?? new Error(t('errors.default')), t)}
          action={<Button onClick={() => void ws.refetchMemberships()}>{t('common.retry')}</Button>}
        />
      </div>
    );
  }
  if (ws.status !== 'ready' || destination) return <PageLoader label={t('common.loading')} />;
  if (ws.workspaceStatus === 'error') {
    return (
      <div className="p-6">
        <ErrorState
          title={t('errors.loadFailed')}
          description={errorMessage(ws.workspaceError, t)}
          action={<Button onClick={() => void ws.refetchWorkspace()}>{t('common.retry')}</Button>}
        />
      </div>
    );
  }
  if (ws.workspaceStatus !== 'ready') return <PageLoader label={t('common.loading')} />;
  return <>{children}</>;
}

/**
 * A wizard page W-k: reachable only while `k ≤ onboarding_step` (no skipping ahead), and
 * not at all once onboarding is complete (then it is the dashboard's job — or, with
 * `completeRedirect`, that page's: W7 sends a finished activation to the live screen).
 */
export function OnboardingStepGuard({ step, completeRedirect, children }: { step: number; completeRedirect?: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const gate = useSessionGate(pathname);
  const ws = useWorkspace();
  const router = useRouter();
  const t = useTranslations();

  // A step with no page of its own (4, ADR 0024) counts as the next one, the page
  // `stepPath` sends it to (QA-004).
  const allowed = gate.ready && gate.onboardingStep !== null && !gate.onboardingComplete && stepAllowed(step, gate.onboardingStep);
  const destination = gate.onboardingComplete && completeRedirect ? completeRedirect : gate.destination;
  // Never redirect on a workspace row that is being re-read: the step may have just advanced.
  const redirect = gate.ready && !gate.settling && destination && !allowed && !samePath(destination, pathname) ? destination : null;

  React.useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (!gate.ready || redirect || (!allowed && gate.settling)) return <PageLoader label={t('common.loading')} />;
  if (!allowed) {
    // Not allowed here and nowhere else to go (the gate points at this very page): say so
    // and offer a re-read, never a spinner that waits for ever (QA-004).
    return (
      <div className="p-6">
        <ErrorState
          title={t('errors.loadFailed')}
          description={t('errors.stepUnavailable')}
          action={<Button onClick={() => void ws.refetchWorkspace()}>{t('common.retry')}</Button>}
        />
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * `/onboarding/live`: only once onboarding is complete — `onboarding_completed_at` is
 * written by the activation job's `mark_live`, so a refresh here never restarts
 * anything, and someone who is not live yet is sent back to their wizard step.
 */
export function LiveGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const gate = useSessionGate(pathname);
  const router = useRouter();
  const t = useTranslations();
  const redirect = gate.ready && !gate.settling && gate.onboardingStep !== null && !gate.onboardingComplete ? stepPath(gate.onboardingStep) : null;

  React.useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (!gate.ready || redirect || !gate.onboardingComplete) return <PageLoader label={t('common.loading')} />;
  return <>{children}</>;
}

/** The dashboard: needs onboarding to be past the last implemented step. */
export function AppGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const gate = useSessionGate(pathname);
  const router = useRouter();
  const t = useTranslations();
  const redirect = gate.ready && !gate.settling && gate.onboardingStep !== null && !gate.dashboardAllowed ? stepPath(gate.onboardingStep) : null;

  React.useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (!gate.ready || redirect) return <PageLoader label={t('common.loading')} />;
  return <>{children}</>;
}

/**
 * The opposite guard, for /login and /signup: a signed-in person is sent on to `?next=`
 * when it is a safe same-origin path (QA-001), else to where they belong, instead of
 * seeing a sign-in button.
 */
export function RedirectIfSignedIn({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const t = useTranslations();
  const pathname = usePathname();
  const gate = useSessionGate(pathname);
  // Read once; the prerendered HTML has no query, and this only matters once signed in.
  const next = React.useMemo(() => readQuery().get('next'), []);
  const target = auth.status === 'authenticated' ? signedInDestination(next, gate.ready ? gate.destination : null) : null;

  React.useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (auth.status === 'loading' || target) return <PageLoader label={t('common.loading')} />;
  return <>{children}</>;
}

function ConfigMissing() {
  const t = useTranslations('auth.configMissing');
  return (
    <div className="p-6">
      <ErrorState title={t('title')} description={t('body', { vars: 'NEXT_PUBLIC_AUTH0_DOMAIN, NEXT_PUBLIC_AUTH0_CLIENT_ID, NEXT_PUBLIC_AUTH0_AUDIENCE' })} />
    </div>
  );
}
