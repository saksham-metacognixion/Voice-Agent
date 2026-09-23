'use client';

import * as React from 'react';
import { Label as LabelPrimitive } from 'radix-ui';
import { cn } from '../lib/utils';

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn('text-sm font-medium leading-none text-foreground peer-disabled:opacity-60', className)}
    {...props}
  />
));
Label.displayName = 'Label';
