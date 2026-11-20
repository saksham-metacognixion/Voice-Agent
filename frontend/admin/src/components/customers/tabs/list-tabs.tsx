'use client';

import {
  useAdminAudit, useAdminCustomerAgents, useAdminCustomerAudit, useAdminCustomerCalls, useAdminCustomerJobs, useAdminCustomerNumbers, useAdminCustomerWebhookEvents, useApi,
} from '@portal/api-client';
import type { AdminAuditEntry, AdminCustomerAuditEntry } from '@portal/schemas';
import { cn } from '@portal/ui';
import * as React from 'react';
import { AuditSheet, StaffAuditTable } from '@/src/components/audit/audit-table';
import { CallSheet } from '@/src/components/calls/call-sheet';
import { CallsTable } from '@/src/components/calls/calls-table';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { JsonView } from '@/src/components/common/json-view';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { JobSheet, JobsTable } from '@/src/components/system/jobs-table';
import { WebhookSheet, WebhooksTable } from '@/src/components/system/webhooks-table';
import { AgentsTable } from '@/src/components/telephony/agents-table';
import { AgentSheet, NumberSheet } from '@/src/components/telephony/detail-panels';
import { NumbersTable } from '@/src/components/telephony/numbers-table';
import { formatDateTime, shortId } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';

const LIMIT = 25;

function usePaged<T extends { items: unknown[]; next_cursor: string | null; total?: number }>(list: { data?: T }, pager: ReturnType<typeof useCursorPager>) {
  return <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />;
}

export function AgentsTab({ customerId }: { customerId: string }) {
  const api = useApi();
  const pager = useCursorPager();
  const [open, setOpen] = React.useState<string | null>(null);
  const list = useAdminCustomerAgents(api, { id: customerId }, { cursor: pager.cursor, limit: LIMIT });
  return (
    <>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No agents' }}>
        {(rows) => <AgentsTable rows={rows} showCustomer={false} onOpen={setOpen} />}
      </QueryList>
      {usePaged(list, pager)}
      <AgentSheet id={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function NumbersTab({ customerId }: { customerId: string }) {
  const api = useApi();
  const pager = useCursorPager();
  const [open, setOpen] = React.useState<string | null>(null);
  const list = useAdminCustomerNumbers(api, { id: customerId }, { cursor: pager.cursor, limit: LIMIT });
  return (
    <>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No numbers' }}>
        {(rows) => <NumbersTable rows={rows} showCustomer={false} onOpen={setOpen} />}
      </QueryList>
      {usePaged(list, pager)}
      <NumberSheet id={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function CallsTab({ customerId }: { customerId: string }) {
  const api = useApi();
  const pager = useCursorPager();
  const [open, setOpen] = React.useState<string | null>(null);
  const list = useAdminCustomerCalls(api, { id: customerId }, { cursor: pager.cursor, limit: LIMIT });
  return (
    <>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No calls yet' }}>
        {(rows) => <CallsTable rows={rows} showCustomer={false} onOpen={setOpen} />}
      </QueryList>
      {usePaged(list, pager)}
      <CallSheet id={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function JobsTab({ customerId }: { customerId: string }) {
  const api = useApi();
  const pager = useCursorPager();
  const [open, setOpen] = React.useState<string | null>(null);
  const list = useAdminCustomerJobs(api, { id: customerId }, { cursor: pager.cursor, limit: LIMIT });
  return (
    <>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No jobs' }}>
        {(rows) => <JobsTable rows={rows} showCustomer={false} onOpen={setOpen} />}
      </QueryList>
      {usePaged(list, pager)}
      <JobSheet id={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function WebhooksTab({ customerId }: { customerId: string }) {
  const api = useApi();
  const pager = useCursorPager();
  const [open, setOpen] = React.useState<string | null>(null);
  const list = useAdminCustomerWebhookEvents(api, { id: customerId }, { cursor: pager.cursor, limit: LIMIT });
  return (
    <>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No webhook events' }}>
        {(rows) => <WebhooksTable rows={rows} showCustomer={false} onOpen={setOpen} />}
      </QueryList>
      {usePaged(list, pager)}
      <WebhookSheet id={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** SA2 Audit: the customer's own `audit_log` or the staff writes against this workspace. */
export function AuditTab({ customerId }: { customerId: string }) {
  const [source, setSource] = React.useState<'customer' | 'staff'>('customer');
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Audit source" className="inline-flex self-start rounded-md border border-border bg-muted p-0.5 text-xs">
        {(['customer', 'staff'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={source === s} onClick={() => setSource(s)} className={cn('rounded px-3 py-1.5 font-medium transition-colors', source === s ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground')}>
            {s === 'customer' ? 'Customer actions' : 'Staff actions'}
          </button>
        ))}
      </div>
      {source === 'customer' ? <CustomerAudit customerId={customerId} /> : <StaffAudit customerId={customerId} />}
    </div>
  );
}

function CustomerAudit({ customerId }: { customerId: string }) {
  const api = useApi();
  const pager = useCursorPager();
  const [open, setOpen] = React.useState<AdminCustomerAuditEntry | null>(null);
  const list = useAdminCustomerAudit(api, { id: customerId }, { source: 'customer', cursor: pager.cursor, limit: LIMIT });
  const columns: Array<DataColumn<AdminCustomerAuditEntry>> = [
    { key: 'time', header: 'Time', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at, { seconds: true })}</span> },
    { key: 'actor', header: 'Actor', cell: (r) => r.actor_email ?? <span className="text-muted-foreground">system</span> },
    { key: 'action', header: 'Action', cell: (r) => <code className="text-xs">{r.action}</code> },
    { key: 'target', header: 'Target', cell: (r) => (r.target_type || r.target_id ? <span className="text-xs">{r.target_type ?? ''} <span className="font-mono text-muted-foreground">{shortId(r.target_id, 12)}</span></span> : <span className="text-muted-foreground">–</span>) },
    { key: 'ip', header: 'IP', cell: (r) => <span className="font-mono text-xs text-muted-foreground">{r.ip ?? '–'}</span> },
  ];
  return (
    <>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No customer audit entries' }}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Customer audit log" onRowClick={setOpen} dense />}
      </QueryList>
      {usePaged(list, pager)}
      <DetailSheet open={Boolean(open)} onOpenChange={(o) => (o ? undefined : setOpen(null))} title={open?.action ?? 'Audit entry'} description={open ? formatDateTime(open.created_at, { seconds: true }) : undefined}>
        {open ? (
          <>
            <p className="text-sm">
              {open.actor_email ?? 'system'} · {open.target_type ?? ''} <span className="font-mono text-xs">{open.target_id ?? ''}</span>
            </p>
            <JsonView value={open.meta} />
          </>
        ) : null}
      </DetailSheet>
    </>
  );
}

function StaffAudit({ customerId }: { customerId: string }) {
  const api = useApi();
  const pager = useCursorPager();
  const [open, setOpen] = React.useState<AdminAuditEntry | null>(null);
  const list = useAdminAudit(api, { tenant_id: customerId, cursor: pager.cursor, limit: LIMIT });
  return (
    <>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No staff actions on this workspace' }}>
        {(rows) => <StaffAuditTable rows={rows} showCustomer={false} onOpen={setOpen} />}
      </QueryList>
      {usePaged(list, pager)}
      <AuditSheet entry={open} onClose={() => setOpen(null)} />
    </>
  );
}
