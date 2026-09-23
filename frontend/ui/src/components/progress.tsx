'use client';

import * as React from 'react';
import { Progress as Primitive } from 'radix-ui';
import { cn } from '../lib/utils';

export const Progress = React.forwardRef<
  React.ComponentRef<typeof Primitive.Root>,
  React.ComponentPropsWithoutRef<typeof Primitive.Root> & { indeterminate?: boolean }
>(({ className, value, indeterminate, ...props }, ref) => (
  <Primitive.Root
    ref={ref}
    value={indeterminate ? undefined : value}
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    {...props}
  >
    <Primitive.Indicator
      className={cn('h-full rounded-full bg-primary transition-[width] duration-500', indeterminate && 'w-1/3 animate-[progress-slide_1.4s_ease-in-out_infinite]')}
      style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
    />
    <style>{`@keyframes progress-slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
  </Primitive.Root>
));
Progress.displayName = 'Progress';
