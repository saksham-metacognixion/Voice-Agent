'use client';

import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import * as React from 'react';
import { Select as Primitive } from 'radix-ui';
import { cn } from '../lib/utils';

export const Select = Primitive.Root;
export const SelectGroup = Primitive.Group;
export const SelectValue = Primitive.Value;

export const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof Primitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.Trigger> & { invalid?: boolean }
>(({ className, children, invalid, ...props }, ref) => (
  <Primitive.Trigger
    ref={ref}
    aria-invalid={invalid || undefined}
    className={cn(
      'flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground shadow-card outline-none transition-[border-color,box-shadow]',
      'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60',
      'data-[placeholder]:text-muted-foreground aria-invalid:border-danger [&>span]:line-clamp-1 [&>span]:text-left',
      className,
    )}
    {...props}
  >
    {children}
    <Primitive.Icon asChild>
      <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Primitive.Icon>
  </Primitive.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <Primitive.Portal>
    <Primitive.Content
      ref={ref}
      position={position}
      className={cn(
        'relative z-50 max-h-80 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-popover data-[state=open]:animate-in-fade',
        position === 'popper' && 'w-full min-w-[var(--radix-select-trigger-width)] data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
        className,
      )}
      {...props}
    >
      <Primitive.ScrollUpButton className="flex items-center justify-center py-1">
        <ChevronUp className="size-4" />
      </Primitive.ScrollUpButton>
      <Primitive.Viewport className={cn('p-1', position === 'popper' && 'h-[var(--radix-select-trigger-height)] w-full')}>
        {children}
      </Primitive.Viewport>
      <Primitive.ScrollDownButton className="flex items-center justify-center py-1">
        <ChevronDown className="size-4" />
      </Primitive.ScrollDownButton>
    </Primitive.Content>
  </Primitive.Portal>
));
SelectContent.displayName = 'SelectContent';

export function SelectLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof Primitive.Label>) {
  return <Primitive.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />;
}

export const SelectItem = React.forwardRef<
  React.ComponentRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item>
>(({ className, children, ...props }, ref) => (
  <Primitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <Primitive.ItemIndicator>
        <Check className="size-4 text-primary" />
      </Primitive.ItemIndicator>
    </span>
    <Primitive.ItemText>{children}</Primitive.ItemText>
  </Primitive.Item>
));
SelectItem.displayName = 'SelectItem';

export function SelectSeparator({ className, ...props }: React.ComponentPropsWithoutRef<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
