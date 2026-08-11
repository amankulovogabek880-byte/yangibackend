import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../cache/cache.constants';

/**
 * ═══════════════════════════════════════════════════════════════
 * ThrottlerStorage — Redis'da (v12.5)
 * ═══════════════════════════════════════════════════════════════
 *
 * NEGA O'ZIMIZ YOZDIK:
 *   Tayyor `@nest-lab/throttler-storage-redis` paketi
 *   `@nestjs/throttler` >= 6.0.0 talab qiladi, loyihada esa 5.2.0.
 *   Versiyani ko'tarish buzuvchi o'zgarish bo'lardi (API o'zgargan).
 *
 *   ThrottlerStorage interfeysi juda sodda — bitta metod. Shuning
 *   uchun mavjud ioredis mijozi bilan o'zimiz yozdik: yangi
 *   bog'liqlik ham yo'q, versiya to'qnashuvi ham.
 *
 * NIMA HAL QILADI:
 *   Standart storage xotirada ishlaydi. 2 ta instans bo'lsa har biri
 *   alohida sanaydi va limit amalda ikki barobar kattayadi. Redis'da
 *   esa sanoq umumiy — nechta instans bo'lsa ham limit bitta.
 *
 * REDIS YO'Q BO'LSA:
 *   Xotira rejimiga tushadi (standart xatti-harakat). Redis o'chib
 *   qolsa ham so'rovlar to'xtamaydi — himoya faqat instans
 *   darajasiga tushadi.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('Throttler');
  private warned = false;

  /** Redis yo'q bo'lgandagi zaxira */
  private memory = new Map<string, { hits: number; expiresAt: number }>();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {
    // XOTIRA SIZISHI TUZATILDI: pastdagi `cleanup()` metodi eskirgan
    // yozuvlarni o'chirish uchun yozilgan edi, lekin uni hech kim, hech
    // qayerda chaqirmasdi (bu klass Nest DI orqali emas, `new
    // RedisThrottlerStorage(...)` bilan qo'lda yaratiladi — shuning
    // uchun `OnModuleInit`/Cron kabi Nest lifecycle-hook'lar ham
    // ishlamaydi). Natijada Redis yo'q rejimda `memory` Map'i har bir
    // yangi (IP/route bo'yicha) kalit uchun cheksiz o'sardi — hech
    // qachon torilmasdan. Endi shu yerning o'zida davriy o'z-o'zini
    // tozalash ishga tushiriladi (bu klassdan FAQAT bitta nusxa
    // yaratiladi — app.module.ts'dagi ThrottlerModule factory'sida —
    // shuning uchun bu bir marta ishga tushadigan yagona timer).
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref?.();
  }

  async increment(key: string, ttl: number): Promise<ThrottlerStorageRecord> {
    // @nestjs/throttler v5 TTL'ni MILLISEKUNDDA beradi
    const ttlSec = Math.max(1, Math.ceil(ttl / 1000));
    const redisKey = `throttle:${key}`;

    if (this.redis) {
      try {
        // Ikkala buyruqni bitta borishda yuboramiz (tezroq va atomik)
        const results = await this.redis
          .multi()
          .incr(redisKey)
          .ttl(redisKey)
          .exec();

        const totalHits = Number(results?.[0]?.[1] ?? 0);
        let timeToExpire = Number(results?.[1]?.[1] ?? -1);

        // Birinchi urinish — muddat belgilaymiz
        if (totalHits === 1 || timeToExpire < 0) {
          await this.redis.expire(redisKey, ttlSec);
          timeToExpire = ttlSec;
        }

        return { totalHits, timeToExpire };
      } catch (e: any) {
        if (!this.warned) {
          this.warned = true;
          this.logger.warn(
            `Redis throttler ishlamadi (${e?.message}) — xotira rejimiga o'tildi`,
          );
        }
      }
    }

    return this.incrementInMemory(redisKey, ttlSec);
  }

  private incrementInMemory(key: string, ttlSec: number): ThrottlerStorageRecord {
    const now = Date.now();
    const rec = this.memory.get(key);

    if (!rec || rec.expiresAt <= now) {
      this.memory.set(key, { hits: 1, expiresAt: now + ttlSec * 1000 });
      return { totalHits: 1, timeToExpire: ttlSec };
    }

    rec.hits++;
    return {
      totalHits: rec.hits,
      timeToExpire: Math.ceil((rec.expiresAt - now) / 1000),
    };
  }

  /** Eskirgan xotira yozuvlarini tozalaydi */
  cleanup() {
    const now = Date.now();
    for (const [k, v] of this.memory.entries()) {
      if (v.expiresAt <= now) this.memory.delete(k);
    }
  }
}