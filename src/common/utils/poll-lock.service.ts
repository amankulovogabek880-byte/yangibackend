import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../cache/cache.constants';

/**
 * ═══════════════════════════════════════════════════════════════
 * POLLING QULFI (v18) — bir nechta instans/replika bir xil Telegram
 * bot tokeni bilan getUpdates so'ramasin
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO (loglarda ko'rilgan holat):
 *   Agar backend bir vaqtning o'zida 2 nusxada ishlab tursa (masalan
 *   deploy paytida eski jarayon hali to'liq o'chmagan, yoki hosting
 *   2+ instans/replika bilan ishlaydi) — HAR BIR nusxa bir xil bot
 *   tokeni bilan `polling: true` rejimida Telegramdan getUpdates
 *   so'raydi. Telegram bunga faqat BITTA "long poll" ulanishga ruxsat
 *   beradi — ikkinchisi darhol 409 Conflict oladi.
 *
 *   telegram.module.ts / jarvis-bot.module.ts'dagi eski kod bu 409'ni
 *   ko'rib botni backoff bilan qayta ishga tushirardi — lekin qaysi
 *   nusxa qayta urinsa ham, IKKALASI HAM baribir tirik bo'lgani uchun,
 *   qayta ishga tushgan zahoti яна bir-biriga 409 qaytarardi. Natijada
 *   bot CHEKSIZ tsiklda 15s→30s→...→120s oralig'ida qayta-qayta
 *   ishga tushib-o'chib turaverdi (aynan loglarda ko'rilgan holat) —
 *   CPU/RAM behuda sarflanardi va real xabarlar band vaqtlarda
 *   yo'qolishi mumkin edi.
 *
 * YECHIM:
 *   Redis'da `SET key NX EX ttl` — atomik "faqat mavjud bo'lmasa
 *   yozish". Qaysi instans birinchi ulgursa, FAQAT O'SHA haqiqiy
 *   pollingni boshlaydi; qolgan instans(lar) qulf band ekanini
 *   ko'rib, HECH QANDAY TelegramBot/getUpdates yaratmaydi — buning
 *   o'rniga davriy (~20s) qulf bo'shaganini tekshirib turadi va
 *   birinchi instans yiqilib qulf bo'shagan zahoti o'zi ishga tushadi.
 *
 *   Qulfni ushlab turgan instans uni "heartbeat" bilan (TTL/3 da bir
 *   marta) yangilab turadi — aks holda TTL tugab, ikkinchi instans
 *   ham qulfni olib, yana konflikt yuzaga kelardi.
 *
 * REDIS BO'LMASA:
 *   Qulf sinab ko'rilmaydi — har doim "berildi" deb qaytariladi (bitta
 *   instans deb hisoblanadi). Bu eski xatti-harakat bilan bir xil va
 *   Redis o'chib qolgani uchun botlar to'xtab qolmasligini ta'minlaydi.
 */
@Injectable()
export class PollLockService {
  private readonly logger = new Logger('PollLock');
  private timers = new Map<string, NodeJS.Timeout>();
  private owners = new Map<string, string>();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {}

  /**
   * Qulfni olishga urinadi.
   * @returns true — qulf bizda (haqiqiy polling boshlash MUMKIN),
   *          false — boshqa instans ushlab turibdi (polling boshlaMA).
   */
  async acquire(name: string, ttlSec = 30): Promise<boolean> {
    if (!this.redis) return true; // Redis yo'q — yagona instans deb hisoblanadi

    const key = `polllock:${name}`;

    // Agar shu instans allaqachon egasi bo'lsa (masalan 409'dan keyin
    // o'zi qayta ishga tushayotgan bo'lsa) — shunchaki TTL'ni yangilaymiz,
    // qayta SET NX urinish shart emas (u NX tufayli baribir rad etilardi).
    if (this.owners.has(name)) {
      try { await this.redis.expire(key, ttlSec); } catch { /* keyingi heartbeat'da qayta urinadi */ }
      return true;
    }

    const owner = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    try {
      const res = await this.redis.set(key, owner, 'EX', ttlSec, 'NX');
      if (res !== 'OK') return false; // boshqa instans egasi
    } catch (e: any) {
      // Redis vaqtincha ishlamasa — bloklab qo'ymaymiz (bitta instans deb hisoblaymiz)
      this.logger.warn(`Qulf "${name}" olinmadi (${e?.message}) — baribir davom etiladi`);
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

  /** Qulfni bo'shatadi (FAQAT o'zimiz egasi bo'lsak). */
  async release(name: string) {
    const timer = this.timers.get(name);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(name);
    }
    const owner = this.owners.get(name);
    this.owners.delete(name);
    if (!this.redis || !owner) return;
    try {
      const key = `polllock:${name}`;
      const cur = await this.redis.get(key);
      if (cur === owner) await this.redis.del(key);
    } catch { /* qulf TTL bo'yicha o'zi bo'shaydi */ }
  }
}