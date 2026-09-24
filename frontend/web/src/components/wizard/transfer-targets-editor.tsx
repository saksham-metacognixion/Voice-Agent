'use client';

import { transferTarget, type TransferTarget } from '@portal/schemas';
import { Button, Input, Label } from '@portal/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

/** `phone_plans.transfer_targets` holds at most five (the request schema's `max(5)`). */
export const MAX_TRANSFER_TARGETS = 5;

export interface TransferTargetDraft {
  key: string;
  label: string;
  number: string;
}

let seq = 0;
export function toDrafts(targets: TransferTarget[]): TransferTargetDraft[] {
  return targets.map((t) => ({ key: `t${(seq += 1)}`, label: t.label, number: t.number }));
}

/** Per-row messages, keyed like the rows; empty when every row is valid. */
export function validateTargets(rows: TransferTargetDraft[], messages: { label: string; number: string }): Record<string, { label?: string; number?: string }> {
  const errors: Record<string, { label?: string; number?: string }> = {};
  for (const row of rows) {
    const parsed = transferTarget.safeParse({ label: row.label, number: normaliseE164(row.number) });
    if (parsed.success) continue;
    const e: { label?: string; number?: string } = {};
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === 'label') e.label = messages.label;
      if (issue.path[0] === 'number') e.number = messages.number;
    }
    errors[row.key] = e;
  }
  return errors;
}

export function toTargets(rows: TransferTargetDraft[]): TransferTarget[] {
  return rows.map((r) => ({ label: r.label.trim(), number: normaliseE164(r.number) }));
}

/** "+1 (450) 555-0123" → "+14505550123". Anything that is not a leading + or a digit goes. */
export function normaliseE164(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits ? `+${digits}` : '';
}

/**
 * W6 TransferTargetsEditor (§11 hand-off): the people the agent may pass a caller to.
 * Add, edit, remove; validated against the same `transferTarget` schema the API parses,
 * so a row the editor accepts is a row the PUT accepts. Saving is the page's job — the
 * targets travel with the phone plan.
 */
export function TransferTargetsEditor({
  value,
  onChange,
  errors,
  disabled,
}: {
  value: TransferTargetDraft[];
  onChange: (next: TransferTargetDraft[]) => void;
  errors: Record<string, { label?: string; number?: string }>;
  disabled?: boolean;
}) {
  const tt = useTranslations('wizard.w6.transfer');

  function update(key: string, patch: Partial<TransferTargetDraft>) {
    onChange(value.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="sr-only">{tt('title')}</legend>
      {value.length === 0 ? <p className="text-sm text-muted-foreground">{tt('empty')}</p> : null}
      <ul className="flex flex-col gap-3">
        {value.map((row, i) => {
          const e = errors[row.key] ?? {};
          const labelId = `tt-label-${row.key}`;
          const numberId = `tt-number-${row.key}`;
          return (
            <li key={row.key} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
              <div className="flex flex-col gap-1">
                <Label htmlFor={labelId} className="text-xs">
                  {tt('label')}
                </Label>
                <Input id={labelId} value={row.label} maxLength={60} placeholder={tt('labelPlaceholder')} onChange={(ev) => update(row.key, { label: ev.target.value })} aria-invalid={Boolean(e.label) || undefined} aria-describedby={e.label ? `${labelId}-err` : undefined} />
                {e.label ? <p id={`${labelId}-err`} className="text-xs text-danger">{e.label}</p> : null}
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={numberId} className="text-xs">
                  {tt('number')}
                </Label>
                <Input id={numberId} type="tel" inputMode="tel" value={row.number} placeholder="+14505550123" onChange={(ev) => update(row.key, { number: ev.target.value })} aria-invalid={Boolean(e.number) || undefined} aria-describedby={e.number ? `${numberId}-err` : undefined} />
                {e.number ? <p id={`${numberId}-err`} className="text-xs text-danger">{e.number}</p> : null}
              </div>
              <Button type="button" variant="ghost" size="icon" className="sm:mt-5" onClick={() => onChange(value.filter((r) => r.key !== row.key))} aria-label={tt('remove', { n: i + 1 })}>
                <Trash2 />
              </Button>
            </li>
          );
        })}
      </ul>
      <div>
        <Button type="button" variant="outline" size="sm" disabled={value.length >= MAX_TRANSFER_TARGETS} onClick={() => onChange([...value, ...toDrafts([{ label: '', number: '' }])])}>
          <Plus /> {tt('add')}
        </Button>
        {value.length >= MAX_TRANSFER_TARGETS ? <p className="mt-1 text-xs text-muted-foreground">{tt('max', { max: MAX_TRANSFER_TARGETS })}</p> : null}
      </div>
    </fieldset>
  );
}
