import { Injectable, NestMiddleware } from '@nestjs/common';
import { TenantContext } from './tenant-context';

/**
 * Har bir HTTP so'rovni TenantContext ichida ishga tushiradi.
 *
 * DIQQAT — TARTIB MUHIM: middleware guard'lardan OLDIN ishlaydi,
 * ya'ni bu payt `req.user` hali to'ldirilmagan. Shuning uchun bu
 * yerda faqat BO'SH kontekst ochamiz, uni keyinroq
 * TenantContextInterceptor (guard'lardan KEYIN ishlaydi) to'ldiradi.
 *
 * Nega shunday: AsyncLocalStorage'ni so'rov boshida ochish kerak,
 * aks holda kontekst zanjiri uzilib qoladi.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(req: any, _res: any, next: () => void) {
    TenantContext.run({ tenantId: null, userId: null, role: null }, () => next());
  }
}