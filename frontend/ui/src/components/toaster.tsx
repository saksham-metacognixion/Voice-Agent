'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, toast } from 'sonner';
import { useUiDirection } from './locale';

/** sonner, themed from the tokens so it matches whichever theme is active. */
export function Toaster(props: React.ComponentProps<typeof Sonner>) {
  const { resolvedTheme } = useTheme();
  const dir = useUiDirection();
  return (
    <Sonner
      theme={(resolvedTheme as 'light' | 'dark' | undefined) ?? 'system'}
      dir={dir}
      // The end corner of the page in either direction.
      position={dir === 'rtl' ? 'bottom-left' : 'bottom-right'}
      closeButton
      toastOptions={{
        classNames: {
          toast: '!rounded-lg !border !border-border !bg-popover !text-popover-foreground !shadow-popover',
          description: '!text-muted-foreground',
          actionButton: '!bg-primary !text-primary-foreground',
          cancelButton: '!bg-muted !text-foreground',
          closeButton: '!border-border !bg-popover !text-muted-foreground hover:!text-foreground',
        },
      }}
      {...props}
    />
  );
}

export { toast };
