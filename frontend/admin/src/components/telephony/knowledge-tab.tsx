'use client';

import { useAdminListKbs, useApi } from '@portal/api-client';
import type { AdminKbResponse } from '@portal/schemas';
import { Badge } from '@portal/ui';
import Link from 'next/link';
import * as React from 'react';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { FilterBar, FilterSelect } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { formatDateTime, formatNumber, humanize } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { customerPath } from '@/src/routes';

const LIMIT = 25;
const STATUSES = ['pending', 'syncing', 'ready', 'failed', 'deleting'] as const;
type Status = (typeof STATUSES)[number];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, 0)} KB`;
  return `${formatNumber(bytes / (1024 * 1024), 1)} MB`;
}

/**
 * Admin §9 `GET /admin/kbs`: every agent with knowledge, across workspaces — whether it
 * holds a knowledge base on the voice platform (what `kb_allowance` counts) and its
 * sources by state. "Failed" finds the ones that need a look.
 */
export function KnowledgeTab() {
  const api = useApi();
  const pager = useCursorPager();
  const [status, setStatus] = React.useState<Status | undefined>();
  const { reset } = pager;
  React.useEffect(() => reset(), [status, reset]);
  const list = useAdminListKbs(api, { status, cursor: pager.cursor, limit: LIMIT });

  const columns: Array<DataColumn<AdminKbResponse>> = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (r) => (
        <Link href={customerPath(r.tenant_id, 'agents')} className="hover:text-primary">
          {r.tenant_name}
        </Link>
      ),
    },
    { key: 'agent', header: 'Agent', cell: (r) => <span className="flex flex-col"><span>{r.agent_name}</span><span className="text-xs text-muted-foreground">{humanize(r.agent_status)}</span></span> },
    { key: 'base', header: 'Platform base', cell: (r) => (r.has_platform_kb ? <Badge variant="outline">Yes</Badge> : <span className="text-muted-foreground">No</span>) },
    {
      key: 'sources',
      header: 'Sources',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.by_status.ready ? <Badge variant="success">{r.by_status.ready} ready</Badge> : null}
          {r.by_status.pending + r.by_status.syncing ? <Badge variant="info">{r.by_status.pending + r.by_status.syncing} syncing</Badge> : null}
          {r.by_status.failed ? <Badge variant="danger">{r.by_status.failed} failed</Badge> : null}
          {r.by_status.deleting ? <Badge variant="outline">{r.by_status.deleting} deleting</Badge> : null}
          {r.has_menu ? <Badge variant="outline">menu</Badge> : null}
          {!r.sources ? <span className="text-muted-foreground">none</span> : null}
        </span>
      ),
    },
    { key: 'size', header: 'Size', align: 'right', cell: (r) => (r.size_bytes ? formatBytes(r.size_bytes) : '–') },
    { key: 'synced', header: 'Last synced', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.last_synced_at)}</span> },
    { key: 'error', header: 'Last error', cell: (r) => (r.last_error ? <span className="block max-w-64 truncate text-xs text-danger" title={r.last_error}>{r.last_error}</span> : <span className="text-muted-foreground">–</span>) },
  ];

  return (
    <>
      <FilterBar>
        <FilterSelect label="Sources" allLabel="Any state" value={status} onChange={(v) => setStatus(v as Status | undefined)} options={STATUSES.map((s) => ({ value: s, label: `With a ${s} source` }))} />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No agent has knowledge yet', description: status ? `No agent has a ${status} source.` : 'Agents appear here once a customer adds what their agent knows.' }}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.agent_id} label="Knowledge bases" dense />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}
