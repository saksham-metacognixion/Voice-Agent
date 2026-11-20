'use client';

import { Button, toast, type ButtonProps } from '@portal/ui';
import { Check } from 'lucide-react';
import * as React from 'react';
import { copyText } from '@/src/lib/clipboard';

/**
 * Copies `text` and says whether it got there: a tick on the button for two seconds and
 * a toast on success; on failure a toast, so the person selects the text by hand. The
 * label is always read out; the icon is decoration.
 */
export function CopyButton({ text, label, copied, failed, icon, onCopied, ...props }: { text: string; label: string; copied: string; failed: string; icon?: React.ReactNode; onCopied?: () => void } & Omit<ButtonProps, 'onClick' | 'children'>) {
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <Button
      {...props}
      type="button"
      aria-label={label}
      data-copied={done || undefined}
      onClick={async () => {
        const ok = await copyText(text);
        setDone(ok);
        if (ok) {
          toast.success(copied);
          onCopied?.();
        } else toast.error(failed);
      }}
    >
      {done ? <Check aria-hidden /> : icon}
      {props.size === 'icon' || props.size === 'icon-sm' ? null : <span>{done ? copied : label}</span>}
    </Button>
  );
}
