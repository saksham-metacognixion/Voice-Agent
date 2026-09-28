'use client';

import { useAdminAdjustCredits, useApi } from '@portal/api-client';
import { adminCreditAdjustRequest, type ReasonCode } from '@portal/schemas';
import {
  Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, toast,
} from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';
import { formatCredits } from '@/src/lib/format';
import { REASON_CODES, REASON_LABELS } from '@/src/lib/reason-codes';
import { useStaff } from '@/src/staff/staff-provider';

/** Admin §7.3 credit adjustment: a ledger row plus a `credit_adjustments` record, under the role's per-action cap. */
export function AdjustCreditsDialog({ customerId, customerName, balance, onClose }: { customerId: string; customerName: string; balance: number; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const cap = can.creditCap();
  const adjust = useAdminAdjustCredits(api);
  const [delta, setDelta] = React.useState('');
  const [reason, setReason] = React.useState<ReasonCode>('goodwill');
  const [note, setNote] = React.useState('');
  const [customerText, setCustomerText] = React.useState('');
  const [ticket, setTicket] = React.useState('');
  // One key per opened dialog: a double click or a retry after a timeout is the same adjustment.
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);

  const parsedDelta = Number(delta);
  const deltaOk = delta.trim() !== '' && Number.isFinite(parsedDelta) && parsedDelta !== 0;
  const overCap = cap !== null && deltaOk && Math.abs(parsedDelta) > cap;
  const resulting = deltaOk ? balance + parsedDelta : balance;

  async function submit() {
    const parsed = adminCreditAdjustRequest.safeParse({
      delta: Math.round(parsedDelta * 100) / 100,
      reason_code: reason,
      note: note.trim() || undefined,
      customer_text: customerText.trim() || undefined,
      ticket_id: ticket.trim() ? Number(ticket.trim()) : undefined,
      idempotency_key: idempotencyKey,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0] ?? 'form')] = i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setError(null);
    try {
      const res = await adjust.mutateAsync({ params: { id: customerId }, body: parsed.data });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['adminGetCustomerWallet'] }),
        queryClient.invalidateQueries({ queryKey: ['adminGetCustomer'] }),
        queryClient.invalidateQueries({ queryKey: ['adminListCustomers'] }),
      ]);
      toast.success(`${res.delta > 0 ? 'Added' : 'Removed'} ${formatCredits(Math.abs(res.delta))} credits`, { description: `${customerName} now has ${formatCredits(res.balance_after)} credits.` });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o || adjust.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust credits</DialogTitle>
          <DialogDescription>
            {customerName} · balance {formatCredits(balance)}
            {cap !== null ? ` · your cap per action: ${formatCredits(cap)}` : ''}
          </DialogDescription>
        </DialogHeader>
        <Field id="adj-delta" label="Credits (+ to add, − to remove)" required error={errors.delta ?? (overCap ? `Over your per-action cap of ${formatCredits(cap ?? 0)}.` : undefined)} description={deltaOk ? `Resulting balance: ${formatCredits(resulting)}` : 'Two decimals at most.'}>
          <Input id="adj-delta" inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value.replace(/[^\d.+-]/g, ''))} placeholder="e.g. 25 or -10" className="max-w-48 tabular-nums" invalid={Boolean(errors.delta) || overCap} />
        </Field>
        <Field id="adj-reason" label="Reason" required error={errors.reason_code}>
          <Select value={reason} onValueChange={(v) => setReason(v as ReasonCode)}>
            <SelectTrigger id="adj-reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASON_CODES.map((c) => (
                <SelectItem key={c} value={c}>
                  {REASON_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="adj-note" label="Internal note" required={reason === 'other'} optional={reason !== 'other'} error={errors.note}>
          <Textarea id="adj-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} className="min-h-16" />
        </Field>
        <Field id="adj-customer" label="Customer-facing text" optional description="Shown beside the ledger row in their wallet." error={errors.customer_text}>
          <Input id="adj-customer" value={customerText} onChange={(e) => setCustomerText(e.target.value)} maxLength={200} placeholder="Goodwill credit for the outage on 24 Sep" />
        </Field>
        <Field id="adj-ticket" label="Ticket number" optional error={errors.ticket_id}>
          <Input id="adj-ticket" inputMode="numeric" value={ticket} onChange={(e) => setTicket(e.target.value.replace(/[^\d]/g, ''))} className="max-w-40" />
        </Field>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!deltaOk || overCap || adjust.isPending} loading={adjust.isPending} variant={deltaOk && parsedDelta < 0 ? 'danger' : 'primary'}>
            {deltaOk && parsedDelta < 0 ? 'Remove credits' : 'Add credits'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
