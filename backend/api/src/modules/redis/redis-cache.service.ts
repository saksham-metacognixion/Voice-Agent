import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RedisLike } from './redis.client';

export const REDIS = Symbol('REDIS');

/** Default budget for a cache round trip. The inbound path passes its own 150 ms. */
export const DEFAULT_REDIS_TIMEOUT_MS = 500;

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
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      this.warnedDown = false;
      return result;
    } catch (error) {
      // One warning per outage, not one per request: the inbound path can see hundreds.
      if (!this.warnedDown) {
        this.log.warn(`redis unavailable (${what}: ${error instanceof Error ? error.message : String(error)}); falling back`);
        this.warnedDown = true;
      }
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
