'use client';

import * as React from 'react';
import { Tabs as Primitive } from 'radix-ui';
import { cn } from '../lib/utils';

/**
 * Tabs in the underline style — the D3 agent page's eight tabs. The list scrolls
 * sideways on a phone instead of wrapping, so the active tab is always reachable.
 */
export const Tabs = Primitive.Root;

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof Primitive.List>,
  React.ComponentPropsWithoutRef<typeof Primitive.List>
>(({ className, ...props }, ref) => (
  <Primitive.List
    ref={ref}
    className={cn('flex w-full gap-1 overflow-x-auto border-b border-border [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof Primitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.Trigger>
>(({ className, ...props }, ref) => (
  <Primitive.Trigger
    ref={ref}
    className={cn(
      '-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors',
      'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50',
      'data-[state=active]:border-primary data-[state=active]:text-foreground [&_svg]:size-4',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, ...props }, ref) => (
  <Primitive.Content ref={ref} className={cn('mt-6 focus-visible:outline-none', className)} {...props} />
));
TabsContent.displayName = 'TabsContent';
