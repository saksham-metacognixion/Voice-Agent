'use client';

import { cn } from '@portal/ui';

/** Which currency a money chart draws. Rendered only when more than one has data: one currency needs no choice. */
export function CurrencyTabs({ currencies, value, onChange }: { currencies: readonly string[]; value: string; onChange: (currency: string) => void }) {
  if (currencies.length < 2) return null;
  return (
    <div role="tablist" aria-label="Currency" className="inline-flex rounded-md border border-border bg-muted p-0.5 text-xs">
      {currencies.map((c) => (
        <button key={c} type="button" role="tab" aria-selected={value === c} onClick={() => onChange(c)} className={cn('rounded px-2.5 py-1 font-medium transition-colors', value === c ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground')}>
          {c}
        </button>
      ))}
    </div>
  );
}
