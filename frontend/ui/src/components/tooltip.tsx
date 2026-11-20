'use client';

import * as React from 'react';
import { Tooltip as Primitive } from 'radix-ui';
import { cn } from '../lib/utils';

export const TooltipProvider = Primitive.Provider;
export const Tooltip = Primitive.Root;
export const TooltipTrigger = Primitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <Primitive.Portal>
    <Primitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 max-w-xs rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-popover data-[state=delayed-open]:animate-in-fade',
        className,
      )}
      {...props}
    />
  </Primitive.Portal>
));
TooltipContent.displayName = 'TooltipContent';
