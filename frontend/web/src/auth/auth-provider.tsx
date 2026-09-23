'use client';

import { Auth0Client, type User } from '@auth0/auth0-spa-js';
import { AuthRequiredError } from '@portal/api-client';
import * as React from 'react';
import { authConfigured, config } from '../config';
import { routes, safeNext } from '../routes';

/**
 * Auth0 Universal Login through `@auth0/auth0-spa-js` — Authorization Code + PKCE, no
 * secret in the browser (ADR 0008). A1 sign-up, A2 login, A5 MFA and the password half
 * of A6 happen on Auth0's hosted pages; this provider owns the session and the token.
 *
 *  - The callback is the app origin itself (`callbacks: [PORTAL_URL]` in
 *    infra/auth0/tenant.customer.yaml), so `/` handles `?code=&state=` and then goes to
 *    `appState.returnTo`.
 *  - Tokens are cached in localStorage with rotating refresh tokens, so a page refresh
 *    does not bounce through Auth0 and the session survives the access token's lifetime.
 *  - `emailVerified` is the ID token's `email_verified`. A3 calls `refresh()` after the
 *    person clicks the link, which re-runs the Post-Login Action on a refresh-token grant
 *    and re-reads the claim.
 */

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  emailVerified: boolean;
  /** `amr` contains `mfa` when the session was established with a second factor (A5). */
  mfa: boolean;
}

export interface LoginOptions {
  returnTo?: string;
  screenHint?: 'signup' | 'login';
  /** Ask Auth0 for a second factor on this sign-in (enrols if needed). */
  requireMfa?: boolean;
  /** Pre-fill the identifier field. */
  loginHint?: string;
}

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Set when the redirect callback failed (A2 error state). */
  error: string | null;
  login: (opts?: LoginOptions) => Promise<void>;
  logout: (returnTo?: string) => Promise<void>;
  getToken: () => Promise<string | null>;
  /** Re-mint the session and re-read claims (email_verified, mfa). Returns the fresh user. */
  refresh: () => Promise<AuthUser | null>;
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
    emailVerified: u.email_verified === true,
    mfa: amr.includes('mfa'),
  };
}

function origin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** The tenant as a URL. A bare domain is https; an explicit http:// (a local stand-in issuer) is kept. */
function issuerBase(): string {
  const d = config.auth0.domain.replace(/\/+$/, '');
  return /^https?:\/\//i.test(d) ? d : `https://${d}`;
}

export function AuthProvider({ children, onSignedIn }: { children: React.ReactNode; onSignedIn?: (user: AuthUser) => void }) {
  const clientRef = React.useRef<Auth0Client | null>(null);
  const [status, setStatus] = React.useState<AuthStatus>('loading');
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const onSignedInRef = React.useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

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
          const returnTo = safeNext(result.appState?.returnTo, routes.root);
          // Strip code/state so a refresh does not replay the callback (Auth0 rejects a reused code).
          window.history.replaceState({}, '', returnTo);
        } else if (params.has('error')) {
          // Auth0 sends `?error=…&error_description=…` when Universal Login could not finish.
          setError(params.get('error_description') ?? params.get('error') ?? 'login_failed');
          window.history.replaceState({}, '', window.location.pathname);
        }
        const u = toUser(await c.getUser());
        if (cancelled) return;
        if (u) {
          setUser(u);
          setStatus('authenticated');
          onSignedInRef.current?.(u);
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

  const login = React.useCallback(async (opts: LoginOptions = {}) => {
    if (!authConfigured) throw new Error('Auth0 is not configured');
    const returnTo = safeNext(opts.returnTo, routes.root);
    await client().loginWithRedirect({
      appState: { returnTo },
      authorizationParams: {
        redirect_uri: origin(),
        ...(opts.screenHint ? { screen_hint: opts.screenHint } : {}),
        ...(opts.requireMfa ? { acr_values: MFA_ACR } : {}),
        ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
      },
    });
  }, []);

  const logout = React.useCallback(async (returnTo?: string) => {
    setUser(null);
    setStatus('anonymous');
    await client().logout({ logoutParams: { returnTo: `${origin()}${returnTo ?? routes.login}` } });
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

  const refresh = React.useCallback(async (): Promise<AuthUser | null> => {
    if (!authConfigured) return null;
    try {
      await client().getTokenSilently({ cacheMode: 'off' });
      const u = toUser(await client().getUser());
      setUser(u);
      setStatus(u ? 'authenticated' : 'anonymous');
      return u;
    } catch {
      return user;
    }
  }, [user]);

  const value = React.useMemo<AuthContextValue>(
    () => ({ status, user, error, login, logout, getToken, refresh, configured: authConfigured }),
    [status, user, error, login, logout, getToken, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>');
  return ctx;
}

/**
 * A6 — the first half of "forgot password". Auth0's public change-password endpoint sends
 * the reset email for a database user; it answers the same sentence whether or not the
 * address exists, so this cannot be used to enumerate accounts.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const res = await fetch(`${issuerBase()}/dbconnections/change_password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: config.auth0.clientId, email, connection: 'Username-Password-Authentication' }),
  });
  if (!res.ok) throw new Error(`reset request failed: ${res.status}`);
}
