'use client';

import { useAdminGetWebhookEvent, useAdminReplayWebhookEvent, useApi } from '@portal/api-client';
import type { AdminWebhookEventResponse, StaffActionRequest } from '@portal/schemas';
import { Alert, Badge, Skeleton, toast } from '@portal/ui';
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
import { WebhookStatusBadge } from '@/src/components/common/status-badges';
import { formatDateTime, shortId } from '@/src/lib/format';
import { customerPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

function providerLabel(p: string): string {
  return p === 'retell' ? 'Voice platform' : p === 'stripe' ? 'Stripe' : p === 'auth' ? 'Auth' : p;
}

function useReplay() {
  const api = useApi();
  const queryClient = useQueryClient();
  const replay = useAdminReplayWebhookEvent(api);
  const [target, setTarget] = React.useState<AdminWebhookEventResponse | null>(null);

  async function run(body: StaffActionRequest) {
    if (!target) return;
    const res = await replay.mutateAsync({ params: { id: target.id }, body });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['adminListWebhookEvents'] }),
      queryClient.invalidateQueries({ queryKey: ['adminCustomerWebhookEvents'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetWebhookEvent'] }),
      queryClient.invalidateQueries({ queryKey: ['adminSystemHealth'] }),
    ]);
    toast.success(`Replay: ${res.outcome}`, { description: res.reason ?? undefined });
  }

  const dialog = (
    <StaffActionDialog
      open={Boolean(target)}
      onOpenChange={(o) => (o ? undefined : setTarget(null))}
      title="Replay webhook event"
      description={target ? `${providerLabel(target.provider)} · ${target.event_type} · ${shortId(target.external_id, 16)}` : undefined}
      consequences={['The stored body is run through its handler again.', 'Handlers are idempotent: a call already billed is not billed twice, a credited purchase is not credited again.', 'The outcome is reported in the toast and the event row.']}
      confirmLabel="Replay"
      onConfirm={run}
    />
  );
  return { setTarget, dialog };
}

// The table must fit beside the sidebar at 1366 px with Replay in view, so provider and
// queue ride under the type and status instead of taking columns, and the error column
// shows only when the table itself (`@container`, not the window) has room; the sheet
// shows all of it.
const ERROR_COLUMN = 'hidden @min-[75rem]:table-cell';

export function WebhooksTable({ rows, showCustomer = true, onOpen }: { rows: AdminWebhookEventResponse[]; showCustomer?: boolean; onOpen: (id: string) => void }) {
  const { can } = useStaff();
  const denied = can.operateQueues();
  const { setTarget, dialog } = useReplay();

  const columns: Array<DataColumn<AdminWebhookEventResponse>> = [
    { key: 'received', header: 'Received', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.received_at)}</span> },
    {
      key: 'type',
      header: 'Type',
      cell: (r) => (
        <>
          <code className="block text-xs">{r.event_type}</code>
          <span className="text-xs text-muted-foreground">{providerLabel(r.provider)}</span>
        </>
      ),
    },
    { key: 'external', header: 'External id', cell: (r) => <Copyable value={r.external_id} /> },
    ...(showCustomer
      ? [
          {
            key: 'customer',
            header: 'Customer',
            cell: (r: AdminWebhookEventResponse) =>
              r.tenant_id ? (
                <Link href={customerPath(r.tenant_id, 'webhooks')} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
                  {r.tenant_name ?? shortId(r.tenant_id)}
                </Link>
              ) : (
                <span className="text-muted-foreground">–</span>
              ),
          },
        ]
      : []),
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <div className="flex flex-col items-start gap-0.5">
          <WebhookStatusBadge status={r.status} />
          {r.queue_state ? (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              queue: {r.queue_state}
              {r.attempts !== null ? ` · ${r.attempts}` : ''}
            </span>
          ) : null}
        </div>
      ),
    },
    { key: 'error', header: 'Error', className: ERROR_COLUMN, cell: (r) => (r.error ? <span className="block max-w-56 truncate text-xs text-danger" title={r.error}>{r.error}</span> : <span className="text-muted-foreground">–</span>) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <CellActions>
          <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget(r)}>
            Replay
          </PermissionButton>
        </CellActions>
      ),
    },
  ];
  return (
    <>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Webhook events" onRowClick={(r) => onOpen(r.id)} className="@container" dense />
      {dialog}
    </>
  );
}

export function WebhookSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const api = useApi();
  const { can } = useStaff();
  const denied = can.operateQueues();
  const payloadDenied = can.viewWebhookPayload();
  // Every open is an audited payload view (QA-033), so it is read once per open, not on
  // every window focus; a replay still invalidates it. `gcTime: 0` drops the body when the
  // sheet closes, so opening the same event again is a new read and a new audit row (QA-055).
  const event = useAdminGetWebhookEvent(api, { id: id ?? '' }, { enabled: Boolean(id) && !payloadDenied, staleTime: Infinity, gcTime: 0 });
  const { setTarget, dialog } = useReplay();
  const e = event.data;
  return (
    <DetailSheet open={Boolean(id)} onOpenChange={(o) => (o ? undefined : onClose())} title={e ? `${providerLabel(e.provider)} · ${e.event_type}` : 'Webhook event'} description={e ? <Copyable value={e.external_id} full /> : undefined}>
      {payloadDenied ? (
        <Alert variant="warning">Opening a stored webhook body is not part of your role. {payloadDenied}</Alert>
      ) : event.isPending ? (
        <Skeleton className="h-64" />
      ) : event.isError ? (
        <LoadError error={event.error} onRetry={() => void event.refetch()} compact />
      ) : !e ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <WebhookStatusBadge status={e.status} />
            {e.queue_state ? <Badge variant="outline">queue: {e.queue_state}</Badge> : null}
            <span className="ml-auto">
              <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget(e)}>
                Replay
              </PermissionButton>
            </span>
          </div>
          <FactGrid columns={2}>
            <Fact label="Customer" wrap>
              {e.tenant_id ? (
                <Link href={customerPath(e.tenant_id, 'webhooks')} className="hover:text-primary">
                  {e.tenant_name ?? e.tenant_id}
                </Link>
              ) : (
                '–'
              )}
            </Fact>
            <Fact label="Received">{formatDateTime(e.received_at, { seconds: true })}</Fact>
            <Fact label="Processed">{formatDateTime(e.processed_at, { seconds: true })}</Fact>
            <Fact label="Attempts">{e.attempts ?? '–'}</Fact>
            <Fact label="Error" wrap>
              <span className="text-danger">{e.error ?? '–'}</span>
            </Fact>
          </FactGrid>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Payload</p>
            {e.payload_redacted ? (
              <Alert variant="info" className="mb-2">
                Recording links, transcripts and the call summary are hidden: your role cannot listen to recordings.
              </Alert>
            ) : null}
            <JsonView value={e.payload} />
          </div>
        </>
      )}
      {dialog}
    </DetailSheet>
  );
}
