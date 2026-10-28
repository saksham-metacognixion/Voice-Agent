'use client';

import { useAdminListUsers, useApi } from '@portal/api-client';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { FilterBar, SearchBox } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { UsersTable } from '@/src/components/users/users-table';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { setParam, useUrlQuery } from '@/src/lib/use-url-query';

const LIMIT = 25;

export default function UsersPage() {
  return (
    <AdminShell>
      <Users />
    </AdminShell>
  );
}

function Users() {
  const api = useApi();
  const [params, setQuery] = useUrlQuery();
  const pager = useCursorPager();
  const [q, setQ] = React.useState(params.get('q') ?? '');
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const tenantId = params.get('tenant_id') || undefined;
  React.useEffect(() => {
    setQuery((n) => setParam(n, 'q', debouncedQ), 'replace');
  }, [debouncedQ, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [debouncedQ, tenantId, reset]);

  const list = useAdminListUsers(api, { q: debouncedQ || undefined, tenant_id: tenantId, cursor: pager.cursor, limit: LIMIT });

  return (
    <>
      <PageHeader title="Users" crumbs={[{ label: 'Users' }]} description="Every sign-in across workspaces." />
      <FilterBar>
        <SearchBox value={q} onChange={setQ} placeholder="Email, name, user id…" />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No users match' }}>
        {(rows) => <UsersTable rows={rows} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}
