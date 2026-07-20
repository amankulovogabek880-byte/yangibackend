import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { isOriginAllowed } from '../config/cors.config';

/**
 * ═══════════════════════════════════════════════════════════════
 * CSRF himoyasi — faqat COOKIE'ga tayanadigan endpointlar uchun
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO:
 *   /auth/refresh @Public va faqat httpOnly cookie'ga tayanadi.
 *   Production'da cookie SameSite=none (frontend va backend turli
 *   domenda). Ya'ni zararli sayt foydalanuvchi brauzeridan bizning
 *   /auth/refresh'ga so'rov yuborsa, brauzer cookie'ni AVTOMATIK
 *   qo'shadi va yangi token beriladi — bu CSRF.
 *
 * NEGA "double-submit cookie" EMAS:
 *   Klassik usulda JS cookie'ni o'qib, header'ga qo'yadi. Lekin
 *   frontend (omoncrm.uz) backend (api.onrender.com) domenidagi
 *   cookie'ni O'QIY OLMAYDI — bular boshqa-boshqa origin. Shuning
 *   uchun bu usul cross-domain arxitekturada ishlamaydi.
 *
 * YECHIM — Origin tekshiruvi:
 *   Brauzer cross-site POST so'rovlarida `Origin` sarlavhasini
 *   HAR DOIM yuboradi va uni JavaScript orqali soxtalashtirib
 *   bo'lmaydi. Demak Origin ruxsat etilgan ro'yxatda bo'lmasa —
 *   bu boshqa saytdan kelgan so'rov, rad etamiz.
 *
 *   DIQQAT: CORS o'zi yetarli emas! CORS faqat JAVOBNI o'qishni
 *   bloklaydi, so'rovning O'ZI baribir bajariladi. Shuning uchun
 *   bu yerda so'rovni ATAYLAB rad etamiz.
 *
 * Origin bo'lmasa (Postman, server-server, mobil ilova) — ruxsat
 * beramiz: brauzerni cross-site so'rovda Origin'ni tashlab ketishga
 * majburlab bo'lmaydi, demak bu hujum yo'li emas.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly logger = new Logger('CSRF');

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();

    const origin: string | undefined = req.headers?.origin;

    // Origin yo'q — brauzer emas (yoki same-origin GET). Ruxsat.
    if (!origin) return true;

    if (isOriginAllowed(origin)) return true;

    this.logger.warn(
      `CSRF: ruxsatsiz origin rad etildi — ${origin} → ${req.method} ${req.url}`,
    );
    throw new ForbiddenException(
      "Bu so'rov ruxsat etilmagan manbadan kelgan (CSRF himoyasi)",
    );
  }
}