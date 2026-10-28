'use client';

import { exportAdminAudit, useAdminAudit, useApi } from '@portal/api-client';
import type { AdminAuditEntry } from '@portal/schemas';
import { Button, Input, toast } from '@portal/ui';
import { Download } from 'lucide-react';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { AuditSheet, StaffAuditTable } from '@/src/components/audit/audit-table';
import { FilterBar } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { errorMessage } from '@/src/lib/errors';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { setParam, useUrlQuery } from '@/src/lib/use-url-query';

const LIMIT = 50;

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
  // `staff_id` / `tenant_id` are what older links carry (`auditPath`); the server matches an id typed here exactly.
  const [staff, setStaff] = React.useState(params.get('staff') ?? params.get('staff_id') ?? '');
  const [customer, setCustomer] = React.useState(params.get('customer') ?? params.get('tenant_id') ?? '');
  const [target, setTarget] = React.useState(params.get('target_id') ?? '');
  const d = { action: useDebouncedValue(action.trim(), 300), staff: useDebouncedValue(staff.trim(), 300), customer: useDebouncedValue(customer.trim(), 300), target: useDebouncedValue(target.trim(), 300) };
  const [open, setOpen] = React.useState<AdminAuditEntry | null>(null);
  const [exporting, setExporting] = React.useState(false);

  React.useEffect(() => {
    setQuery((n) => {
      setParam(n, 'action', d.action);
      setParam(n, 'staff', d.staff);
      setParam(n, 'customer', d.customer);
      setParam(n, 'target_id', d.target);
      n.delete('staff_id');
      n.delete('tenant_id');
    }, 'replace');
  }, [d.action, d.staff, d.customer, d.target, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [d.action, d.staff, d.customer, d.target, reset]);

  const filters = {
    action: d.action || undefined,
    staff: d.staff || undefined,
    customer: d.customer || undefined,
    target_id: d.target || undefined,
  };
  const list = useAdminAudit(api, { ...filters, cursor: pager.cursor, limit: LIMIT });
  const filtered = Object.values(filters).some(Boolean);

  async function exportCsv() {
    setExporting(true);
    try {
      const { blob, filename } = await exportAdminAudit(api, filters);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success('Audit export downloaded', { description: filtered ? 'The rows matching your filters, newest first.' : 'Newest first, up to 10,000 rows.' });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Audit"
        crumbs={[{ label: 'Audit' }]}
        description="Every customer-affecting staff write, newest first."
        actions={
          <Button variant="outline" size="sm" onClick={() => void exportCsv()} loading={exporting}>
            <Download /> Export CSV
          </Button>
        }
      />
      <FilterBar>
        <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action prefix, e.g. customer.pause" className="w-full sm:w-60" aria-label="Action prefix" />
        <Input value={staff} onChange={(e) => setStaff(e.target.value)} placeholder="Staff email or name" className="w-full sm:w-56" aria-label="Staff email or name" />
        <Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Customer name" className="w-full sm:w-56" aria-label="Customer name" />
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target id" className="w-full sm:w-56" aria-label="Target id" />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No audit entries match', description: filtered ? 'Nothing matches these filters. Staff matches part of an email or name; customer, part of a workspace name.' : undefined }}>
        {(rows) => <StaffAuditTable rows={rows} onOpen={setOpen} onFilterStaff={setStaff} onFilterCustomer={setCustomer} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
      <AuditSheet entry={open} onClose={() => setOpen(null)} />
    </>
  );
}
