'use client';

import { useAdminApprovePurchaseReview, useAdminRejectPurchaseReview, useApi } from '@portal/api-client';
import type { AdminPurchaseReview, StaffActionRequest } from '@portal/schemas';
import { Badge, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { CellActions, DataTable, type DataColumn } from '@/src/components/common/data-table';
import { PermissionButton } from '@/src/components/common/permission-button';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { PurchaseStatusBadge } from '@/src/components/common/status-badges';
import { formatCents, formatCredits, formatDateTime, relativeTime } from '@/src/lib/format';
import { customerPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

type Decision = 'approve' | 'reject';

/**
 * §17 "manual review flag for > $1,000 first purchase" (ADR 0036 §3). A first purchase over
 * the limit waits here with no Stripe session: approving lets the customer pay it, rejecting
 * closes it — nothing was charged either way. Every decision takes a reason code (no
 * default), lands in `staff_audit_log` and the workspace's own log, and emails the
 * workspace's owners and admins.
 */
export function PurchaseReviewsTable({ rows }: { rows: AdminPurchaseReview[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const denied = can.purchaseReview();
  const approve = useAdminApprovePurchaseReview(api);
  const reject = useAdminRejectPurchaseReview(api);
  const [target, setTarget] = React.useState<{ row: AdminPurchaseReview; decision: Decision } | null>(null);

  async function run(body: StaffActionRequest) {
    if (!target) return;
    const mutation = target.decision === 'approve' ? approve : reject;
    await mutation.mutateAsync({ params: { id: target.row.id }, body });
    toast.success(target.decision === 'approve' ? `Approved — ${target.row.tenant_name} can now pay` : `Rejected — ${target.row.tenant_name} was told, nothing was charged`);
    await Promise.all(['adminListPurchaseReviews', 'adminListPurchases'].map((queryKey) => queryClient.invalidateQueries({ queryKey: [queryKey] })));
  }

  const columns: Array<DataColumn<AdminPurchaseReview>> = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (r) => (
        <Link href={customerPath(r.tenant_id, 'wallet')} className="hover:text-primary">
          {r.tenant_name}
        </Link>
      ),
    },
    { key: 'country', header: 'Country', cell: (r) => r.tenant_country },
    { key: 'age', header: 'Workspace age', cell: (r) => <span title={formatDateTime(r.tenant_created_at)}>{relativeTime(r.tenant_created_at)}</span> },
    { key: 'asked', header: 'Asked', cell: (r) => <span className="whitespace-nowrap" title={formatDateTime(r.created_at)}>{relativeTime(r.created_at)}</span> },
    { key: 'by', header: 'Requested by', cell: (r) => r.requested_by_email ?? '–' },
    { key: 'pack', header: 'Pack', cell: (r) => r.pack_id ?? '–' },
    { key: 'amount', header: 'Amount', align: 'right', cell: (r) => (r.amount_cents !== null ? formatCents(r.amount_cents, r.currency ?? 'USD') : '–') },
    { key: 'credits', header: 'Credits', align: 'right', cell: (r) => (r.credits !== null ? formatCredits(r.credits) : '–') },
    { key: 'review', header: 'Review', cell: (r) => <Badge variant={r.status === 'open' ? 'warning' : r.status === 'approved' ? 'success' : 'danger'}>{r.status}</Badge> },
    { key: 'purchase', header: 'Purchase', cell: (r) => (r.purchase_status ? <PurchaseStatusBadge status={r.purchase_status} /> : '–') },
    { key: 'reviewer', header: 'Decided by', cell: (r) => (r.reviewer_email ? <span title={r.decided_at ? formatDateTime(r.decided_at) : undefined}>{r.reviewer_email}</span> : '–') },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) =>
        r.status === 'open' ? (
          <CellActions>
            <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget({ row: r, decision: 'approve' })}>
              Approve
            </PermissionButton>
            <PermissionButton size="sm" variant="danger-outline" denied={denied} onClick={() => setTarget({ row: r, decision: 'reject' })}>
              Reject
            </PermissionButton>
          </CellActions>
        ) : null,
    },
  ];

  return (
    <>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="First-purchase reviews" dense />
      <StaffActionDialog
        open={Boolean(target)}
        onOpenChange={(o) => (o ? undefined : setTarget(null))}
        title={target?.decision === 'approve' ? 'Approve this first purchase' : 'Reject this first purchase'}
        description={target ? `${target.row.tenant_name} · ${target.row.pack_id ?? 'pack'} · ${target.row.amount_cents !== null ? formatCents(target.row.amount_cents, target.row.currency ?? 'USD') : ''}` : undefined}
        consequences={
          target?.decision === 'approve'
            ? ['The customer can now pay for this pack at this price through Stripe Checkout.', 'Credits are added only when Stripe confirms the payment.', 'Owners and admins of the workspace are emailed.']
            : ['The purchase is closed. Nothing was charged, so nothing is refunded.', 'Owners and admins of the workspace are emailed that it was not approved; no staff note is sent.', 'The customer may ask again; a new review opens.']
        }
        confirmLabel={target?.decision === 'approve' ? 'Approve' : 'Reject'}
        destructive={target?.decision === 'reject'}
        onConfirm={run}
      />
    </>
  );
}
