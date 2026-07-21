/**
 * ═══════════════════════════════════════════════════════════════
 * TUR-OPERATOR ADAPTER INTERFEYSI — v1
 * ═══════════════════════════════════════════════════════════════
 *
 * Nima uchun kerak:
 *   Mavjud `marketplace` moduli BITTA umumiy naqshni taxmin qiladi:
 *   "login qil → token ol → /tours dan JSON RO'YXAT ol → DB'ga import qil".
 *   Bu naqsh statik katalog (masalan Excel eksport) beradigan
 *   operatorlar uchun to'g'ri ishlaydi.
 *
 *   Lekin haqiqiy hotel/tur B2B tizimlari (Ratehawk va aksariyat
 *   boshqa operatorlar) BUTUNLAY BOSHQACHA ishlaydi: ular sizga
 *   "barcha turlar ro'yxati"ni bermaydi — sana, mehmonxona/shahar va
 *   mehmonlar soniga qarab JONLI (live) narx qaytaradi. Bugun $120
 *   bo'lgan xona ertaga $95 yoki "joy yo'q" bo'lishi mumkin.
 *
 *   Shu sababli har bir operator uchun alohida ADAPTER yozamiz — u
 *   operatorning o'ziga xos API/portal formatini shu interfeysga
 *   "tarjima" qiladi. CRM qolgan qismi esa faqat shu interfeys bilan
 *   ishlaydi va operator qanday ishlashidan bexabar bo'ladi.
 *
 * QANDAY QO'SHISH KERAK (yangi operator uchun):
 *   1. Shu interfeysni implement qiluvchi klass yozing
 *      (masalan `kompas.adapter.ts`).
 *   2. `adapter-registry.ts` da slug → klass bog'lang.
 *   3. `operator-catalog.ts` da operatorga `hasAdapter: true` qo'ying.
 *   Boshqa hech narsani o'zgartirish shart emas — marketplace moduli
 *   va frontend avtomatik ishlay boshlaydi.
 * ═══════════════════════════════════════════════════════════════
 */

/** Operatorga ulanish uchun tenant kiritgan maxfiy ma'lumotlar (deshifrlangan holda) */
export interface TourAdapterCredentials {
  /** Ratehawk uchun: KEY_ID. Boshqa operatorlar uchun: login/username */
  login: string;
  /** Ratehawk uchun: API_KEY. Boshqa operatorlar uchun: parol */
  password: string;
}

export interface LiveSearchParams {
  /** Erkin matn: "Antalya", "Dubay", "Bali" va h.k. */
  destination: string;
  /** Agar oldindan ma'lum bo'lsa (masalan keshdan) — resolve bosqichini tejaydi */
  regionId?: number | string;
  /** YYYY-MM-DD */
  checkin: string;
  /** YYYY-MM-DD */
  checkout: string;
  adults: number;
  /** Har bir bola yoshi, masalan [5, 9] */
  childrenAges?: number[];
  /** Standart: USD */
  currency?: string;
  /** Mijoz fuqaroligi (ba'zi operatorlar buni talab qiladi). Standart: 'uz' */
  residency?: string;
  /** Natijalar sonini cheklash (default adapter ichida belgilanadi) */
  limit?: number;
}

export interface NormalizedSearchResult {
  operatorSlug: string;
  operatorName: string;

  /**
   * Keyingi bosqich (prebook/booking) uchun kerak bo'ladigan xom
   * identifikator — masalan Ratehawk'da bu "rate hash". CRM buni
   * o'zgartirmasdan saqlaydi va booking chaqirig'ida qaytaradi.
   */
  externalId: string;

  title: string;
  destination: string;
  country?: string | null;
  hotelStars?: number | null;
  mealPlan?: string | null;
  roomName?: string | null;

  price: number;
  currency: string;

  /** Bekor qilish shartlari — inson o'qiy oladigan qisqa matn */
  cancellationPolicy?: string | null;

  /** Diqqat: production loglariga yozilmasin — faqat debug uchun */
  raw?: unknown;
}

export interface CredentialCheckResult {
  ok: boolean;
  error?: string;
}

export interface ITourAdapter {
  /** operator-catalog.ts dagi slug bilan bir xil bo'lishi SHART */
  readonly slug: string;

  /**
   * Login/parolni (yoki API kalitni) operatorda tekshiradi.
   * Tenant "Ulanish" tugmasini bosganda chaqiriladi.
   */
  verifyCredentials(creds: TourAdapterCredentials): Promise<CredentialCheckResult>;

  /**
   * Jonli qidiruv. Har chaqiruvda operator serveriga so'rov ketadi —
   * natija DB'ga saqlanmaydi (yoki qisqa muddatga keshlanadi), chunki
   * narx/joy tez eskiradi.
   */
  searchLive(
    creds: TourAdapterCredentials,
    params: LiveSearchParams,
  ): Promise<NormalizedSearchResult[]>;
}