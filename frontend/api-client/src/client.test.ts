import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient, isApiError } from './client';

/*
 * ADR 0036 §1: the API refuses a customer token older than 15 minutes with
 * `401 TOKEN_EXPIRED`. The client answers that by asking for a freshly minted token and
 * sending the request once more — never by signing the person out — and treats a second
 * refusal, or any other 401, as a lost session.
 */
function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createApiClient and an expired token', () => {
  it('re-mints and retries once on TOKEN_EXPIRED', async () => {
    const getToken = vi.fn(async (o?: { fresh?: boolean }) => (o?.fresh ? 'fresh' : 'stale'));
    const onUnauthorized = vi.fn();
    const seen: string[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization!;
      seen.push(auth);
      return auth === 'Bearer stale' ? respond(401, { code: 'TOKEN_EXPIRED', message: 'x' }) : respond(200, { ok: true });
    });
    const api = createApiClient({ baseUrl: 'http://api.test', getToken, getWorkspaceId: () => null, onUnauthorized, fetch: fetch as never });

    await expect(api.get('/me', z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
    expect(seen).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(getToken).toHaveBeenLastCalledWith({ fresh: true });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('a second TOKEN_EXPIRED is a lost session', async () => {
    const onUnauthorized = vi.fn();
    const fetch = vi.fn(async () => respond(401, { code: 'TOKEN_EXPIRED', message: 'x' }));
    const api = createApiClient({ baseUrl: 'http://api.test', getToken: async () => 't', getWorkspaceId: () => null, onUnauthorized, fetch: fetch as never });

    const error = await api.get('/me', z.unknown()).catch((e: unknown) => e);
    expect(isApiError(error, 'TOKEN_EXPIRED')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('any other 401 signs out at once, with no retry', async () => {
    const onUnauthorized = vi.fn();
    const fetch = vi.fn(async () => respond(401, { code: 'INVALID_TOKEN', message: 'x' }));
    const api = createApiClient({ baseUrl: 'http://api.test', getToken: async () => 't', getWorkspaceId: () => null, onUnauthorized, fetch: fetch as never });

    await expect(api.post('/x', {}, z.unknown())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
