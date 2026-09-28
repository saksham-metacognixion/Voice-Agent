'use client';

import { useAdminGetWebhookEvent, useAdminReplayWebhookEvent, useApi } from '@portal/api-client';
import type { AdminWebhookEventResponse, StaffActionRequest } from '@portal/schemas';
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
      defaultReason="service_issue"
      onConfirm={run}
    />
  );
  return { setTarget, dialog };
}

export function WebhooksTable({ rows, showCustomer = true, onOpen }: { rows: AdminWebhookEventResponse[]; showCustomer?: boolean; onOpen: (id: string) => void }) {
  const { can } = useStaff();
  const denied = can.operateQueues();
  const { setTarget, dialog } = useReplay();

  const columns: Array<DataColumn<AdminWebhookEventResponse>> = [
    { key: 'received', header: 'Received', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.received_at, { seconds: true })}</span> },
    { key: 'provider', header: 'Provider', cell: (r) => <Badge variant="outline">{providerLabel(r.provider)}</Badge> },
    { key: 'type', header: 'Type', cell: (r) => <code className="text-xs">{r.event_type}</code> },
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
    { key: 'status', header: 'Status', cell: (r) => <WebhookStatusBadge status={r.status} /> },
    { key: 'error', header: 'Error', cell: (r) => (r.error ? <span className="block max-w-56 truncate text-xs text-danger" title={r.error}>{r.error}</span> : <span className="text-muted-foreground">–</span>) },
    { key: 'queue', header: 'Queue', cell: (r) => (r.queue_state ? <Badge variant="outline">{r.queue_state}{r.attempts !== null ? ` · ${r.attempts}` : ''}</Badge> : <span className="text-muted-foreground">–</span>) },
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
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Webhook events" onRowClick={(r) => onOpen(r.id)} dense />
      {dialog}
    </>
  );
}

export function WebhookSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const api = useApi();
  const { can } = useStaff();
  const denied = can.operateQueues();
  const event = useAdminGetWebhookEvent(api, { id: id ?? '' }, { enabled: Boolean(id) });
  const { setTarget, dialog } = useReplay();
  const e = event.data;
  return (
    <DetailSheet open={Boolean(id)} onOpenChange={(o) => (o ? undefined : onClose())} title={e ? `${providerLabel(e.provider)} · ${e.event_type}` : 'Webhook event'} description={e ? <Copyable value={e.external_id} full /> : undefined}>
      {event.isPending ? (
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
            <JsonView value={e.payload} />
          </div>
        </>
      )}
      {dialog}
    </DetailSheet>
  );
}
