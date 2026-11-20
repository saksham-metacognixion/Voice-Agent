'use client';

import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@portal/ui';
import { Search } from 'lucide-react';
import * as React from 'react';

export function FilterBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export function SearchBox({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cn('relative w-full sm:w-72', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'Search…'} className="pl-9" aria-label={placeholder ?? 'Search'} />
    </div>
  );
}

const ALL = '__all__';

/** A select with an "All" option that maps to `undefined`. */
export function FilterSelect({ value, onChange, options, label, allLabel, className }: { value: string | undefined; onChange: (v: string | undefined) => void; options: Array<{ value: string; label: string }>; label: string; allLabel?: string; className?: string }) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className={cn('w-auto min-w-36 sm:w-44', className)} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel ?? `All ${label.toLowerCase()}`}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
