'use client';

import { useAdminGetPurchase, useAdminRefundPurchase, useApi } from '@portal/api-client';
import type { AdminPurchaseDetail, StaffActionRequest } from '@portal/schemas';
import { Alert, Field, Input, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { formatCents, formatCredits } from '@/src/lib/format';
import { useStaff } from '@/src/staff/staff-provider';

/**
 * SA9 refund (admin §4 SA9): the reason dialog with an amount on top. The amount defaults
 * to what is still refundable and is capped by the role's `refund_max_cents`; the credits
 * that will be drawn back are computed live from the purchase's own rate; a refund of
 * everything asks for the amount to be typed. One idempotency key per opened dialog, so
 * a double click or a retry after a timeout is the same refund (never a second Stripe call).
 *
 * The detail is fetched here rather than passed in: the SA2 purchases tab only has the
 * SA2 row, and `refundable_cents` must be the server's number, not a guess.
 */
export function RefundDialog({ purchaseId, onClose, onDone }: { purchaseId: string | null; onClose: () => void; onDone?: () => void | Promise<void> }) {
  if (!purchaseId) return null;
  // Keyed so every opened dialog starts clean: fresh amount, fresh idempotency key.
  return <RefundDialogInner key={purchaseId} purchaseId={purchaseId} onClose={onClose} onDone={onDone} />;
}

function RefundDialogInner({ purchaseId, onClose, onDone }: { purchaseId: string; onClose: () => void; onDone?: () => void | Promise<void> }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const cap = can.refundCap();
  const detail = useAdminGetPurchase(api, { id: purchaseId });
  const refund = useAdminRefundPurchase(api);
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());
  const [amount, setAmount] = React.useState<string | null>(null);

  const p = detail.data;
  const refundable = p?.refundable_cents ?? 0;
  const max = cap === null ? refundable : Math.min(refundable, cap);
  const value = amount ?? (p ? (max / 100).toFixed(2) : '');
  const parsed = Number(value);
  const cents = value.trim() !== '' && Number.isFinite(parsed) ? Math.round(parsed * 100) : NaN;
  const valid = Boolean(p) && Number.isFinite(cents) && cents >= 1 && cents <= refundable && (cap === null || cents <= cap);
  const credits = p && valid ? Math.round(((p.credits * cents) / p.amount_cents) * 100) / 100 : null;
  const full = Boolean(p) && valid && cents === refundable;
  const amountError = !p || value.trim() === '' ? undefined : !Number.isFinite(cents) || cents < 1 ? 'Enter an amount.' : cents > refundable ? `At most ${formatCents(refundable, p.currency)} is left to refund.` : cap !== null && cents > cap ? `Over your per-refund cap of ${formatCents(cap, p.currency)}.` : undefined;

  async function confirm(body: StaffActionRequest) {
    if (!p || !valid) return;
    const res = await refund.mutateAsync({ params: { id: purchaseId }, body: { ...body, amount_cents: cents, idempotency_key: idempotencyKey } });
    await Promise.all(
      ['adminListPurchases', 'adminGetPurchase', 'adminCustomerPurchases', 'adminBillingSummary', 'adminGetCustomerWallet', 'adminGetCustomer', 'adminListCustomers'].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey: [queryKey] }),
      ),
    );
    toast.success(`Refunded ${formatCents(cents, p.currency)}`, { description: `${formatCredits(credits ?? 0)} credits drawn back from ${p.tenant_name}${res.status === 'refunded' ? ' · purchase fully refunded' : ''}.` });
    await onDone?.();
  }

  return (
    <StaffActionDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title="Refund purchase"
      description={p ? <Summary p={p} /> : undefined}
      consequences={[
        'Stripe refunds the amount to the original payment method (3–10 business days).',
        'The credits that amount bought are drawn back from the wallet now, FIFO. Credits already spent leave the balance negative until the next purchase.',
        'A full refund marks the purchase refunded; a partial one keeps it paid with the remainder still refundable.',
        'The customer sees the reversal in their wallet ledger.',
      ]}
      confirmLabel={full ? 'Refund in full' : 'Refund'}
      destructive
      typeToConfirm={p && full ? (cents / 100).toFixed(2) : undefined}
      typeLabel={<>Type the amount <span className="font-mono">{(cents / 100).toFixed(2)}</span> to confirm a full refund</>}
      defaultReason="customer_request"
      extraValid={valid && !refund.isPending}
      onConfirm={confirm}
    >
      {detail.isPending ? (
        <Skeleton className="h-16" aria-busy />
      ) : detail.isError || !p ? (
        <Alert variant="danger">Could not load the purchase.</Alert>
      ) : refundable <= 0 ? (
        <Alert variant="danger">Nothing is left to refund on this purchase.</Alert>
      ) : (
        <Field
          id="refund-amount"
          label={`Amount (${p.currency})`}
          required
          error={amountError}
          description={
            <>
              Refundable {formatCents(refundable, p.currency)} of {formatCents(p.amount_cents, p.currency)}
              {cap !== null ? ` · your cap per refund ${formatCents(cap, p.currency)}` : ''}
              {credits !== null ? ` · reverses ${formatCredits(credits)} of ${formatCredits(p.credits)} credits` : ''}
            </>
          }
        >
          <Input id="refund-amount" inputMode="decimal" value={value} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className="max-w-48 tabular-nums" invalid={Boolean(amountError)} />
        </Field>
      )}
    </StaffActionDialog>
  );
}

function Summary({ p }: { p: AdminPurchaseDetail }) {
  return (
    <>
      {p.tenant_name} · {p.pack_name ?? p.pack_id ?? 'custom'} · {formatCents(p.amount_cents, p.currency)} for {formatCredits(p.credits)} credits
      {p.refunded_cents > 0 ? ` · ${formatCents(p.refunded_cents, p.currency)} already refunded` : ''}
    </>
  );
}
