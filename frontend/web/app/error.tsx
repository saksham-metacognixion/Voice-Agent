'use client';

import { ErrorFallback } from '@/src/components/error-fallback';

/** §12.1: the boundary under the root layout. Every route segment that throws lands here. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorFallback error={error} reset={reset} />;
}
