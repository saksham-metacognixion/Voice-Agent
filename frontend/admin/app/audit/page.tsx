'use client';

import { useAdminAudit, useApi } from '@portal/api-client';
import type { AdminAuditEntry } from '@portal/schemas';
import { Input } from '@portal/ui';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { AuditSheet, StaffAuditTable } from '@/src/components/audit/audit-table';
import { FilterBar } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { setParam, useUrlQuery } from '@/src/lib/use-url-query';

const LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AuditPage() {
  return (
    <AdminShell>
      <Audit />
    </AdminShell>
  );
}

function Audit() {
  const api = useApi();
  const [params, setQuery] = useUrlQuery();
  const pager = useCursorPager();
  const [action, setAction] = React.useState(params.get('action') ?? '');
  const [staff, setStaff] = React.useState(params.get('staff_id') ?? '');
  const [tenant, setTenant] = React.useState(params.get('tenant_id') ?? '');
  const [target, setTarget] = React.useState(params.get('target_id') ?? '');
  const d = { action: useDebouncedValue(action.trim(), 300), staff: useDebouncedValue(staff.trim(), 300), tenant: useDebouncedValue(tenant.trim(), 300), target: useDebouncedValue(target.trim(), 300) };
  const [open, setOpen] = React.useState<AdminAuditEntry | null>(null);

  React.useEffect(() => {
    setQuery((n) => {
      setParam(n, 'action', d.action);
      setParam(n, 'staff_id', d.staff);
      setParam(n, 'tenant_id', d.tenant);
      setParam(n, 'target_id', d.target);
    }, 'replace');
  }, [d.action, d.staff, d.tenant, d.target, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [d.action, d.staff, d.tenant, d.target, reset]);

  const list = useAdminAudit(api, {
    action: d.action || undefined,
    staff_id: UUID.test(d.staff) ? d.staff : undefined,
    tenant_id: UUID.test(d.tenant) ? d.tenant : undefined,
    target_id: d.target || undefined,
    cursor: pager.cursor,
    limit: LIMIT,
  });

  return (
    <>
      <PageHeader title="Audit" crumbs={[{ label: 'Audit' }]} description="Every customer-affecting staff write, newest first (SA14, admin §10)." />
      <FilterBar>
        <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action prefix, e.g. customer.pause" className="w-full sm:w-60" aria-label="Action prefix" />
        <Input value={staff} onChange={(e) => setStaff(e.target.value)} placeholder="Staff id (uuid)" className="w-full sm:w-56" aria-label="Staff id" invalid={Boolean(staff.trim()) && !UUID.test(staff.trim())} />
        <Input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="Customer id (uuid)" className="w-full sm:w-56" aria-label="Customer id" invalid={Boolean(tenant.trim()) && !UUID.test(tenant.trim())} />
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target id" className="w-full sm:w-56" aria-label="Target id" />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No audit entries match' }}>
        {(rows) => <StaffAuditTable rows={rows} onOpen={setOpen} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
      <AuditSheet entry={open} onClose={() => setOpen(null)} />
    </>
  );
}
