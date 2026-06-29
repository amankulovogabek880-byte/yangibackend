import {
  Injectable, CanActivate, ExecutionContext,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';

// In-memory IP rate limiter (login uchun)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimit');
  private readonly MAX = parseInt(process.env.LOGIN_RATE_LIMIT || '10', 10);
  private readonly WINDOW_MS = parseInt(process.env.LOGIN_RATE_WINDOW_MS || '900000', 10); // 15 min

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.ip || 'unknown';

    const now = Date.now();
    const key = `login:${ip}`;
    const existing = loginAttempts.get(key);

    if (!existing || existing.resetAt < now) {
      loginAttempts.set(key, { count: 1, resetAt: now + this.WINDOW_MS });
      return true;
    }

    existing.count++;
    if (existing.count > this.MAX) {
      const waitMin = Math.ceil((existing.resetAt - now) / 60000);
      this.logger.warn(`Login rate limit: IP=${ip} attempts=${existing.count}`);
      throw new HttpException(
        `Juda ko'p urinish. ${waitMin} daqiqadan keyin qayta urinib ko'ring.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

// Cleanup every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of loginAttempts.entries()) {
    if (val.resetAt < now) loginAttempts.delete(key);
  }
}, 30 * 60 * 1000);
