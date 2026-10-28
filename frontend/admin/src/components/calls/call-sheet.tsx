'use client';

import { useAdminFlagCall, useAdminGetCall, useAdminRefundCall, useApi } from '@portal/api-client';
import type { AdminCallResponse, StaffActionRequest } from '@portal/schemas';
import { Badge, Field, Input, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { Copyable } from '@/src/components/common/copyable';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { PermissionButton } from '@/src/components/common/permission-button';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { CallStatusBadge, SentimentBadge, TierBadge } from '@/src/components/common/status-badges';
import { formatCents, formatCredits, formatDateTime, formatDuration, formatPhone, humanize } from '@/src/lib/format';
import { customerPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

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
            {c.flagged_at ? <Badge variant="warning">flagged</Badge> : null}
          </div>
          <CallActions c={c} />
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
            <Fact label="Credits charged">
              {formatCredits(c.credits_charged)}
              {c.transfer_credits_charged ? ` + ${formatCredits(c.transfer_credits_charged)} transfer` : ''}
            </Fact>
            <Fact label="Refunded">{c.refunded_credits === null ? '–' : `${formatCredits(c.refunded_credits)} credits`}</Fact>
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
            {c.flagged_at ? (
              <Fact label={`Flagged ${formatDateTime(c.flagged_at)}`} className="col-span-2" wrap>
                {c.flag_note ?? '–'}
              </Fact>
            ) : null}
          </FactGrid>
        </>
      )}
    </DetailSheet>
  );
}

/**
 * Admin §9 call actions. Refund gives back both legs once per call — the support desk's
 * `refund_call` macro and this button are one path, so a second refund is refused
 * whichever screen asks. A flag marks the call for a second look and says why.
 */
function CallActions({ c }: { c: AdminCallResponse }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const refund = useAdminRefundCall(api);
  const flag = useAdminFlagCall(api);
  const [open, setOpen] = React.useState<'refund' | 'flag' | 'unflag' | null>(null);
  const [customerText, setCustomerText] = React.useState('');
  const charged = (c.credits_charged ?? 0) + (c.transfer_credits_charged ?? 0);
  const refundDenied = can.adjustCredits() ?? (c.refunded_credits !== null ? 'This call was already refunded.' : charged <= 0 ? 'This call was not charged.' : null);

  async function invalidate() {
    await Promise.all(['adminGetCall', 'adminListCalls', 'adminCustomerCalls', 'adminGetCustomer', 'adminGetCustomerWallet'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  }
  async function doRefund(body: StaffActionRequest) {
    const res = await refund.mutateAsync({ params: { id: c.id }, body: { ...body, customer_text: customerText.trim() || undefined } });
    await invalidate();
    toast.success(`Refunded ${formatCredits(res.delta)} credits`, { description: `${c.tenant_name}'s balance is now ${formatCredits(res.balance_after)}.` });
  }
  async function doFlag(body: StaffActionRequest) {
    const flagged = open === 'flag';
    await flag.mutateAsync({ params: { id: c.id }, body: { ...body, flagged } });
    await invalidate();
    toast.success(flagged ? 'Call flagged' : 'Flag cleared');
  }

  return (
    <div className="flex flex-wrap gap-2">
      <PermissionButton size="sm" variant="outline" denied={refundDenied} onClick={() => setOpen('refund')}>
        Refund call
      </PermissionButton>
      <PermissionButton size="sm" variant="outline" denied={can.supportActions()} onClick={() => setOpen(c.flagged_at ? 'unflag' : 'flag')}>
        {c.flagged_at ? 'Clear flag' : 'Flag'}
      </PermissionButton>
      <StaffActionDialog
        open={open === 'refund'}
        onOpenChange={(o) => {
          if (!o) {
            setOpen(null);
            setCustomerText('');
          }
        }}
        title={`Refund ${formatCredits(charged)} credits`}
        description={`To ${c.tenant_name}, for the call on ${formatDateTime(c.started_at ?? c.created_at)}.`}
        consequences={['The credits go back to the wallet as a new lot with the standard expiry.', 'A call is refunded once, whether from here or from a support ticket.']}
        confirmLabel="Refund"
        onConfirm={doRefund}
      >
        <Field id="refund-customer-text" label="Customer-facing text" optional description="Shown beside the refund in their wallet. Default: “Refund for the call on …”.">
          <Input id="refund-customer-text" value={customerText} onChange={(e) => setCustomerText(e.target.value)} maxLength={200} />
        </Field>
      </StaffActionDialog>
      <StaffActionDialog
        open={open === 'flag' || open === 'unflag'}
        onOpenChange={(o) => (o ? undefined : setOpen(null))}
        title={open === 'flag' ? 'Flag this call' : 'Clear the flag'}
        description={open === 'flag' ? 'Flagged calls are listed under Calls → Flagged for a second look. The customer does not see the flag.' : c.flag_note ? `Flagged for: ${c.flag_note}` : undefined}
        confirmLabel={open === 'flag' ? 'Flag call' : 'Clear flag'}
        noteRequired={open === 'flag'}
        onConfirm={doFlag}
      />
    </div>
  );
}
