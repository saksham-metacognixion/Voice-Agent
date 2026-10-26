'use client';

import { useAdminTicketMacro, useApi } from '@portal/api-client';
import type { AdminTicketDetail, AdminTicketMacroRequest, StaffActionRequest, TicketMacro } from '@portal/schemas';
import { Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { formatCredits, shortId } from '@/src/lib/format';
import { useStaff } from '@/src/staff/staff-provider';

/**
 * SA4 macros (admin §4, §11): each is a `StaffActionDialog` — reason code, note, the
 * consequences — plus the one field the macro needs. The API runs the same paths the
 * console's other buttons do (credits through the wallet under the role's cap, the
 * activation through the §13.8 job) and appends a system line to the thread.
 */
export type MacroKind = TicketMacro;

function useRunMacro(ticket: AdminTicketDetail, onDone?: () => void) {
  const api = useApi();
  const queryClient = useQueryClient();
  const run = useAdminTicketMacro(api);
  return async (macro: MacroKind, body: AdminTicketMacroRequest, done: (res: Awaited<ReturnType<typeof run.mutateAsync>>) => string) => {
    const res = await run.mutateAsync({ params: { id: String(ticket.id), macro }, body });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['adminGetTicket'] }),
      queryClient.invalidateQueries({ queryKey: ['adminListTickets'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetCustomerWallet'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetCustomer'] }),
    ]);
    toast.success(done(res));
    onDone?.();
  };
}

/** Strips the dialog's optional `ticket_id` (this ticket is the path) and adds the macro's fields. */
function macroBody(action: StaffActionRequest, extra: Partial<AdminTicketMacroRequest>): AdminTicketMacroRequest {
  return { reason_code: action.reason_code, ...(action.note ? { note: action.note } : {}), ...extra } as AdminTicketMacroRequest;
}

export function CompCreditsDialog({ ticket, open, onOpenChange }: { ticket: AdminTicketDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useStaff();
  const cap = can.creditCap();
  const runMacro = useRunMacro(ticket);
  const [credits, setCredits] = React.useState('');
  const [customerText, setCustomerText] = React.useState('');
  // One key per opened dialog: a double click or a retry after a timeout comps once.
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => crypto.randomUUID());
  React.useEffect(() => {
    if (!open) {
      setCredits('');
      setCustomerText('');
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [open]);
  const n = Number(credits);
  const valid = credits.trim() !== '' && Number.isFinite(n) && n > 0;
  const overCap = cap !== null && valid && n > cap;

  return (
    <StaffActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Comp credits"
      description={`${ticket.tenant.name} · balance ${formatCredits(ticket.tenant.balance)}${cap !== null ? ` · your cap per action: ${formatCredits(cap)}` : ''}`}
      consequences={['A ledger row and a credit adjustment linked to this ticket.', 'A system line on the thread; the customer sees the credit in their wallet.']}
      confirmLabel="Add credits"
      extraValid={valid && !overCap}
      onConfirm={(action) =>
        runMacro(
          'comp_credits',
          macroBody(action, { credits: Math.round(n * 100) / 100, idempotency_key: idempotencyKey, ...(customerText.trim() ? { customer_text: customerText.trim() } : {}) }),
          (res) => `Added ${formatCredits(res.adjustment?.delta ?? n)} credits — balance ${formatCredits(res.adjustment?.balance_after ?? 0)}`,
        )
      }
    >
      <Field id="macro-credits" label="Credits" required error={overCap ? `Over your per-action cap of ${formatCredits(cap ?? 0)}.` : undefined} description={valid ? `Resulting balance: ${formatCredits(ticket.tenant.balance + n)}` : 'Positive, two decimals at most.'}>
        <Input id="macro-credits" inputMode="decimal" value={credits} onChange={(e) => setCredits(e.target.value.replace(/[^\d.]/g, ''))} placeholder="e.g. 25" className="max-w-40 tabular-nums" invalid={overCap} />
      </Field>
      <Field id="macro-customer-text" label="Customer-facing text" optional description="Shown beside the ledger row in their wallet.">
        <Input id="macro-customer-text" value={customerText} onChange={(e) => setCustomerText(e.target.value)} maxLength={200} placeholder="Goodwill credit for the missed calls on Monday" />
      </Field>
    </StaffActionDialog>
  );
}

export function RefundCallDialog({ ticket, open, onOpenChange }: { ticket: AdminTicketDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const runMacro = useRunMacro(ticket);
  const linked = ticket.linked_call_ids;
  const [callId, setCallId] = React.useState(linked[0] ?? '');
  React.useEffect(() => {
    if (!open) setCallId(linked[0] ?? '');
  }, [open, linked]);
  const valid = callId.trim().length > 0;

  return (
    <StaffActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Refund a call"
      description={`${ticket.tenant.name} · the call’s charge is credited back in full.`}
      consequences={['Only a charged call of this workspace can be refunded, and only once — a call already refunded from any ticket is refused.', 'A ledger row and a credit adjustment linked to this ticket, plus a system line on the thread.']}
      confirmLabel="Refund call"
      extraValid={valid}
      onConfirm={(action) => runMacro('refund_call', macroBody(action, { call_id: callId.trim() }), (res) => `Refunded ${formatCredits(res.adjustment?.delta ?? 0)} credits for call ${shortId(callId, 14)}`)}
    >
      {linked.length ? (
        <Field id="macro-call" label="Call" required description="One of the calls linked to this ticket.">
          <Select value={callId} onValueChange={setCallId}>
            <SelectTrigger id="macro-call" aria-label="Call">
              <SelectValue placeholder="Pick a call" />
            </SelectTrigger>
            <SelectContent>
              {linked.map((id) => (
                <SelectItem key={id} value={id}>
                  <span className="font-mono text-xs">{id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : (
        <Field id="macro-call" label="Call id" required description="No call is linked to this ticket; paste the id from the Calls page.">
          <Input id="macro-call" value={callId} onChange={(e) => setCallId(e.target.value)} placeholder="call_…" className="font-mono text-xs" spellCheck={false} />
        </Field>
      )}
    </StaffActionDialog>
  );
}

export function RerunActivationDialog({ ticket, open, onOpenChange }: { ticket: AdminTicketDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const runMacro = useRunMacro(ticket);
  return (
    <StaffActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Re-run the activation"
      description={`${ticket.tenant.name} · queues the go-live job for the workspace’s agent again.`}
      consequences={['Publishes the agent, provisions or re-binds its number and marks it live — each step resumes where it stopped.', 'Refused while an activation is already running, or when the workspace has no generated agent.']}
      confirmLabel="Re-run activation"
      onConfirm={(action) => runMacro('rerun_activation', macroBody(action, {}), (res) => `Activation queued (job ${shortId(res.job_id, 8)})`)}
    />
  );
}
