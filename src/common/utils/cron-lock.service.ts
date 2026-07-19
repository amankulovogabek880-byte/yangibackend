import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../cache/cache.constants';
import { TenantContext } from '../tenant/tenant-context';

/**
 * ═══════════════════════════════════════════════════════════════
 * CRON QULFI — bir nechta instans uchun (v12.7)
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO:
 *   Loyihada 7 ta rejalashtirilgan ish bor (followup eslatmalari,
 *   kurs yangilash, kiruvchi qo'ng'iroqlar, zaxira nusxa va h.k.).
 *
 *   Bitta server bo'lsa muammo yo'q. Lekin 2 ta instans ishlab tursa,
 *   HAR IKKALASI bir xil vaqtda bir xil cron'ni ishga tushiradi:
 *
 *     09:05 → instans-1: kurslarni yangilaydi
 *     09:05 → instans-2: kurslarni yangilaydi  (takror)
 *
 *   Natija: mijozga BITTA eslatma o'rniga IKKITA email ketadi,
 *   zaxira nusxa ikki marta olinadi, tashqi API'lar bekorga
 *   ikki barobar chaqiriladi.
 *
 * YECHIM:
 *   Redis'da `SET key NX EX ttl` — atomik "faqat mavjud bo'lmasa
 *   yozish" amaliyoti. Qaysi instans birinchi ulgursa, o'sha
 *   bajaradi; qolganlari o'tkazib yuboradi.
 *
 * REDIS BO'LMASA:
 *   Qulf ishlamaydi va ish BAJARILADI. Bu to'g'ri xatti-harakat —
 *   bitta instansda qulf shart emas, va Redis o'chgani uchun
 *   rejalashtirilgan ishlar to'xtab qolmasligi kerak.
 */
@Injectable()
export class CronLockService {
  private readonly logger = new Logger('CronLock');

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {}

  /**
   * Ishni FAQAT BITTA instansda bajaradi.
   *
   * @param name    ish nomi (masalan 'followups')
   * @param ttlSec  qulf muddati — ishning eng uzoq davom etish vaqtidan
   *                biroz KO'PROQ bo'lsin. Instans qulab qolsa, qulf
   *                shu muddatdan keyin o'z-o'zidan bo'shaydi.
   * @param fn      bajariladigan ish
   * @returns       ish bajarildimi (false — boshqa instans bajaryapti)
   */
  async runOnce<T>(name: string, ttlSec: number, fn: () => Promise<T>): Promise<boolean> {
    // Redis yo'q — bitta instans deb hisoblaymiz va bajaramiz
    if (!this.redis) {
      await this.safeRun(name, fn);
      return true;
    }

    const key = `cronlock:${name}`;
    const owner = `${process.pid}-${Date.now()}`;

    let acquired = false;
    try {
      // SET key value NX EX ttl — atomik: faqat kalit yo'q bo'lsa yozadi
      const res = await this.redis.set(key, owner, 'EX', ttlSec, 'NX');
      acquired = res === 'OK';
    } catch (e: any) {
      // Redis ishlamadi — ishni o'tkazib yubormaymiz, bajaramiz.
      // (Takror bajarilishi, umuman bajarilmaganidan yaxshiroq.)
      this.logger.warn(`Qulf olinmadi (${e?.message}) — ish baribir bajariladi: ${name}`);
      await this.safeRun(name, fn);
      return true;
    }

    if (!acquired) {
      this.logger.debug(`"${name}" boshqa instansda bajarilmoqda — o'tkazildi`);
      return false;
    }

    try {
      await this.safeRun(name, fn);
      return true;
    } finally {
      // Qulfni FAQAT o'zimiz qo'ygan bo'lsak bo'shatamiz.
      // (Aks holda TTL tugab, boshqa instans qulf olgan bo'lishi
      //  mumkin — uni tasodifan bo'shatib yubormaslik kerak.)
      try {
        const current = await this.redis.get(key);
        if (current === owner) await this.redis.del(key);
      } catch {
        /* qulf TTL bo'yicha o'zi bo'shaydi */
      }
    }
  }

  /**
   * Ish xatosi butun cron mexanizmini to'xtatmasin.
   *
   * Shuningdek, cron ishlari TENANT TEKSHIRUVIDAN ozod qilinadi:
   * ular ataylab barcha agentliklar bo'ylab ishlaydi (masalan
   * kurslarni yangilash yoki kiruvchi qo'ng'iroqlarni tortish),
   * shuning uchun tenant-guard ularni "sizish" deb hisoblamasin.
   */
  private async safeRun(name: string, fn: () => Promise<any>) {
    try {
      await TenantContext.bypass(() => fn());
    } catch (e: any) {
      this.logger.error(`Cron "${name}" xato berdi: ${e?.message}`);
    }
  }
}