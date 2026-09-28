'use client';

import { useAdminGetCall, useApi } from '@portal/api-client';
import { Badge, Skeleton } from '@portal/ui';
import Link from 'next/link';
import { Copyable } from '@/src/components/common/copyable';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { CallStatusBadge, SentimentBadge, TierBadge } from '@/src/components/common/status-badges';
import { formatCents, formatCredits, formatDateTime, formatDuration, formatPhone, humanize } from '@/src/lib/format';
import { customerPath } from '@/src/routes';

/** SA8 call detail. The list never carries the transcript, and neither does this: staff read the customer's row plus cost. */
export function CallSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const api = useApi();
  const call = useAdminGetCall(api, { id: id ?? '' }, { enabled: Boolean(id) });
  const c = call.data;
  return (
    <DetailSheet open={Boolean(id)} onOpenChange={(o) => (o ? undefined : onClose())} title="Call" description={c ? <Link href={customerPath(c.tenant_id, 'calls')} className="hover:text-primary">{c.tenant_name}</Link> : undefined}>
      {call.isPending ? (
        <Skeleton className="h-64" />
      ) : call.isError ? (
        <LoadError error={call.error} onRetry={() => void call.refetch()} compact />
      ) : !c ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <CallStatusBadge status={c.status} />
            <TierBadge tier={c.tier} />
            <Badge variant="outline">{c.channel}</Badge>
            <Badge variant="outline">{c.direction}</Badge>
            {c.is_test ? <Badge variant="outline">test</Badge> : null}
            {c.decline_reason ? <Badge variant="danger">declined: {c.decline_reason}</Badge> : null}
          </div>
          <FactGrid columns={2}>
            <Fact label="Call id" className="col-span-2" wrap>
              <Copyable value={c.id} full />
            </Fact>
            <Fact label="Agent">{c.agent_name ?? '–'}{c.agent_version ? ` · v${c.agent_version}` : ''}</Fact>
            <Fact label="From">{formatPhone(c.from_number)}</Fact>
            <Fact label="To">{formatPhone(c.to_number)}</Fact>
            <Fact label="Started">{formatDateTime(c.started_at, { seconds: true })}</Fact>
            <Fact label="Ended">{formatDateTime(c.ended_at, { seconds: true })}</Fact>
            <Fact label="Duration">{formatDuration(c.duration_s)}</Fact>
            <Fact label="Disconnection">{c.disconnection_reason ? humanize(c.disconnection_reason) : '–'}</Fact>
            <Fact label="Rate">{formatCredits(c.rate)} cr/min{c.config_version ? ` (config v${c.config_version})` : ''}</Fact>
            <Fact label="Credits charged">{formatCredits(c.credits_charged)}</Fact>
            <Fact label="Platform cost">{c.retell_cost_cents === null ? '–' : formatCents(c.retell_cost_cents)}</Fact>
            <Fact label="Sentiment">
              <SentimentBadge value={c.sentiment} />
            </Fact>
            <Fact label="Outcome" wrap>
              {c.outcome ?? '–'}
            </Fact>
            <Fact label="Handled">{formatDateTime(c.handled_at)}</Fact>
            <Fact label="Recording">{c.has_recording ? 'Yes (customer portal only)' : 'No'}</Fact>
            <Fact label="Customer note" wrap>
              {c.note ?? '–'}
            </Fact>
          </FactGrid>
        </>
      )}
    </DetailSheet>
  );
}
