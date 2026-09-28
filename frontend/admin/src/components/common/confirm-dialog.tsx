'use client';

import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@portal/ui';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';

/**
 * The one confirmation every destructive or hard-to-undo action goes through: what will
 * happen, an optional typed confirmation that must match before the button enables, a
 * busy state, and the error in place. `onConfirm` resolving closes the dialog; throwing
 * keeps it open with the message.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  confirmLabel,
  typeToConfirm,
  typeLabel,
  destructive = true,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  consequences?: React.ReactNode[];
  confirmLabel: string;
  /** When set, the person types this (spaces and case ignored) to enable the button. */
  typeToConfirm?: string;
  typeLabel?: React.ReactNode;
  destructive?: boolean;
  /** Extra fields between the bullets and the typed confirmation. */
  children?: React.ReactNode;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setTyped('');
      setError(null);
    }
  }, [open]);

  const normalise = (v: string) => v.replace(/\s+/g, '').toLowerCase();
  const matches = !typeToConfirm || normalise(typed) === normalise(typeToConfirm);

  async function confirm() {
    if (busy || !matches) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
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
        {typeToConfirm ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-typed">{typeLabel ?? <>Type <span className="font-mono">{typeToConfirm}</span> to confirm</>}</Label>
            <Input id="confirm-typed" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? void confirm() : undefined)} />
          </div>
        ) : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={() => void confirm()} disabled={!matches || busy} loading={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
