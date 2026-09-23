'use client';

import { ApiProvider, createApiClient, createQueryClient } from '@portal/api-client';
import { ThemeProvider, Toaster, TooltipProvider } from '@portal/ui';
import { NextIntlClientProvider } from 'next-intl';
import * as React from 'react';
import { AnalyticsProvider, identify, resetAnalytics, track } from './analytics/posthog';
import { AuthProvider, useAuth, type AuthUser } from './auth/auth-provider';
import { config } from './config';
import { DEFAULT_LOCALE, messages } from './i18n';
import { storage } from './lib/storage';
import { workspaceStore } from './workspace/store';
import { WorkspaceProvider } from './workspace/workspace-provider';

/**
 * Provider order matters: the API client needs the token (auth), the workspace provider
 * needs the API, analytics needs the workspace id. Theme is outermost so even the loader
 * is in the right colours.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <NextIntlClientProvider locale={DEFAULT_LOCALE} messages={messages[DEFAULT_LOCALE]} timeZone="UTC">
        <TooltipProvider delayDuration={300}>
          <AuthProvider onSignedIn={onSignedIn}>
            <ApiBridge>
              <WorkspaceProvider>
                <AnalyticsProvider>{children}</AnalyticsProvider>
              </WorkspaceProvider>
            </ApiBridge>
          </AuthProvider>
          <Toaster />
        </TooltipProvider>
      </NextIntlClientProvider>
    </ThemeProvider>
  );
}

const SEEN_KEY = 'portal:seen-users';

function onSignedIn(user: AuthUser) {
  identify(user.id, { email_verified: user.emailVerified });
  // First sign-in on this browser → count it as the signup milestone once.
  const seen = (storage.get(SEEN_KEY) ?? '').split(',').filter(Boolean);
  if (!seen.includes(user.id)) {
    storage.set(SEEN_KEY, [...seen, user.id].slice(-10).join(','));
    track('signup_completed', { email_verified: user.emailVerified });
  } else {
    track('login_completed', { email_verified: user.emailVerified });
  }
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
      getWorkspaceId: () => workspaceStore.get(),
    }),
  );

  React.useEffect(() => {
    if (auth.status === 'anonymous') resetAnalytics();
  }, [auth.status]);

  return (
    <ApiProvider client={client} queryClient={queryClient}>
      {children}
    </ApiProvider>
  );
}
