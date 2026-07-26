import { Logger } from '@nestjs/common';
import { TenantContext } from './tenant-context';

/**
 * ═══════════════════════════════════════════════════════════════
 * TENANT HIMOYA QATLAMI — "defense in depth" (v12.7)
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO:
 *   Hozir tenant izolyatsiyasi HAR BIR servis metodida qo'lda
 *   yoziladi: `where: { tenantId, ... }`. Bu ishlaydi, lekin
 *   YAGONA himoya qatlami — bitta joyda unutilsa, bir agentlik
 *   boshqasining ma'lumotini ko'radi.
 *
 *   Bu nazariy xavf emas: shu loyihada AYNAN SHU sabab bilan
 *   ikkita haqiqiy sizish topildi (hisobot kalendari va pipeline
 *   tarixi). Ikkalasi ham qo'lda tekshirishda topildi — avtomatik
 *   himoya bo'lganida darhol ushlanardi.
 *
 * YECHIM:
 *   Prisma so'rovi natijasi qaytganda, qaytgan yozuvlarning
 *   `tenantId` maydonini joriy so'rov tenant'i bilan solishtiramiz.
 *   Mos kelmasa — signal beramiz.
 *
 * REJIMLAR (TENANT_GUARD env):
 *   off      — o'chirilgan
 *   warn     — faqat log'ga yozadi (STANDART, xavfsiz)
 *   enforce  — xato tashlaydi va so'rovni to'xtatadi
 *
 *   Ishlab chiqarishga birinchi marta chiqarganda 'warn' bilan
 *   boshlang: log'da nima chiqishini ko'rasiz, hech narsa buzilmaydi.
 *   Log toza bo'lgach 'enforce' ga o'ting.
 *
 * NIMA TEKSHIRILMAYDI:
 *   - `bypass` yoqilgan kontekst (cron, PLATFORM_OWNER)
 *   - kontekstda tenantId yo'q (tizim so'rovlari, login)
 *   - `tenantId` maydoni yo'q modellar (Message, UserSession va h.k.
 *     — ular bog'langan yozuv orqali himoyalanadi)
 */

const logger = new Logger('TenantGuard');

type Mode = 'off' | 'warn' | 'enforce';

function getMode(): Mode {
  const raw = (process.env.TENANT_GUARD || '').toLowerCase();
  if (['off', 'warn', 'enforce'].includes(raw)) return raw as Mode;
  // XAVFSIZLIK TUZATISH: TENANT_GUARD env qo'yilmagan bo'lsa,
  // production'da standart holat ENDI "enforce" (ilgari "warn" edi —
  // ya'ni tenant sizishi faqat log'ga yozilib, so'rov baribir davom
  // etardi). Dev'da hamon "warn" — log'da ko'rib, keyin xohlasangiz
  // enforce'ga o'tasiz.
  return process.env.NODE_ENV === 'production' ? 'enforce' : 'warn';
}

/** Natijadagi yozuvlarni tekshiradi (birinchi mos kelmaganida to'xtaydi) */
function findMismatch(result: any, tenantId: string): string | null {
  if (result === null || result === undefined) return null;

  const check = (rec: any): string | null => {
    if (!rec || typeof rec !== 'object') return null;
    // tenantId maydoni bo'lmagan modellar tekshirilmaydi
    if (!('tenantId' in rec)) return null;
    const rt = rec.tenantId;
    if (rt === null || rt === undefined) return null;
    return rt === tenantId ? null : String(rt);
  };

  if (Array.isArray(result)) {
    for (const r of result) {
      const bad = check(r);
      if (bad) return bad;
    }
    return null;
  }
  return check(result);
}

/**
 * PrismaService.onModuleInit ichida chaqiriladi.
 * `$use` — Prisma 5 middleware API'si.
 */
export function installTenantGuard(prisma: any): void {
  const mode = getMode();
  if (mode === 'off') {
    logger.log("Tenant guard O'CHIRILGAN (TENANT_GUARD=off)");
    return;
  }

  logger.log(`Tenant guard yoqildi — rejim: ${mode.toUpperCase()}`);

  prisma.$use(async (params: any, next: (p: any) => Promise<any>) => {
    const result = await next(params);

    const ctx = TenantContext.get();
    // Kontekst yo'q, bypass yoqilgan yoki tenant noma'lum — tekshirmaymiz
    if (!ctx || ctx.bypass || !ctx.tenantId) return result;

    // Faqat o'qish amaliyotlarini tekshiramiz (yozishda tenantId
    // servis tomonidan beriladi va natija qaytmasligi mumkin)
    const readActions = ['findUnique', 'findFirst', 'findMany', 'findUniqueOrThrow', 'findFirstOrThrow'];
    if (!readActions.includes(params.action)) return result;

    const bad = findMismatch(result, ctx.tenantId);
    if (!bad) return result;

    const msg =
      `TENANT SIZISHI: ${params.model}.${params.action} — ` +
      `so'rov tenant'i "${ctx.tenantId}", lekin natijada "${bad}" bor. ` +
      `Servis metodida where: { tenantId } unutilgan bo'lishi mumkin.`;

    if (mode === 'enforce') {
      logger.error(msg);
      throw new Error("Tenant izolyatsiyasi buzildi — so'rov to'xtatildi");
    }

    logger.error(msg);
    return result;
  });
}