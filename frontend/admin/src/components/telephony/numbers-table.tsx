'use client';

import { useAdminPauseNumber, useAdminResumeNumber, useAdminSetCallerId, useApi } from '@portal/api-client';
import type { AdminNumberResponse, StaffActionRequest } from '@portal/schemas';
import { Badge, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { CellActions, DataTable, type DataColumn } from '@/src/components/common/data-table';
import { PermissionButton } from '@/src/components/common/permission-button';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { NumberStatusBadge } from '@/src/components/common/status-badges';
import { callerIdAction, callerIdLabel, callerIdVariant } from '@/src/lib/compliance';
import { formatDate, formatNumber, formatPhone, humanize, relativeTime } from '@/src/lib/format';
import { customerPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

export function NumbersTable({ rows, showCustomer = true, onOpen }: { rows: AdminNumberResponse[]; showCustomer?: boolean; onOpen?: (id: string) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const pause = useAdminPauseNumber(api);
  const resume = useAdminResumeNumber(api);
  const setCallerId = useAdminSetCallerId(api);
  const [target, setTarget] = React.useState<{ number: AdminNumberResponse; action: 'pause' | 'resume' } | null>(null);
  const [callerTarget, setCallerTarget] = React.useState<{ number: AdminNumberResponse; action: 'verify' | 'revoke' } | null>(null);
  const denied = can.pauseAgentOrNumber();
  const complianceDenied = can.compliance();

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['adminListNumbers'] }),
      queryClient.invalidateQueries({ queryKey: ['adminCustomerNumbers'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetNumber'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetCustomer'] }),
      queryClient.invalidateQueries({ queryKey: ['adminCustomerAudit'] }),
    ]);
  }

  async function run(body: StaffActionRequest) {
    if (!target) return;
    const vars = { params: { id: target.number.id }, body };
    if (target.action === 'pause') await pause.mutateAsync(vars);
    else await resume.mutateAsync(vars);
    await invalidate();
    toast.success(`${formatPhone(target.number.e164)} ${target.action === 'pause' ? 'paused' : 'resumed'}`);
  }

  async function runCallerId(body: StaffActionRequest) {
    if (!callerTarget) return;
    const verified = callerTarget.action === 'verify';
    await setCallerId.mutateAsync({ params: { id: callerTarget.number.id }, body: { ...body, verified } });
    await invalidate();
    toast.success(`${formatPhone(callerTarget.number.e164)} ${verified ? 'verified as a caller ID' : 'caller ID revoked'}`);
  }

  const columns: Array<DataColumn<AdminNumberResponse>> = [
    { key: 'e164', header: 'Number', cell: (r) => <span className="whitespace-nowrap font-medium tabular-nums">{formatPhone(r.e164) || <span className="text-muted-foreground">(pending)</span>}</span> },
    ...(showCustomer
      ? [
          {
            key: 'customer',
            header: 'Customer',
            cell: (r: AdminNumberResponse) => (
              <Link href={customerPath(r.tenant_id, 'numbers')} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
                {r.tenant_name}
              </Link>
            ),
          },
        ]
      : []),
    { key: 'agent', header: 'Agent', cell: (r) => r.agent_name ?? <span className="text-muted-foreground">unbound</span> },
    { key: 'type', header: 'Type', cell: (r) => <span className="whitespace-nowrap">{humanize(r.type)}{r.forwarding_status ? ` · ${humanize(r.forwarding_status)}` : ''}</span> },
    { key: 'status', header: 'Status', cell: (r) => <NumberStatusBadge status={r.status} /> },
    { key: 'caller_id', header: 'Caller ID', cell: (r) => <Badge variant={callerIdVariant(r)} className="whitespace-nowrap">{callerIdLabel(r)}</Badge> },
    { key: 'rental', header: 'Rental', align: 'right', cell: (r) => (r.rental_credits ? `${formatNumber(r.rental_credits, 0)} cr/mo` : <span className="text-muted-foreground">0</span>) },
    { key: 'next', header: 'Next rental', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{formatDate(r.next_rental_at)}</span> },
    { key: 'overdue', header: 'Overdue', cell: (r) => (r.rental_overdue_since ? <Badge variant="danger">since {relativeTime(r.rental_overdue_since)}</Badge> : <span className="text-muted-foreground">–</span>) },
    { key: 'calls', header: 'Calls 7d', align: 'right', cell: (r) => formatNumber(r.calls_7d, 0) },
    { key: 'error', header: 'Error', cell: (r) => (r.error ? <span className="max-w-48 truncate text-xs text-danger" title={r.error}>{r.error}</span> : <span className="text-muted-foreground">–</span>) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => {
        const callerAction = callerIdAction(r);
        return (
          <CellActions>
            {callerAction ? (
              <PermissionButton size="sm" variant={callerAction === 'revoke' ? 'danger-outline' : 'outline'} denied={complianceDenied} onClick={() => setCallerTarget({ number: r, action: callerAction })}>
                {callerAction === 'verify' ? 'Verify caller ID' : 'Revoke caller ID'}
              </PermissionButton>
            ) : null}
            {r.status === 'paused' ? (
              <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget({ number: r, action: 'resume' })}>
                Resume
              </PermissionButton>
            ) : r.status === 'active' ? (
              <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget({ number: r, action: 'pause' })}>
                Pause
              </PermissionButton>
            ) : null}
          </CellActions>
        );
      },
    },
  ];

  return (
    <>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Numbers" onRowClick={onOpen ? (r) => onOpen(r.id) : undefined} />
      <StaffActionDialog
        open={Boolean(target)}
        onOpenChange={(o) => (o ? undefined : setTarget(null))}
        title={`${target?.action === 'pause' ? 'Pause' : 'Resume'} ${formatPhone(target?.number.e164)}`}
        description={target ? `${target.number.tenant_name} · ${target.number.agent_name ?? 'unbound'}` : undefined}
        consequences={target?.action === 'pause' ? ['Inbound calls to this number are declined (busy tone, no charge).', 'Rental keeps accruing; the number is not released.'] : ['Inbound calls are answered again by the bound agent.']}
        confirmLabel={target?.action === 'pause' ? 'Pause number' : 'Resume number'}
        destructive={target?.action === 'pause'}
        onConfirm={run}
      />
      <StaffActionDialog
        open={Boolean(callerTarget)}
        onOpenChange={(o) => (o ? undefined : setCallerTarget(null))}
        title={`${callerTarget?.action === 'verify' ? 'Verify' : 'Revoke'} ${formatPhone(callerTarget?.number.e164)} as a caller ID`}
        description={callerTarget ? `${callerTarget.number.tenant_name} · ${humanize(callerTarget.number.type)} · ${callerIdLabel(callerTarget.number)}` : undefined}
        consequences={
          callerTarget?.action === 'verify'
            ? ['The customer may show this number as the caller ID on outbound calls.', 'Verify only after seeing proof the customer holds the number, such as a letter of authorisation or a carrier bill.']
            : ['Outbound calls stop showing this number at once: an attempt that asks for it is refused, others use another verified number if the workspace has one.', 'Inbound calls to the number are not affected.', 'Only staff can verify it again.']
        }
        confirmLabel={callerTarget?.action === 'verify' ? 'Verify caller ID' : 'Revoke caller ID'}
        destructive={callerTarget?.action === 'revoke'}
        onConfirm={runCallerId}
      />
    </>
  );
}
