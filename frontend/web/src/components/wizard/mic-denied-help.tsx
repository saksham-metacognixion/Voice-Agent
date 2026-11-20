'use client';

import { Alert } from '@portal/ui';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { detectBrowser } from '@/src/wizard/browser-help';

/**
 * §8 W5 "mic denied → inline instructions per browser": the steps for the browser in
 * use (Chrome, Edge, Safari, Firefox), from its user agent; anything else gets the
 * generic line. Steps are the catalogue's, so they read in the portal's language.
 * Shared by the W5 test call and W2's spoken answers; `children` is the caller's own line.
 */
export function MicDeniedHelp({ children, actions, lastStep }: { children?: React.ReactNode; actions?: React.ReactNode; lastStep?: string }) {
  const tt = useTranslations('wizard.w5.call.errors');
  const browser = React.useSyncExternalStore(
    () => () => undefined,
    () => detectBrowser(navigator.userAgent),
    () => 'other' as const,
  );
  // The catalogue's last step is "start the call again"; another screen says its own.
  const steps = (tt.raw(`micHelp.${browser}`) as string[]).map((step, i, all) => (lastStep && i === all.length - 1 ? lastStep : step));
  return (
    <Alert variant="danger" title={tt('micDeniedTitle')} actions={actions}>
      <p>{tt('micDenied')}</p>
      <p className="mt-2 text-xs font-medium">{tt(`micHelpTitle.${browser}`)}</p>
      <ol className="mt-1 list-decimal space-y-0.5 ps-5 text-sm" data-testid="mic-help">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {children ? <p className="mt-2">{children}</p> : null}
    </Alert>
  );
}
