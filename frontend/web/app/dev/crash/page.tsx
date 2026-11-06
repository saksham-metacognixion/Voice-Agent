'use client';

import { Button } from '@portal/ui';
import * as React from 'react';
import { config } from '@/src/config';

/**
 * Dev only: a page that throws on demand, so the §12.1 error boundary can be exercised
 * in the browser (the wizard's end-to-end script clicks it). Outside `APP_ENV=dev` it
 * renders nothing but a line saying so, like the API's `/dev/*` routes answer 404.
 */
export default function CrashPage() {
  const [crash, setCrash] = React.useState(false);
  if (config.appEnv !== 'dev') return <main className="p-6 text-sm text-muted-foreground">Not available outside development.</main>;
  if (crash) throw new Error('dev: deliberate render error');
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Button onClick={() => setCrash(true)} data-testid="dev-crash">
        Throw a render error
      </Button>
    </main>
  );
}
