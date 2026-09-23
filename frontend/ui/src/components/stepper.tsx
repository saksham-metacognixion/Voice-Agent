import { Check } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';

export interface StepperStep {
  key: string;
  label: string;
  /** Reachable = the customer may click back to it. */
  href?: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** 0-based index of the current step. */
  current: number;
  /** Renders each reachable step as a link. Supply your router's Link. */
  renderLink?: (step: StepperStep, children: React.ReactNode, className: string) => React.ReactNode;
  className?: string;
  stepLabel?: (n: number, total: number) => string;
}

/** The wizard header (§8): numbered dots, done ticks, current highlighted, later ones muted. */
export function Stepper({ steps, current, renderLink, className, stepLabel }: StepperProps) {
  return (
    <nav aria-label="Progress" className={cn('w-full', className)}>
      <ol className="flex items-center gap-1 overflow-x-auto scrollbar-thin sm:gap-2">
        {steps.map((step, i) => {
          const done = i < current;
          const active = i === current;
          const content = (
            <>
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                  done && 'border-primary bg-primary text-primary-foreground',
                  active && 'border-primary bg-card text-primary ring-4 ring-primary/15',
                  !done && !active && 'border-border bg-card text-muted-foreground',
                )}
                aria-hidden
              >
                {done ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className={cn('hidden text-xs font-medium md:inline', active ? 'text-foreground' : done ? 'text-foreground/80' : 'text-muted-foreground')}>
                {step.label}
              </span>
            </>
          );
          const cls = 'flex items-center gap-2 rounded-md px-1.5 py-1';
          return (
            <li key={step.key} className="flex items-center gap-1 sm:gap-2" aria-current={active ? 'step' : undefined}>
              {done && step.href && renderLink ? (
                renderLink(step, content, cn(cls, 'hover:bg-muted'))
              ) : (
                <span className={cls}>{content}</span>
              )}
              <span className="sr-only">{stepLabel ? stepLabel(i + 1, steps.length) : `Step ${i + 1} of ${steps.length}`}</span>
              {i < steps.length - 1 ? <span className={cn('h-px w-4 sm:w-8', done ? 'bg-primary' : 'bg-border')} aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
