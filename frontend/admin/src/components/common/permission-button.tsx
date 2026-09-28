'use client';

import { Button, Tooltip, TooltipContent, TooltipTrigger, type ButtonProps } from '@portal/ui';
import * as React from 'react';
import type { Denied } from '@/src/lib/permissions';

/**
 * A button that is disabled with a tooltip naming the role needed when `denied` is a
 * sentence. The API enforces the rule again; this only avoids a dead end.
 */
export const PermissionButton = React.forwardRef<HTMLButtonElement, ButtonProps & { denied: Denied }>(({ denied, disabled, children, ...props }, ref) => {
  if (!denied) {
    return (
      <Button ref={ref} disabled={disabled} {...props}>
        {children}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          <Button ref={ref} disabled aria-disabled {...props} className={`${props.className ?? ''} pointer-events-none`}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{denied}</TooltipContent>
    </Tooltip>
  );
});
PermissionButton.displayName = 'PermissionButton';
