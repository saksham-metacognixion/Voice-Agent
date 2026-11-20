'use client';

import { cn } from '@portal/ui';
import { prettyJson } from '@/src/lib/json';

/** Pretty JSON in a scrollable, selectable block. */
export function JsonView({ value, className, maxHeight = 'max-h-[60vh]' }: { value: unknown; className?: string; maxHeight?: string }) {
  const text = prettyJson(value);
  if (!text || text === 'null') return <p className="text-sm text-muted-foreground">–</p>;
  return <pre className={cn('overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed', maxHeight, className)}>{text}</pre>;
}
