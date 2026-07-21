import { Injectable } from '@nestjs/common';
import { RatehawkAdapter } from './ratehawk.adapter';
import type { ITourAdapter } from './tour-adapter.types';

/**
 * Slug → maxsus kod-adapter bog'lovchisi.
 *
 * Bu yerda RO'YXATDAN O'TGAN operatorlar `marketplace` modulidagi
 * generic (login→token→/tours) oqimini AYLANIB O'TADI va o'z
 * maxsus mantig'i bilan ishlaydi (masalan Ratehawk — Basic Auth +
 * jonli qidiruv, statik /tours yo'q).
 *
 * Ro'yxatda YO'Q slug'lar — eski, generic REST oqimida ishlashda
 * davom etadi (operator-catalog.ts + marketplace.module.ts dagi
 * `verifyCredentials`/`syncOperator`), demak hech narsa buzilmaydi.
 *
 * Yangi adapter qo'shganda faqat shu yerga bitta qator qo'shiladi:
 *   this.map.set(new KompasAdapter().slug, new KompasAdapter());
 */
@Injectable()
export class TourAdapterRegistry {
  private readonly map = new Map<string, ITourAdapter>();

  constructor(private readonly ratehawk: RatehawkAdapter) {
    this.register(ratehawk);
    // Keyingi operatorlar shu yerga qo'shiladi, masalan:
    // this.register(new KompasAdapter());
  }

  private register(adapter: ITourAdapter) {
    this.map.set(adapter.slug, adapter);
  }

  get(slug: string): ITourAdapter | null {
    return this.map.get(String(slug || '').toLowerCase()) || null;
  }

  has(slug: string): boolean {
    return this.map.has(String(slug || '').toLowerCase());
  }

  /** Barcha kod-adapterli slug'lar ro'yxati (cron avtosinxronni o'tkazib yuborishi uchun) */
  get registeredSlugs(): string[] {
    return Array.from(this.map.keys());
  }
}