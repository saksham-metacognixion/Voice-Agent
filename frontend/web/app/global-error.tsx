'use client';

import { reportError } from '@portal/ui/error-reporting';
import * as React from 'react';

/**
 * §12.1: the boundary around the root layout itself. No providers survive here, so the
 * markup is plain and the copy is English only; `error.tsx` handles everything below
 * the layout with the translated, themed fallback.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    reportError(error, { boundary: 'root' });
  }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#f7f8fb', color: '#0a0f1a' }}>
        <main style={{ maxWidth: '28rem', padding: '1.5rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.5rem' }}>Something went wrong</h1>
          <p style={{ margin: '0 0 1rem' }}>The page could not be shown. Nothing you saved is lost.</p>
          <button type="button" onClick={reset} style={{ cursor: 'pointer', padding: '0.5rem 1rem', borderRadius: '0.5rem', border: 0, background: '#7050f5', color: '#fff', font: 'inherit' }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
