import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { hasPermission, PermissionKey } from '../permissions/permissions.constants';

/**
 * `@RequirePermission('export_data')` bilan birga ishlatiladi.
 * TENANT_ADMIN/PLATFORM_OWNER'ga har doim ruxsat beradi; boshqa rollar
 * uchun foydalanuvchining `permissions` (Json) ustunidagi override yoki
 * rol bo'yicha standart ruxsatni tekshiradi.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey>('permission', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest();
    const authUser = req.user;
    if (!authUser?.sub && !authUser?.id) throw new ForbiddenException('Hisob aniqlanmadi');

    // JWT payload'da `permissions` bo'lmasligi mumkin (token eski bo'lsa) —
    // shuning uchun har doim bazadan yangilangan holatni o'qiymiz.
    const dbUser = await this.prisma.user.findUnique({
      where: { id: authUser.sub || authUser.id },
      select: { role: true, permissions: true },
    });
    if (!dbUser) throw new ForbiddenException('Hisob topilmadi');

    const allowed = hasPermission(
      { role: dbUser.role, permissions: (dbUser.permissions as any) || null },
      required,
    );
    if (!allowed) {
      throw new ForbiddenException(`Bu amal uchun "${required}" ruxsati kerak. Administratordan so'rang.`);
    }
    return true;
  }
}