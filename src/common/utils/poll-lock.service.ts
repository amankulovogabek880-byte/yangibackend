import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../cache/cache.constants';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ═══════════════════════════════════════════════════════════════
 * POLLING QULFI (v19) — bir nechta instans/replika bir xil Telegram
 * bot tokeni bilan getUpdates so'ramasin
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO (loglarda ko'rilgan holat):
 *   Backend bir vaqtning o'zida 2 (yoki undan ko'p) nusxada ishlab
 *   turibdi (masalan Render'da 2 instans/replika, yoki eski deploy
 *   hech qachon to'liq o'chmagan) — HAR BIR nusxa bir xil bot tokeni
 *   bilan `polling: true` rejimida Telegramdan getUpdates so'raydi.
 *   Telegram bunga faqat BITTA ulanishga ruxsat beradi — qolganlari
 *   409 Conflict oladi va CHEKSIZ qayta-ishga-tushish tsikliga tushib
 *   qoladi (loglarda 60+ urinishgacha ko'tarilgani shundan).
 *
 * YECHIM — IKKI QATLAMLI QULF:
 *   1) REDIS mavjud bo'lsa: `SET key NX EX ttl` (tezroq, tavsiya etiladi).
 *   2) REDIS mavjud BO'LMASA (masalan REDIS_URL Render'da sozlanmagan —
 *      bu holatda v18'dagi qulf HECH NARSANI QILMASDI, chunki
 *      `this.redis` null bo'lsa avvalgi kod har doim `true` qaytarardi!):
 *      endi shu holatda `PlatformSetting` jadvali (allaqachon mavjud,
 *      migratsiya kerak emas) orqali DB darajasidagi CAS
 *      (compare-and-swap, `updateMany` + `where: {key, value}`)
 *      yordamida XUDDI SHUNDAY qulf ta'minlanadi. Bu Postgres har doim
 *      mavjudligi sababli ENG ISHONCHLI variant.
 *
 *   Qaysi biri ishlatilishidan qat'i nazar: qulfni ushlab turgan
 *   instans uni "heartbeat" bilan (TTL/3 da bir marta) yangilab
 *   turadi; qolgan instans(lar) hech qanday TelegramBot/getUpdates
 *   yaratmasdan, davriy ravishda qulf bo'shaganini tekshiradi.
 */
@Injectable()
export class PollLockService {
  private readonly logger = new Logger('PollLock');
  private timers = new Map<string, NodeJS.Timeout>();
  // Redis rejimida: qulf egaligini bildiruvchi token
  private owners = new Map<string, string>();
  // DB rejimida: oxirgi yozgan qatorimizning qiymati (CAS uchun kerak)
  private dbLockValue = new Map<string, string>();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Qulfni olishga urinadi.
   * @returns true — qulf bizda (haqiqiy polling boshlash MUMKIN),
   *          false — boshqa instans ushlab turibdi (polling boshlaMA).
   */
  async acquire(name: string, ttlSec = 30): Promise<boolean> {
    return this.redis ? this.acquireRedis(name, ttlSec) : this.acquireDb(name, ttlSec);
  }

  /** Qulfni bo'shatadi (FAQAT o'zimiz egasi bo'lsak). */
  async release(name: string) {
    const timer = this.timers.get(name);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(name);
    }
    if (this.redis) {
      const owner = this.owners.get(name);
      this.owners.delete(name);
      if (!owner) return;
      try {
        const key = `polllock:${name}`;
        const cur = await this.redis.get(key);
        if (cur === owner) await this.redis.del(key);
      } catch { /* qulf TTL bo'yicha o'zi bo'shaydi */ }
      return;
    }
    const val = this.dbLockValue.get(name);
    this.dbLockValue.delete(name);
    if (!val) return;
    try {
      await this.prisma.platformSetting.deleteMany({
        where: { key: `polllock:${name}`, value: val },
      });
    } catch { /* qulf TTL (exp) bo'yicha o'zi "bo'shagan" hisoblanadi */ }
  }

  // ─── REDIS QULFI ────────────────────────────────────────────────

  private async acquireRedis(name: string, ttlSec: number): Promise<boolean> {
    const key = `polllock:${name}`;

    // Agar shu instans allaqachon egasi bo'lsa — shunchaki TTL'ni yangilaymiz.
    if (this.owners.has(name)) {
      try { await this.redis!.expire(key, ttlSec); } catch { /* keyingi heartbeat'da qayta urinadi */ }
      return true;
    }

    const owner = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    try {
      const res = await this.redis!.set(key, owner, 'EX', ttlSec, 'NX');
      if (res !== 'OK') return false; // boshqa instans egasi
    } catch (e: any) {
      this.logger.warn(`Redis qulfi "${name}" olinmadi (${e?.message}) — baribir davom etiladi`);
      return true;
    }

    this.owners.set(name, owner);
    const timer = setInterval(async () => {
      try {
        const cur = await this.redis!.get(key);
        if (cur === owner) {
          await this.redis!.expire(key, ttlSec);
        } else {
          this.logger.warn(`Qulf "${name}" boshqa instansga o'tib ketdi (TTL tugagan bo'lishi mumkin)`);
        }
      } catch { /* keyingi heartbeat'da qayta urinadi */ }
    }, Math.max(5000, Math.floor((ttlSec * 1000) / 3)));
    timer.unref?.();
    this.timers.set(name, timer);
    return true;
  }

  // ─── DB (PlatformSetting) QULFI — Redis bo'lmasa fallback ──────

  private async acquireDb(name: string, ttlSec: number): Promise<boolean> {
    const key = `polllock:${name}`;
    const owner = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const now = Date.now();
    const newValue = JSON.stringify({ owner, exp: now + ttlSec * 1000 });

    try {
      const existing = await this.prisma.platformSetting.findUnique({ where: { key } });

      if (!existing) {
        // Qator umuman yo'q — birinchi bo'lib yaratishga urinamiz.
        // `key` @id (unique) bo'lgani uchun ikkita instans bir vaqtda
        // yozsa, faqat BITTASI muvaffaqiyatli bo'ladi (boshqasi xato
        // olib "band" deb hisoblanadi).
        try {
          await this.prisma.platformSetting.create({ data: { key, value: newValue } });
        } catch {
          return false; // boshqa instans bizdan bir zum oldin yaratdi
        }
      } else {
        let parsed: any = null;
        try { parsed = JSON.parse(existing.value); } catch { /* eskirgan/formatsiz qiymat — muddati tugagan deb hisoblanadi */ }
        const isExpired = !parsed?.exp || parsed.exp < now;
        const isOurs = this.dbLockValue.get(name) === existing.value;
        if (!isOurs && !isExpired) {
          return false; // boshqa instans hali egasi va muddati tugamagan
        }
        // CAS: faqat baza qatoridagi qiymat biz kutgan qiymat bilan
        // bir xil bo'lsagina yangilaymiz — shu bilan ikkita instans
        // bir vaqtda "muddati tugagan" deb topib, ikkalasi ham
        // yozmoqchi bo'lsa ham, FAQAT BITTASI muvaffaqiyatli bo'ladi.
        const res = await this.prisma.platformSetting.updateMany({
          where: { key, value: existing.value },
          data: { value: newValue },
        });
        if (res.count !== 1) return false; // boshqa instans bizdan oldin o'zgartirdi
      }
    } catch (e: any) {
      this.logger.warn(`DB qulfi "${name}" olinmadi (${e?.message}) — baribir davom etiladi`);
      return true;
    }

    this.dbLockValue.set(name, newValue);
    const timer = setInterval(async () => {
      try {
        const curVal = this.dbLockValue.get(name);
        if (!curVal) return;
        const renewedAt = Date.now();
        const renewed = JSON.stringify({ owner, exp: renewedAt + ttlSec * 1000 });
        const r = await this.prisma.platformSetting.updateMany({
          where: { key, value: curVal },
          data: { value: renewed },
        });
        if (r.count === 1) {
          this.dbLockValue.set(name, renewed);
        } else {
          this.logger.warn(`DB qulfi "${name}" boshqa instansga o'tib ketdi (TTL tugagan bo'lishi mumkin)`);
        }
      } catch { /* keyingi heartbeat'da qayta urinadi */ }
    }, Math.max(5000, Math.floor((ttlSec * 1000) / 3)));
    timer.unref?.();
    this.timers.set(name, timer);
    return true;
  }
}