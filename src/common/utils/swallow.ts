import { Logger } from '@nestjs/common';

const logger = new Logger('Swallowed');

/**
 * ═══════════════════════════════════════════════════════════════
 * "Yon amal" xatolarini LOG bilan yutish (v12.5)
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO:
 *   Kod bo'ylab 70 ta `.catch(swallow('yon amal'))` bor edi. Ular ataylab
 *   qo'yilgan — masalan bildirishnoma yuborilmasa ham booking
 *   yaratilishi to'xtamasligi kerak. Bu MANTIQAN to'g'ri.
 *
 *   Lekin xato BUTUNLAY yo'qolardi. Natijada:
 *     - Bildirishnomalar kelmayapti, lekin log toza
 *     - Audit yozuvlari yozilmayapti, hech kim bilmaydi
 *     - Muammoni topish uchun hech qanday iz yo'q
 *
 * YECHIM:
 *   `.catch(swallow('yon amal'))`  →  `.catch(swallow('bildirishnoma'))`
 *
 *   Asosiy amal baribir to'xtamaydi (avvalgidek), lekin xato
 *   Winston log'iga tushadi va muammoni ko'rish mumkin bo'ladi.
 *
 * NEGA `this.logger` EMAS:
 *   Barcha joylar klass ichida emas. `this.logger` klassdan tashqarida
 *   ishlatilsa, TypeScript ushlamaydi (strict rejim o'chiq), lekin
 *   ishga tushganda qulaydi. Bu funksiya `this` ga bog'liq emas —
 *   istalgan joyda xavfsiz.
 *
 * ISHLATISH:
 *   await this.notifications.create({...}).catch(swallow('bildirishnoma'));
 *   await this.audit.log({...}).catch(swallow('audit'));
 */
export function swallow(context: string) {
  return (e: any): void => {
    const msg = e?.message ?? e?.toString?.() ?? 'noma\'lum xato';
    logger.warn(`${context} bajarilmadi: ${msg}`);
  };
}

/**
 * Xatoni butunlay e'tiborsiz qoldirish kerak bo'lgan NOYOB holatlar uchun
 * (masalan ixtiyoriy tozalash). Ataylab qilinganini bildiradi.
 */
export function ignore(): void {
  /* ataylab bo'sh */
}