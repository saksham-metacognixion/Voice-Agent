'use client';

import type { AdminCallResponse } from '@portal/schemas';
import { Badge } from '@portal/ui';
import Link from 'next/link';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { CallStatusBadge, SentimentBadge, TierBadge } from '@/src/components/common/status-badges';
import { formatCents, formatCredits, formatDateTime, formatDuration, formatPhone } from '@/src/lib/format';
import { customerPath } from '@/src/routes';

export function CallsTable({ rows, showCustomer = true, onOpen }: { rows: AdminCallResponse[]; showCustomer?: boolean; onOpen: (id: string) => void }) {
  const columns: Array<DataColumn<AdminCallResponse>> = [
    { key: 'time', header: 'Time', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.started_at ?? r.created_at)}</span> },
    ...(showCustomer
      ? [
          {
            key: 'customer',
            header: 'Customer',
            cell: (r: AdminCallResponse) => (
              <Link href={customerPath(r.tenant_id, 'calls')} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
                {r.tenant_name}
              </Link>
            ),
          },
        ]
      : []),
    { key: 'from', header: 'From', cell: (r) => <span className="whitespace-nowrap tabular-nums">{r.channel === 'web' ? 'Web test' : formatPhone(r.direction === 'inbound' ? r.from_number : r.to_number)}</span> },
    { key: 'agent', header: 'Agent', cell: (r) => r.agent_name ?? <span className="text-muted-foreground">–</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <CallStatusBadge status={r.status} />
          {r.decline_reason ? <Badge variant="outline">{r.decline_reason}</Badge> : null}
          {r.is_test ? <Badge variant="outline">test</Badge> : null}
        </span>
      ),
    },
    { key: 'duration', header: 'Duration', align: 'right', cell: (r) => formatDuration(r.duration_s) },
    { key: 'credits', header: 'Credits', align: 'right', cell: (r) => formatCredits(r.credits_charged) },
    { key: 'tier', header: 'Tier', cell: (r) => <TierBadge tier={r.tier} /> },
    { key: 'sentiment', header: 'Sentiment', cell: (r) => <SentimentBadge value={r.sentiment} /> },
    { key: 'cost', header: 'Cost', align: 'right', cell: (r) => (r.retell_cost_cents === null ? <span className="text-muted-foreground">–</span> : formatCents(r.retell_cost_cents)) },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Calls" onRowClick={(r) => onOpen(r.id)} />;
}
