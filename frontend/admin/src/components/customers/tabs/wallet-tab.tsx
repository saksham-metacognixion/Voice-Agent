'use client';

import { adminGetCustomerWallet, useAdminGetCustomerWallet, useApi } from '@portal/api-client';
import type { AdminCustomerWallet, LedgerEntryResponse } from '@portal/schemas';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton, cn, toast } from '@portal/ui';
import * as React from 'react';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { PermissionButton } from '@/src/components/common/permission-button';
import { LoadError } from '@/src/components/common/query-states';
import { AdjustCreditsDialog } from '@/src/components/customers/adjust-credits-dialog';
import { errorMessage } from '@/src/lib/errors';
import { formatCredits, formatDate, formatDateTime, formatDelta, humanize, shortId } from '@/src/lib/format';
import { reasonLabel } from '@/src/lib/reason-codes';
import { useStaff } from '@/src/staff/staff-provider';

export function WalletTab({ customerId, customerName }: { customerId: string; customerName: string }) {
  const api = useApi();
  const { can } = useStaff();
  const wallet = useAdminGetCustomerWallet(api, { id: customerId });
  const [extra, setExtra] = React.useState<{ rows: LedgerEntryResponse[]; next: string | null; loadedFor: string | null }>({ rows: [], next: null, loadedFor: null });
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [adjusting, setAdjusting] = React.useState(false);

  if (wallet.isPending) return <Skeleton className="h-64" aria-busy />;
  if (wallet.isError) return <LoadError error={wallet.error} onRetry={() => void wallet.refetch()} />;
  const w = wallet.data;
  // Extra pages belong to the first page they were loaded after; a refetch that moved the head drops them.
  const headKey = w.ledger[0]?.id ?? 'empty';
  const rows = extra.loadedFor === headKey ? [...w.ledger, ...extra.rows] : w.ledger;
  const nextCursor = extra.loadedFor === headKey ? extra.next : w.ledger_next_cursor;

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await adminGetCustomerWallet(api, { id: customerId }, { cursor: nextCursor });
      setExtra((e) => ({ rows: [...(e.loadedFor === headKey ? e.rows : []), ...page.ledger], next: page.ledger_next_cursor, loadedFor: headKey }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-xs text-muted-foreground">Balance</p>
          <p className={cn('text-2xl font-semibold tabular-nums', w.balance <= 0 && 'text-danger')}>{formatCredits(w.balance)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Last pack</p>
          <p className="text-lg tabular-nums">{w.last_pack_credits === null ? '–' : formatCredits(w.last_pack_credits)}</p>
        </div>
        <span className="ml-auto">
          <PermissionButton size="sm" denied={can.adjustCredits()} onClick={() => setAdjusting(true)}>
            Adjust credits
          </PermissionButton>
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Lots (FIFO by expiry)</CardTitle>
        </CardHeader>
        <CardContent>
          {w.lots.length ? <DataTable rows={w.lots} columns={lotColumns} rowKey={(r) => r.id} label="Credit lots" dense /> : <p className="text-sm text-muted-foreground">No lots.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Ledger (append-only)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {rows.length ? <DataTable rows={rows} columns={ledgerColumns} rowKey={(r) => r.id} label="Credit ledger" dense /> : <p className="text-sm text-muted-foreground">No movements yet.</p>}
          {nextCursor ? (
            <Button variant="outline" size="sm" className="self-center" onClick={() => void loadMore()} loading={loadingMore}>
              Load more
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Staff adjustments</CardTitle>
        </CardHeader>
        <CardContent>{w.adjustments.length ? <DataTable rows={w.adjustments} columns={adjustmentColumns} rowKey={(r) => r.id} label="Staff adjustments" dense /> : <p className="text-sm text-muted-foreground">None.</p>}</CardContent>
      </Card>

      {adjusting ? <AdjustCreditsDialog customerId={customerId} customerName={customerName} balance={w.balance} onClose={() => setAdjusting(false)} /> : null}
    </div>
  );
}

type Lot = AdminCustomerWallet['lots'][number];
const lotColumns: Array<DataColumn<Lot>> = [
  { key: 'id', header: 'Lot', cell: (r) => <span className="font-mono text-xs">{shortId(r.id)}</span> },
  { key: 'purchase', header: 'Purchase', cell: (r) => (r.purchase_id ? <span className="font-mono text-xs">{shortId(r.purchase_id)}</span> : <span className="text-muted-foreground">trial / grant</span>) },
  { key: 'total', header: 'Total', align: 'right', cell: (r) => formatCredits(r.credits_total) },
  { key: 'remaining', header: 'Remaining', align: 'right', cell: (r) => <span className={cn(r.credits_remaining === 0 && 'text-muted-foreground')}>{formatCredits(r.credits_remaining)}</span> },
  { key: 'created', header: 'Created', cell: (r) => formatDate(r.created_at) },
  { key: 'expires', header: 'Expires', cell: (r) => <span className={cn(new Date(r.expires_at).getTime() < Date.now() && 'text-danger')}>{formatDate(r.expires_at)}</span> },
];

const ledgerColumns: Array<DataColumn<LedgerEntryResponse>> = [
  { key: 'time', header: 'Time', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at)}</span> },
  { key: 'reason', header: 'Reason', cell: (r) => <Badge variant={r.reason === 'call' || r.reason === 'rental' || r.reason === 'expiry' || r.reason === 'kb' ? 'outline' : 'primary'}>{humanize(r.reason)}</Badge> },
  { key: 'delta', header: 'Delta', align: 'right', cell: (r) => <span className={cn('font-medium', r.delta < 0 ? 'text-danger' : 'text-success-emphasis')}>{formatDelta(r.delta)}</span> },
  { key: 'after', header: 'Balance after', align: 'right', cell: (r) => formatCredits(r.balance_after) },
  { key: 'ref', header: 'Ref', cell: (r) => (r.ref_id ? <span className="font-mono text-xs text-muted-foreground">{r.ref_type ?? ''} {shortId(r.ref_id, 14)}</span> : <span className="text-muted-foreground">–</span>) },
];

type Adjustment = AdminCustomerWallet['adjustments'][number];
const adjustmentColumns: Array<DataColumn<Adjustment>> = [
  { key: 'time', header: 'Time', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at)}</span> },
  { key: 'staff', header: 'Staff', cell: (r) => r.staff_email ?? '–' },
  { key: 'delta', header: 'Delta', align: 'right', cell: (r) => <span className={cn('font-medium', r.delta < 0 ? 'text-danger' : 'text-success-emphasis')}>{formatDelta(r.delta)}</span> },
  { key: 'reason', header: 'Reason', cell: (r) => reasonLabel(r.reason_code) },
  { key: 'note', header: 'Note', cell: (r) => r.note ?? <span className="text-muted-foreground">–</span> },
  { key: 'customer', header: 'Customer text', cell: (r) => r.customer_text ?? <span className="text-muted-foreground">–</span> },
];
