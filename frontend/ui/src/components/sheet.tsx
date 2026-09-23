'use client';

import { X } from 'lucide-react';
import * as React from 'react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import { cn } from '../lib/utils';

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

const sides = {
  left: 'inset-y-0 left-0 h-full w-80 max-w-[85vw] border-r',
  right: 'inset-y-0 right-0 h-full w-full max-w-md border-l sm:w-[28rem]',
  bottom: 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl border-t',
} as const;

export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & { side?: keyof typeof sides; closeLabel?: string }
>(({ className, children, side = 'right', closeLabel = 'Close', ...props }, ref) => (
  <SheetPrimitive.Portal>
    <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in-fade dark:bg-black/70" />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-50 flex flex-col gap-4 overflow-y-auto border-border bg-popover p-6 text-popover-foreground shadow-popover outline-none data-[state=open]:animate-in-fade',
        sides[side],
        className,
      )}
      {...props}
    >
      {children}
      <SheetPrimitive.Close
        className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label={closeLabel}
      >
        <X className="size-4" aria-hidden />
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPrimitive.Portal>
));
SheetContent.displayName = 'SheetContent';

export const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title ref={ref} className={cn('text-base font-semibold', className)} {...props} />
));
SheetTitle.displayName = 'SheetTitle';
export const SheetDescription = SheetPrimitive.Description;
