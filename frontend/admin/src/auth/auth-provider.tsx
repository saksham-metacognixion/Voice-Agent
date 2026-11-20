'use client';

import { Auth0Client, type User } from '@auth0/auth0-spa-js';
import { AuthRequiredError } from '@portal/api-client';
import { CLAIM_MFA } from '@portal/schemas';
import * as React from 'react';
import { authConfigured, config } from '../config';
import { routes, safeNext } from '../routes';

/**
 * Auth0 Universal Login through `@auth0/auth0-spa-js` — Authorization Code + PKCE, no
 * secret in the browser (ADR 0008) — against the STAFF tenant (ADR 0002: Google Workspace
 * domain + mandatory TOTP). Differences from the portal's provider:
 *
 *  - `login()` always asks for `acr_values` multi-factor. The API refuses a staff token
 *    without the `https://portal/mfa` claim (`MFA_REQUIRED`), so there is no point
 *    minting one.
 *  - The callback is the app origin itself; `/` handles `?code=&state=` and goes to
 *    `appState.returnTo` (default /overview/).
 */

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  /** The staff Post-Login Action's `https://portal/mfa` claim, or `amr` containing `mfa`. */
  mfa: boolean;
}

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Set when the redirect callback failed. */
  error: string | null;
  login: (returnTo?: string) => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => Promise<string | null>;
  configured: boolean;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

const MFA_ACR = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

function toUser(u: User | undefined): AuthUser | null {
  if (!u?.sub) return null;
  const amr = Array.isArray(u.amr) ? (u.amr as string[]) : [];
  return {
    id: u.sub,
    email: u.email ?? null,
    name: u.name ?? u.nickname ?? null,
    picture: u.picture ?? null,
    mfa: u[CLAIM_MFA] === true || amr.includes('mfa'),
  };
}

function origin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const clientRef = React.useRef<Auth0Client | null>(null);
  const [status, setStatus] = React.useState<AuthStatus>('loading');
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  function client(): Auth0Client {
    if (!clientRef.current) {
      clientRef.current = new Auth0Client({
        domain: config.auth0.domain,
        clientId: config.auth0.clientId,
        cacheLocation: 'localstorage',
        useRefreshTokens: true,
        useRefreshTokensFallback: true,
        authorizationParams: {
          audience: config.auth0.audience,
          redirect_uri: origin(),
          scope: 'openid profile email offline_access',
        },
      });
    }
    return clientRef.current;
  }

  React.useEffect(() => {
    if (!authConfigured) {
      setStatus('anonymous');
      return;
    }
    let cancelled = false;
    (async () => {
      const c = client();
      const params = new URLSearchParams(window.location.search);
      try {
        if (params.has('code') && params.has('state')) {
          const result = await c.handleRedirectCallback<{ returnTo?: string }>();
          const returnTo = safeNext(result.appState?.returnTo, routes.overview);
          // Strip code/state so a refresh does not replay the callback (Auth0 rejects a reused code).
          window.history.replaceState({}, '', returnTo);
        } else if (params.has('error')) {
          setError(params.get('error_description') ?? params.get('error') ?? 'login_failed');
          window.history.replaceState({}, '', window.location.pathname);
        }
        const u = toUser(await c.getUser());
        if (cancelled) return;
        if (u) {
          setUser(u);
          setStatus('authenticated');
        } else {
          setStatus('anonymous');
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('anonymous');
        window.history.replaceState({}, '', window.location.pathname);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = React.useCallback(async (returnTo?: string) => {
    if (!authConfigured) throw new Error('Auth0 is not configured');
    await client().loginWithRedirect({
      appState: { returnTo: safeNext(returnTo, routes.overview) },
      authorizationParams: { redirect_uri: origin(), acr_values: MFA_ACR },
    });
  }, []);

  // Only the origin is an allowed logout URL, so logout returns there and `/` sends a signed-out visitor to /login.
  const logout = React.useCallback(async () => {
    setUser(null);
    setStatus('anonymous');
    await client().logout({ logoutParams: { returnTo: origin() } });
  }, []);

  const getToken = React.useCallback(async (): Promise<string | null> => {
    if (!authConfigured) return null;
    try {
      return (await client().getTokenSilently()) ?? null;
    } catch (e) {
      const code = (e as { error?: string }).error;
      if (code === 'login_required' || code === 'consent_required' || code === 'missing_refresh_token' || code === 'invalid_grant') {
        setUser(null);
        setStatus('anonymous');
        throw new AuthRequiredError();
      }
      throw e;
    }
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ status, user, error, login, logout, getToken, configured: authConfigured }),
    [status, user, error, login, logout, getToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>');
  return ctx;
}
