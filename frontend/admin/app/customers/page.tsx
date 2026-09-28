'use client';

import { useAdminListCustomers, useApi } from '@portal/api-client';
import { adminCustomerStatus, planTier, type AdminCustomerStatus, type PlanTier } from '@portal/schemas';
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@portal/ui';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { FilterBar, FilterSelect, SearchBox } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { CustomersTable } from '@/src/components/customers/customers-table';
import { humanize } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';

const SORTS = ['created_at', 'name', 'balance', 'last_activity'] as const;
const ORDERS = ['asc', 'desc'] as const;
const LIMIT = 25;

export default function CustomersPage() {
  return (
    <AdminShell>
      <Customers />
    </AdminShell>
  );
}

function Customers() {
  const api = useApi();
  const [params, setQuery] = useUrlQuery();
  const pager = useCursorPager();
  const [q, setQ] = React.useState(params.get('q') ?? '');
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const plan = pickParam(params, 'plan', planTier.options, '' as PlanTier | '') || undefined;
  const status = pickParam(params, 'status', adminCustomerStatus.options, '' as AdminCustomerStatus | '') || undefined;
  const country = params.get('country')?.toUpperCase() || undefined;
  const sort = pickParam(params, 'sort', SORTS, 'created_at');
  const order = pickParam(params, 'order', ORDERS, 'desc');

  React.useEffect(() => {
    setQuery((n) => setParam(n, 'q', debouncedQ), 'replace');
  }, [debouncedQ, setQuery]);
  const filterKey = `${debouncedQ}|${plan}|${status}|${country}|${sort}|${order}`;
  const { reset } = pager;
  React.useEffect(() => reset(), [filterKey, reset]);

  const list = useAdminListCustomers(api, { q: debouncedQ || undefined, plan, status, country: country && country.length === 2 ? country : undefined, sort, order, cursor: pager.cursor, limit: LIMIT });

  return (
    <>
      <PageHeader title="Customers" crumbs={[{ label: 'Customers' }]} description={list.data?.total !== undefined ? `${list.data.total} workspaces` : undefined} />
      <FilterBar>
        <SearchBox value={q} onChange={setQ} placeholder="Name, owner email, id…" />
        <FilterSelect label="Plan" value={plan} onChange={(v) => setQuery((n) => setParam(n, 'plan', v))} options={planTier.options.map((p) => ({ value: p, label: humanize(p) }))} />
        <FilterSelect label="Status" value={status} onChange={(v) => setQuery((n) => setParam(n, 'status', v))} options={adminCustomerStatus.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <Input value={country ?? ''} onChange={(e) => setQuery((n) => setParam(n, 'country', e.target.value.toUpperCase().slice(0, 2)), 'replace')} placeholder="CC" maxLength={2} className="w-20 uppercase" aria-label="Country (ISO code)" />
        <Select value={`${sort}:${order}`} onValueChange={(v) => setQuery((n) => { const [s, o] = v.split(':'); setParam(n, 'sort', s === 'created_at' ? null : s); setParam(n, 'order', o === 'desc' ? null : o); })}>
          <SelectTrigger className="w-auto min-w-44" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="created_at:desc">Newest first</SelectItem>
            <SelectItem value="created_at:asc">Oldest first</SelectItem>
            <SelectItem value="name:asc">Name A–Z</SelectItem>
            <SelectItem value="name:desc">Name Z–A</SelectItem>
            <SelectItem value="balance:asc">Balance low → high</SelectItem>
            <SelectItem value="balance:desc">Balance high → low</SelectItem>
            <SelectItem value="last_activity:desc">Recently active</SelectItem>
            <SelectItem value="last_activity:asc">Least recently active</SelectItem>
          </SelectContent>
        </Select>
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No customers match', description: 'Try a broader search or clear a filter.' }}>
        {(rows) => <CustomersTable rows={rows} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}
