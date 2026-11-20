'use client';

import { Button, toast } from '@portal/ui';
import { Check, Copy } from 'lucide-react';
import * as React from 'react';
import { shortId } from '@/src/lib/format';

/** An id with a copy button; shows the short form unless `full`. */
export function Copyable({ value, full = false, className }: { value: string; full?: boolean; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy');
    }
  }
  return (
    <span className={`inline-flex max-w-full min-w-0 items-center gap-1 font-mono text-xs ${className ?? ''}`} title={value}>
      <span className={full ? 'min-w-0 break-all' : 'truncate'}>{full ? value : shortId(value, 12)}</span>
      <Button variant="ghost" size="icon-sm" className="size-6" onClick={(e) => void copy(e)} aria-label={copied ? 'Copied' : 'Copy'}>
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </Button>
    </span>
  );
}
