import { Global, Module } from '@nestjs/common';
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import Redis from 'ioredis';

import { REDIS_CLIENT, DEFAULT_CACHE_TTL_MS } from './cache.constants';
import { RedisClientModule } from './redis-client.module';
import { ioRedisStore } from './redis-store';
import { CacheService } from './cache.service';

/**
 * Global cache moduli.
 *  1. `NestCacheModule` ni ioredis store bilan ro'yxatdan o'tkazadi — shunda
 *     `CACHE_MANAGER` in-memory emas, Redis bilan ishlaydi (REDIS_URL bo'lsa).
 *     Bir xil `RedisClientModule` ishlatilgani uchun ulanish YAGONA (dublikat yo'q).
 *  2. `CacheService` ni butun ilovaga taqdim etadi.
 */
@Global()
@Module({
  imports: [
    RedisClientModule,
    NestCacheModule.registerAsync({
      isGlobal: true,
      imports: [RedisClientModule],
      inject: [REDIS_CLIENT],
      useFactory: (client: Redis | null) => ({
        // client bo'lmasa store berilmaydi → cache-manager standart 'memory' store'iga tushadi.
        store: client ? ioRedisStore(client, DEFAULT_CACHE_TTL_MS) : undefined,
        ttl: DEFAULT_CACHE_TTL_MS,
        max: 1000,
      }),
    }),
  ],
  providers: [CacheService],
  exports: [CacheService, NestCacheModule],
})
export class AppCacheModule {}