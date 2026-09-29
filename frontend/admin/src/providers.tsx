'use client';

import { ApiProvider, createApiClient, createQueryClient } from '@portal/api-client';
import { ThemeProvider, Toaster, TooltipProvider } from '@portal/ui';
import { initErrorReporting } from '@portal/ui/error-reporting';
import * as React from 'react';
import { AuthProvider, useAuth } from './auth/auth-provider';
import { config } from './config';

// D14: before the first render, so an error while the providers mount is reported too.
initErrorReporting({ dsn: config.sentry.dsn, app: 'admin', environment: config.appEnv, release: config.sentry.release });

/**
 * Provider order: the API client needs the token (auth). Theme is outermost so even the
 * loader is in the right colours. Staff have no workspace, so the client sends no
 * `X-Workspace-Id` (`getWorkspaceId: () => null`). No analytics, no i18n.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider storageKey="admin-theme">
      <TooltipProvider delayDuration={300}>
        <AuthProvider>
          <ApiBridge>{children}</ApiBridge>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}

/** Builds the one ApiClient from the auth context; stable for the app's lifetime. */
function ApiBridge({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const getTokenRef = React.useRef(auth.getToken);
  getTokenRef.current = auth.getToken;

  const [queryClient] = React.useState(createQueryClient);
  const [client] = React.useState(() =>
    createApiClient({
      baseUrl: config.apiUrl,
      getToken: () => getTokenRef.current(),
      getWorkspaceId: () => null,
    }),
  );

  return (
    <ApiProvider client={client} queryClient={queryClient}>
      {children}
    </ApiProvider>
  );
}
