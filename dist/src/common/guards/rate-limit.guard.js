"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoginRateLimitGuard = void 0;
const common_1 = require("@nestjs/common");
const loginAttempts = new Map();
let LoginRateLimitGuard = class LoginRateLimitGuard {
    constructor() {
        this.logger = new common_1.Logger('RateLimit');
        this.MAX = parseInt(process.env.LOGIN_RATE_LIMIT || '10', 10);
        this.WINDOW_MS = parseInt(process.env.LOGIN_RATE_WINDOW_MS || '900000', 10);
    }
    canActivate(ctx) {
        const req = ctx.switchToHttp().getRequest();
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
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
            throw new common_1.HttpException(`Juda ko'p urinish. ${waitMin} daqiqadan keyin qayta urinib ko'ring.`, common_1.HttpStatus.TOO_MANY_REQUESTS);
        }
        return true;
    }
};
exports.LoginRateLimitGuard = LoginRateLimitGuard;
exports.LoginRateLimitGuard = LoginRateLimitGuard = __decorate([
    (0, common_1.Injectable)()
], LoginRateLimitGuard);
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of loginAttempts.entries()) {
        if (val.resetAt < now)
            loginAttempts.delete(key);
    }
}, 30 * 60 * 1000);
//# sourceMappingURL=rate-limit.guard.js.map