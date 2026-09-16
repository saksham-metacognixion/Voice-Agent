import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * The commands the cache wrapper needs. Narrower than ioredis so tests can hand in
 * `InMemoryRedis` and so the wrapper never grows a dependency on a command that the
 * inbound hot path could not afford.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  /** `SET key value EX seconds NX` — 'OK' when written, null when the key already existed. */
  set(key: string, value: string, mode: 'EX', seconds: number, condition: 'NX'): Promise<'OK' | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  scan(cursor: string, matchToken: 'MATCH', pattern: string, countToken: 'COUNT', count: number): Promise<[string, string[]]>;
  /** `active:{ws}` is a hash: one field per live call (redis.keys.ts). */
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<number>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  /** SSE fan-out (modules/events). Returns the number of subscribers that received it. */
  publish(channel: string, message: string): Promise<number>;
  /**
   * Optional: the §13.9 check-and-reserve runs as one atomic script (reserve.script.ts).
   * Optional because `InMemoryRedis` has no Lua interpreter — a caller that does not find
   * it falls back to a plain HSET, which is correct for one process and is exactly what a
   * unit test is.
   */
  eval?(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

/**
 * One ioredis client per process, built from REDIS_URL.
 *
 * `lazyConnect` so a process without Redis still boots — the connection is kicked off
 * here without being awaited, and a failure is a warning, not a crash. `enableOfflineQueue:
 * false` and one retry per request so a Redis outage surfaces as a fast error the callers
 * can bound with a timeout — never as a request that hangs until Retell has given up
 * (ADR 0003 §12). The price of that choice is that a command issued in the first few
 * milliseconds after boot, before the socket is ready, fails fast and RedisCache treats it
 * as a miss; that is the intended trade.
 */
export function createRedisClient(url: string | undefined, logger = new Logger('Redis')): Redis {
  if (!url) {
    throw new Error('REDIS_URL is not set. Copy .env.example to .env; see the redis section.');
  }
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  client.on('error', (error: Error) => logger.warn(`redis: ${error.message}`));
  client.on('ready', () => logger.log('redis ready'));
  // Start connecting now so the first real command finds an open socket, but do not
  // block boot on it: health, auth and the Stripe webhook must come up without Redis.
  client.connect().catch((error: Error) => logger.warn(`redis connect: ${error.message}`));
  return client;
}

/**
 * Waits until the client's socket is open, or gives up after `timeoutMs`.
 *
 * A long-lived process never needs this: by the time a request arrives the socket is up,
 * and a command that lands in the gap is a cache miss the caller already handles. A
 * short-lived script does need it — every command it issues is inside that gap, so
 * without this it runs entirely uncached and prints a warning per read. Resolves false
 * rather than throwing: a script that cannot reach Redis should still do its work.
 */
export async function waitForRedis(client: Redis, timeoutMs = 2_000): Promise<boolean> {
  if (client.status === 'ready') return true;
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('error', onError);
      resolve(ok);
    };
    const onReady = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    client.once('ready', onReady);
    client.once('error', onError);
  });
}

/** Closes a client that may never have connected. Never throws. */
export async function closeRedis(client: Redis): Promise<void> {
  try {
    if (client.status === 'ready') await client.quit();
    else client.disconnect();
  } catch {
    client.disconnect();
  }
}

/**
 * Enough of Redis for the unit tests: a Map with EX expiry and MATCH/COUNT scan. Not a
 * fake to grow; anything the code needs that this lacks belongs in the RedisLike interface
 * first.
 */
export class InMemoryRedis implements RedisLike {
  private readonly store = new Map<string, { value: string; expiresAt?: number }>();
  private readonly hashes = new Map<string, { fields: Map<string, string>; expiresAt?: number }>();
  /** Every PUBLISH, in order, for the SSE tests. */
  published: Array<{ channel: string; message: string }> = [];
  /** Set to true to make every command throw, for the "Redis is down" paths. */
  down = false;
  calls: string[] = [];

  private guard(command: string): void {
    this.calls.push(command);
    if (this.down) throw new Error('ECONNREFUSED (InMemoryRedis.down)');
  }

  private live(key: string): { value: string; expiresAt?: number } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    this.guard('get');
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, mode?: 'EX', seconds?: number): Promise<'OK'> {
    this.guard('set');
    this.store.set(key, {
      value,
      ...(mode === 'EX' && seconds ? { expiresAt: Date.now() + seconds * 1000 } : {}),
    });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    this.guard('del');
    let n = 0;
    for (const key of keys) {
      if (this.store.delete(key)) n += 1;
      if (this.hashes.delete(key)) n += 1;
    }
    return n;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.guard('mget');
    return keys.map((key) => this.live(key)?.value ?? null);
  }

  private liveHash(key: string): { fields: Map<string, string>; expiresAt?: number } | undefined {
    const entry = this.hashes.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.hashes.delete(key);
      return undefined;
    }
    return entry;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.guard('hgetall');
    return Object.fromEntries(this.liveHash(key)?.fields ?? []);
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.guard('hset');
    const entry = this.liveHash(key) ?? { fields: new Map<string, string>() };
    const added = entry.fields.has(field) ? 0 : 1;
    entry.fields.set(field, value);
    this.hashes.set(key, entry);
    return added;
  }

  async hsetnx(key: string, field: string, value: string): Promise<number> {
    this.guard('hsetnx');
    const entry = this.liveHash(key) ?? { fields: new Map<string, string>() };
    if (entry.fields.has(field)) return 0;
    entry.fields.set(field, value);
    this.hashes.set(key, entry);
    return 1;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    this.guard('hdel');
    const entry = this.liveHash(key);
    if (!entry) return 0;
    let n = 0;
    for (const field of fields) if (entry.fields.delete(field)) n += 1;
    if (entry.fields.size === 0) this.hashes.delete(key);
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.guard('expire');
    const hash = this.liveHash(key);
    if (hash) {
      hash.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }
    const plain = this.live(key);
    if (plain) {
      plain.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }
    return 0;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.guard('publish');
    this.published.push({ channel, message });
    return 0;
  }

  async scan(_cursor: string, _m: 'MATCH', pattern: string): Promise<[string, string[]]> {
    this.guard('scan');
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return ['0', [...this.store.keys()].filter((k) => re.test(k) && this.live(k))];
  }

  async ping(): Promise<string> {
    this.guard('ping');
    return 'PONG';
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  /** Test helper. */
  keys(): string[] {
    return [...[...this.store.keys()].filter((k) => this.live(k)), ...[...this.hashes.keys()].filter((k) => this.liveHash(k))];
  }
}
