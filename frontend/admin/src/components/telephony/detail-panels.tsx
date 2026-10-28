'use client';

import { useAdminGetAgent, useAdminGetNumber, useAdminReleaseNumber, useAdminReprovisionNumber, useAdminResyncNumber, useApi } from '@portal/api-client';
import type { AdminNumberResponse, StaffActionRequest } from '@portal/schemas';
import { Badge, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { PermissionButton } from '@/src/components/common/permission-button';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { Copyable } from '@/src/components/common/copyable';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { AgentStatusBadge, NumberStatusBadge, TierBadge } from '@/src/components/common/status-badges';
import { callerIdLabel, callerIdVariant } from '@/src/lib/compliance';
import { formatDateTime, formatNumber, formatPhone, humanize } from '@/src/lib/format';
import { customerPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

export function AgentSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const api = useApi();
  const agent = useAdminGetAgent(api, { id: id ?? '' }, { enabled: Boolean(id) });
  const a = agent.data;
  return (
    <DetailSheet open={Boolean(id)} onOpenChange={(o) => (o ? undefined : onClose())} title={a?.name ?? 'Agent'} description={a ? <Link href={customerPath(a.tenant_id, 'agents')} className="hover:text-primary">{a.tenant_name}</Link> : undefined}>
      {agent.isPending ? (
        <Skeleton className="h-40" />
      ) : agent.isError ? (
        <LoadError error={agent.error} onRetry={() => void agent.refetch()} compact />
      ) : !a ? null : (
        <FactGrid columns={2}>
          <Fact label="Id">
            <Copyable value={a.id} />
          </Fact>
          <Fact label="Status">
            <AgentStatusBadge status={a.status} />
          </Fact>
          <Fact label="Tier">
            <TierBadge tier={a.tier} />
          </Fact>
          <Fact label="Template">{a.template_id ?? '–'}</Fact>
          <Fact label="Industry">{a.industry ?? '–'}</Fact>
          <Fact label="Published version">{a.published_version ?? '–'}</Fact>
          <Fact label="Draft version">{a.draft_version ?? '–'}</Fact>
          <Fact label="Knowledge sources">{formatNumber(a.knowledge_sources, 0)}</Fact>
          <Fact label="Calls 7d">{formatNumber(a.calls_7d, 0)}</Fact>
          <Fact label="Numbers" wrap>
            {a.numbers.length ? a.numbers.map((n) => `${formatPhone(n.e164)} (${n.status})`).join(', ') : '–'}
          </Fact>
          <Fact label="Created">{formatDateTime(a.created_at)}</Fact>
          <Fact label="Deleted">{formatDateTime(a.deleted_at)}</Fact>
        </FactGrid>
      )}
    </DetailSheet>
  );
}

export function NumberSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const api = useApi();
  const number = useAdminGetNumber(api, { id: id ?? '' }, { enabled: Boolean(id) });
  const n = number.data;
  return (
    <DetailSheet open={Boolean(id)} onOpenChange={(o) => (o ? undefined : onClose())} title={n ? formatPhone(n.e164) : 'Number'} description={n ? <Link href={customerPath(n.tenant_id, 'numbers')} className="hover:text-primary">{n.tenant_name}</Link> : undefined}>
      {number.isPending ? (
        <Skeleton className="h-40" />
      ) : number.isError ? (
        <LoadError error={number.error} onRetry={() => void number.refetch()} compact />
      ) : !n ? null : (
        <>
        <NumberPlatformActions n={n} />
        <FactGrid columns={2}>
          <Fact label="Id">
            <Copyable value={n.id} />
          </Fact>
          <Fact label="Status">
            <NumberStatusBadge status={n.status} />
          </Fact>
          <Fact label="Type">{humanize(n.type)}</Fact>
          <Fact label="Forwarding">{n.forwarding_status ? humanize(n.forwarding_status) : '–'}</Fact>
          <Fact label="Agent">{n.agent_name ?? '–'}</Fact>
          <Fact label="Caller ID">
            <Badge variant={callerIdVariant(n)}>{callerIdLabel(n)}</Badge>
          </Fact>
          <Fact label="Rental">{n.rental_credits} credits / month</Fact>
          <Fact label="Next rental">{formatDateTime(n.next_rental_at)}</Fact>
          <Fact label="Overdue since">{formatDateTime(n.rental_overdue_since)}</Fact>
          <Fact label="Paused at">{formatDateTime(n.paused_at)}</Fact>
          <Fact label="Calls 7d">{formatNumber(n.calls_7d, 0)}</Fact>
          <Fact label="Created">{formatDateTime(n.created_at)}</Fact>
          <Fact label="Error" wrap>
            {n.error ?? '–'}
          </Fact>
        </FactGrid>
        </>
      )}
    </DetailSheet>
  );
}

type PlatformAction = 'resync' | 'reprovision' | 'release';

/**
 * Admin §9 number actions on the voice platform. Each is offered only where it applies:
 * re-sync for a number that answers (active or paused), re-provision for a failed one,
 * release for anything not already released.
 */
function NumberPlatformActions({ n }: { n: AdminNumberResponse }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const resync = useAdminResyncNumber(api);
  const reprovision = useAdminReprovisionNumber(api);
  const release = useAdminReleaseNumber(api);
  const [action, setAction] = React.useState<PlatformAction | null>(null);
  const denied = can.supportActions();
  const phone = formatPhone(n.e164);

  async function run(body: StaffActionRequest) {
    const vars = { params: { id: n.id }, body };
    if (action === 'resync') {
      const res = await resync.mutateAsync(vars);
      toast.success(res.updated ? `${phone} re-pointed at its agent` : `${phone} was already correct`, { description: res.updated ? 'The platform binding had drifted; it now matches.' : 'Nothing needed changing.' });
    } else if (action === 'reprovision') {
      await reprovision.mutateAsync(vars);
      toast.success('Provisioning started', { description: 'Follow it in the provisioning queue; a number already bought is reused.' });
    } else if (action === 'release') {
      await release.mutateAsync(vars);
      toast.success(`${phone} released`);
    }
    await Promise.all(['adminGetNumber', 'adminListNumbers', 'adminCustomerNumbers'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  }

  const answering = n.status === 'active' || n.status === 'paused';
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {answering ? (
        <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setAction('resync')}>
          Re-sync
        </PermissionButton>
      ) : null}
      {n.status === 'failed' ? (
        <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setAction('reprovision')}>
          Re-provision
        </PermissionButton>
      ) : null}
      {n.status !== 'released' ? (
        <PermissionButton size="sm" variant="danger-outline" denied={denied} onClick={() => setAction('release')}>
          Release
        </PermissionButton>
      ) : null}
      <StaffActionDialog
        open={action === 'resync'}
        onOpenChange={(o) => (o ? undefined : setAction(null))}
        title={`Re-sync ${phone}`}
        consequences={['Reads the number on the voice platform and re-points it at this agent and our call handling only if it drifted.', 'A number that is already correct is left as it is.']}
        confirmLabel="Re-sync"
        onConfirm={run}
      />
      <StaffActionDialog
        open={action === 'reprovision'}
        onOpenChange={(o) => (o ? undefined : setAction(null))}
        title="Re-provision this number"
        description={n.error ? `It failed with: ${n.error}` : undefined}
        consequences={['Starts setting the number up again, then binds it to its agent.', 'A number the failed attempt already bought is reused, never bought twice.']}
        confirmLabel="Re-provision"
        onConfirm={run}
      />
      <StaffActionDialog
        open={action === 'release'}
        onOpenChange={(o) => (o ? undefined : setAction(null))}
        title={`Release ${phone}`}
        consequences={['The number stops answering and goes back to the carrier; it cannot be recovered.', 'Its rental stops. Call history is kept.', 'The customer sees it as released on their Numbers page.']}
        confirmLabel="Release number"
        destructive
        typeToConfirm={n.e164 ?? n.id}
        typeLabel="Type the number to confirm"
        onConfirm={run}
      />
    </div>
  );
}
