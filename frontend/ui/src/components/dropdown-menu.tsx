'use client';

import { Check, ChevronRight } from 'lucide-react';
import * as React from 'react';
import { DropdownMenu as Primitive } from 'radix-ui';
import { cn } from '../lib/utils';

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuSub = Primitive.Sub;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <Primitive.Portal>
    <Primitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[12rem] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-popover data-[state=open]:animate-in-fade',
        className,
      )}
      {...props}
    />
  </Primitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item> & { inset?: boolean; destructive?: boolean }
>(({ className, inset, destructive, ...props }, ref) => (
  <Primitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
      destructive && 'text-danger data-[highlighted]:bg-danger/10 [&_svg]:text-danger',
      inset && 'pl-8',
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof Primitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof Primitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <Primitive.CheckboxItem
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <Primitive.ItemIndicator>
        <Check className="size-4" />
      </Primitive.ItemIndicator>
    </span>
    {children}
  </Primitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

export const DropdownMenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof Primitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof Primitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <Primitive.RadioItem
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <Primitive.ItemIndicator>
        <Check className="size-4" />
      </Primitive.ItemIndicator>
    </span>
    {children}
  </Primitive.RadioItem>
));
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof Primitive.Label>) {
  return <Primitive.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />;
}
export function DropdownMenuSeparator({ className, ...props }: React.ComponentPropsWithoutRef<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
export function DropdownMenuShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)} {...props} />;
}
export const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof Primitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <Primitive.SubTrigger
    ref={ref}
    className={cn('flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[state=open]:bg-muted', className)}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto size-4" />
  </Primitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger';
export const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof Primitive.SubContent>
>(({ className, ...props }, ref) => (
  <Primitive.SubContent
    ref={ref}
    className={cn('z-50 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-popover', className)}
    {...props}
  />
));
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent';
