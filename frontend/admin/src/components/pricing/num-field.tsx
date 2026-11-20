'use client';

import { Input, type InputProps } from '@portal/ui';
import * as React from 'react';

/**
 * A number input that keeps what the person typed ("1." on the way to "1.5") and commits
 * the parsed value on every valid keystroke. `null` allowed when `nullable`.
 */
export function NumField({ value, onChange, nullable = false, integer = false, ...props }: Omit<InputProps, 'value' | 'onChange'> & { value: number | null; onChange: (v: number | null) => void; nullable?: boolean; integer?: boolean }) {
  const [text, setText] = React.useState(value === null ? '' : String(value));
  React.useEffect(() => {
    const parsed = text.trim() === '' ? null : Number(text);
    if (parsed !== value && !(Number.isNaN(parsed) && value === null)) setText(value === null ? '' : String(value));
    // Only resync when the prop changes from outside; `text` is deliberately not a dependency.
  }, [value]);
  return (
    <Input
      {...props}
      inputMode={integer ? 'numeric' : 'decimal'}
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === '') {
          if (nullable) onChange(null);
          return;
        }
        const n = Number(t);
        if (!Number.isNaN(n) && (!integer || Number.isInteger(n))) onChange(n);
      }}
    />
  );
}
