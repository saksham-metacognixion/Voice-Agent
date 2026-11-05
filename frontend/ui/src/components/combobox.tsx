'use client';

import { Check, ChevronDown, Search, X } from 'lucide-react';
import * as React from 'react';
import { Popover } from 'radix-ui';
import { matchesSearch } from '../lib/search';
import { cn } from '../lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Extra words the search also matches (synonyms, the untranslated slug). */
  keywords?: string[];
}

export interface ComboboxGroup {
  key: string;
  label: string;
  options: ComboboxOption[];
}

export interface ComboboxProps {
  id?: string;
  value: string | null;
  onValueChange: (value: string | null) => void;
  /** Flat or grouped; a flat list is one unnamed group. */
  options: ComboboxOption[] | ComboboxGroup[];
  placeholder: string;
  searchPlaceholder: string;
  /** Shown when the search matches nothing. */
  emptyLabel: string;
  /** Offered at the top of the list when `value` is set; omit to make the choice permanent. */
  clearLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}

function isGrouped(options: ComboboxProps['options']): options is ComboboxGroup[] {
  return options.length > 0 && 'options' in options[0]!;
}

/**
 * A searchable select: a button that opens a list with a search box above it (W1's
 * industry, ≈ 40 options). Radix's Popover owns the open state, the outside click and
 * Escape; the search box is the `combobox` and the list its `listbox`, so arrow keys,
 * Enter and the active option are read out as one control. A native `<select>` cannot
 * be searched and Radix's Select has no text input, hence the hand-rolled list.
 */
export function Combobox({ id, value, onValueChange, options, placeholder, searchPlaceholder, emptyLabel, clearLabel, disabled, invalid, className }: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  const groups = React.useMemo<ComboboxGroup[]>(() => (isGrouped(options) ? options : [{ key: '', label: '', options }]), [options]);
  const visible = React.useMemo(
    () => groups.map((g) => ({ ...g, options: g.options.filter((o) => matchesSearch(o, query)) })).filter((g) => g.options.length > 0),
    [groups, query],
  );
  // The rows in reading order, so the arrow keys walk them regardless of grouping.
  const rows = React.useMemo<Array<{ value: string | null; label: string }>>(
    () => [...(clearLabel && value ? [{ value: null, label: clearLabel }] : []), ...visible.flatMap((g) => g.options)],
    [visible, clearLabel, value],
  );
  const selected = React.useMemo(() => groups.flatMap((g) => g.options).find((o) => o.value === value) ?? null, [groups, value]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // Radix moves focus to the content on open; the search box is what should have it.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);
  React.useEffect(() => setActive(0), [query]);
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose(index: number) {
    const row = rows[index];
    if (!row) return;
    onValueChange(row.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(rows.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  }

  const optionId = (index: number) => `${listId}-${index}`;
  let index = -1;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground shadow-card outline-none transition-[border-color,box-shadow]',
            'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger',
            className,
          )}
        >
          <span className={cn('truncate text-start', !selected && 'text-muted-foreground')}>{selected?.label ?? placeholder}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[14rem] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-popover data-[state=open]:animate-in-fade"
        >
          <div className="relative border-b border-border">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={rows.length > 0 ? optionId(active) : undefined}
              value={query}
              placeholder={searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className="h-10 w-full bg-transparent ps-9 pe-9 text-sm outline-none placeholder:text-muted-foreground"
            />
            {query ? (
              <button type="button" tabIndex={-1} aria-hidden className="absolute end-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted" onClick={() => setQuery('')}>
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <ul ref={listRef} id={listId} role="listbox" className="max-h-72 overflow-y-auto p-1 scrollbar-thin">
            {rows.length === 0 ? (
              <li role="presentation" className="px-3 py-6 text-center text-sm text-muted-foreground">
                {emptyLabel}
              </li>
            ) : null}
            {clearLabel && value
              ? (() => {
                  index += 1;
                  const i = index;
                  return (
                    <li
                      role="option"
                      id={optionId(i)}
                      data-index={i}
                      aria-selected={false}
                      className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground', i === active && 'bg-muted')}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose(i)}
                    >
                      <X className="size-3.5" aria-hidden />
                      {clearLabel}
                    </li>
                  );
                })()
              : null}
            {visible.map((group) => (
              <li key={group.key} role="presentation">
                {group.label ? <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group.label}</div> : null}
                <ul role="group" aria-label={group.label || undefined}>
                  {group.options.map((option) => {
                    index += 1;
                    const i = index;
                    const chosen = option.value === value;
                    return (
                      <li
                        key={option.value}
                        role="option"
                        id={optionId(i)}
                        data-index={i}
                        aria-selected={chosen}
                        className={cn('flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm', i === active && 'bg-muted', chosen && 'font-medium')}
                        onMouseMove={() => setActive(i)}
                        onClick={() => choose(i)}
                      >
                        <span className="truncate">{option.label}</span>
                        {chosen ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
