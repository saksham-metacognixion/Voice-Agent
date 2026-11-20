'use client';

import { Button, ErrorState } from '@portal/ui';
import { reportError } from '@portal/ui/error-reporting';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { config } from '@/src/config';
import { routes } from '@/src/routes';

/**
 * §12.1 "global error boundary": what a page shows when rendering threw. Next's
 * `error.tsx` catches below the root layout, so the providers (theme, language) are
 * still up and this is translated; `global-error.tsx` covers the layout itself with
 * plain markup. "Try again" re-renders the segment (`reset`); the home link is the way
 * out when it throws again. The error itself goes to Sentry once, with the page's path
 * stripped of its query (the reporter does that), never its message on screen.
 */
export function ErrorFallback({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('errors.boundary');
  React.useEffect(() => {
    reportError(error, { boundary: 'page' });
  }, [error]);
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <ErrorState
        title={t('title')}
        description={error.digest ? t('bodyWithRef', { ref: error.digest }) : t('body')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={reset} data-testid="error-retry">
              {t('retry')}
            </Button>
            <Button variant="outline" asChild>
              <a href={routes.app.home}>{t('home')}</a>
            </Button>
            <Button variant="link" asChild>
              <a href={`mailto:${config.support.email}`}>{t('support')}</a>
            </Button>
          </div>
        }
      />
    </main>
  );
}
