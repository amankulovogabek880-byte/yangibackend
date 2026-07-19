import {
  Injectable, CanActivate, ExecutionContext, Inject, Optional,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../cache/cache.constants';

/**
 * ═══════════════════════════════════════════════════════════════
 * LOGIN RATE LIMIT — brute-force himoyasi (v12.5)
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO (oldingi versiyada):
 *   Urinishlar `Map` da, ya'ni O'SHA jarayonning xotirasida saqlanardi.
 *   Bitta server bo'lsa ishlaydi. Lekin 2 ta instans bo'lsa:
 *
 *     Limit = 10 urinish
 *     Hujumchi so'rovlarini load balancer ikkiga bo'ladi
 *     → har bir instans alohida 10 tagacha sanaydi
 *     → amalda 20 ta urinishga ruxsat beriladi
 *
 *   Instanslar soni ortgani sari himoya shunchalik zaiflashadi.
 *
 * YECHIM:
 *   Hisoblagich Redis'da — barcha instanslar BITTA sanoqni ko'radi.
 *   INCR atomik amaliyot, shuning uchun bir vaqtda kelgan so'rovlar
 *   ham to'g'ri sanaladi (poyga yo'q).
 *
 * REDIS BO'LMASA:
 *   In-memory rejimga tushadi (eski xatti-harakat). Bitta instans
 *   uchun bu to'liq yetarli. Redis o'chib qolsa ham login ishlaydi —
 *   himoya butunlay yo'qolmaydi, faqat instans darajasida qoladi.
 */

/** Redis yo'q bo'lgandagi zaxira (bitta instans uchun) */
const memoryAttempts = new Map<string, { count: number; resetAt: number }>();

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimit');
  private readonly MAX = parseInt(process.env.LOGIN_RATE_LIMIT || '10', 10);
  private readonly WINDOW_MS = parseInt(
    process.env.LOGIN_RATE_WINDOW_MS || '900000', 10,
  ); // 15 daqiqa

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      'unknown';

    const key = `ratelimit:login:${ip}`;
    const windowSec = Math.ceil(this.WINDOW_MS / 1000);

    // ── Redis rejimi (barcha instanslar uchun umumiy) ──
    if (this.redis) {
      try {
        // INCR atomik: bir vaqtda kelgan so'rovlar to'g'ri sanaladi
        const count = await this.redis.incr(key);

        // Birinchi urinishda oynani belgilaymiz
        if (count === 1) {
          await this.redis.expire(key, windowSec);
        }

        if (count > this.MAX) {
          const ttl = await this.redis.ttl(key);
          const waitMin = Math.max(1, Math.ceil((ttl > 0 ? ttl : windowSec) / 60));
          this.logger.warn(`Login rate limit (Redis): IP=${ip} urinish=${count}`);
          throw new HttpException(
            `Juda ko'p urinish. ${waitMin} daqiqadan keyin qayta urinib ko'ring.`,
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        return true;
      } catch (e) {
        // Limit xatosi bo'lsa — uni o'tkazamiz (bu bizning xatomiz emas)
        if (e instanceof HttpException) throw e;

        // Redis o'chib qolgan — login butunlay to'xtab qolmasin,
        // xotira rejimiga tushamiz va ogohlantiramiz.
        this.logger.warn(
          `Redis rate-limit ishlamadi (${(e as any)?.message}) — xotira rejimiga o'tildi`,
        );
      }
    }

    // ── Zaxira: in-memory ──
    return this.checkInMemory(key, ip);
  }

  private checkInMemory(key: string, ip: string): boolean {
    const now = Date.now();
    const existing = memoryAttempts.get(key);

    if (!existing || existing.resetAt < now) {
      memoryAttempts.set(key, { count: 1, resetAt: now + this.WINDOW_MS });
      return true;
    }

    existing.count++;
    if (existing.count > this.MAX) {
      const waitMin = Math.ceil((existing.resetAt - now) / 60000);
      this.logger.warn(`Login rate limit (xotira): IP=${ip} urinish=${existing.count}`);
      throw new HttpException(
        `Juda ko'p urinish. ${waitMin} daqiqadan keyin qayta urinib ko'ring.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

// Eskirgan xotira yozuvlarini tozalab turamiz (Redis yo'q rejim uchun)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of memoryAttempts.entries()) {
    if (val.resetAt < now) memoryAttempts.delete(key);
  }
}, 30 * 60 * 1000);