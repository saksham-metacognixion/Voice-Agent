import { Injectable, Logger } from '@nestjs/common';
import { withTimeout } from '../../common/timeout';

/** What SA3 reads back from the identity provider about one person. */
export interface ProviderUserFacts {
  email_verified: boolean;
  blocked: boolean;
}

/** One sign-in session as §6.2 shows it; nothing else of the provider's object leaves this file. */
export interface ProviderSession {
  id: string;
  created_at: string | null;
  last_active_at: string | null;
  expires_at: string | null;
  user_agent: string | null;
  ip: string | null;
}

/** A 404 from the Management API: the object is not there (or not ours to see). */
export class Auth0NotFound extends Error {}

const TOKEN_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 10_000;

/**
 * The customer tenant's Management API, for the SA3 actions that live in Auth0 rather
 * than in our tables: mark an email verified, reset a second factor, block a sign-in,
 * revoke sessions. Client-credentials from `AUTH0_CUSTOMER_M2M_CLIENT_ID/SECRET`
 * (auth0.md §1); the token is cached until shortly before it expires.
 *
 * Unconfigured (a dev box, CI) is a state, not an error: `configured` is false, every
 * call answers `skipped`, and the local row still changes — the API-side effect of a
 * lock (AuthGuard refusing the user) holds without the provider. Staff see `provider:
 * skipped` on the response, never a silent success.
 */
@Injectable()
export class Auth0ManagementService {
  private readonly log = new Logger(Auth0ManagementService.name);
  private readonly domain: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const raw = env.AUTH0_CUSTOMER_DOMAIN?.trim() ?? '';
    this.domain = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    this.clientId = env.AUTH0_CUSTOMER_M2M_CLIENT_ID?.trim() ?? '';
    this.clientSecret = env.AUTH0_CUSTOMER_M2M_CLIENT_SECRET?.trim() ?? '';
    if (!this.configured)
      this.log.warn(
        'AUTH0_CUSTOMER_M2M_CLIENT_ID/SECRET unset: SA3 user actions change local state only',
      );
  }

  get configured(): boolean {
    // A plaintext local issuer (`pnpm dev:issuer`) has no Management API.
    return (
      Boolean(this.domain && this.clientId && this.clientSecret) &&
      !/^(localhost|127\.0\.0\.1)(:|$)/.test(this.domain)
    );
  }

  async getUser(sub: string): Promise<ProviderUserFacts | null> {
    if (!this.configured) return null;
    const body = (await this.call(
      'GET',
      `/api/v2/users/${encodeURIComponent(sub)}?fields=email_verified,blocked`,
    )) as { email_verified?: boolean; blocked?: boolean };
    return { email_verified: body.email_verified === true, blocked: body.blocked === true };
  }

  async setEmailVerified(sub: string, verified: boolean): Promise<'applied' | 'skipped'> {
    if (!this.configured) return 'skipped';
    await this.call('PATCH', `/api/v2/users/${encodeURIComponent(sub)}`, {
      email_verified: verified,
    });
    return 'applied';
  }

  async setBlocked(sub: string, blocked: boolean): Promise<'applied' | 'skipped'> {
    if (!this.configured) return 'skipped';
    await this.call('PATCH', `/api/v2/users/${encodeURIComponent(sub)}`, { blocked });
    return 'applied';
  }

  /**
   * Lifts the brute-force blocks on one account (ADR 0036 §8, `update:users`): by `sub`
   * when the log named the user, else by the address typed. Every IP's block on that
   * account goes at once — the API takes no IP. A block set by a staff member
   * (`setBlocked`) is not a brute-force block and stays. `not_found` = no such user.
   */
  async liftBruteForceBlocks(target: { sub: string | null; identifier: string | null }): Promise<'applied' | 'not_found' | 'skipped'> {
    if (!this.configured) return 'skipped';
    const path = target.sub
      ? `/api/v2/user-blocks/${encodeURIComponent(target.sub)}`
      : target.identifier
        ? `/api/v2/user-blocks?identifier=${encodeURIComponent(target.identifier)}`
        : null;
    if (!path) return 'not_found';
    try {
      await this.call('DELETE', path);
    } catch (error) {
      if (error instanceof Auth0NotFound) return 'not_found';
      throw error;
    }
    return 'applied';
  }

  /**
   * D6 "connected SSO accounts": the identities linked to the person (`read:users`). Only
   * the provider and connection names leave this method — never a provider's token or
   * profile. Null when the Management API is not configured.
   */
  async identities(sub: string): Promise<Array<{ provider: string; connection: string }> | null> {
    if (!this.configured) return null;
    const body = (await this.call('GET', `/api/v2/users/${encodeURIComponent(sub)}?fields=identities&include_fields=true`)) as { identities?: unknown[] };
    return (body.identities ?? []).flatMap((raw) => {
      const identity = raw as { provider?: unknown; connection?: unknown };
      return typeof identity.provider === 'string' && typeof identity.connection === 'string' ? [{ provider: identity.provider, connection: identity.connection }] : [];
    });
  }

  /** Removes every enrolled authenticator; the next sign-in enrols afresh (A5). */
  async resetMfa(sub: string): Promise<'applied' | 'skipped'> {
    if (!this.configured) return 'skipped';
    await this.call('DELETE', `/api/v2/users/${encodeURIComponent(sub)}/authenticators`);
    return 'applied';
  }

  /**
   * Ends every session and refresh token. An access token already minted stays valid for
   * its lifetime (an hour at most); the SA3 lock is what refuses it sooner.
   */
  async revokeSessions(sub: string): Promise<'applied' | 'skipped'> {
    if (!this.configured) return 'skipped';
    await this.call('DELETE', `/api/v2/users/${encodeURIComponent(sub)}/sessions`);
    await this.call('DELETE', `/api/v2/users/${encodeURIComponent(sub)}/refresh-tokens`);
    return 'applied';
  }

  /**
   * A2 "Resend" (ADR 0036 §8): Auth0 mails a fresh verification link
   * (`POST /api/v2/jobs/verification-email`, `update:users`). The rate limits are ours and
   * are checked before this is called.
   */
  async sendVerificationEmail(sub: string): Promise<'applied' | 'skipped'> {
    if (!this.configured) return 'skipped';
    await this.call('POST', '/api/v2/jobs/verification-email', { user_id: sub });
    return 'applied';
  }

  /**
   * "Remember this device" ends (ADR 0036 §4): every browser that skipped the second
   * factor for 30 days is asked for it again at its next sign-in
   * (`invalidate-remember-browser`, `update:users`). Run after a password change, a staff
   * MFA reset or lock, and when the person signs out everywhere.
   */
  async forgetRememberedDevices(sub: string): Promise<'applied' | 'skipped'> {
    if (!this.configured) return 'skipped';
    await this.call('POST', `/api/v2/users/${encodeURIComponent(sub)}/multifactor/actions/invalidate-remember-browser`, {});
    return 'applied';
  }

  /**
   * §6.2 Settings → Security: the person's own sign-in sessions (`read:sessions`). Null when
   * the Management API is not configured — the portal says so rather than showing none.
   */
  async listSessions(sub: string): Promise<ProviderSession[] | null> {
    if (!this.configured) return null;
    const body = (await this.call('GET', `/api/v2/users/${encodeURIComponent(sub)}/sessions`)) as { sessions?: unknown[] };
    return (body.sessions ?? []).map(toSession).filter((s): s is ProviderSession => s !== null);
  }

  /**
   * Ends one of the person's sessions and revokes the refresh tokens issued in it, so the
   * device cannot quietly mint a new access token (`read:sessions`, `delete:sessions`,
   * `read:refresh_tokens`, `delete:refresh_tokens`). A session that is not `sub`'s — or no
   * longer exists — is `not_found`: one person never ends another's session by its id.
   */
  async endSession(sub: string, sessionId: string): Promise<{ outcome: 'ended' | 'not_found' | 'skipped'; refreshTokensRevoked: number }> {
    if (!this.configured) return { outcome: 'skipped', refreshTokensRevoked: 0 };
    let owner: string | null;
    try {
      owner = ((await this.call('GET', `/api/v2/sessions/${encodeURIComponent(sessionId)}`)) as { user_id?: string }).user_id ?? null;
    } catch (error) {
      if (error instanceof Auth0NotFound) return { outcome: 'not_found', refreshTokensRevoked: 0 };
      throw error;
    }
    if (owner !== sub) return { outcome: 'not_found', refreshTokensRevoked: 0 };
    await this.call('DELETE', `/api/v2/sessions/${encodeURIComponent(sessionId)}`);
    const tokens = ((await this.call('GET', `/api/v2/users/${encodeURIComponent(sub)}/refresh-tokens`)) as { tokens?: Array<{ id?: string; session_id?: string }> }).tokens ?? [];
    let revoked = 0;
    for (const token of tokens)
      if (token.id && token.session_id === sessionId) {
        await this.call('DELETE', `/api/v2/refresh-tokens/${encodeURIComponent(token.id)}`);
        revoked++;
      }
    return { outcome: 'ended', refreshTokensRevoked: revoked };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await withTimeout(TOKEN_TIMEOUT_MS, () =>
      fetch(`https://${this.domain}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          audience: `https://${this.domain}/api/v2/`,
        }),
      }),
    );
    if (!res.ok) throw new Error(`Auth0 token endpoint answered ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.accessToken();
    const res = await withTimeout(CALL_TIMEOUT_MS, () =>
      fetch(`https://${this.domain}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    if (res.status === 204) return {};
    const text = await res.text();
    if (res.status === 404) throw new Auth0NotFound(`Auth0 ${method} ${path} answered 404`);
    if (!res.ok) {
      this.log.warn(`Auth0 ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`);
      throw new Error(`Auth0 Management API answered ${res.status}`);
    }
    return text ? JSON.parse(text) : {};
  }
}

/** The provider's dates come as ISO strings; anything else is unknown, never a guess. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export function toSession(raw: unknown): ProviderSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as { id?: unknown; created_at?: unknown; last_interacted_at?: unknown; updated_at?: unknown; expires_at?: unknown; idle_expires_at?: unknown; device?: Record<string, unknown> };
  if (typeof s.id !== 'string') return null;
  const device = s.device ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    id: s.id,
    created_at: isoOrNull(s.created_at),
    last_active_at: isoOrNull(s.last_interacted_at) ?? isoOrNull(s.updated_at),
    expires_at: isoOrNull(s.expires_at) ?? isoOrNull(s.idle_expires_at),
    user_agent: str(device.last_user_agent) ?? str(device.initial_user_agent),
    ip: str(device.last_ip) ?? str(device.initial_ip),
  };
}
