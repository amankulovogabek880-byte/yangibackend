import { CanActivate, ExecutionContext } from '@nestjs/common';
export declare class LoginRateLimitGuard implements CanActivate {
    private readonly logger;
    private readonly MAX;
    private readonly WINDOW_MS;
    canActivate(ctx: ExecutionContext): boolean;
}
