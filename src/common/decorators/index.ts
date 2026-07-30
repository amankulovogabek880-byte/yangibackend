import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../permissions/permissions.constants';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user,
);

export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

export const Public = () => SetMetadata('isPublic', true);

export const SkipAudit = () => SetMetadata('skipAudit', true);

// v17: moslashtiriladigan ruxsat (custom permission) — PermissionsGuard bilan
// birga ishlaydi. Masalan: @RequirePermission('export_data')
export const RequirePermission = (key: PermissionKey) => SetMetadata('permission', key);