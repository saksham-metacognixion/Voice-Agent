'use client';

import { useApi, useListNumbers } from '@portal/api-client';
import type { PhoneNumberResponse } from '@portal/schemas';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Skeleton } from '@portal/ui';
import { MoreHorizontal, Pencil, Phone, Plus, Trash2, Waypoints } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { DataTable, type DataColumn } from '@/src/components/dashboard/data-table';
import { LoadError } from '@/src/components/dashboard/query-states';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { anyProvisioning, isNumberEditable, sortNumbers } from '@/src/dashboard/numbers-view';
import { formatDate, formatPhone } from '@/src/lib/format';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';
import { AddNumberDialog } from './add-number-dialog';
import { NumberLabel, NumberStatusBadge, NumberTypeBadge, useAgentsForNumbers, useNumbersNav } from './number-bits';
import { RenameNumberDialog } from './rename-number-dialog';

/**
 * D4 list (spec p. 36): number, label, type, country, agent, status, calls in the last
 * seven days, rental, and a ⋯ menu (Rename, Change agent, Release). A row opens the
 * number. While a number is provisioning or releasing the list polls every 3 s —
 * the activation SSE frame refreshes it too, but a number bought from here has no
 * activation job to publish one.
 */
export function NumbersList() {
  const t = useTranslations('dashboard.numbers');
  const tc = useTranslations();
  const api = useApi();
  const nav = useNumbersNav();
  const ws = useWorkspace();
  const { canAdmin, canEdit } = useRole();
  const [polling, setPolling] = React.useState(false);
  const numbers = useListNumbers(api, { staleTime: 10_000, refetchInterval: polling ? 3_000 : false });
  const agents = useAgentsForNumbers();
  const [adding, setAdding] = React.useState(false);
  const [renaming, setRenaming] = React.useState<PhoneNumberResponse | null>(null);

  React.useEffect(() => setPolling(anyProvisioning(numbers.data)), [numbers.data]);
  const rows = React.useMemo(() => sortNumbers(numbers.data ?? []), [numbers.data]);
  const tz = ws.workspace?.timezone;

  const columns: Array<DataColumn<PhoneNumberResponse>> = [
    { key: 'number', header: t('columns.number'), card: 'title', cell: (n) => <span className="font-medium"><NumberLabel number={n} /></span> },
    { key: 'label', header: t('columns.label'), card: 'subtitle', cell: (n) => n.nickname ?? <span className="text-muted-foreground">–</span> },
    { key: 'type', header: t('columns.type'), cell: (n) => <NumberTypeBadge number={n} /> },
    { key: 'country', header: t('columns.country'), className: 'hidden md:table-cell', cell: (n) => n.country ?? '–' },
    { key: 'agent', header: t('columns.agent'), cell: (n) => (n.agent_id ? (agents.name(n.agent_id) ?? t('unknownAgent')) : <span className="text-muted-foreground">{t('noAgent')}</span>) },
    { key: 'status', header: t('columns.status'), card: 'badge', cell: (n) => <NumberStatusBadge status={n.status} /> },
    { key: 'calls', header: t('columns.calls7d'), align: 'right', cell: (n) => n.calls_7d },
    {
      key: 'rental',
      header: t('columns.rental'),
      align: 'right',
      className: 'hidden md:table-cell',
      cell: (n) =>
        n.rental_credits > 0 && isNumberEditable(n) ? (
          <span title={n.next_rental_at ? t('nextRental', { date: formatDate(n.next_rental_at, tz) }) : undefined}>{t('rentalValue', { credits: n.rental_credits })}</span>
        ) : (
          t('rentalNone')
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{tc('common.actions')}</span>,
      card: 'actions',
      align: 'right',
      cell: (n) => (
        <div className="flex w-full justify-end gap-2 sm:w-auto" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Button variant="outline" size="sm" className="flex-1 sm:hidden" onClick={() => nav.open(n.id)}>
            {t('openNumber')}
          </Button>
          {canEdit && isNumberEditable(n) ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('moreActions', { number: n.e164 ? formatPhone(n.e164) : t('settingUp') })}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(n)}>
                  <Pencil /> {t('rename')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => nav.open(n.id)}>
                  <Waypoints /> {t('changeAgent')}
                </DropdownMenuItem>
                {canAdmin ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => nav.open(n.id, 'danger')}>
                      <Trash2 /> {t('release')}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          canAdmin ? (
            <Button onClick={() => setAdding(true)}>
              <Plus /> {t('add')}
            </Button>
          ) : undefined
        }
      />
      {numbers.isPending ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : numbers.isError ? (
        <LoadError title={t('loadFailed')} error={numbers.error} onRetry={() => void numbers.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Phone />}
          title={t('empty')}
          description={canAdmin ? t('emptyHint') : `${t('emptyHint')} ${t('emptyViewer')}`}
          action={
            canAdmin ? (
              <Button onClick={() => setAdding(true)}>
                <Plus /> {t('add')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable label={t('listLabel')} rows={rows} columns={columns} rowKey={(n) => n.id} onRowClick={(n) => nav.open(n.id)} rowClassName={(n) => (isNumberEditable(n) ? undefined : 'opacity-70')} />
      )}
      {canAdmin ? <AddNumberDialog open={adding} onOpenChange={setAdding} /> : null}
      <RenameNumberDialog number={renaming} onOpenChange={(open) => (open ? undefined : setRenaming(null))} />
    </>
  );
}
