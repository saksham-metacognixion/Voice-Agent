'use client';

import { useAdminGetPurchase, useApi } from '@portal/api-client';
import type { AdminBillingPurchase, AdminPurchaseDetail } from '@portal/schemas';
import { Badge, Skeleton } from '@portal/ui';
import Link from 'next/link';
import * as React from 'react';
import { RefundDialog } from '@/src/components/billing/refund-dialog';
import { Copyable } from '@/src/components/common/copyable';
import { CellActions, DataTable, type DataColumn } from '@/src/components/common/data-table';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { PermissionButton } from '@/src/components/common/permission-button';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { PurchaseStatusBadge, YesNo } from '@/src/components/common/status-badges';
import { formatCents, formatCredits, formatDateTime, formatDelta, humanize, shortId } from '@/src/lib/format';
import { reasonLabel } from '@/src/lib/reason-codes';
import { customerPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

/** The Refund action, shared by the rows, the sheet and the SA2 tab: one dialog, one permission. */
export function useRefundAction() {
  const { can } = useStaff();
  const denied = can.refund();
  const [target, setTarget] = React.useState<string | null>(null);
  const dialog = <RefundDialog purchaseId={target} onClose={() => setTarget(null)} />;
  return { denied, setTarget, dialog };
}

export function RefundButton({ purchase, denied, onClick, size = 'sm' }: { purchase: { status: string; refundable_cents?: number }; denied: string | null; onClick: () => void; size?: 'sm' | 'md' }) {
  if (purchase.status !== 'paid' || purchase.refundable_cents === 0) return null;
  return (
    <PermissionButton size={size} variant="danger-outline" denied={denied} onClick={onClick}>
      Refund
    </PermissionButton>
  );
}

export function PurchasesTable({ rows, onOpen }: { rows: AdminBillingPurchase[]; onOpen: (id: string) => void }) {
  const { denied, setTarget, dialog } = useRefundAction();
  const columns: Array<DataColumn<AdminBillingPurchase>> = [
    { key: 'created', header: 'Created', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at)}</span> },
    {
      key: 'customer',
      header: 'Customer',
      cell: (r) => (
        <Link href={customerPath(r.tenant_id, 'purchases')} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
          {r.tenant_name}
        </Link>
      ),
    },
    {
      key: 'pack',
      header: 'Pack',
      cell: (r) => (
        <span className="flex items-center gap-1">
          {r.pack_name ?? r.pack_id ?? '–'}
          {r.is_auto_topup ? <Badge variant="outline">auto top-up</Badge> : null}
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', cell: (r) => formatCents(r.amount_cents, r.currency) },
    { key: 'credits', header: 'Credits', align: 'right', cell: (r) => formatCredits(r.credits) },
    { key: 'status', header: 'Status', cell: (r) => <PurchaseStatusBadge status={r.status} /> },
    { key: 'refunded', header: 'Refunded', align: 'right', cell: (r) => (r.refunded_cents > 0 ? <span className="text-danger">{formatCents(r.refunded_cents, r.currency)}</span> : <span className="text-muted-foreground">–</span>) },
    { key: 'failure', header: 'Failure', cell: (r) => (r.failure_reason ? <span className="text-xs text-danger">{r.failure_reason}</span> : <span className="text-muted-foreground">–</span>) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <CellActions>
          <RefundButton purchase={r} denied={denied} onClick={() => setTarget(r.id)} />
        </CellActions>
      ),
    },
  ];
  return (
    <>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Purchases" onRowClick={(r) => onOpen(r.id)} dense />
      {dialog}
    </>
  );
}

export function PurchaseSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const api = useApi();
  const purchase = useAdminGetPurchase(api, { id: id ?? '' }, { enabled: Boolean(id) });
  const { denied, setTarget, dialog } = useRefundAction();
  const p = purchase.data;
  return (
    <DetailSheet open={Boolean(id)} onOpenChange={(o) => (o ? undefined : onClose())} title={p ? `${p.pack_name ?? p.pack_id ?? 'Purchase'} · ${formatCents(p.amount_cents, p.currency)}` : 'Purchase'} description={p ? <Copyable value={p.id} full /> : undefined}>
      {purchase.isPending ? (
        <Skeleton className="h-64" />
      ) : purchase.isError ? (
        <LoadError error={purchase.error} onRetry={() => void purchase.refetch()} compact />
      ) : !p ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <PurchaseStatusBadge status={p.status} />
            {p.is_auto_topup ? <Badge variant="outline">auto top-up</Badge> : null}
            <span className="ml-auto">
              <RefundButton purchase={p} denied={denied} onClick={() => setTarget(p.id)} />
            </span>
          </div>
          <PurchaseFacts p={p} />
          <Section title={`Refunds (${p.refunds.length})`}>
            {p.refunds.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {p.refunds.map((r) => (
                  <li key={r.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {formatCents(r.amount_cents, p.currency)} · {formatCredits(r.credits_reversed)} credits
                      </span>
                      <Badge variant={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{humanize(r.status)}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {reasonLabel(r.reason_code)} · {r.staff.email ?? r.staff.name ?? shortId(r.staff.id)} · {formatDateTime(r.created_at)}
                      {r.stripe_refund_id ? (
                        <>
                          {' '}
                          · <Copyable value={r.stripe_refund_id} />
                        </>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No refunds.</p>
            )}
          </Section>
          <Section title="Ledger">
            {p.ledger.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {p.ledger.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{humanize(l.reason)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(l.created_at)}</span>
                    </span>
                    <span className="tabular-nums">
                      <span className={l.delta < 0 ? 'text-danger' : 'text-success-emphasis'}>{formatDelta(l.delta)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">→ {formatCredits(l.balance_after)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing credited yet.</p>
            )}
          </Section>
          {dialog}
        </>
      )}
    </DetailSheet>
  );
}

function PurchaseFacts({ p }: { p: AdminPurchaseDetail }) {
  const lot = p.lots[0];
  return (
    <FactGrid columns={2}>
      <Fact label="Customer" wrap>
        <Link href={customerPath(p.tenant_id, 'purchases')} className="hover:text-primary">
          {p.tenant_name}
        </Link>
      </Fact>
      <Fact label="Pack">{p.pack_name ?? p.pack_id ?? '–'}</Fact>
      <Fact label="Amount">{formatCents(p.amount_cents, p.currency)}</Fact>
      <Fact label="Credits">{formatCredits(p.credits)}</Fact>
      <Fact label="Refunded">{p.refunded_cents > 0 ? formatCents(p.refunded_cents, p.currency) : '–'}</Fact>
      <Fact label="Refundable">{p.status === 'paid' ? formatCents(p.refundable_cents, p.currency) : '–'}</Fact>
      <Fact label="Created">{formatDateTime(p.created_at)}</Fact>
      <Fact label="Updated">{formatDateTime(p.updated_at)}</Fact>
      <Fact label="Auto top-up">
        <YesNo value={p.is_auto_topup} />
      </Fact>
      <Fact label="Failure" wrap>
        {p.failure_reason ? <span className="text-danger">{p.failure_reason}</span> : '–'}
      </Fact>
      <Fact label="Payment">{p.stripe_payment_intent ? <Copyable value={p.stripe_payment_intent} /> : p.stripe_session_id ? <Copyable value={p.stripe_session_id} /> : '–'}</Fact>
      <Fact label="Invoice" wrap>
        {p.invoice?.hosted_url || p.invoice_url ? (
          <a href={p.invoice?.hosted_url ?? p.invoice_url ?? '#'} target="_blank" rel="noopener noreferrer" className="text-primary underline">
            {p.invoice?.number ?? 'Open invoice'}
          </a>
        ) : (
          '–'
        )}
        {p.invoice?.pdf_url ? (
          <>
            {' · '}
            <a href={p.invoice.pdf_url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
              PDF
            </a>
          </>
        ) : null}
        {p.invoice?.status ? <span className="ml-2 text-xs text-muted-foreground">{humanize(p.invoice.status)}</span> : null}
      </Fact>
      <Fact label="Lot">{lot ? `${formatCredits(lot.credits_remaining)} of ${formatCredits(lot.credits_total)} left · expires ${formatDateTime(lot.expires_at)}` : '–'}</Fact>
    </FactGrid>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}
