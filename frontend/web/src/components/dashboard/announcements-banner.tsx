'use client';

import { useApi, useListActiveAnnouncements } from '@portal/api-client';
import { Alert, Button } from '@portal/ui';
import { Megaphone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { announcementVariant, readDismissed, visibleAnnouncements, writeDismissed } from '@/src/dashboard/announcements-view';
import { formatDate } from '@/src/lib/format';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D1 staff announcements (spec p. 33, `GET /announcements/active`, ADR 0041): the SA10
 * banners that apply to this workspace, as plain text. A dismissible one is hidden per
 * browser (there is no per-member row); one that is not stays until staff end it. A
 * failed load shows nothing — the banner is staff's word to the customer, and a broken
 * fetch is not worth a red box on every Home. Fetched once per five minutes at most.
 */
export function AnnouncementsBanner() {
  const t = useTranslations('dashboard.announcements');
  const api = useApi();
  const ws = useWorkspace();
  const announcements = useListActiveAnnouncements(api, { enabled: Boolean(ws.active), staleTime: 5 * 60_000 });
  // Hidden since this component mounted; the store holds the ones from before.
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(() => new Set());
  // Read during render, once per fetch: read in an effect, a dismissed banner was painted
  // from the cached answer and then removed, on every visit to Home.
  const dismissed = React.useMemo(() => {
    const ids = (announcements.data?.items ?? []).map((a) => a.id);
    const stored = readDismissed(typeof window === 'undefined' ? null : window.localStorage, ids);
    for (const id of hidden) stored.add(id);
    return stored;
  }, [announcements.data, hidden]);

  if (!announcements.data) return null;
  const items = visibleAnnouncements(announcements.data.items, dismissed);
  if (items.length === 0) return null;

  function hide(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    setHidden(next);
    writeDismissed(typeof window === 'undefined' ? null : window.localStorage, next);
  }

  return (
    <div className="flex flex-col gap-3" data-testid="announcements">
      {items.map((a) => (
        <Alert
          key={a.id}
          variant={announcementVariant(a.severity)}
          icon={<Megaphone className="size-5" aria-hidden />}
          title={t('title')}
          actions={a.dismissible ? <Button size="sm" variant="ghost" onClick={() => hide(a.id)}>{t('dismiss')}</Button> : null}
        >
          <p dir="auto" className="whitespace-pre-line">{a.body}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {a.ends_at ? t('until', { date: formatDate(a.ends_at, ws.workspace?.timezone) }) : t('posted', { date: formatDate(a.created_at, ws.workspace?.timezone) })}
          </p>
        </Alert>
      ))}
    </div>
  );
}
