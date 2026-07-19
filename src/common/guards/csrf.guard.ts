import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
} from '@nestjs/common';
import { isOriginAllowed } from '../config/cors.config';

/**
 * Faqat cookie'ga tayanadigan endpointlar (refresh, logout) uchun CSRF himoyasi.
 * SameSite=None cookie cross-site so'rovlarda ham avtomatik yuboriladi,
 * shuning uchun Origin header ruxsat etilgan ro'yxatda ekanini tekshiramiz.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const origin = req.headers.origin as string | undefined;

    // Origin yo'q (server-to-server, mobil ilova) — ruxsat beramiz.
    if (!origin) return true;

    if (!isOriginAllowed(origin)) {
      throw new ForbiddenException("CSRF himoyasi: ruxsat etilmagan manba");
    }
    return true;
  }
}