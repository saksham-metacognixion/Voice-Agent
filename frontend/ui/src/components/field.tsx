import * as React from 'react';
import { cn } from '../lib/utils';
import { Label } from './label';

export interface FieldProps {
  id?: string;
  label?: React.ReactNode;
  /** Small grey copy under the label — the W2 "example" hints live here. */
  description?: React.ReactNode;
  /** The validation message. Rendered in danger colour with aria-live. */
  error?: React.ReactNode;
  /** Something on the right of the label row (a counter, a "required" mark). */
  addon?: React.ReactNode;
  required?: boolean;
  optional?: boolean;
  optionalLabel?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Label + control + description + error, in a consistent 8-px rhythm. Pass `id` and give
 * the control the same id so the label is clickable and screen readers pair them.
 */
export function Field({ id, label, description, error, addon, required, optional, optionalLabel = 'Optional', className, children }: FieldProps) {
  const errorId = id ? `${id}-error` : undefined;
  const descId = id ? `${id}-desc` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label !== undefined ? (
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor={id} className="flex items-center gap-1.5">
            {label}
            {required ? <span className="text-danger" aria-hidden>*</span> : null}
            {optional ? <span className="text-xs font-normal text-muted-foreground">{optionalLabel}</span> : null}
          </Label>
          {addon ? <span className="text-xs text-muted-foreground">{addon}</span> : null}
        </div>
      ) : null}
      {children}
      {description ? (
        <p id={descId} className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" aria-live="polite" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
