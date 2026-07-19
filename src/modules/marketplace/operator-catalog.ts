import { Logger } from '@nestjs/common';

/**
 * ═══════════════════════════════════════════════════════════════
 * TUR OPERATORLAR KATALOGI — v12.4
 * ═══════════════════════════════════════════════════════════════
 *
 * MODEL:
 *   Platforma egasi (siz) tur operatorlar bilan SHARTNOMA tuzadi va
 *   ularning API manzillarini oladi. Bu manzillar SERVERDA (env'da)
 *   turadi — agentliklar ularni ko'rmaydi va o'zgartira olmaydi.
 *
 *   Har bir agentlik (tenant) esa o'zining LOGIN/PAROLINI kiritadi —
 *   ya'ni o'sha operatordagi shaxsiy kabinetiga ulanadi.
 *
 *   Natija: siz integratsiyani BIR MARTA yozasiz, 100 ta agentlik
 *   undan foydalanadi, lekin har biri o'z akkaunti bilan.
 *
 * SOZLASH (.env):
 *   MARKETPLACE_OPERATORS_JSON='[{...},{...}]'
 *
 *   Har bir yozuv:
 *   {
 *     "slug":       "asia-tour",              // takrorlanmas kalit
 *     "name":       "Asia Tour",              // agent ko'radigan nom
 *     "logoUrl":    "https://.../logo.png",   // kartochkadagi logo
 *     "website":    "https://asiatour.uz",
 *     "apiBaseUrl": "https://api.asiatour.uz",
 *     "authType":   "login",                  // login | basic | apikey
 *     "loginPath":  "/auth/login",            // authType=login uchun
 *     "toursPath":  "/tours",                 // turlar ro'yxati
 *     "loginLabel": "Login",                  // forma yorlig'i (ixtiyoriy)
 *     "passwordLabel": "Parol",
 *     "helpText":   "Kabinetdagi login va parolingizni kiriting"
 *   }
 *
 * MUHIM: env sozlanmagan bo'lsa quyidagi BO'SH SLOTLAR ko'rinadi.
 * Ular namuna — shartnoma tuzgach haqiqiy ma'lumot bilan almashtiring.
 * Sozlanmagan operatorga ulanmoqchi bo'lsangiz tushunarli xato chiqadi.
 * ═══════════════════════════════════════════════════════════════
 */

export type OperatorAuthType = 'login' | 'basic' | 'apikey';

export interface CatalogOperator {
  slug: string;
  name: string;
  logoUrl?: string | null;
  website?: string | null;
  description?: string | null;

  /** API manzili — env'da. Bo'sh bo'lsa operator "tayyor emas" hisoblanadi */
  apiBaseUrl?: string | null;

  authType: OperatorAuthType;
  loginPath?: string | null;
  toursPath?: string | null;

  loginLabel?: string;
  passwordLabel?: string;
  helpText?: string;

  /** env'da to'liq sozlanganmi (API manzili bormi) */
  configured: boolean;
}

const logger = new Logger('OperatorCatalog');

/**
 * Standart 10 ta slot.
 *
 * Bular NAMUNA — haqiqiy operator emas. Shartnoma tuzganingizda
 * env orqali almashtiring. Nomlari ataylab neytral qoldirilgan,
 * chunki o'ylab topilgan brend nomi chalg'itadi.
 */
const PLACEHOLDER_SLOTS: CatalogOperator[] = Array.from({ length: 10 }, (_, i) => ({
  slug: `operator-${i + 1}`,
  name: `Operator ${i + 1} (sozlanmagan)`,
  logoUrl: null,
  website: null,
  description: "Shartnoma tuzilgach .env orqali sozlanadi",
  apiBaseUrl: null,
  authType: 'login' as OperatorAuthType,
  loginPath: '/auth/login',
  toursPath: '/tours',
  loginLabel: 'Login',
  passwordLabel: 'Parol',
  helpText: "Bu operator hali sozlanmagan. Platforma administratoriga murojaat qiling.",
  configured: false,
}));

let cached: CatalogOperator[] | null = null;

/** env qiymatini xavfsiz o'qiydi va tekshiradi */
function parseFromEnv(): CatalogOperator[] | null {
  const raw = process.env.MARKETPLACE_OPERATORS_JSON;
  if (!raw || !raw.trim()) return null;

  let arr: any;
  try {
    arr = JSON.parse(raw);
  } catch (e: any) {
    logger.error(
      `MARKETPLACE_OPERATORS_JSON noto'g'ri JSON: ${e.message}. ` +
      `Standart bo'sh slotlar ishlatiladi.`,
    );
    return null;
  }

  if (!Array.isArray(arr)) {
    logger.error("MARKETPLACE_OPERATORS_JSON massiv bo'lishi kerak");
    return null;
  }

  const seen = new Set<string>();
  const out: CatalogOperator[] = [];

  for (const item of arr) {
    const slug = String(item?.slug || '').trim().toLowerCase();
    const name = String(item?.name || '').trim();

    if (!slug || !name) {
      logger.warn(`Katalog yozuvi o'tkazildi — slug yoki name yo'q`);
      continue;
    }
    if (seen.has(slug)) {
      logger.warn(`Takrorlangan slug o'tkazildi: ${slug}`);
      continue;
    }
    seen.add(slug);

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
      configured: Boolean(apiBaseUrl),
    });
  }

  if (out.length === 0) {
    logger.warn('MARKETPLACE_OPERATORS_JSON bo\'sh — standart slotlar ishlatiladi');
    return null;
  }

  logger.log(`Katalog yuklandi: ${out.length} ta operator`);
  return out;
}

/** Butun katalogni qaytaradi (birinchi chaqiruvda o'qiladi va keshlanadi) */
export function getCatalog(): CatalogOperator[] {
  if (cached) return cached;
  cached = parseFromEnv() || PLACEHOLDER_SLOTS;
  return cached;
}

/** Bitta operatorni slug bo'yicha topadi */
export function getCatalogOperator(slug: string): CatalogOperator | null {
  const s = String(slug || '').trim().toLowerCase();
  return getCatalog().find((o) => o.slug === s) || null;
}

/** Testlar va env qayta yuklanganda keshni tozalaydi */
export function resetCatalogCache(): void {
  cached = null;
}