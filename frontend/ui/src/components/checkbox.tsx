'use client';

import { Check, Minus } from 'lucide-react';
import * as React from 'react';
import { Checkbox as Primitive } from 'radix-ui';
import { cn } from '../lib/utils';

/**
 * A tri-state checkbox (checked, unchecked, `indeterminate`) — the D2 table's row and
 * header selection. Radix owns the state and the keyboard; the box is drawn with the
 * theme tokens so it matches the Switch.
 */
export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof Primitive.Root>,
  React.ComponentPropsWithoutRef<typeof Primitive.Root>
>(({ className, ...props }, ref) => (
  <Primitive.Root
    ref={ref}
    className={cn(
      'peer flex size-4 shrink-0 items-center justify-center rounded border border-input bg-card shadow-card transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary',
      className,
    )}
    {...props}
  >
    <Primitive.Indicator className="flex items-center justify-center text-primary-foreground">
      {props.checked === 'indeterminate' ? <Minus className="size-3" aria-hidden /> : <Check className="size-3" aria-hidden />}
    </Primitive.Indicator>
  </Primitive.Root>
));
Checkbox.displayName = 'Checkbox';
