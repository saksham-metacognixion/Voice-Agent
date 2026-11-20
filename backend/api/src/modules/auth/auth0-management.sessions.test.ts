import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth0ManagementService, toSession } from './auth0-management.service';

const ENV = { AUTH0_CUSTOMER_DOMAIN: 'tenant.example.auth0.com', AUTH0_CUSTOMER_M2M_CLIENT_ID: 'id', AUTH0_CUSTOMER_M2M_CLIENT_SECRET: 'secret' };
const ME = 'auth0|me';

/** A Management API that answers by method and path, and records what was asked. */
function fakeAuth0(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { method?: string } = {}) => {
    const path = new URL(url).pathname;
    const key = `${init.method ?? 'GET'} ${decodeURIComponent(path)}`;
    calls.push(key);
    if (path === '/oauth/token') return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    const route = routes[key];
    if (!route) return new Response('{}', { status: 404 });
    if (route.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('Auth0ManagementService sessions (§6.2)', () => {
  it('ends only the caller’s own session, and revokes only that session’s refresh tokens', async () => {
    const calls = fakeAuth0({
      'GET /api/v2/sessions/s1': { body: { id: 's1', user_id: ME } },
      'DELETE /api/v2/sessions/s1': { status: 204 },
      [`GET /api/v2/users/${ME}/refresh-tokens`]: { body: { tokens: [{ id: 'rt1', session_id: 's1' }, { id: 'rt2', session_id: 's2' }] } },
      'DELETE /api/v2/refresh-tokens/rt1': { status: 204 },
    });
    const result = await new Auth0ManagementService(ENV).endSession(ME, 's1');
    expect(result).toEqual({ outcome: 'ended', refreshTokensRevoked: 1 });
    expect(calls).toContain('DELETE /api/v2/refresh-tokens/rt1');
    expect(calls).not.toContain('DELETE /api/v2/refresh-tokens/rt2');
  });

  it('answers not_found for somebody else’s session and deletes nothing', async () => {
    const calls = fakeAuth0({ 'GET /api/v2/sessions/theirs': { body: { id: 'theirs', user_id: 'auth0|someone-else' } } });
    expect(await new Auth0ManagementService(ENV).endSession(ME, 'theirs')).toEqual({ outcome: 'not_found', refreshTokensRevoked: 0 });
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
  });

  it('answers not_found for a session the provider no longer has', async () => {
    fakeAuth0({});
    expect((await new Auth0ManagementService(ENV).endSession(ME, 'gone')).outcome).toBe('not_found');
  });

  it('is skipped, not an error, where the Management API is not configured', async () => {
    const svc = new Auth0ManagementService({});
    expect(await svc.listSessions(ME)).toBeNull();
    expect(await svc.endSession(ME, 's1')).toEqual({ outcome: 'skipped', refreshTokensRevoked: 0 });
  });
});

describe('toSession', () => {
  it('keeps the device and the times, prefers the last seen over the first, and drops a row without an id', () => {
    expect(
      toSession({
        id: 's1',
        created_at: '2026-10-01T10:00:00.000Z',
        last_interacted_at: '2026-10-28T09:00:00.000Z',
        expires_at: 'not a date',
        idle_expires_at: '2026-11-01T00:00:00.000Z',
        device: { initial_user_agent: 'old', last_user_agent: 'Mozilla/5.0 (Macintosh) Chrome/130', initial_ip: '1.1.1.1', last_ip: '2.2.2.2' },
      }),
    ).toEqual({ id: 's1', created_at: '2026-10-01T10:00:00.000Z', last_active_at: '2026-10-28T09:00:00.000Z', expires_at: '2026-11-01T00:00:00.000Z', user_agent: 'Mozilla/5.0 (Macintosh) Chrome/130', ip: '2.2.2.2' });
    expect(toSession({ device: {} })).toBeNull();
  });
});
