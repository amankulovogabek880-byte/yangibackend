/**
 * ═══════════════════════════════════════════════════════════════
 * TUR OPERATOR ADAPTERI — UMUMIY SHARTNOMA (v14)
 * ═══════════════════════════════════════════════════════════════
 *
 * Har bir operatorning API'si o'zgacha. Bu interfeys ularni bitta
 * ko'rinishga keltiradi — CRM qolgan qismi qaysi operator bilan
 * ishlayotganini umuman bilmaydi.
 *
 * Yangi operator qo'shish uchun:
 *   1. `ITourAdapter` ni implement qiluvchi klass yozing
 *   2. `adapter-registry.ts` ga bitta qator qo'shing
 *   3. `operator-catalog.ts` da `available: true, hasAdapter: true` qiling
 */

export interface TourAdapterCredentials {
  login: string;
  password: string;
}

export interface LiveSearchParams {
  destination: string;
  /** Oldindan aniqlangan region ID (autocomplete orqali tanlangan bo'lsa) */
  regionId?: string | number | null;
  checkin: string;  // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
  adults: number;
  childrenAges?: number[];
  currency?: string;
  residency?: string;
  limit?: number;
}

/** Autocomplete natijasi — foydalanuvchi yo'nalishni ANIQ tanlaydi */
export interface RegionSuggestion {
  id: string;
  name: string;
  /** "Turkiya, Antalya viloyati" kabi to'liq nom */
  fullName?: string | null;
  countryCode?: string | null;
  type?: string | null;
}

export interface NormalizedSearchResult {
  operatorSlug: string;
  operatorName: string;

  /**
   * Keyingi bosqich (prebook/booking) uchun kerak bo'ladigan xom
   * identifikator — masalan Ratehawk'da bu "rate hash". CRM buni
   * o'zgartirmasdan saqlaydi.
   *
   * DIQQAT: bu qiymat qisqa muddat (Ratehawk'da ~38 daqiqa) amal
   * qiladi. Uni "doimiy tur" sifatida saqlamang.
   */
  externalId: string;

  title: string;
  destination: string;
  country?: string | null;
  hotelStars?: number | null;
  mealPlan?: string | null;
  roomName?: string | null;

  /** BRUTTO — mijoz to'laydigan narx */
  price: number;

  /**
   * NETTO — operatordan sotib olish narxi.
   *
   * TUZATILDI: ilgari bu maydon UMUMAN YO'Q edi. Natijada jonli
   * qidiruvdan yaratilgan har bir bookingda `supplierCost = 0` bo'lardi
   * va `profit = totalPrice` chiqardi. Ya'ni hisobotlarda foyda
   * haqiqiydan bir necha barobar katta ko'rinardi, agent komissiyasi
   * (`agentCommissionPercent` foydadan hisoblanadi) va KPI pog'onalari
   * ham noto'g'ri hisoblanardi. Bu pul bilan bog'liq xato edi.
   *
   * `null` bo'lsa CRM tenant sozlamasidagi standart ustama (markup)
   * bo'yicha hisoblaydi — pastdagi `TourSearchService.resolveNetPrice`.
   */
  netPrice?: number | null;

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
  /** `operator-catalog.ts` dagi slug bilan bir xil bo'lishi shart */
  readonly slug: string;

  /** Login/parolni operator API'sida tekshiradi */
  verifyCredentials(creds: TourAdapterCredentials): Promise<CredentialCheckResult>;

  /** Jonli qidiruv */
  searchLive(
    creds: TourAdapterCredentials,
    params: LiveSearchParams,
  ): Promise<NormalizedSearchResult[]>;

  /**
   * Yo'nalish autocomplete (ixtiyoriy).
   *
   * NEGA KERAK: ilgari qidiruv matnni o'zi region'ga aylantirib,
   * BIRINCHI natijani ko'r-ko'rona olardi. "Antalya" yozilganda
   * ba'zan noto'g'ri region tanlanib, natijalar butunlay boshqa
   * joydan kelardi va sababi ko'rinmasdi.
   */
  suggestRegions?(
    creds: TourAdapterCredentials,
    query: string,
  ): Promise<RegionSuggestion[]>;
}