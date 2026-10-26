'use client';

import { useAdminDiscardJob, useAdminGetJob, useAdminRetryJob, useApi } from '@portal/api-client';
import type { AdminJobResponse, StaffActionRequest } from '@portal/schemas';
import { Badge, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { Copyable } from '@/src/components/common/copyable';
import { CellActions, DataTable, type DataColumn } from '@/src/components/common/data-table';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { JsonView } from '@/src/components/common/json-view';
import { PermissionButton } from '@/src/components/common/permission-button';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { JobStatusBadge } from '@/src/components/common/status-badges';
import { formatDateTime, relativeTime, shortId } from '@/src/lib/format';
import { customerPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

type JobAction = 'retry' | 'discard';

/** Retry / Discard through the reason dialog; shared by the row actions and the sheet. */
function useJobActions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const retry = useAdminRetryJob(api);
  const discard = useAdminDiscardJob(api);
  const [target, setTarget] = React.useState<{ job: AdminJobResponse; action: JobAction } | null>(null);

  async function run(body: StaffActionRequest) {
    if (!target) return;
    const vars = { params: { id: target.job.id }, body };
    if (target.action === 'retry') await retry.mutateAsync(vars);
    else await discard.mutateAsync(vars);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['adminListJobs'] }),
      queryClient.invalidateQueries({ queryKey: ['adminCustomerJobs'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetJob'] }),
      queryClient.invalidateQueries({ queryKey: ['adminSystemHealth'] }),
    ]);
    toast.success(target.action === 'retry' ? 'Job re-enqueued' : 'Job discarded');
  }

  const dialog = (
    <StaffActionDialog
      open={Boolean(target)}
      onOpenChange={(o) => (o ? undefined : setTarget(null))}
      title={target?.action === 'retry' ? 'Retry job' : 'Discard job'}
      description={target ? `${target.job.type} · ${shortId(target.job.id)}${target.job.tenant_name ? ` · ${target.job.tenant_name}` : ''}` : undefined}
      consequences={target?.action === 'retry' ? ['The job is re-enqueued with the payload it was created with.', 'A step machine (activation) resumes at its first incomplete step.'] : ['The row is written off as failed and dropped from the queue.', 'The customer sees the failure reason already recorded; nothing is retried.', 'This cannot be undone — a new job must be started by the customer.']}
      confirmLabel={target?.action === 'retry' ? 'Retry' : 'Discard'}
      destructive={target?.action === 'discard'}
      typeToConfirm={target?.action === 'discard' ? 'DISCARD' : undefined}
      onConfirm={run}
    />
  );
  return { setTarget, dialog };
}

export function JobsTable({ rows, showCustomer = true, onOpen }: { rows: AdminJobResponse[]; showCustomer?: boolean; onOpen: (id: string) => void }) {
  const { can } = useStaff();
  const denied = can.operateQueues();
  const { setTarget, dialog } = useJobActions();

  const columns: Array<DataColumn<AdminJobResponse>> = [
    { key: 'id', header: 'Job', cell: (r) => <Copyable value={r.id} /> },
    { key: 'type', header: 'Type', cell: (r) => <code className="text-xs">{r.type}</code> },
    { key: 'status', header: 'Status', cell: (r) => <JobStatusBadge status={r.status} /> },
    ...(showCustomer
      ? [
          {
            key: 'customer',
            header: 'Customer',
            cell: (r: AdminJobResponse) =>
              r.tenant_id ? (
                <Link href={customerPath(r.tenant_id, 'jobs')} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
                  {r.tenant_name ?? shortId(r.tenant_id)}
                </Link>
              ) : (
                <span className="text-muted-foreground">–</span>
              ),
          },
        ]
      : []),
    { key: 'created', header: 'Created', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at)}</span> },
    { key: 'updated', header: 'Updated', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{relativeTime(r.updated_at)}</span> },
    { key: 'attempts', header: 'Attempts', align: 'right', cell: (r) => r.attempts },
    { key: 'queue', header: 'Queue', cell: (r) => (r.queue_state ? <Badge variant="outline">{r.queue_state}</Badge> : <span className="text-muted-foreground">–</span>) },
    { key: 'error', header: 'Error', cell: (r) => (r.error ? <span className="block max-w-56 truncate text-xs text-danger" title={r.error}>{r.error}</span> : <span className="text-muted-foreground">–</span>) },
    { key: 'reason', header: 'Customer reason', cell: (r) => (r.customer_reason ? <span className="block max-w-56 truncate text-xs" title={r.customer_reason}>{r.customer_reason}</span> : <span className="text-muted-foreground">–</span>) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <CellActions>
          {r.can_retry ? (
            <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget({ job: r, action: 'retry' })}>
              Retry
            </PermissionButton>
          ) : null}
          {r.can_discard ? (
            <PermissionButton size="sm" variant="danger-outline" denied={denied} onClick={() => setTarget({ job: r, action: 'discard' })}>
              Discard
            </PermissionButton>
          ) : null}
        </CellActions>
      ),
    },
  ];
  return (
    <>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Jobs" onRowClick={(r) => onOpen(r.id)} dense />
      {dialog}
    </>
  );
}

export function JobSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const api = useApi();
  const { can } = useStaff();
  const denied = can.operateQueues();
  const job = useAdminGetJob(api, { id: id ?? '' }, { enabled: Boolean(id) });
  const { setTarget, dialog } = useJobActions();
  const j = job.data;
  return (
    <DetailSheet open={Boolean(id)} onOpenChange={(o) => (o ? undefined : onClose())} title={j ? j.type : 'Job'} description={j ? <Copyable value={j.id} full /> : undefined}>
      {job.isPending ? (
        <Skeleton className="h-64" />
      ) : job.isError ? (
        <LoadError error={job.error} onRetry={() => void job.refetch()} compact />
      ) : !j ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <JobStatusBadge status={j.status} />
            {j.queue_state ? <Badge variant="outline">queue: {j.queue_state}</Badge> : null}
            <span className="ml-auto flex gap-2">
              {j.can_retry ? (
                <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget({ job: j, action: 'retry' })}>
                  Retry
                </PermissionButton>
              ) : null}
              {j.can_discard ? (
                <PermissionButton size="sm" variant="danger-outline" denied={denied} onClick={() => setTarget({ job: j, action: 'discard' })}>
                  Discard
                </PermissionButton>
              ) : null}
            </span>
          </div>
          <FactGrid columns={2}>
            <Fact label="Customer" wrap>
              {j.tenant_id ? (
                <Link href={customerPath(j.tenant_id, 'jobs')} className="hover:text-primary">
                  {j.tenant_name ?? j.tenant_id}
                </Link>
              ) : (
                '–'
              )}
            </Fact>
            <Fact label="Agent">{j.agent_id ? <Copyable value={j.agent_id} /> : '–'}</Fact>
            <Fact label="Created">{formatDateTime(j.created_at, { seconds: true })}</Fact>
            <Fact label="Started">{formatDateTime(j.started_at, { seconds: true })}</Fact>
            <Fact label="Finished">{formatDateTime(j.finished_at, { seconds: true })}</Fact>
            <Fact label="Attempts">{j.attempts}</Fact>
            <Fact label="Error" wrap>
              <span className="text-danger">{j.error ?? '–'}</span>
            </Fact>
            <Fact label="Customer reason" wrap>
              {j.customer_reason ?? '–'}
            </Fact>
          </FactGrid>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Steps</p>
            <JsonView value={j.steps} />
          </div>
        </>
      )}
      {dialog}
    </DetailSheet>
  );
}
