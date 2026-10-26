'use client';

import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';
import { useUiLabels } from './locale';

export interface TagInputProps {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Per-tag character limit; longer entries are trimmed. */
  maxLength?: number;
  /** Total number of tags; the input hides when reached. */
  max?: number;
  disabled?: boolean;
  removeLabel?: string;
  className?: string;
  'aria-describedby'?: string;
}

/**
 * Comma/Enter-separated chips (W2 "Services"). Paste of "a, b, c" adds three tags. Backspace
 * on an empty input removes the last tag, which is the behaviour people expect from a
 * chip field and the one that does not need a mouse.
 */
export function TagInput({ id, value, onChange, placeholder, maxLength = 60, max, disabled, removeLabel, className, ...rest }: TagInputProps) {
  const labels = useUiLabels();
  const remove = removeLabel ?? labels.remove;
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const full = max !== undefined && value.length >= max;

  function commit(raw: string) {
    const parts = raw
      .split(/[,\n]/)
      .map((s) => s.trim().slice(0, maxLength))
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) {
      if (max !== undefined && next.length >= max) break;
      if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    onChange(next);
    setDraft('');
  }

  return (
    <div
      className={cn(
        'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1.5 text-sm shadow-card transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((tag) => (
        <span key={tag} className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
          <span className="truncate">{tag}</span>
          {disabled ? null : (
            <button
              type="button"
              aria-label={`${remove} ${tag}`}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((v) => v !== tag));
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </span>
      ))}
      {full ? null : (
        <input
          ref={inputRef}
          id={id}
          value={draft}
          disabled={disabled}
          placeholder={value.length === 0 ? placeholder : undefined}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (text.includes(',') || text.includes('\n')) {
              e.preventDefault();
              commit(text);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(draft);
            } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          {...rest}
        />
      )}
    </div>
  );
}
