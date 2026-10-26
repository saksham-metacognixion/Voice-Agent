'use client';

import { useApi, useListAuditLog } from '@portal/api-client';
import type { AuditEntryResponse } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@portal/ui';
import { ScrollText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { DataTable, type DataColumn } from '@/src/components/dashboard/data-table';
import { Pager } from '@/src/components/dashboard/pager';
import { LoadError } from '@/src/components/dashboard/query-states';
import { AUDIT_AREAS, auditActionKey, auditActorKind, auditMetaPairs, humaniseAction, type AuditArea } from '@/src/dashboard/audit-view';
import { formatDateTime } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D6 Audit log (spec p. 39, §6.2): `GET /audit-log`, newest first, narrowed by area,
 * with who, what, the details the writer recorded and the IP. Owner/admin — the page
 * only renders this tab for them and the API refuses anyone else.
 */
export function AuditTab() {
  const t = useTranslations('dashboard.settings.audit');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const [area, setArea] = React.useState<AuditArea | 'all'>('all');
  const pager = useCursorPager();
  const log = useListAuditLog(api, { limit: 25, ...(area !== 'all' ? { area } : {}), ...(pager.cursor ? { cursor: pager.cursor } : {}) }, { staleTime: 15_000 });

  const describe = (e: AuditEntryResponse) => {
    const key = auditActionKey(e.action);
    return key ? t(`actions.${key}` as never) : humaniseAction(e.action);
  };

  const columns: Array<DataColumn<AuditEntryResponse>> = [
    { key: 'time', header: t('columns.time'), card: 'subtitle', cell: (e) => <span className="whitespace-nowrap tabular-nums">{formatDateTime(e.created_at, ws.workspace?.timezone, { seconds: true })}</span> },
    { key: 'action', header: t('columns.action'), card: 'title', cell: (e) => describe(e) },
    {
      key: 'actor',
      header: t('columns.actor'),
      cell: (e) =>
        e.actor ? (
          <span className="flex min-w-0 flex-col">
            <span className="break-words">{e.actor.name ?? e.actor.email}</span>
            {e.actor.name ? <span className="break-all text-xs text-muted-foreground">{e.actor.email}</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">{auditActorKind(e) === 'staff' ? t('staff') : t('system')}</span>
        ),
    },
    {
      key: 'details',
      header: t('columns.details'),
      cell: (e) => {
        const pairs = auditMetaPairs(e.meta);
        if (!pairs.length) return <span className="text-muted-foreground">–</span>;
        return (
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {pairs.map(({ key, value, valueKey }) => (
              <li key={key} className="break-words">
                <span className="text-foreground">{t(`meta.${key}` as never)}:</span> {typeof value === 'boolean' ? tc(value ? 'common.yes' : 'common.no') : valueKey ? tc(valueKey as never) : value}
              </li>
            ))}
          </ul>
        );
      },
    },
    { key: 'ip', header: t('columns.ip'), className: 'hidden lg:table-cell', cell: (e) => <span className="break-all font-mono text-xs">{e.ip ?? '–'}</span> },
  ];

  const page = log.data;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="size-4 text-primary" aria-hidden /> {t('title')}
          </CardTitle>
          <CardDescription>{t('body')}</CardDescription>
        </div>
        <div className="w-full sm:w-48">
          <Select
            value={area}
            onValueChange={(v) => {
              setArea(v as AuditArea | 'all');
              pager.reset();
            }}
          >
            <SelectTrigger aria-label={t('area')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('allAreas')}</SelectItem>
              {AUDIT_AREAS.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`areas.${a}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {log.isPending ? (
          <Skeleton className="h-48 w-full" aria-busy />
        ) : log.isError ? (
          <LoadError compact error={log.error} onRetry={() => void log.refetch()} />
        ) : !page || page.items.length === 0 ? (
          <EmptyState className="py-8" icon={<ScrollText />} title={area === 'all' ? t('empty') : t('emptyFiltered')} />
        ) : (
          <>
            <DataTable label={t('label')} rows={page.items} columns={columns} rowKey={(e) => e.id} />
            <Pager page={pager.page} hasPrevious={pager.hasPrevious} hasNext={Boolean(page.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(page.next_cursor)} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
