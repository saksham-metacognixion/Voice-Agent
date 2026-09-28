'use client';

import { useAdminEndImpersonation, useAdminOpenImpersonation, useApi } from '@portal/api-client';
import { Button, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, ExternalLink } from 'lucide-react';
import { errorMessage } from '@/src/lib/errors';
import { formatTime } from '@/src/lib/format';
import { useStaff } from '@/src/staff/staff-provider';

/**
 * Admin §7.4: while a view-as session is open, a full-width bar above every page. "Open
 * portal" asks `POST /admin/impersonations/:id/open` for a fresh link: the key lives only
 * in the portal tab's sessionStorage, so a plain link to the portal origin lands on the
 * customer login page once that tab is closed (review, 28 Sep).
 */
export function ImpersonationBanner() {
  const { me, refetch } = useStaff();
  const api = useApi();
  const queryClient = useQueryClient();
  const end = useAdminEndImpersonation(api);
  const open = useAdminOpenImpersonation(api);
  const sessions = me.impersonations.filter((s) => !s.ended_at);
  if (!sessions.length) return null;

  async function openPortal(id: string) {
    // Open the tab synchronously so the browser does not treat the post-await open as a popup.
    const tab = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    try {
      const session = await open.mutateAsync({ params: { id } });
      if (!session.portal_url) throw new Error('No portal link answered');
      if (tab) tab.location.href = session.portal_url;
      else window.open(session.portal_url, '_blank', 'noopener');
    } catch (e) {
      tab?.close();
      toast.error(errorMessage(e));
      await queryClient.invalidateQueries({ queryKey: ['adminMe'] });
      await refetch();
    }
  }

  async function exit(id: string) {
    try {
      await end.mutateAsync({ params: { id } });
      toast.success('View-as session ended');
      await queryClient.invalidateQueries({ queryKey: ['adminMe'] });
      await refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div role="status" className="flex flex-col gap-2 border-b border-danger/40 bg-warning/20 px-4 py-2 text-sm sm:px-6">
      {sessions.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Eye className="size-4 text-warning-emphasis" aria-hidden />
          <span className="font-medium">
            Viewing <span className="font-semibold">{s.tenant_name}</span> as read-only in another tab
          </span>
          <span className="text-muted-foreground">· expires {formatTime(s.expires_at)}</span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void openPortal(s.id)} loading={open.isPending}>
              <ExternalLink /> Open portal
            </Button>
            <Button size="sm" variant="danger" onClick={() => void exit(s.id)} loading={end.isPending}>
              Exit
            </Button>
          </span>
        </div>
      ))}
    </div>
  );
}
