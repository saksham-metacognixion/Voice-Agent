'use client';

import * as React from 'react';
import { Avatar as Primitive } from 'radix-ui';
import { cn } from '../lib/utils';

export const Avatar = React.forwardRef<
  React.ComponentRef<typeof Primitive.Root>,
  React.ComponentPropsWithoutRef<typeof Primitive.Root>
>(({ className, ...props }, ref) => (
  <Primitive.Root ref={ref} className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full', className)} {...props} />
));
Avatar.displayName = 'Avatar';

export const AvatarImage = React.forwardRef<
  React.ComponentRef<typeof Primitive.Image>,
  React.ComponentPropsWithoutRef<typeof Primitive.Image>
>(({ className, ...props }, ref) => (
  <Primitive.Image ref={ref} className={cn('aspect-square size-full object-cover', className)} {...props} />
));
AvatarImage.displayName = 'AvatarImage';

export const AvatarFallback = React.forwardRef<
  React.ComponentRef<typeof Primitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof Primitive.Fallback>
>(({ className, ...props }, ref) => (
  <Primitive.Fallback
    ref={ref}
    className={cn('flex size-full items-center justify-center rounded-full bg-primary/15 text-xs font-semibold uppercase text-primary', className)}
    {...props}
  />
));
AvatarFallback.displayName = 'AvatarFallback';

/** "Pramod Nazre" → "PN"; an email → its first letter. */
export function initials(name?: string | null, fallback = '?'): string {
  if (!name) return fallback;
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
