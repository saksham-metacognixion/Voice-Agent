'use client';

import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@portal/ui';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';

/**
 * The one confirmation every destructive or hard-to-undo action goes through: what will
 * happen, an optional typed confirmation (the number, the email) that must match before
 * the button enables, a busy state that blocks a double submit, and the error in place.
 * `onConfirm` resolving closes the dialog; throwing keeps it open with the message.
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
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Bullets under the description: what stops, what is lost. */
  consequences?: React.ReactNode[];
  confirmLabel: string;
  /** When set, the person types this (spaces and case ignored) to enable the button. */
  typeToConfirm?: string;
  typeLabel?: React.ReactNode;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations();
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
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? undefined : onOpenChange(v))}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {consequences?.length ? (
          <ul className="list-disc space-y-1 ps-5 text-sm">
            {consequences.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : null}
        {typeToConfirm ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-typed">{typeLabel}</Label>
            <Input id="confirm-typed" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? void confirm() : undefined)} />
          </div>
        ) : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={() => void confirm()} disabled={!matches || busy} loading={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
