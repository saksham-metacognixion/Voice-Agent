'use client';

import { Check } from 'lucide-react';
import * as React from 'react';
import { RadioGroup as Primitive } from 'radix-ui';
import { cn } from '../lib/utils';

export const RadioGroup = React.forwardRef<
  React.ComponentRef<typeof Primitive.Root>,
  React.ComponentPropsWithoutRef<typeof Primitive.Root>
>(({ className, ...props }, ref) => <Primitive.Root ref={ref} className={cn('grid gap-2', className)} {...props} />);
RadioGroup.displayName = 'RadioGroup';

export interface RadioCardProps extends Omit<React.ComponentPropsWithoutRef<typeof Primitive.Item>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
}

/** A selectable card — used for choices with a sentence of explanation (W2 AI disclosure, W6 options). */
export const RadioCard = React.forwardRef<React.ComponentRef<typeof Primitive.Item>, RadioCardProps>(
  ({ className, title, description, icon, ...props }, ref) => (
    <Primitive.Item
      ref={ref}
      className={cn(
        'group relative flex w-full items-start gap-3 rounded-lg border border-border bg-card p-4 text-left shadow-card outline-none transition-[border-color,box-shadow,background-color]',
        'hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=checked]:border-primary data-[state=checked]:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    >
      {icon ? <span className="mt-0.5 text-muted-foreground [&_svg]:size-5 group-data-[state=checked]:text-primary">{icon}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {description ? <span className="text-xs leading-relaxed text-muted-foreground">{description}</span> : null}
      </span>
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-input bg-card group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary">
        <Primitive.Indicator>
          <Check className="size-3 text-primary-foreground" aria-hidden />
        </Primitive.Indicator>
      </span>
    </Primitive.Item>
  ),
);
RadioCard.displayName = 'RadioCard';
