'use client';

import { useAdminGetAgent, useAdminGetNumber, useApi } from '@portal/api-client';
import { Skeleton } from '@portal/ui';
import Link from 'next/link';
import { Copyable } from '@/src/components/common/copyable';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { AgentStatusBadge, NumberStatusBadge, TierBadge } from '@/src/components/common/status-badges';
import { formatDateTime, formatNumber, formatPhone, humanize } from '@/src/lib/format';
import { customerPath } from '@/src/routes';

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
      )}
    </DetailSheet>
  );
}
