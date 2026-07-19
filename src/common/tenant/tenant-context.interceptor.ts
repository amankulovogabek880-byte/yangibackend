import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContext } from './tenant-context';

/**
 * Guard'lar `req.user` ni to'ldirgandan KEYIN ishlaydi va joriy
 * so'rov kontekstiga tenantId/userId/role yozadi.
 *
 * PLATFORM_OWNER uchun `bypass` yoqiladi — u ataylab barcha
 * tenantlar ma'lumotini ko'radi (platforma boshqaruvi).
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest?.();
    const user = req?.user;
    const store = TenantContext.get();

    if (store && user) {
      store.tenantId = user.tenantId ?? null;
      store.userId = user.sub ?? user.id ?? null;
      store.role = user.role ?? null;
      // Platforma egasi barcha tenantlarni ko'radi — bu ataylab
      store.bypass = user.role === 'PLATFORM_OWNER';
    }

    return next.handle();
  }
}