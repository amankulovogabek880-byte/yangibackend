import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { REDIS_CLIENT } from './cache.constants';

const logger = new Logger('Redis');

/**
 * Yagona, xatoga chidamli ioredis mijozi (butun ilova uchun bitta ulanish).
 *  - REDIS_URL bo'lmasa → `null` qaytaradi (cache o'chadi, tizim in-memory'ga tushadi).
 *  - Redis o'chib qolsa → buyruqlar TEZ rad etiladi (`enableOfflineQueue: false`,
 *    `maxRetriesPerRequest: 1`), so'rovlar navbatda "osilib" qolmaydi. CacheService
 *    bu xatolarni yutib, bevosita bazadan ishlaydi — ya'ni yuk ostida ham qotmaydi.
 *  - Fonda avtomatik qayta ulanadi (retryStrategy).
 *  - 'error' hodisasi tinglanadi — aks holda ioredis jarayonni yiqitishi mumkin.
 */
export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis | null => {
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      logger.warn(
        "REDIS_URL topilmadi — cache O'CHIRILGAN (in-memory fallback). " +
          'Production-da tezlik uchun Redis ulash tavsiya etiladi.',
      );
      return null;
    }

    const client = new Redis(url, {
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      reconnectOnError: () => true,
    });

    client.on('error', (e) => logger.error(`Redis xatosi: ${e?.message ?? e}`));
    client.on('connect', () => logger.log('Redis ulandi ✓'));
    client.on('close', () => logger.warn('Redis ulanishi yopildi'));

    return client;
  },
};

@Module({
  providers: [redisClientProvider],
  exports: [redisClientProvider],
})
export class RedisClientModule {}