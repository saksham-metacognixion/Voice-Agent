import Fastify, { type FastifyInstance } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  budgetVerdict,
  originVerdict,
  rateLimitPerMinute,
  registerRequestLimits,
} from './request-limits';

const ENV = {
  PORTAL_URL: 'https://app-staging.oraly.ai',
  ADMIN_URL: 'https://admin-staging.oraly.ai/',
} as NodeJS.ProcessEnv;

describe('originVerdict (§6.2 CSRF)', () => {
  const allowed = new Set(['https://app-staging.oraly.ai', 'https://admin-staging.oraly.ai']);

  it('refuses a state-changing request from a foreign origin', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(originVerdict(method, '/agents', 'https://evil.example', allowed)).toEqual({
        allow: false,
        code: 'ORIGIN_NOT_ALLOWED',
      });
    }
  });

  it('allows reads, the portal and the console, and a request with no Origin', () => {
    expect(originVerdict('GET', '/agents', 'https://evil.example', allowed).allow).toBe(true);
    expect(originVerdict('POST', '/agents', 'https://APP-staging.oraly.ai/', allowed).allow).toBe(
      true,
    );
    expect(
      originVerdict('POST', '/admin/flags', 'https://admin-staging.oraly.ai', allowed).allow,
    ).toBe(true);
    expect(originVerdict('POST', '/agents', undefined, allowed).allow).toBe(true);
  });

  it('never checks the webhooks', () => {
    expect(originVerdict('POST', '/webhooks/stripe', 'https://evil.example', allowed).allow).toBe(
      true,
    );
  });
});

describe('budgetVerdict', () => {
  it('allows up to the limit and refuses after it, with the seconds left in the window', () => {
    expect(budgetVerdict(600, 600, 0).allow).toBe(true);
    expect(budgetVerdict(601, 600, 45_000)).toEqual({
      allow: false,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 15,
    });
  });

  it('fails open when Redis did not answer, and a limit of 0 is off', () => {
    expect(budgetVerdict(null, 600, 0).allow).toBe(true);
    expect(budgetVerdict(10_000, 0, 0).allow).toBe(true);
  });

  it('reads API_RATE_LIMIT_PER_MIN, defaulting on garbage', () => {
    expect(rateLimitPerMinute({} as NodeJS.ProcessEnv)).toBe(600);
    expect(rateLimitPerMinute({ API_RATE_LIMIT_PER_MIN: '30' } as NodeJS.ProcessEnv)).toBe(30);
    expect(rateLimitPerMinute({ API_RATE_LIMIT_PER_MIN: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(rateLimitPerMinute({ API_RATE_LIMIT_PER_MIN: 'lots' } as NodeJS.ProcessEnv)).toBe(600);
  });
});

describe('registerRequestLimits on a real Fastify instance', () => {
  let server: FastifyInstance;
  afterEach(() => server?.close());

  function boot(env: NodeJS.ProcessEnv, counter: { redisDown?: boolean } = {}) {
    server = Fastify();
    const counts = new Map<string, number>();
    const app = {
      getHttpAdapter: () => ({ getInstance: () => server }),
    } as unknown as NestFastifyApplication;
    registerRequestLimits(
      app,
      {
        increment: async (key) => {
          if (counter.redisDown) return null;
          const next = (counts.get(key) ?? 0) + 1;
          counts.set(key, next);
          return next;
        },
        windowKey: (ip, window) => `ratelimit:api:${ip}:${window}`,
        now: () => 30_000,
      },
      env,
    );
    for (const method of ['GET', 'POST'] as const) {
      server.route({ method, url: '/agents', handler: async () => ({ ok: true }) });
      server.route({ method, url: '/webhooks/retell', handler: async () => ({ ok: true }) });
    }
    server.get('/health', async () => ({ ok: true }));
    return server;
  }

  it('answers 403 ORIGIN_NOT_ALLOWED to a foreign POST and lets the portal through', async () => {
    boot(ENV);
    const foreign = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    const portal = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: { origin: 'https://app-staging.oraly.ai' },
    });
    expect(portal.statusCode).toBe(200);
  });

  it('answers 429 RATE_LIMITED with Retry-After and CORS headers once the minute is spent', async () => {
    boot({ ...ENV, API_RATE_LIMIT_PER_MIN: '3' });
    const origin = 'https://app-staging.oraly.ai';
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await server.inject({ method: 'GET', url: '/agents', headers: { origin } })).statusCode,
      ).toBe(200);
    }
    const limited = await server.inject({ method: 'GET', url: '/agents', headers: { origin } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers['retry-after']).toBe('30');
    expect(limited.headers['access-control-allow-origin']).toBe(origin);
  });

  it('never limits or origin-checks the webhooks and health', async () => {
    boot({ ...ENV, API_RATE_LIMIT_PER_MIN: '1' });
    for (let i = 0; i < 5; i += 1) {
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/webhooks/retell',
            headers: { origin: 'https://evil.example' },
          })
        ).statusCode,
      ).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
  });

  it('fails open when Redis is down', async () => {
    boot({ ...ENV, API_RATE_LIMIT_PER_MIN: '1' }, { redisDown: true });
    for (let i = 0; i < 5; i += 1) {
      expect((await server.inject({ method: 'GET', url: '/agents' })).statusCode).toBe(200);
    }
  });
});
