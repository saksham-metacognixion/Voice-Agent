'use client';

import { useAdminDecideKyc, useAdminGetKyc, useApi } from '@portal/api-client';
import type { StaffActionRequest } from '@portal/schemas';
import { Badge, Card, CardContent, CardHeader, CardTitle, Field, Skeleton, Textarea, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { PermissionButton } from '@/src/components/common/permission-button';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { KYC_CUSTOMER_REASON_MAX, KYC_STATUS_LABELS, customerReasonValid, kycActions, kycStatusVariant } from '@/src/lib/compliance';
import { formatDateTime } from '@/src/lib/format';
import { useStaff } from '@/src/staff/staff-provider';

type Decision = 'approve' | 'reject' | 'withdraw';

const DIALOG: Record<Decision, { title: string; confirm: string; consequences: string[] }> = {
  approve: {
    title: 'Approve business verification',
    confirm: 'Approve',
    consequences: [
      'The workspace may place outbound calls from its next attempt, from a verified caller ID and within the other outbound rules.',
      'The customer sees their business as verified.',
    ],
  },
  reject: {
    title: 'Reject business verification',
    confirm: 'Reject',
    consequences: ['Outbound calling stays off.', 'The customer sees the message below and can correct their details and submit again.'],
  },
  withdraw: {
    title: 'Withdraw business verification',
    confirm: 'Withdraw verification',
    consequences: [
      'Outbound calling stops at once: the next outbound attempt is refused.',
      'The customer sees the message below and can submit their details again.',
      'Inbound calls are not affected.',
    ],
  },
};

/**
 * Customer 360 business verification: what the customer submitted for outbound calling,
 * and the staff verdict on it. Approve needs a submission; reject and withdraw carry the
 * sentence the customer reads, separate from the audit note.
 */
export function KycCard({ customerId }: { customerId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const kyc = useAdminGetKyc(api, { id: customerId });
  const decide = useAdminDecideKyc(api);
  const [decision, setDecision] = React.useState<Decision | null>(null);
  const [message, setMessage] = React.useState('');
  const denied = can.compliance();

  function open(d: Decision) {
    setMessage('');
    setDecision(d);
  }

  async function confirm(body: StaffActionRequest) {
    if (!decision) return;
    const rejecting = decision !== 'approve';
    if (rejecting && !customerReasonValid(message)) return;
    await decide.mutateAsync({
      params: { id: customerId },
      body: rejecting ? { ...body, decision: 'rejected', customer_reason: message.trim() } : { ...body, decision: 'verified' },
    });
    await Promise.all(['adminGetKyc', 'adminCustomerAudit', 'adminAudit'].map((queryKey) => queryClient.invalidateQueries({ queryKey: [queryKey] })));
    toast.success(decision === 'approve' ? 'Business verified' : decision === 'withdraw' ? 'Verification withdrawn' : 'Verification rejected');
  }

  const k = kyc.data;
  const actions = k ? kycActions(k) : null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          Business verification
          {k ? <Badge variant={kycStatusVariant(k.status)}>{KYC_STATUS_LABELS[k.status]}</Badge> : null}
        </CardTitle>
        {actions && (actions.approve || actions.reject) ? (
          <span className="flex flex-wrap justify-end gap-2">
            {actions.approve ? (
              <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => open('approve')}>
                Approve
              </PermissionButton>
            ) : null}
            {actions.reject ? (
              <PermissionButton size="sm" variant="danger-outline" denied={denied} onClick={() => open(actions.reject!)}>
                {actions.reject === 'withdraw' ? 'Withdraw verification' : 'Reject'}
              </PermissionButton>
            ) : null}
          </span>
        ) : null}
      </CardHeader>
      <CardContent>
        {kyc.isPending ? (
          <Skeleton className="h-24" />
        ) : kyc.isError ? (
          <LoadError error={kyc.error} onRetry={() => void kyc.refetch()} compact />
        ) : !k ? null : (
          <div className="flex flex-col gap-4">
            {k.status === 'none' && !k.details ? (
              <p className="text-sm text-muted-foreground">Not submitted. Outbound calling stays off until the customer submits their business details and staff approve them.</p>
            ) : null}
            <FactGrid columns={2}>
              <Fact label="Submitted">{formatDateTime(k.submitted_at)}</Fact>
              <Fact label="Decided">{formatDateTime(k.decided_at)}</Fact>
              {k.details ? (
                <>
                  <Fact label="Legal name" wrap>
                    {k.details.legal_name}
                  </Fact>
                  <Fact label="Registration number" wrap>
                    {k.details.registration_number}
                  </Fact>
                  <Fact label="Registration country">{k.details.registration_country}</Fact>
                  <Fact label="Contact" wrap>
                    {k.details.contact_name}
                  </Fact>
                  <Fact label="Address" className="col-span-2" wrap>
                    {k.details.address}
                  </Fact>
                  <Fact label="Do-not-call registration" wrap>
                    {k.details.dnc_registration ?? '–'}
                  </Fact>
                </>
              ) : null}
            </FactGrid>
            {k.status === 'rejected' && k.reason ? (
              <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm">
                <p className="mb-1 text-xs text-muted-foreground">Message to the customer</p>
                <p className="break-words">{k.reason}</p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
      <StaffActionDialog
        open={Boolean(decision)}
        onOpenChange={(o) => (o ? undefined : setDecision(null))}
        title={decision ? DIALOG[decision].title : ''}
        description={k ? (k.details ? `${k.tenant_name} · ${k.details.legal_name}` : k.tenant_name) : undefined}
        consequences={decision ? DIALOG[decision].consequences : undefined}
        confirmLabel={decision ? DIALOG[decision].confirm : ''}
        destructive={decision === 'withdraw' || decision === 'reject'}
        extraValid={decision === 'approve' || customerReasonValid(message)}
        onConfirm={confirm}
      >
        {decision && decision !== 'approve' ? (
          <Field
            id="kyc-customer-reason"
            label="Message to the customer"
            required
            description={`Shown to the customer under Settings → Outbound calling. ${message.trim().length}/${KYC_CUSTOMER_REASON_MAX}`}
          >
            <Textarea id="kyc-customer-reason" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={KYC_CUSTOMER_REASON_MAX} rows={3} placeholder="e.g. The registration number does not match the business registry." />
          </Field>
        ) : null}
      </StaffActionDialog>
    </Card>
  );
}
