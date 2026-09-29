'use client';

import type { AdminTicketSummary } from '@portal/schemas';
import Link from 'next/link';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { SlaCell, TicketPriorityBadge, TicketStatusBadge } from '@/src/components/support/ticket-badges';
import { relativeTime } from '@/src/lib/format';
import { customerPath } from '@/src/routes';

/** SA4 queue columns: number, subject, customer, priority, status, assignee, last activity, SLA. */
export function TicketsTable({ rows, onOpen, showCustomer = true }: { rows: AdminTicketSummary[]; onOpen: (id: number) => void; showCustomer?: boolean }) {
  const columns: Array<DataColumn<AdminTicketSummary>> = [
    { key: 'id', header: '#', cell: (r) => <span className="font-mono text-xs tabular-nums text-muted-foreground">{r.id}</span> },
    {
      key: 'subject',
      header: 'Subject',
      cell: (r) => (
        <div className="flex min-w-0 max-w-[28rem] flex-col">
          <span className="truncate font-medium">{r.subject}</span>
          <span className="truncate text-xs text-muted-foreground">
            {r.category ? `${r.category} · ` : ''}
            {r.message_count} {r.message_count === 1 ? 'message' : 'messages'}
            {r.tags.length ? ` · ${r.tags.join(', ')}` : ''}
          </span>
        </div>
      ),
    },
    ...(showCustomer
      ? [
          {
            key: 'customer',
            header: 'Customer',
            cell: (r: AdminTicketSummary) => (
              <Link href={customerPath(r.tenant_id)} className="truncate text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                {r.tenant_name}
              </Link>
            ),
          } satisfies DataColumn<AdminTicketSummary>,
        ]
      : []),
    { key: 'priority', header: 'Priority', cell: (r) => <TicketPriorityBadge priority={r.priority} /> },
    { key: 'status', header: 'Status', cell: (r) => <TicketStatusBadge status={r.status} /> },
    { key: 'assignee', header: 'Assignee', cell: (r) => (r.assignee ? <span className="truncate">{r.assignee.name ?? r.assignee.email}</span> : <span className="text-muted-foreground">Unassigned</span>) },
    { key: 'activity', header: 'Last activity', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{relativeTime(r.last_message_at ?? r.created_at)}</span> },
    { key: 'sla', header: 'SLA', cell: (r) => <SlaCell ticket={r} /> },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={(r) => String(r.id)} label="Tickets" onRowClick={(r) => onOpen(r.id)} />;
}
