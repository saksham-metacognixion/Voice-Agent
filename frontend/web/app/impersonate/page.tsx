'use client';

import { Button, ErrorState, PageLoader } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { impersonationStore } from '@/src/auth/impersonation';
import { routes } from '@/src/routes';
import { workspaceStore } from '@/src/workspace/store';

/**
 * Admin §7.4 (D12): where the console's "View as" lands. The link carries the session id
 * and the API-minted key in the fragment (`/impersonate/#session=&key=`) — a fragment is
 * never sent to CloudFront or S3, so the credential reaches no access log, history entry
 * or referrer (review, 28 Sep). This page keeps them for the tab, wipes them from the
 * address bar, and opens the dashboard. Everything after that is the ordinary portal
 * running read-only on a staff credential.
 *
 * The expiry is read out of the key itself (its payload is `[session, tenant, staff,
 * exp]`), so a link pasted an hour later is refused here rather than by the first API call.
 */
export default function ImpersonatePage() {
  const router = useRouter();
  const t = useTranslations();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const session = params.get('session');
    const key = params.get('key');
    const claims = key ? claimsOf(key) : null;
    const expiresAt = claims?.expiresAt ?? null;
    if (!session || !key || !claims || !expiresAt) {
      setError(t('impersonation.invalidLink'));
      return;
    }
    if (expiresAt.getTime() <= Date.now()) {
      setError(t('impersonation.expiredLink'));
      return;
    }
    impersonationStore.set({ session, key, expires_at: expiresAt.toISOString() });
    // A fresh tab has no remembered workspace; without this the shell opens on the A7 picker.
    workspaceStore.set(claims.tenantId);
    window.history.replaceState({}, '', routes.impersonate);
    // A full navigation, not router.replace: AuthProvider reads the store once, on mount.
    window.location.replace(routes.app.home);
  }, [router, t]);

  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <ErrorState title={t('impersonation.title')} description={error} action={<Button onClick={() => window.close()}>{t('common.close')}</Button>} />
      </main>
    );
  }
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <PageLoader label={t('impersonation.opening')} />
    </main>
  );
}

/** The key's payload is `[session, tenant, staff, exp]`; only the tenant and the expiry are read here. */
function claimsOf(key: string): { tenantId: string; expiresAt: Date } | null {
  try {
    const body = key.replace(/^imp_/, '');
    const payload = body.slice(0, body.lastIndexOf('.'));
    const parsed: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!Array.isArray(parsed) || typeof parsed[1] !== 'string' || typeof parsed[3] !== 'number') return null;
    return { tenantId: parsed[1], expiresAt: new Date(parsed[3] * 1000) };
  } catch {
    return null;
  }
}
