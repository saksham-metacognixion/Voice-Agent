'use client';

import type { AdminAuditEntry } from '@portal/schemas';
import { Badge } from '@portal/ui';
import Link from 'next/link';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { JsonView } from '@/src/components/common/json-view';
import { Fact, FactGrid } from '@/src/components/common/query-states';
import { formatDateTime, shortId } from '@/src/lib/format';
import { diffPaths } from '@/src/lib/json';
import { reasonLabel } from '@/src/lib/reason-codes';
import { customerPath } from '@/src/routes';

/** SA14 staff audit log. */
export function StaffAuditTable({ rows, showCustomer = true, onOpen }: { rows: AdminAuditEntry[]; showCustomer?: boolean; onOpen: (entry: AdminAuditEntry) => void }) {
  const columns: Array<DataColumn<AdminAuditEntry>> = [
    { key: 'time', header: 'Time', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at, { seconds: true })}</span> },
    { key: 'staff', header: 'Staff', cell: (r) => <span className="truncate">{r.staff_email ?? shortId(r.staff_id)}</span> },
    { key: 'action', header: 'Action', cell: (r) => <code className="text-xs">{r.action}</code> },
    { key: 'target', header: 'Target', cell: (r) => (r.target_type || r.target_id ? <span className="whitespace-nowrap text-xs">{r.target_type ?? ''} <span className="font-mono text-muted-foreground">{shortId(r.target_id, 12)}</span></span> : <span className="text-muted-foreground">–</span>) },
    ...(showCustomer
      ? [
          {
            key: 'customer',
            header: 'Customer',
            cell: (r: AdminAuditEntry) =>
              r.tenant_id ? (
                <Link href={customerPath(r.tenant_id, 'audit')} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
                  {r.tenant_name ?? shortId(r.tenant_id)}
                </Link>
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
