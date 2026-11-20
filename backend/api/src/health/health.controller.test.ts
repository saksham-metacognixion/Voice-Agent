import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { InMemoryRedis, RedisCache, redisKeys } from '../modules/redis';
import { HealthController } from './health.controller';

function controller(redis = new InMemoryRedis()) {
  return Test.createTestingModule({ controllers: [HealthController], providers: [{ provide: RedisCache, useValue: new RedisCache(redis) }] }).compile();
}

describe('HealthController', () => {
  it('returns ok', async () => {
    const mod = await controller();
    const res = mod.get(HealthController).get();
    expect(res.status).toBe('ok');
    expect(res.service).toBe('api');
  });

  it('reads the worker heartbeat from Redis and calls a stale one out', async () => {
    const redis = new InMemoryRedis();
    const mod = await controller(redis);
    const health = mod.get(HealthController);
    // Private probe, reached through the class so the readiness shape is tested without Postgres.
    const probe = (health as unknown as { probeWorker: () => Promise<{ ok: boolean; detail: string | null; schedulers: number | null }> }).probeWorker.bind(health);

    expect(await probe()).toMatchObject({ ok: false, detail: 'no heartbeat', schedulers: null });

    await redis.set(redisKeys.workerHeartbeat, JSON.stringify({ at: new Date().toISOString(), pid: 1, host: 'w', env: 'dev', schedulers: 13, queues: [] }), 'EX', 120);
    expect(await probe()).toMatchObject({ ok: true, detail: null, schedulers: 13 });

    await redis.set(redisKeys.workerHeartbeat, JSON.stringify({ at: new Date(Date.now() - 10 * 60_000).toISOString(), pid: 1, host: 'w', env: 'dev', schedulers: 13, queues: [] }), 'EX', 120);
    const stale = await probe();
    expect(stale.ok).toBe(false);
    expect(stale.detail).toMatch(/last heartbeat \d+ s ago/);
  });
});
