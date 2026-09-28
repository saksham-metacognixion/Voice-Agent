'use client';

import { useAdminListCalls, useApi } from '@portal/api-client';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { CallSheet } from '@/src/components/calls/call-sheet';
import { CallsTable } from '@/src/components/calls/calls-table';
import { FilterBar, FilterSelect, SearchBox } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { humanize } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';

const STATUSES = ['registered', 'in_progress', 'ended', 'analyzed', 'missed'] as const;
const LIMIT = 25;

export default function CallsPage() {
  return (
    <AdminShell>
      <Calls />
    </AdminShell>
  );
}

function Calls() {
  const api = useApi();
  const [params, setQuery] = useUrlQuery();
  const pager = useCursorPager();
  const [q, setQ] = React.useState(params.get('q') ?? '');
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const status = pickParam(params, 'status', STATUSES, '' as (typeof STATUSES)[number] | '') || undefined;
  const tenantId = params.get('tenant_id') || undefined;
  const openId = params.get('id');
  React.useEffect(() => {
    setQuery((n) => setParam(n, 'q', debouncedQ), 'replace');
  }, [debouncedQ, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [debouncedQ, status, tenantId, reset]);

  const list = useAdminListCalls(api, { q: debouncedQ || undefined, status, tenant_id: tenantId, cursor: pager.cursor, limit: LIMIT }, { refetchInterval: 30_000 });

  return (
    <>
      <PageHeader title="Calls" crumbs={[{ label: 'Calls' }]} description="Every call across workspaces, newest first (SA8)." />
      <FilterBar>
        <SearchBox value={q} onChange={setQ} placeholder="Customer, number, call id…" />
        <FilterSelect label="Status" value={status} onChange={(v) => setQuery((n) => setParam(n, 'status', v))} options={STATUSES.map((s) => ({ value: s, label: s === 'missed' ? 'Missed (declined)' : humanize(s) }))} />
        {tenantId ? (
          <button type="button" className="text-xs text-primary underline" onClick={() => setQuery((n) => setParam(n, 'tenant_id', null))}>
            Clear customer filter
          </button>
        ) : null}
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No calls match' }}>
        {(rows) => <CallsTable rows={rows} onOpen={(id) => setQuery((n) => setParam(n, 'id', id), 'replace')} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
      <CallSheet id={openId} onClose={() => setQuery((n) => setParam(n, 'id', null), 'replace')} />
    </>
  );
}
