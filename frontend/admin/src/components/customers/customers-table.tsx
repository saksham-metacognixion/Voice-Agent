'use client';

import type { AdminCustomerSummary } from '@portal/schemas';
import { Badge, cn } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { CustomerStatusBadge, PlanBadge } from '@/src/components/common/status-badges';
import { balanceTone } from '@/src/lib/badges';
import { formatCredits, formatNumber, relativeTime } from '@/src/lib/format';
import { customerPath } from '@/src/routes';

export function BalanceCell({ balance, lastPack }: { balance: number; lastPack: number | null }) {
  const tone = balanceTone(balance, lastPack);
  return <span className={cn('font-medium tabular-nums', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning-emphasis')}>{formatCredits(balance)}</span>;
}

/** SA2 list. Row click opens the Customer 360. */
export function CustomersTable({ rows }: { rows: AdminCustomerSummary[] }) {
  const router = useRouter();
  const columns: Array<DataColumn<AdminCustomerSummary>> = [
    {
      key: 'name',
      header: 'Customer',
      cell: (r) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{r.name}</span>
          <span className="text-xs text-muted-foreground">
            {r.country} · {r.owner_email ?? 'no owner'}
          </span>
        </div>
      ),
    },
    { key: 'plan', header: 'Plan', cell: (r) => <PlanBadge tier={r.plan_tier} /> },
    { key: 'status', header: 'Status', cell: (r) => <CustomerStatusBadge status={r.status} /> },
    { key: 'balance', header: 'Balance', align: 'right', cell: (r) => <BalanceCell balance={r.balance} lastPack={r.last_pack_credits} /> },
    { key: 'usage', header: '30-d usage', align: 'right', cell: (r) => formatCredits(r.usage_30d) },
    { key: 'agents', header: 'Agents', align: 'right', cell: (r) => `${r.agents_live} / ${r.agents_total}` },
    { key: 'numbers', header: 'Numbers', align: 'right', cell: (r) => formatNumber(r.numbers_active, 0) },
    { key: 'activity', header: 'Last activity', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{relativeTime(r.last_activity_at)}</span> },
    {
      key: 'flags',
      header: 'Flags',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.custom_deal ? <Badge variant="premium">Custom deal</Badge> : null}
          {r.flags.map((f) => (
            <Badge key={f} variant="outline">
              {f}
            </Badge>
          ))}
        </span>
      ),
    },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Customers" onRowClick={(r) => router.push(customerPath(r.id))} />;
}
