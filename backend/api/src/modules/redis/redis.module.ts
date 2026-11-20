import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { closeRedis, createRedisClient } from './redis.client';
import { REDIS, RedisCache } from './redis-cache.service';

/**
 * One Redis connection for the process, exposed two ways:
 *
 *   REDIS        the raw ioredis client — BullMQ, pub/sub and the inbound path (D4)
 *   RedisCache   the safe, bounded cache wrapper everything else uses
 *
 * Global because every feature module caches something and none of them should have to
 * know how the client is built.
 */
@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: () => createRedisClient(process.env.REDIS_URL) },
    RedisCache,
  ],
  exports: [REDIS, RedisCache],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.client);
  }
}
