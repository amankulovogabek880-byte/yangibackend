import { Logger } from '@nestjs/common';

/**
 * ═══════════════════════════════════════════════════════════════
 * TUR OPERATORLAR KATALOGI — v14
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO (tuzatishdan oldin):
 *   Katalogda 19 ta operator ko'rinardi, lekin ulardan FAQAT BITTASI
 *   (Ratehawk) haqiqatan ishlardi. Qolgan 18 tasining kartochkasini
 *   bosgan foydalanuvchi "bu operator hali ulanmagan" degan xabarni
 *   olardi.
 *
 *   Sotuvda bu halokatli: mijoz 19 ta logotipni ko'rib umid qiladi,
 *   keyin 18 marta devorga uriladi va "ishlamaydigan mahsulot" degan
 *   xulosaga keladi.
 *
 * YECHIM:
 *   Har bir operatorda endi `available` bayrog'i bor.
 *
 *     available: true   → hoziroq ulanadi va ishlaydi
 *     available: false  → "Tez orada" bo'limida, ALOHIDA ko'rsatiladi,
 *                         ulanish tugmasi YO'Q, faqat "Menga xabar
 *                         bering" tugmasi bo'ladi
 *
 *   Frontend ikkalasini ARALASHTIRMAYDI. Foydalanuvchi darhol nima
 *   ishlashini va nima kutilayotganini ko'radi — bu ishonch beradi,
 *   soxta va'da esa ishonchni yo'q qiladi.
 *
 * IKKI XIL ISHLAYDIGAN OPERATOR TURI:
 *   1) hasAdapter: true — kod adapteri bor (tour-search/adapters).
 *      Jonli qidiruv: narx/joy har safar so'raladi, DB'ga yozilmaydi.
 *   2) hasAdapter: false + apiBaseUrl bor — generic REST.
 *      Statik import: turlar bir marta tortiladi va DB'da saqlanadi.
 * ═══════════════════════════════════════════════════════════════
 */

export type OperatorAuthType = 'login' | 'basic' | 'apikey';

export interface CatalogOperator {
  slug: string;
  name: string;
  logoUrl?: string | null;
  website?: string | null;
  description?: string | null;

  apiBaseUrl?: string | null;

  authType: OperatorAuthType;
  loginPath?: string | null;
  toursPath?: string | null;

  loginLabel?: string;
  passwordLabel?: string;
  helpText?: string;

  /** Kod darajasidagi maxsus adapter bormi (tour-search/adapters) */
  hasAdapter?: boolean;

  /** API manzili sozlanganmi (env yoki adapter orqali) */
  configured: boolean;

  /**
   * HOZIR ULANSA ISHLAYDIMI.
   * `false` bo'lsa frontend uni "Tez orada" bo'limida, ulanish
   * tugmasisiz ko'rsatadi.
   */
  available: boolean;

  /** Nima orqali ishlaydi — UI'da tushuntirish uchun */
  mode: 'live-search' | 'static-import' | 'manual-csv' | 'coming-soon';
}

const logger = new Logger('OperatorCatalog');

/**
 * ISHLAYDIGAN OPERATORLAR.
 *
 * Bu ro'yxatga operator FAQAT adapteri yozilgach yoki API manzili
 * sozlangach qo'shiladi. "Yozamiz" degan niyat bilan qo'shilmaydi.
 */
const WORKING_OPERATORS: Array<Partial<CatalogOperator> & { slug: string; name: string }> = [
  {
    slug: 'ratehawk',
    name: 'Ratehawk',
    website: 'https://www.ratehawk.com',
    description: 'Mehmonxonalar B2B API (Emerging Travel Group) — 2.5 mln+ mehmonxona',
    apiBaseUrl: 'https://api.worldota.net/api/b2b/v3',
    // 'apikey' EMAS: u frontendda bitta maydon ko'rsatadi. Ratehawk esa
    // ikkita qiymat (KEY_ID + API_KEY) talab qiladi → 'basic'.
    // Backendga ta'siri yo'q — hasAdapter true bo'lgani uchun tekshiruv
    // har doim RatehawkAdapter orqali boradi.
    authType: 'basic',
    loginLabel: 'KEY_ID',
    passwordLabel: 'API_KEY',
    helpText:
      'Ratehawk shartnoma kabinetingizdagi "API" bo\'limidan (faqat Master account) ' +
      'KEY_ID va API_KEY qiymatlarini oling va shu yerga kiriting.',
    hasAdapter: true,
    configured: true,
    available: true,
    mode: 'live-search',
  },
];

/**
 * HALI ULANMAGAN OPERATORLAR.
 *
 * Bular UI'da ALOHIDA, "Tez orada" bo'limida ko'rinadi. Ulanish
 * tugmasi yo'q. Foydalanuvchi ular ustida vaqt sarflamaydi.
 *
 * MUHIM: bu operatorlarning aksariyati Samo/Mega-tour tipidagi B2B
 * portallar — ularda ochiq REST API YO'Q. "Login → token → /tours"
 * degan generic oqim ular uchun ishlamaydi. Har biriga yo rasmiy
 * XML/SOAP shartnoma, yo portal adapteri kerak.
 *
 * SHU PAYTGACHA: bu operatorlar bilan CSV/Excel orqali ishlanadi
 * (Sozlamalar → Tur operatorlar → "Qo'lda operator qo'shish").
 */
const COMING_SOON: Array<{ slug: string; name: string; website: string }> = [
  { slug: 'asialuxe',         name: 'Asialuxe (DMC)',        website: 'https://b2b.asialuxe.uz/tour/dmc' },
  { slug: 'prestige',         name: 'Prestige',              website: 'https://online.uz-prestige.com/search_tour' },
  { slug: 'kompas',           name: 'Kompas Tour',           website: 'https://online.kompastour.uz/search_tour' },
  { slug: 'tui-fstravel',     name: 'TUI (Fun&Sun)',         website: 'https://b2b.fstravel.asia/' },
  { slug: 'kazunion',         name: 'KazUnion',              website: 'https://online.kazunion.com/search_tour' },
  { slug: 'selfie',           name: 'Selfie Travel',         website: 'https://b2b.selfietravel.kz/search_tour' },
  { slug: 'pegas',            name: 'Pegas Touristik',       website: 'https://uz.pegast.asia/ru/agency' },
  { slug: 'anex',             name: 'Anex Tour',             website: 'https://agent.anextour.uz/' },
  { slug: 'easybooking',      name: 'EasyBooking',           website: 'https://tours.easybooking.uz/search_tour' },
  { slug: 'crystalbay',       name: 'Crystalbay',            website: 'https://booking-uz.crystalbay.com/search_tour' },
  { slug: 'centrum-holidays', name: 'Centrum Holidays',      website: 'https://online.centrum-holidays.com/search_tour' },
  { slug: 'aqua-travel',      name: 'Aqua Travel Plus',      website: 'https://online.aquatravelplus.com/search_hotel' },
  { slug: 'flykhiya',         name: 'FlyKhiya',              website: 'https://b2b.flykhiya.travel/' },
  { slug: 'smart-holiday',    name: 'Smart Holiday Group',   website: 'http://online.smartholidaygroup.com/b2b/' },
  { slug: 'unit-travel',      name: 'Unit Travel',           website: 'https://b2b.unittravel.uz' },
  { slug: 'centbed',          name: 'Centbed',               website: 'https://b2b.centbed.com' },
  { slug: 'malva',            name: 'Malva Tour Operator',   website: 'https://malvatouroperator.uz/search_tour' },
  { slug: 'jahon',            name: 'Mir Jahon',             website: 'https://online.mir-jahon.uz/open/excursion-tours/index' },
];

function buildKnown(): CatalogOperator[] {
  const working: CatalogOperator[] = WORKING_OPERATORS.map((o) => ({
    loginPath: '/auth/login',
    toursPath: '/tours',
    loginLabel: o.authType === 'apikey' ? 'API kalit' : 'Login',
    passwordLabel: 'Parol',
    helpText: '',
    logoUrl: null,
    website: null,
    description: null,
    apiBaseUrl: null,
    authType: 'login' as OperatorAuthType,
    hasAdapter: false,
    configured: false,
    available: true,
    mode: 'static-import' as const,
    ...o,
  })) as CatalogOperator[];

  const soon: CatalogOperator[] = COMING_SOON.map((o) => ({
    slug: o.slug,
    name: o.name,
    website: o.website,
    logoUrl: null,
    description: null,
    apiBaseUrl: null,
    authType: 'login' as OperatorAuthType,
    loginPath: '/auth/login',
    toursPath: '/tours',
    loginLabel: 'Login',
    passwordLabel: 'Parol',
    helpText:
      "Bu operator bilan avtomatik integratsiya hali tayyor emas. " +
      "Hozircha turlarni Excel/CSV orqali yuklashingiz mumkin " +
      "(Sozlamalar → Tur operatorlar → «Qo'lda operator qo'shish»).",
    hasAdapter: false,
    configured: false,
    available: false,
    mode: 'coming-soon' as const,
  }));

  return [...working, ...soon];
}

const KNOWN_OPERATORS: CatalogOperator[] = buildKnown();

let cached: CatalogOperator[] | null = null;

/**
 * env orqali qo'shimcha generic REST operatorlarni o'qiydi.
 * Bu yerdan kelganlar HAR DOIM `available: true` — chunki admin
 * ularni ataylab, ishlaydigan API manzili bilan qo'shgan.
 */
function parseFromEnv(): CatalogOperator[] {
  const raw = process.env.MARKETPLACE_OPERATORS_JSON;
  if (!raw || !raw.trim()) return [];

  let arr: any;
  try {
    arr = JSON.parse(raw);
  } catch (e: any) {
    logger.error(`MARKETPLACE_OPERATORS_JSON noto'g'ri JSON: ${e.message}`);
    return [];
  }
  if (!Array.isArray(arr)) {
    logger.error("MARKETPLACE_OPERATORS_JSON massiv bo'lishi kerak");
    return [];
  }

  const out: CatalogOperator[] = [];

  for (const item of arr) {
    const slug = String(item?.slug || '').trim().toLowerCase();
    const name = String(item?.name || '').trim();
    if (!slug || !name) continue;

    const authType: OperatorAuthType = ['login', 'basic', 'apikey'].includes(item?.authType)
      ? item.authType
      : 'login';
    const apiBaseUrl = String(item?.apiBaseUrl || '').trim().replace(/\/+$/, '') || null;

    if (!apiBaseUrl) {
      logger.warn(`env'dagi "${slug}" operatorida apiBaseUrl yo'q — o'tkazib yuborildi`);
      continue;
    }

    out.push({
      slug,
      name,
      logoUrl: item?.logoUrl || null,
      website: item?.website || null,
      description: item?.description || null,
      apiBaseUrl,
      authType,
      loginPath: item?.loginPath || '/auth/login',
      toursPath: item?.toursPath || '/tours',
      loginLabel: item?.loginLabel || (authType === 'apikey' ? 'API kalit' : 'Login'),
      passwordLabel: item?.passwordLabel || 'Parol',
      helpText: item?.helpText || '',
      hasAdapter: false,
      configured: true,
      available: true,
      mode: 'static-import',
    });
  }

  return out;
}

export function getCatalog(): CatalogOperator[] {
  if (cached) return cached;

  const fromEnv = parseFromEnv();
  const envSlugs = new Set(fromEnv.map((o) => o.slug));

  // env'dagi operator "tez orada" ro'yxatidagi bilan bir xil slug'ga ega
  // bo'lsa — env yutadi (admin uni haqiqatan sozlagan).
  const base = KNOWN_OPERATORS.filter((o) => !envSlugs.has(o.slug));

  cached = [...base, ...fromEnv];
  return cached;
}

/** Faqat hoziroq ulanadigan operatorlar */
export function getAvailableCatalog(): CatalogOperator[] {
  return getCatalog().filter((o) => o.available);
}

export function getCatalogOperator(slug: string): CatalogOperator | null {
  const s = String(slug || '').trim().toLowerCase();
  return getCatalog().find((o) => o.slug === s) || null;
}

export function resetCatalogCache(): void {
  cached = null;
}