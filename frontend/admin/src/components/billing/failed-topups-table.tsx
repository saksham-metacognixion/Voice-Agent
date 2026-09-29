'use client';

import { useAdminDisableAutoTopup, useAdminRetryTopup, useApi } from '@portal/api-client';
import type { AdminFailedTopup, StaffActionRequest } from '@portal/schemas';
import { Badge, Button, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { CellActions, DataTable, type DataColumn } from '@/src/components/common/data-table';
import { PermissionButton } from '@/src/components/common/permission-button';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { PurchaseStatusBadge, YesNo } from '@/src/components/common/status-badges';
import { formatCents, formatCredits, formatDateTime, relativeTime } from '@/src/lib/format';
import { customerPath, routes } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

type TopupAction = 'retry' | 'disable';

/** SA9 failed auto top-ups (§5.4): retry now past the cooldown, or switch the setting off. Credits still only follow Stripe's confirmation. */
export function FailedTopupsTable({ rows }: { rows: AdminFailedTopup[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const denied = can.topupActions();
  const retry = useAdminRetryTopup(api);
  const disable = useAdminDisableAutoTopup(api);
  const [target, setTarget] = React.useState<{ row: AdminFailedTopup; action: TopupAction } | null>(null);

  async function run(body: StaffActionRequest) {
    if (!target) return;
    if (target.action === 'retry') {
      const res = await retry.mutateAsync({ params: { id: target.row.id }, body });
      if (res.outcome === 'charged') toast.success('Card charged — credits follow the payment confirmation', { description: `Purchase ${res.purchase_id?.slice(0, 8) ?? ''} is pending with Stripe.` });
      else if (res.outcome === 'declined') toast.error('Card declined again', { description: res.reason ?? undefined });
      else toast.warning('Nothing charged', { description: skipReason(res.reason) });
    } else {
      await disable.mutateAsync({ params: { id: target.row.tenant_id }, body });
      toast.success(`Auto top-up switched off for ${target.row.tenant_name}`);
    }
    await Promise.all(['adminListFailedTopups', 'adminListPurchases', 'adminGetCustomer', 'adminBillingSummary'].map((queryKey) => queryClient.invalidateQueries({ queryKey: [queryKey] })));
  }

  const columns: Array<DataColumn<AdminFailedTopup>> = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (r) => (
        <Link href={customerPath(r.tenant_id, 'wallet')} className="hover:text-primary">
          {r.tenant_name}
        </Link>
      ),
    },
    { key: 'when', header: 'When', cell: (r) => <span className="whitespace-nowrap" title={formatDateTime(r.created_at)}>{relativeTime(r.created_at)}</span> },
    { key: 'pack', header: 'Pack', cell: (r) => r.pack_id ?? '–' },
    { key: 'amount', header: 'Amount', align: 'right', cell: (r) => formatCents(r.amount_cents, r.currency) },
    { key: 'credits', header: 'Credits', align: 'right', cell: (r) => formatCredits(r.credits) },
    { key: 'status', header: 'Status', cell: (r) => <PurchaseStatusBadge status={r.status} /> },
    { key: 'reason', header: 'Decline', cell: (r) => (r.failure_reason ? <span className="text-xs text-danger">{r.failure_reason}</span> : <span className="text-xs text-muted-foreground">never confirmed</span>) },
    { key: 'card', header: 'Card', cell: (r) => (r.card_last4 ? <span className="font-mono text-xs">•••• {r.card_last4}</span> : <span className="text-muted-foreground">–</span>) },
    { key: 'enabled', header: 'Auto top-up', cell: (r) => <YesNo value={r.auto_topup_enabled} yes="On" no="Off" /> },
    {
      key: 'cooldown',
      header: 'Cooldown',
      cell: (r) => {
        if (!r.cooldown_until) return <span className="text-muted-foreground">–</span>;
        const over = new Date(r.cooldown_until).getTime() <= Date.now();
        return over ? <Badge variant="outline">over</Badge> : <span className="whitespace-nowrap text-xs">until {formatDateTime(r.cooldown_until)}</span>;
      },
    },
    { key: 'alert', header: 'Customer told', cell: (r) => (r.alert_open ? <Badge variant="warning">alert open</Badge> : <span className="text-muted-foreground">–</span>) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <CellActions>
          <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget({ row: r, action: 'retry' })}>
            Retry now
          </PermissionButton>
          {r.auto_topup_enabled ? (
            <PermissionButton size="sm" variant="danger-outline" denied={denied} onClick={() => setTarget({ row: r, action: 'disable' })}>
              Disable auto top-up
            </PermissionButton>
          ) : null}
          <Button size="sm" variant="ghost" asChild>
            <Link href={`${routes.support}?new=${encodeURIComponent(r.tenant_id)}`}>Open ticket</Link>
          </Button>
        </CellActions>
      ),
    },
  ];

  return (
    <>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Failed auto top-ups" dense />
      <StaffActionDialog
        open={Boolean(target)}
        onOpenChange={(o) => (o ? undefined : setTarget(null))}
        title={target?.action === 'retry' ? 'Retry auto top-up now' : 'Disable auto top-up'}
        description={target ? `${target.row.tenant_name} · ${target.row.pack_id ?? 'pack'} · ${formatCents(target.row.amount_cents, target.row.currency)}` : undefined}
        consequences={
          target?.action === 'retry'
            ? [
                'The saved card is charged off-session for the configured pack, skipping the 6-hour cooldown after a decline.',
                'Nothing is charged while a top-up is already in flight, auto top-up is off, no card is saved, or the balance is above the threshold.',
                'Credits are added only when Stripe confirms the payment — never from this click.',
              ]
            : ['The workspace stops topping up automatically; the saved card stays on file.', 'Low-balance alerts keep going out; the customer can switch it back on in their wallet.']
        }
        confirmLabel={target?.action === 'retry' ? 'Charge now' : 'Disable'}
        destructive={target?.action === 'disable'}
        defaultReason={target?.action === 'retry' ? 'service_issue' : 'customer_request'}
        onConfirm={run}
      />
    </>
  );
}

function skipReason(reason: string | null): string {
  switch (reason) {
    case 'disabled':
      return 'Auto top-up is switched off for this workspace.';
    case 'no_card':
      return 'No saved card — the customer buys a pack with "keep my card" to add one.';
    case 'no_pack':
      return 'The configured pack is no longer sold.';
    case 'above_threshold':
      return 'The balance is above the top-up threshold.';
    case 'paused':
      return 'The workspace is paused.';
    case 'cooldown':
      return 'A decline is still cooling down.';
    default:
      return reason ?? 'Nothing to do.';
  }
}
