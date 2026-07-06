import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT, reportsTenantPattern, kpiTenantPattern } from './cache.constants';
import { scanKeys } from './redis-store';

/**
 * Ilova bo'ylab ishlatiladigan yuqori darajali cache yordamchisi.
 *
 * DIZAYN QOIDASI — "fail-open": Redis ishlamay qolsa yoki sozlanmagan bo'lsa,
 * cache operatsiyalari HECH QACHON xato tashlamaydi va so'rovni bloklamaydi.
 * Bunday holatda tizim shunchaki cache'siz (bevosita bazadan) ishlaydi — sekinroq,
 * lekin "qotib qolmaydi". Shu sabab barcha metodlar try/catch bilan o'ralgan va
 * `getOrSet` mishda/xatoda doim asl funksiyani (bazaga so'rov) qaytaradi.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger('Cache');

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis | null) {}

  /** Cache faol (Redis ulangan) yoki yo'qligini bildiradi. */
  get enabled(): boolean {
    return !!this.client;
  }

  private static msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const raw = await this.client.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (e) {
      this.logger.warn(`get(${key}) o'tkazib yuborildi: ${CacheService.msg(e)}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSeconds)));
    } catch (e) {
      this.logger.warn(`set(${key}) o'tkazib yuborildi: ${CacheService.msg(e)}`);
    }
  }

  /**
   * Get-or-set: kalit bo'lsa — cache'dan, bo'lmasa — `factory()` ni ishga tushirib,
   * natijani cache'ga yozadi (best-effort) va qaytaradi.
   *
   * Cache o'qish/yozishdagi HAR QANDAY nosozlikda `factory()` baribir bajariladi —
   * demak endpoint hech qachon cache tufayli buzilmaydi.
   */
  async getOrSet<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    if (!this.client) return factory();

    try {
      const cached = await this.client.get(key);
      if (cached !== null) {
        try {
          return JSON.parse(cached) as T;
        } catch {
          /* buzilgan qiymat — pastda qayta hisoblaymiz */
        }
      }
    } catch (e) {
      this.logger.warn(`getOrSet get(${key}) o'tkazib yuborildi: ${CacheService.msg(e)}`);
    }

    const fresh = await factory();
    // Yozishni kutmaymiz — javob tezligiga ta'sir qilmasin, xato bo'lsa yutiladi.
    void this.set(key, fresh, ttlSeconds);
    return fresh;
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.client || keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (e) {
      this.logger.warn(`del o'tkazib yuborildi: ${CacheService.msg(e)}`);
    }
  }

  /**
   * Pattern bo'yicha o'chirish (SCAN + bo'lakli DEL). Katta hajmda ham
   * Redis'ni bloklamaydi.
   */
  async delByPattern(pattern: string): Promise<void> {
    if (!this.client) return;
    try {
      const keys = await scanKeys(this.client, pattern);
      const CHUNK = 500;
      for (let i = 0; i < keys.length; i += CHUNK) {
        await this.client.del(...keys.slice(i, i + CHUNK));
      }
    } catch (e) {
      this.logger.warn(`delByPattern(${pattern}) o'tkazib yuborildi: ${CacheService.msg(e)}`);
    }
  }

  /**
   * Bitta tenant'ning barcha hisobot va KPI cache'ini tozalaydi.
   * Booking/payment/client/KPI o'zgarganda chaqiriladi — eskirgan raqamlar
   * ko'rsatilib qolmasligi uchun.
   */
  async invalidateReports(tenantId: string): Promise<void> {
    if (!tenantId) return;
    await Promise.all([
      this.delByPattern(reportsTenantPattern(tenantId)),
      this.delByPattern(kpiTenantPattern(tenantId)),
    ]);
  }
}