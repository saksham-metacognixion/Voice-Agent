import { Inject, Injectable, Logger } from '@nestjs/common';
import { withTimeout } from '../../common/timeout';
import type { RedisLike } from './redis.client';

export const REDIS = Symbol('REDIS');

/** Default budget for a cache round trip. The inbound path passes its own 150 ms. */
export const DEFAULT_REDIS_TIMEOUT_MS = 500;

/** What `scanKeys` found, and whether it walked the whole keyspace before stopping. */
export interface ScanResult {
  keys: string[];
  complete: boolean;
}

/**
 * Redis as a cache that can be missing.
 *
 * Every method here is *safe*: it never throws and never waits longer than its budget.
 * A failed read is a miss, a failed write is a no-op, a failed invalidation is logged —
 * because everything cached here (balance, pricing, flags, caps) has Postgres as its
 * truth and a caller can always fall back to it. The one place that cannot fall back to
 * Postgres is the §13.9 inbound path, and its policy on a miss is written down in
 * ADR 0003 §12, not here.
 *
 * What this is *not*: a wrapper for BullMQ or pub/sub (D4). Those need the raw client
 * and their own failure semantics.
 */
/** Compare-and-delete: `DEL key` only while it still holds `ARGV[1]`. 1 when this call deleted it. */
export const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

@Injectable()
export class RedisCache {
  private readonly log = new Logger(RedisCache.name);
  private warnedDown = false;

  constructor(@Inject(REDIS) readonly client: RedisLike) {}

  async get(key: string, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<string | null> {
    return this.attempt(`GET ${key}`, () => this.client.get(key), timeoutMs, null);
  }

  async getJson<T>(key: string, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<T | null> {
    const raw = await this.get(key, timeoutMs);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt entry is treated as a miss and dropped so it cannot poison later reads.
      this.log.warn(`${key} held invalid JSON; dropping it`);
      void this.del(key);
      return null;
    }
  }

  /** Returns true when the write landed. `ttlSeconds` omitted = no expiry. */
  async set(key: string, value: string, ttlSeconds?: number, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<boolean> {
    const write = ttlSeconds ? () => this.client.set(key, value, 'EX', ttlSeconds) : () => this.client.set(key, value);
    return this.attempt(`SET ${key}`, async () => (await write(), true), timeoutMs, false);
  }

  /**
   * Writes only when the key is absent (`SET … NX`). True when this call filled it. For a
   * reader that rebuilt a value *outside* the lock that orders the writers: it may fill a
   * miss, but it must never overwrite what a writer published after the reader's read.
   */
  async setIfAbsent(key: string, value: string, ttlSeconds: number, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<boolean> {
    return this.attempt(`SET NX ${key}`, async () => (await this.client.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK', timeoutMs, false);
  }

  /**
   * A fixed-window counter: `SET key 0 EX ttl NX` then `INCR`. The window starts with the
   * first write and is never pushed out by later ones — `SET … EX` on every increment would
   * make a sliding window that never expires while writes keep coming. Two commands, so a
   * crash between them leaves a `0` that expires on its own, never a counter with no TTL.
   * Null when Redis did not answer: the caller decides whether that means allow.
   */
  async increment(key: string, ttlSeconds: number, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<number | null> {
    return this.attempt(
      `INCR ${key}`,
      async () => {
        await this.client.set(key, '0', 'EX', ttlSeconds, 'NX');
        return this.client.incr(key);
      },
      timeoutMs,
      null,
    );
  }

  setJson(key: string, value: unknown, ttlSeconds?: number, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<boolean> {
    return this.set(key, JSON.stringify(value), ttlSeconds, timeoutMs);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.attempt(`DEL ${keys.join(' ')}`, () => this.client.del(...keys), DEFAULT_REDIS_TIMEOUT_MS, 0);
  }

  /**
   * Deletes every key matching `pattern` with SCAN, never KEYS: KEYS blocks the server for
   * the whole keyspace, and the inbound path shares this Redis.
   */
  async delPattern(pattern: string, timeoutMs = 2_000): Promise<number> {
    return this.attempt(
      `DEL ${pattern}`,
      async () => {
        let cursor = '0';
        let deleted = 0;
        do {
          const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
          cursor = next;
          if (keys.length) deleted += await this.client.del(...keys);
        } while (cursor !== '0');
        return deleted;
      },
      timeoutMs,
      0,
    );
  }

  /**
   * Every key matching `pattern`, with SCAN (never KEYS — the inbound path shares this
   * Redis). `null` when Redis did not answer inside the budget, and `complete: false`
   * when the walk stopped at `limit`. Neither is "no keys": a caller that infers state
   * from a key's *absence* (the concurrency monitor resolving alerts for workspaces whose
   * hash is gone) must treat both as unknown and resolve nothing.
   */
  async scanKeys(pattern: string, timeoutMs = 2_000, limit = 10_000): Promise<ScanResult | null> {
    return this.attempt(
      `SCAN ${pattern}`,
      async () => {
        let cursor = '0';
        const found: string[] = [];
        do {
          const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
          cursor = next;
          found.push(...keys);
        } while (cursor !== '0' && found.length < limit);
        return { keys: found, complete: cursor === '0' };
      },
      timeoutMs,
      null,
    );
  }

  /**
   * `SET NX` a lock for `ttlSeconds`. True when this caller holds it. Redis down reads as
   * "not acquired": a D7 schedule that cannot prove it is alone does not run.
   */
  acquireLock(key: string, token: string, ttlSeconds: number, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<boolean> {
    return this.setIfAbsent(key, token, ttlSeconds, timeoutMs);
  }

  /** Releases a lock only while it still holds `token`, so a run that overran its TTL cannot free the next holder's lock. */
  async releaseLock(key: string, token: string): Promise<boolean> {
    return this.attempt(
      `DEL lock ${key}`,
      async () => {
        if (this.client.eval) {
          const freed = await this.client.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
          return freed === 1;
        }
        // InMemoryRedis has no Lua: compare-and-delete in two steps, which is exact for one process.
        if ((await this.client.get(key)) !== token) return false;
        await this.client.del(key);
        return true;
      },
      DEFAULT_REDIS_TIMEOUT_MS,
      false,
    );
  }

  /** Read-through: cached JSON, else `load()` and cache the result for `ttlSeconds`. */
  async remember<T>(key: string, ttlSeconds: number, load: () => Promise<T>, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<{ value: T; hit: boolean }> {
    const cached = await this.getJson<T>(key, timeoutMs);
    if (cached !== null) return { value: cached, hit: true };
    const value = await load();
    await this.setJson(key, value, ttlSeconds, timeoutMs);
    return { value, hit: false };
  }

  async ping(timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<boolean> {
    return this.attempt('PING', async () => (await this.client.ping()) === 'PONG', timeoutMs, false);
  }

  private async attempt<T>(what: string, run: () => Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    try {
      const result = await withTimeout(timeoutMs, () => run());
      this.warnedDown = false;
      return result;
    } catch (error) {
      // One warning per outage, not one per request: the inbound path can see hundreds.
      if (!this.warnedDown) {
        this.log.warn(`redis unavailable (${what}: ${error instanceof Error ? error.message : String(error)}); falling back`);
        this.warnedDown = true;
      }
      return fallback;
    }
  }
}
