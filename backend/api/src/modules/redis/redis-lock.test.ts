import { describe, expect, it } from 'vitest';
import { InMemoryRedis } from './redis.client';
import { RedisCache } from './redis-cache.service';
import { redisKeys, workspaceOfActiveKey } from './redis.keys';

describe('schedule locks (D7)', () => {
  it('lets exactly one holder in, and releases only for the token that holds it', async () => {
    const cache = new RedisCache(new InMemoryRedis());
    const key = redisKeys.scheduleLock('number-rental');
    expect(await cache.acquireLock(key, 'worker-a', 60)).toBe(true);
    expect(await cache.acquireLock(key, 'worker-b', 60)).toBe(false);
    // A stale holder cannot free a lock it no longer owns.
    expect(await cache.releaseLock(key, 'worker-b')).toBe(false);
    expect(await cache.acquireLock(key, 'worker-b', 60)).toBe(false);
    expect(await cache.releaseLock(key, 'worker-a')).toBe(true);
    expect(await cache.acquireLock(key, 'worker-b', 60)).toBe(true);
  });

  it('reads Redis-down as "not acquired", so a tick that cannot prove it is alone does not run', async () => {
    const redis = new InMemoryRedis();
    redis.down = true;
    const cache = new RedisCache(redis);
    expect(await cache.acquireLock(redisKeys.scheduleLock('x'), 't', 60)).toBe(false);
    // A scan that could not run is unknown, never an empty keyspace.
    expect(await cache.scanKeys('active:*')).toBeNull();
  });

  it('scans keys by pattern and parses the workspace out of an active-calls key', async () => {
    const redis = new InMemoryRedis();
    const cache = new RedisCache(redis);
    const ws = '11111111-2222-3333-4444-555555555555';
    await redis.hset(redisKeys.activeCalls(ws), 'call_1', '5|999999999999999');
    await redis.set('bal:{x}', '1');
    const scan = await cache.scanKeys(redisKeys.activeCallsPattern);
    expect(scan).toEqual({ keys: [redisKeys.activeCalls(ws)], complete: true });
    expect(workspaceOfActiveKey(scan!.keys[0]!)).toBe(ws);
    expect(workspaceOfActiveKey('active:{nope}')).toBeNull();
    expect(workspaceOfActiveKey('bal:{x}')).toBeNull();
  });
});
