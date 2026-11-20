'use client';

import type { AdminAuditEntry } from '@portal/schemas';
import { Badge } from '@portal/ui';
import { Filter } from 'lucide-react';
import Link from 'next/link';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { JsonView } from '@/src/components/common/json-view';
import { Fact, FactGrid } from '@/src/components/common/query-states';
import { formatDateTime, shortId } from '@/src/lib/format';
import { diffPaths } from '@/src/lib/json';
import { reasonLabel } from '@/src/lib/reason-codes';
import { customerPath } from '@/src/routes';

/**
 * SA14 staff audit log. With `onFilterStaff` / `onFilterCustomer` (the Audit page), a staff
 * email and a customer's filter button apply that filter, so nobody has to find an id.
 */
export function StaffAuditTable({
  rows,
  showCustomer = true,
  onOpen,
  onFilterStaff,
  onFilterCustomer,
}: {
  rows: AdminAuditEntry[];
  showCustomer?: boolean;
  onOpen: (entry: AdminAuditEntry) => void;
  onFilterStaff?: (staff: string) => void;
  onFilterCustomer?: (customer: string) => void;
}) {
  const columns: Array<DataColumn<AdminAuditEntry>> = [
    { key: 'time', header: 'Time', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at, { seconds: true })}</span> },
    {
      key: 'staff',
      header: 'Staff',
      cell: (r) => {
        const label = r.staff_email ?? shortId(r.staff_id);
        if (!onFilterStaff) return <span className="truncate">{label}</span>;
        return (
          <button
            type="button"
            className="truncate text-left hover:text-primary hover:underline"
            title="Show only this person’s entries"
            onClick={(e) => {
              e.stopPropagation();
              onFilterStaff(r.staff_email ?? r.staff_id);
            }}
          >
            {label}
          </button>
        );
      },
    },
    { key: 'action', header: 'Action', cell: (r) => <code className="text-xs">{r.action}</code> },
    { key: 'target', header: 'Target', cell: (r) => (r.target_type || r.target_id ? <span className="whitespace-nowrap text-xs">{r.target_type ?? ''} <span className="font-mono text-muted-foreground">{shortId(r.target_id, 12)}</span></span> : <span className="text-muted-foreground">–</span>) },
    ...(showCustomer
      ? [
          {
            key: 'customer',
            header: 'Customer',
            cell: (r: AdminAuditEntry) =>
              r.tenant_id ? (
                <span className="flex items-center gap-1">
                  <Link href={customerPath(r.tenant_id, 'audit')} onClick={(e) => e.stopPropagation()} className="truncate hover:text-primary">
                    {r.tenant_name ?? shortId(r.tenant_id)}
                  </Link>
                  {onFilterCustomer ? (
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-primary"
                      title="Show only this customer’s entries"
                      aria-label={`Show only ${r.tenant_name ?? 'this customer'}’s entries`}
                      onClick={(e) => {
                        e.stopPropagation();
                        // The id, not the name: two workspaces can share a name, and the server matches an id exactly.
                        onFilterCustomer(r.tenant_id!);
                      }}
                    >
                      <Filter className="size-3.5" aria-hidden />
                    </button>
                  ) : null}
                </span>
              ) : (
                <span className="text-muted-foreground">–</span>
              ),
          },
        ]
      : []),
    { key: 'reason', header: 'Reason', cell: (r) => (r.reason_code ? <Badge variant="outline">{reasonLabel(r.reason_code)}</Badge> : <span className="text-muted-foreground">–</span>) },
    { key: 'note', header: 'Note', cell: (r) => (r.note ? <span className="block max-w-56 truncate" title={r.note}>{r.note}</span> : <span className="text-muted-foreground">–</span>) },
    { key: 'request', header: 'Request', cell: (r) => <span className="font-mono text-xs text-muted-foreground">{shortId(r.request_id, 10)}</span> },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Staff audit log" onRowClick={onOpen} dense />;
}

export function AuditSheet({ entry, onClose }: { entry: AdminAuditEntry | null; onClose: () => void }) {
  const changed = entry ? diffPaths(entry.before, entry.after) : [];
  return (
    <DetailSheet open={Boolean(entry)} onOpenChange={(o) => (o ? undefined : onClose())} title={entry?.action ?? 'Audit entry'} description={entry ? formatDateTime(entry.created_at, { seconds: true }) : undefined}>
      {entry ? (
        <>
          <FactGrid columns={2}>
            <Fact label="Staff" wrap>
              {entry.staff_email ?? entry.staff_id}
            </Fact>
            <Fact label="Customer" wrap>
              {entry.tenant_id ? (
                <Link href={customerPath(entry.tenant_id)} className="hover:text-primary">
                  {entry.tenant_name ?? entry.tenant_id}
                </Link>
              ) : (
                '–'
              )}
            </Fact>
            <Fact label="Target" wrap>
              {entry.target_type ?? '–'} {entry.target_id ? <span className="font-mono text-xs">{entry.target_id}</span> : null}
            </Fact>
            <Fact label="Reason">{reasonLabel(entry.reason_code)}</Fact>
            <Fact label="IP">{entry.ip ?? '–'}</Fact>
            <Fact label="Request id" wrap>
              <span className="font-mono text-xs">{entry.request_id ?? '–'}</span>
            </Fact>
            <Fact label="View-as session" wrap>
              <span className="font-mono text-xs">{entry.impersonation_id ?? '–'}</span>
            </Fact>
            <Fact label="Note" wrap>
              {entry.note ?? '–'}
            </Fact>
          </FactGrid>
          {changed.length ? (
            <p className="text-xs text-muted-foreground">
              Changed: {changed.map((p) => <code key={p} className="mr-1 rounded bg-muted px-1">{p}</code>)}
            </p>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Before</p>
              <JsonView value={entry.before} maxHeight="max-h-80" />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">After</p>
              <JsonView value={entry.after} maxHeight="max-h-80" />
            </div>
          </div>
        </>
      ) : null}
    </DetailSheet>
  );
}
