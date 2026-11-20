import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';

const alertVariants = cva('relative flex w-full gap-3 rounded-lg border p-4 text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0', {
  variants: {
    variant: {
      info: 'border-info/30 bg-info/8 text-foreground [&_svg]:text-info',
      success: 'border-success/30 bg-success/8 text-foreground [&_svg]:text-success',
      warning: 'border-warning/40 bg-warning/12 text-foreground [&_svg]:text-warning-foreground dark:[&_svg]:text-warning',
      danger: 'border-danger/30 bg-danger/8 text-foreground [&_svg]:text-danger',
      neutral: 'border-border bg-muted/60 text-foreground [&_svg]:text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'info' },
});

const icons = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle, neutral: Info } as const;

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>, VariantProps<typeof alertVariants> {
  title?: React.ReactNode;
  icon?: React.ReactNode | false;
  actions?: React.ReactNode;
}

export function Alert({ className, variant = 'info', title, icon, actions, children, ...props }: AlertProps) {
  const Icon = icons[variant ?? 'info'];
  return (
    <div role={variant === 'danger' ? 'alert' : 'status'} className={cn(alertVariants({ variant }), className)} {...props}>
      {icon === false ? null : (icon ?? <Icon aria-hidden />)}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <p className="font-medium leading-tight">{title}</p> : null}
        {children ? <div className="text-muted-foreground [&_a]:text-foreground [&_a]:underline">{children}</div> : null}
        {actions ? <div className="mt-1 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
