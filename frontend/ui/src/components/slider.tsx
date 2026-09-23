'use client';

import * as React from 'react';
import { Slider as Primitive } from 'radix-ui';
import { cn } from '../lib/utils';

export const Slider = React.forwardRef<
  React.ComponentRef<typeof Primitive.Root>,
  React.ComponentPropsWithoutRef<typeof Primitive.Root>
>(({ className, ...props }, ref) => (
  <Primitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center py-2', className)}
    {...props}
  >
    <Primitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-input">
      <Primitive.Range className="absolute h-full bg-primary" />
    </Primitive.Track>
    {(props.value ?? props.defaultValue ?? [0]).map((_, i) => (
      <Primitive.Thumb
        key={i}
        className="block size-4 rounded-full border-2 border-primary bg-card shadow-card transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"
      />
    ))}
  </Primitive.Root>
));
Slider.displayName = 'Slider';
