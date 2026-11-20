import type { ConnectionOptions } from 'bullmq';
import { resolveAppEnv } from '../../common/env';

/**
 * BullMQ opens its own connections (a blocking one per Worker), so it gets options, not
 * the shared client from RedisModule. `maxRetriesPerRequest: null` is what BullMQ
 * requires for its blocking commands; without it a Worker refuses to start.
 *
 * Producers additionally disable the offline queue so `queue.add()` from the inbound hot
 * path fails fast while Redis is down instead of buffering until Retell has given up —
 * JobQueues bounds the call with a timeout as well (ADR 0003 §12).
 */
export function bullConnection(url: string | undefined, role: 'producer' | 'worker'): ConnectionOptions {
  if (!url) throw new Error('REDIS_URL is not set. Copy .env.example to .env; see the redis section.');
  const parsed = new URL(url);
  const db = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: db ? Number(db) : undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    // BullMQ builds its own ioredis client from these; `RedisOptions` here is BullMQ's
    // structural type, not ioredis', which is why it is imported from bullmq.
    maxRetriesPerRequest: null,
    enableOfflineQueue: role === 'worker',
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  };
}

/**
 * Key prefix for every BullMQ structure. Per environment, so a dev API and the e2e suite
 * sharing one local Redis never consume each other's jobs; the e2e config overrides it.
 */
export function bullPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return env.BULLMQ_PREFIX?.trim() || `portal:${resolveAppEnv(env)}`;
}
