export { RedisModule } from './redis.module';
export { RedisCache, REDIS, DEFAULT_REDIS_TIMEOUT_MS } from './redis-cache.service';
export type { ScanResult } from './redis-cache.service';
export { redisKeys, workspaceOfActiveKey } from './redis.keys';
export { createRedisClient, waitForRedis, closeRedis, InMemoryRedis } from './redis.client';
export type { RedisLike } from './redis.client';
