/**
 * Cache qatlami — umumiy konstanta va kalit yasovchilar.
 *
 * MUHIM: bu multi-tenant tizim. Har bir cache kaliti ichida `tenantId`
 * BO'LISHI SHART — aks holda bir tenant'ning cache'i boshqasiga chiqib ketadi.
 * Shu sabab kalit formati doim `<domain>:<tenantId>:<name>:<...params>` —
 * `tenantId` prefiksdan keyin ikkinchi bo'lakda turadi, shunda butun bir
 * tenant'ni bitta pattern (`reports:<tenantId>:*`) bilan invalidatsiya qilish oson.
 */

/** ioredis mijozi uchun DI token (Redis | null — REDIS_URL bo'lmasa null). */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * TTL qiymatlari — SEKUNDDA.
 *  - SHORT (60s): tez-tez o'zgaradigan ma'lumot (dashboard, joriy statistika).
 *  - MEDIUM (300s): kunlik/oylik hisobotlar, maosh, tahlillar.
 *  - LONG (900s): deyarli o'zgarmaydigan konfiguratsiya (masalan KPI tier'lari).
 */
export const CACHE_TTL = {
  SHORT: 60,
  MEDIUM: 300,
  LONG: 900,
} as const;

/** cache-manager (CACHE_MANAGER) uchun standart TTL — millisekundda. */
export const DEFAULT_CACHE_TTL_MS = CACHE_TTL.SHORT * 1000;

const norm = (v: unknown): string =>
  v === undefined || v === null || v === '' ? '-' : String(v);

/** Hisobot cache kaliti: `reports:<tenantId>:<name>:<...params>` */
export const reportsKey = (
  tenantId: string,
  name: string,
  ...params: unknown[]
): string => `reports:${tenantId}:${name}:${params.map(norm).join(':')}`;

/** KPI cache kaliti: `kpi:<tenantId>:<name>:<...params>` */
export const kpiKey = (
  tenantId: string,
  name: string,
  ...params: unknown[]
): string => `kpi:${tenantId}:${name}:${params.map(norm).join(':')}`;

/** Bitta tenant'ning BARCHA hisobot kalitlarini qamrab oluvchi pattern. */
export const reportsTenantPattern = (tenantId: string): string =>
  `reports:${tenantId}:*`;

/** Bitta tenant'ning BARCHA KPI kalitlarini qamrab oluvchi pattern. */
export const kpiTenantPattern = (tenantId: string): string =>
  `kpi:${tenantId}:*`;