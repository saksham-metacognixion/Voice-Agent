import { describe, expect, it } from 'vitest';
import { InMemoryRedis } from './redis.client';
import { RedisCache } from './redis-cache.service';

describe('RedisCache', () => {
  it('reads through and caches on a miss, then serves the hit', async () => {
    const redis = new InMemoryRedis();
    const cache = new RedisCache(redis);
    let loads = 0;
    const load = async () => ({ n: ++loads });

    expect(await cache.remember('k', 60, load)).toEqual({ value: { n: 1 }, hit: false });
    expect(await cache.remember('k', 60, load)).toEqual({ value: { n: 1 }, hit: true });
    expect(loads).toBe(1);
  });

  it('treats a Redis outage as a miss and never throws', async () => {
    const redis = new InMemoryRedis();
    redis.down = true;
    const cache = new RedisCache(redis);

    await expect(cache.get('k')).resolves.toBeNull();
    await expect(cache.set('k', 'v', 10)).resolves.toBe(false);
    await expect(cache.del('k')).resolves.toBe(0);
    await expect(cache.delPattern('flags:*')).resolves.toBe(0);
    const out = await cache.remember('k', 60, async () => 'from-db');
    expect(out).toEqual({ value: 'from-db', hit: false });
  });

  it('bounds a slow Redis by the timeout and falls back', async () => {
    const slow = {
      get: () => new Promise<string | null>(() => undefined),
    } as unknown as InMemoryRedis;
    const cache = new RedisCache(slow);
    const started = Date.now();
    await expect(cache.get('k', 50)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('drops a corrupt JSON entry instead of returning it', async () => {
    const redis = new InMemoryRedis();
    await redis.set('k', '{not json');
    const cache = new RedisCache(redis);
    expect(await cache.getJson('k')).toBeNull();
    expect(redis.keys()).not.toContain('k');
  });

  it('deletes by pattern with SCAN', async () => {
    const redis = new InMemoryRedis();
    const cache = new RedisCache(redis);
    await cache.set('flags:global', '1');
    await cache.set('flags:{ws-1}', '1');
    await cache.set('caps:{ws-1}', '1');
    expect(await cache.delPattern('flags:*')).toBe(2);
    expect(redis.keys()).toEqual(['caps:{ws-1}']);
  });
});
