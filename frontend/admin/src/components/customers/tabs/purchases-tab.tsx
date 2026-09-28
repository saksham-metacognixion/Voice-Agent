'use client';

import { useAdminCustomerPurchases, useApi } from '@portal/api-client';
import type { AdminPurchaseResponse } from '@portal/schemas';
import { Badge } from '@portal/ui';
import { Copyable } from '@/src/components/common/copyable';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { PurchaseStatusBadge } from '@/src/components/common/status-badges';
import { formatCents, formatDateTime, formatNumber } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';

const LIMIT = 25;

export function PurchasesTab({ customerId }: { customerId: string }) {
  const api = useApi();
  const pager = useCursorPager();
  const list = useAdminCustomerPurchases(api, { id: customerId }, { cursor: pager.cursor, limit: LIMIT });
  const columns: Array<DataColumn<AdminPurchaseResponse>> = [
    { key: 'created', header: 'Created', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at)}</span> },
    { key: 'pack', header: 'Pack', cell: (r) => <span className="flex items-center gap-1">{r.pack_id ?? '–'}{r.is_auto_topup ? <Badge variant="outline">auto top-up</Badge> : null}</span> },
    { key: 'amount', header: 'Amount', align: 'right', cell: (r) => formatCents(r.amount_cents, r.currency) },
    { key: 'credits', header: 'Credits', align: 'right', cell: (r) => formatNumber(r.credits, 0) },
    { key: 'status', header: 'Status', cell: (r) => <PurchaseStatusBadge status={r.status} /> },
    { key: 'failure', header: 'Failure', cell: (r) => (r.failure_reason ? <span className="text-xs text-danger">{r.failure_reason}</span> : <span className="text-muted-foreground">–</span>) },
    { key: 'stripe', header: 'Stripe', cell: (r) => (r.stripe_payment_intent ? <Copyable value={r.stripe_payment_intent} /> : r.stripe_session_id ? <Copyable value={r.stripe_session_id} /> : <span className="text-muted-foreground">–</span>) },
    { key: 'invoice', header: 'Invoice', cell: (r) => (r.invoice_url ? <a href={r.invoice_url} target="_blank" rel="noopener noreferrer" className="text-primary underline" onClick={(e) => e.stopPropagation()}>Open</a> : <span className="text-muted-foreground">–</span>) },
    { key: 'updated', header: 'Updated', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.updated_at)}</span> },
  ];
  return (
    <>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No purchases' }}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Purchases" dense />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}
