import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} aria-hidden {...props} />;
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex text-muted-foreground', className)}>
      <Loader2 className="size-5 animate-spin" aria-hidden />
    </span>
  );
}

/** Full-area loading state used by route guards and page shells while data resolves. */
export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] w-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <Spinner label={label} />
      <span>{label}</span>
    </div>
  );
}
