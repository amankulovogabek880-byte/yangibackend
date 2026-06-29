import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// Hierarchy: PLATFORM_OWNER > TENANT_ADMIN > MANAGER > AGENT/ACCOUNTANT
const HIERARCHY: Record<string, number> = {
  PLATFORM_OWNER: 100,
  TENANT_ADMIN: 80,
  MANAGER: 60,
  AGENT: 40,
  ACCOUNTANT: 40,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user;
    if (!user?.role) throw new ForbiddenException('Hisob aniqlanmadi');

    const userLevel = HIERARCHY[user.role] || 0;
    const passes = required.some((r) => userLevel >= (HIERARCHY[r] || 0));
    if (!passes) {
      throw new ForbiddenException(
        `Bu amalga ruxsat yo'q. Kerakli rol: ${required.join(' yoki ')}`,
      );
    }
    return true;
  }
}
