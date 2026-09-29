'use client';

import { ApiProvider, createApiClient, createQueryClient } from '@portal/api-client';
import { ThemeProvider, Toaster, TooltipProvider } from '@portal/ui';
import { NextIntlClientProvider } from 'next-intl';
import { initErrorReporting } from '@portal/ui/error-reporting';
import * as React from 'react';
import { AnalyticsProvider, identify, resetAnalytics, track } from './analytics/posthog';
import { AuthProvider, useAuth, type AuthUser } from './auth/auth-provider';
import { ImpersonationBanner } from './components/shell/impersonation-banner';
import { impersonationStore } from './auth/impersonation';
import { routes } from './routes';
import { config } from './config';
import { DEFAULT_LOCALE, messages } from './i18n';
import { storage } from './lib/storage';
import { workspaceStore } from './workspace/store';
import { WorkspaceProvider } from './workspace/workspace-provider';

// D14: before the first render, so an error while the providers mount is reported too.
initErrorReporting({ dsn: config.sentry.dsn, app: 'portal', environment: config.appEnv, release: config.sentry.release });

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
                <AnalyticsProvider>
                  {/* Admin §7.4: above every screen — the wizard and the auth pages included — while a staff member views the workspace. */}
                  <ImpersonationBanner />
                  {children}
                </AnalyticsProvider>
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
  const logoutRef = React.useRef(auth.logout);
  logoutRef.current = auth.logout;

  const [queryClient] = React.useState(createQueryClient);
  const [client] = React.useState(() =>
    createApiClient({
      baseUrl: config.apiUrl,
      getToken: () => getTokenRef.current(),
      getWorkspaceId: () => workspaceStore.get(),
      // A view-as session ended from the console answers 401 on the next request; the
      // tab forgets the key and goes to the sign-in page instead of looping on errors.
      onUnauthorized: () => {
        if (impersonationStore.get()) {
          impersonationStore.clear();
          window.location.replace(routes.login);
          return;
        }
        // The API refused a token the SPA still holds (support ended the sessions, or the
        // account was locked): sign out rather than leave the person on a page of errors.
        void logoutRef.current();
      },
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
