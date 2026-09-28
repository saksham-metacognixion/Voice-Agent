'use client';

import { endImpersonation, useApi, useGetImpersonation } from '@portal/api-client';
import { Button, cn } from '@portal/ui';
import { Eye, LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useAuth } from '@/src/auth/auth-provider';
import { impersonationStore } from '@/src/auth/impersonation';
import { routes } from '@/src/routes';

/**
 * Admin §7.4 (D12): the bar a staff member sees above every portal screen while viewing
 * a workspace read-only — who is being viewed, that nothing can be changed, when it
 * ends, and the way out. "Exit" ends the session on the API (the one write a view-as
 * credential may make), forgets the key, and sends the tab to the sign-in page; the
 * console's own banner picks the ended session up on its next refresh.
 */
export function ImpersonationBanner({ className }: { className?: string }) {
  const t = useTranslations();
  const auth = useAuth();
  const api = useApi();
  const [busy, setBusy] = React.useState(false);
  const context = useGetImpersonation(api, { enabled: Boolean(auth.impersonating), staleTime: 60_000, retry: false });

  if (!auth.impersonating) return null;
  const tenant = context.data?.tenant_name;
  const expires = context.data?.expires_at ?? auth.impersonating.expires_at;

  async function exit() {
    setBusy(true);
    try {
      await endImpersonation(api).catch(() => undefined);
    } finally {
      impersonationStore.clear();
      window.location.replace(routes.login);
    }
  }

  return (
    <div role="status" aria-live="polite" className={cn('sticky top-0 z-40 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-warning/40 bg-warning px-4 py-2 text-sm text-warning-foreground sm:px-6', className)}>
      <Eye className="size-4 shrink-0" aria-hidden />
      <span className="font-semibold">{tenant ? t('impersonation.banner', { tenant }) : t('impersonation.bannerNoName')}</span>
      <span className="opacity-90">{t('impersonation.hint')}</span>
      {context.data?.staff_email ? <span className="opacity-90">{t('impersonation.staff', { email: context.data.staff_email })}</span> : null}
      <span className="opacity-90">{t('impersonation.expires', { time: new Date(expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</span>
      <Button size="sm" variant="outline" className="ml-auto" onClick={() => void exit()} loading={busy} disabled={busy}>
        <LogOut className="size-4" aria-hidden />
        {busy ? t('impersonation.exiting') : t('impersonation.exit')}
      </Button>
    </div>
  );
}
