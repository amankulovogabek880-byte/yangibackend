import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

/**
 * ═══════════════════════════════════════════════════════════════
 * STATIK FAYLLAR uchun rate limit (v12.8)
 * ═══════════════════════════════════════════════════════════════
 *
 * NEGA ALOHIDA:
 *   `/uploads` — bu Nest controller EMAS, balki Express middleware
 *   (`express.static`). Nest'ning ThrottlerGuard'i faqat Nest
 *   marshrutlariga qo'llanadi, shuning uchun bu yerda ishlamaydi.
 *
 * NIMADAN HIMOYA QILADI:
 *   Fayl yuklab olish endpointi eng "og'ir" joylardan biri — har
 *   so'rov diskdan o'qiydi va trafik sarflaydi. Cheklovsiz bo'lsa
 *   bitta skript minglab so'rov yuborib serverni band qilishi
 *   yoki trafik hisobini oshirib yuborishi mumkin.
 *
 * REDIS BO'LMASA:
 *   Xotira rejimiga tushadi (bitta instans uchun yetarli).
 */

const logger = new Logger('StaticRateLimit');
const memory = new Map<string, { hits: number; resetAt: number }>();

/** Eskirgan yozuvlarni tozalab turamiz */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory.entries()) if (v.resetAt <= now) memory.delete(k);
}, 5 * 60 * 1000);

export interface StaticRateLimitOptions {
  /** Oyna ichida ruxsat etilgan so'rovlar soni */
  limit?: number;
  /** Oyna uzunligi (soniya) */
  windowSec?: number;
  redis?: Redis | null;
}

/**
 * Express middleware qaytaradi.
 *
 * IP bo'yicha sanaydi. Proxy orqasida ishlagani uchun
 * `X-Forwarded-For` birinchi qiymati olinadi (nginx/Render shuni
 * to'ldiradi).
 */
export function createStaticRateLimit(opts: StaticRateLimitOptions = {}) {
  const limit = opts.limit ?? parseInt(process.env.STATIC_RATE_LIMIT || '120', 10);
  const windowSec = opts.windowSec ?? parseInt(process.env.STATIC_RATE_WINDOW_SEC || '60', 10);
  const redis = opts.redis ?? null;
  let warned = false;

  return async function staticRateLimit(req: any, res: any, next: () => void) {
    const ip =
      (req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      'unknown';

    const key = `staticlimit:${ip}`;

    // ── Redis rejimi ──
    if (redis) {
      try {
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, windowSec);

        if (count > limit) {
          const ttl = await redis.ttl(key);
          res.setHeader('Retry-After', String(ttl > 0 ? ttl : windowSec));
          return res.status(429).json({
            message: `Juda ko'p so'rov. ${ttl > 0 ? ttl : windowSec} soniyadan keyin urinib ko'ring.`,
          });
        }
        return next();
      } catch (e: any) {
        if (!warned) {
          warned = true;
          logger.warn(`Redis ishlamadi (${e?.message}) — xotira rejimiga o'tildi`);
        }
      }
    }

    // ── Zaxira: xotira ──
    const now = Date.now();
    const rec = memory.get(key);
    if (!rec || rec.resetAt <= now) {
      memory.set(key, { hits: 1, resetAt: now + windowSec * 1000 });
      return next();
    }

    rec.hits++;
    if (rec.hits > limit) {
      const retry = Math.ceil((rec.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({
        message: `Juda ko'p so'rov. ${retry} soniyadan keyin urinib ko'ring.`,
      });
    }
    return next();
  };
}