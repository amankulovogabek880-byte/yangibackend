import { AsyncLocalStorage } from 'async_hooks';

/**
 * ═══════════════════════════════════════════════════════════════
 * SO'ROV KONTEKSTI — joriy foydalanuvchi tenant'i (v12.7)
 * ═══════════════════════════════════════════════════════════════
 *
 * Node.js'da har bir HTTP so'rov alohida "async zanjir"da ishlaydi.
 * AsyncLocalStorage shu zanjir bo'ylab ma'lumot olib yuradi — ya'ni
 * chuqurdagi Prisma so'rovi ham "bu qaysi tenant so'rovi" ekanini
 * biladi, uni har bir funksiyaga parametr sifatida uzatmasdan.
 *
 * Bu tenant-guard uchun kerak: so'rov natijasi qaytganda uni joriy
 * tenant bilan solishtirish mumkin bo'ladi.
 */

export interface TenantContextData {
  tenantId?: string | null;
  userId?: string | null;
  role?: string | null;
  /** true bo'lsa tenant tekshiruvi o'tkazib yuboriladi (cron, migratsiya) */
  bypass?: boolean;
}

const storage = new AsyncLocalStorage<TenantContextData>();

export const TenantContext = {
  /** Berilgan kontekstda funksiyani ishga tushiradi */
  run<T>(data: TenantContextData, fn: () => T): T {
    return storage.run(data, fn);
  },

  /** Joriy kontekst (yo'q bo'lsa undefined) */
  get(): TenantContextData | undefined {
    return storage.getStore();
  },

  /** Joriy tenant ID */
  tenantId(): string | null {
    return storage.getStore()?.tenantId ?? null;
  },

  /**
   * Tekshiruvni ataylab o'tkazib yuborish kerak bo'lgan joylar uchun:
   * cron ishlari, platforma egasi so'rovlari, migratsiyalar.
   */
  bypass<T>(fn: () => T): T {
    const cur = storage.getStore() || {};
    return storage.run({ ...cur, bypass: true }, fn);
  },
};