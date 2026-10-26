'use client';

import { STAFF_NOTE_MAX, staffActionRequest, type ReasonCode, type StaffActionRequest } from '@portal/schemas';
import {
  Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea,
} from '@portal/ui';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';
import { REASON_CODES, REASON_LABELS } from '@/src/lib/reason-codes';

/**
 * Admin §10 / Appendix B: every customer-affecting staff write carries a reason. One
 * dialog for all of them — reason code, optional note (required for `other`), optional
 * ticket, the consequences, and for the irreversible ones a typed confirmation. The reason
 * starts empty and the button stays disabled until one is picked (QA-041): a pre-selected
 * reason is one nobody chose, and the audit row would say otherwise. Resolves
 * with the validated `staffActionRequest` body through `onConfirm`; throwing keeps the
 * dialog open with the message in place.
 */
export interface StaffActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  consequences?: React.ReactNode[];
  confirmLabel: string;
  destructive?: boolean;
  /** Irreversible: the person types this (case and spaces ignored) before the button enables. */
  typeToConfirm?: string;
  typeLabel?: React.ReactNode;
  /** The schema's note limit for this request (`STAFF_NOTE_MAX` unless the route's is lower). */
  noteMax?: number;
  /** Extra fields rendered above the reason (an adjust-credits delta, a kill-switch expiry). */
  children?: React.ReactNode;
  /** Blocks the confirm until the extra fields are valid. */
  extraValid?: boolean;
  onConfirm: (body: StaffActionRequest) => Promise<void>;
}

export function StaffActionDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  confirmLabel,
  destructive = false,
  typeToConfirm,
  typeLabel,
  noteMax = STAFF_NOTE_MAX,
  children,
  extraValid = true,
  onConfirm,
}: StaffActionDialogProps) {
  const [reason, setReason] = React.useState<ReasonCode | ''>('');
  const [note, setNote] = React.useState('');
  const [ticket, setTicket] = React.useState('');
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) {
      setReason('');
      setNote('');
      setTicket('');
      setTyped('');
      setError(null);
      setFieldErrors({});
    }
  }, [open]);

  const normalise = (v: string) => v.replace(/\s+/g, '').toLowerCase();
  const typedOk = !typeToConfirm || normalise(typed) === normalise(typeToConfirm);
  const noteRequired = reason === 'other';

  function build(): StaffActionRequest | null {
    const ticketNum = ticket.trim() ? Number(ticket.trim()) : undefined;
    const parsed = staffActionRequest.safeParse({
      reason_code: reason || undefined,
      note: note.trim() || undefined,
      ticket_id: ticketNum,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0] ?? 'form')] = issue.path[0] === 'reason_code' ? 'Pick a reason.' : issue.message;
      setFieldErrors(errs);
      return null;
    }
    setFieldErrors({});
    return parsed.data;
  }

  async function confirm() {
    if (busy || !typedOk || !extraValid || !reason) return;
    const body = build();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(body);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? undefined : onOpenChange(v))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {consequences?.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {consequences.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : null}
        {children}
        <Field id="action-reason" label="Reason" required error={fieldErrors.reason_code}>
          <Select value={reason} onValueChange={(v) => setReason(v as ReasonCode)}>
            <SelectTrigger id="action-reason" aria-label="Reason">
              <SelectValue placeholder="Choose a reason" />
            </SelectTrigger>
            <SelectContent>
              {REASON_CODES.map((code) => (
                <SelectItem key={code} value={code}>
                  {REASON_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="action-note" label="Note" required={noteRequired} optional={!noteRequired} error={fieldErrors.note} description={noteRequired ? 'A note is required with reason "Other".' : 'Goes in the staff audit log.'}>
          <Textarea id="action-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={noteMax} rows={3} invalid={Boolean(fieldErrors.note)} />
        </Field>
        <Field id="action-ticket" label="Ticket number" optional error={fieldErrors.ticket_id}>
          <Input id="action-ticket" inputMode="numeric" value={ticket} onChange={(e) => setTicket(e.target.value.replace(/[^\d]/g, ''))} placeholder="e.g. 1042" className="max-w-40" />
        </Field>
        {typeToConfirm ? (
          <Field id="action-typed" label={typeLabel ?? <>Type <span className="font-mono">{typeToConfirm}</span> to confirm</>}>
            <Input id="action-typed" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? void confirm() : undefined)} />
          </Field>
        ) : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={() => void confirm()} disabled={!reason || !typedOk || !extraValid || busy} loading={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
