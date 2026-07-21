import { Logger } from '@nestjs/common';

/**
 * ═══════════════════════════════════════════════════════════════
 * TUR OPERATORLAR KATALOGI — v13 (haqiqiy operatorlar bilan)
 * ═══════════════════════════════════════════════════════════════
 *
 * IKKI XIL OPERATOR TURI BOR:
 *
 * 1) hasAdapter: true — kod darajasida maxsus adapter yozilgan
 *    (masalan Ratehawk). Bular src/modules/tour-search/adapters/
 *    papkasida joylashadi va JONLI qidiruvni qo'llab-quvvatlaydi.
 *    `configured` bu operatorlar uchun DOIM true — chunki API
 *    manzili adapter kodining ichida (bu operatorlar uchun ochiq/
 *    hujjatlashtirilgan bo'lgani sababli sir emas).
 *
 * 2) hasAdapter: false — hali adapter yozilmagan. Bular UI'da
 *    ko'rinadi (nom/logo/sayt bilan), lekin ulanish tugmasi bosilsa
 *    tushunarli xabar chiqadi: "bu operator hali ulanmagan, tez orada".
 *    Adapter yozilgach shu yerda hasAdapter: true qilinadi — boshqa
 *    hech narsa o'zgarmaydi.
 *
 * ESKI (env orqali) GENERIC REST OPERATORLAR ham ishlashda davom
 * etadi — MARKETPLACE_OPERATORS_JSON orqali qo'shilgan har qanday
 * operator quyidagi ro'yxatga QO'SHILADI (ustiga yozilmaydi), agar
 * shu slug pastda band qilinmagan bo'lsa.
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

  /** kod darajasidagi maxsus adapter bormi (tour-search/adapters) */
  hasAdapter?: boolean;

  /** env'da yoki adapter orqali to'liq sozlanganmi */
  configured: boolean;
}

const logger = new Logger('OperatorCatalog');

/**
 * HAQIQIY OPERATORLAR — foydalanuvchi bergan 19 ta sayt.
 *
 * DIQQAT: bu yerda faqat OMMAVIY ma'lumot bor (nom, sayt manzili).
 * Login/parol HECH QACHON bu faylga yozilmaydi — ular har bir
 * tenant tomonidan "Ulanish" formasida kiritiladi va shifrlanib
 * DB'ga saqlanadi (marketplace.module.ts → connectCatalogOperator).
 */
const KNOWN_OPERATORS: CatalogOperator[] = [
  {
    slug: 'ratehawk',
    name: 'Ratehawk',
    website: 'https://www.ratehawk.com',
    description: 'Mehmonxonalar B2B API (Emerging Travel Group) — 2.5mln+ mehmonxona',
    apiBaseUrl: 'https://api.worldota.net/api/b2b/v3',
    authType: 'apikey',
    loginLabel: 'KEY_ID',
    passwordLabel: 'API_KEY',
    helpText:
      'Ratehawk shartnoma kabinetingizdagi "API" bo\'limidan (faqat Master account) ' +
      'KEY_ID va API_KEY qiymatlarini kiriting.',
    hasAdapter: true,
    configured: true,
  },
  {
    slug: 'asialuxe',
    name: 'Asialuxe (DMC)',
    website: 'https://b2b.asialuxe.uz/tour/dmc',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'prestige',
    name: 'Prestige',
    website: 'https://online.uz-prestige.com/search_tour',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'kompas',
    name: 'Kompas Tour',
    website: 'https://online.kompastour.uz/search_tour',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'tui-fstravel',
    name: 'TUI (Fun&Sun)',
    website: 'https://b2b.fstravel.asia/',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'kazunion',
    name: 'KazUnion',
    website: 'https://online.kazunion.com/search_tour',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'selfie',
    name: 'Selfie Travel',
    website: 'https://b2b.selfietravel.kz/search_tour',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'pegas',
    name: 'Pegas Touristik',
    website: 'https://uz.pegast.asia/ru/agency',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'anex',
    name: 'Anex Tour',
    website: 'https://agent.anextour.uz/',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'easybooking',
    name: 'EasyBooking',
    website: 'https://tours.easybooking.uz/search_tour',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'crystalbay',
    name: 'Crystalbay',
    website: 'https://booking-uz.crystalbay.com/search_tour',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'centrum-holidays',
    name: 'Centrum Holidays',
    website: 'https://online.centrum-holidays.com/search_tour',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'aqua-travel',
    name: 'Aqua Travel Plus',
    website: 'https://online.aquatravelplus.com/search_hotel',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'flykhiya',
    name: 'FlyKhiya',
    website: 'https://b2b.flykhiya.travel/',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'smart-holiday',
    name: 'Smart Holiday Group',
    website: 'http://online.smartholidaygroup.com/b2b/',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'unit-travel',
    name: 'Unit Travel',
    website: 'https://b2b.unittravel.uz',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'centbed',
    name: 'Centbed',
    website: 'https://b2b.centbed.com',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'malva',
    name: 'Malva Tour Operator',
    website: 'https://malvatouroperator.uz/search_tour',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
  {
    slug: 'jahon',
    name: 'Mir Jahon',
    website: 'https://online.mir-jahon.uz/open/excursion-tours/index',
    authType: 'login',
    hasAdapter: false,
    configured: false,
  },
].map((o) => ({
  loginPath: '/auth/login',
  toursPath: '/tours',
  loginLabel: o.authType === 'apikey' ? 'API kalit' : 'Login',
  passwordLabel: 'Parol',
  helpText:
    (o as any).helpText ||
    ((o as any).hasAdapter
      ? ''
      : "Bu operator hali ulanmagan — integratsiya navbatda. Admin bilan bog'laning."),
  ...o,
})) as CatalogOperator[];

let cached: CatalogOperator[] | null = null;

/** env orqali qo'shimcha (yoki eski) generic REST operatorlarni o'qiydi */
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

  const known = new Set(KNOWN_OPERATORS.map((o) => o.slug));
  const out: CatalogOperator[] = [];

  for (const item of arr) {
    const slug = String(item?.slug || '').trim().toLowerCase();
    const name = String(item?.name || '').trim();
    if (!slug || !name) continue;
    if (known.has(slug)) {
      logger.warn(`env'dagi "${slug}" allaqachon bilinadigan operator — o'tkazildi`);
      continue;
    }

    const authType: OperatorAuthType =
      ['login', 'basic', 'apikey'].includes(item?.authType) ? item.authType : 'login';
    const apiBaseUrl = String(item?.apiBaseUrl || '').trim().replace(/\/+$/, '') || null;

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
      configured: Boolean(apiBaseUrl),
    });
  }

  return out;
}

export function getCatalog(): CatalogOperator[] {
  if (cached) return cached;
  cached = [...KNOWN_OPERATORS, ...parseFromEnv()];
  return cached;
}

export function getCatalogOperator(slug: string): CatalogOperator | null {
  const s = String(slug || '').trim().toLowerCase();
  return getCatalog().find((o) => o.slug === s) || null;
}

export function resetCatalogCache(): void {
  cached = null;
}