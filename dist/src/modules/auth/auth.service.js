"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const argon2 = __importStar(require("argon2"));
const crypto = __importStar(require("crypto"));
const otplib_1 = require("otplib");
const QRCode = __importStar(require("qrcode"));
const geoip = __importStar(require("geoip-lite"));
const ua_parser_js_1 = require("ua-parser-js");
const prisma_service_1 = require("../../prisma/prisma.service");
const encryption_service_1 = require("../../common/encryption/encryption.service");
const email_service_1 = require("../email/email.service");
const notifications_service_1 = require("../notifications/notifications.service");
async function hashPassword(password) {
    return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
    });
}
async function verifyPassword(hash, password) {
    try {
        return await argon2.verify(hash, password);
    }
    catch {
        return false;
    }
}
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}
let AuthService = class AuthService {
    constructor(prisma, jwt, encryption, email, notifications) {
        this.prisma = prisma;
        this.jwt = jwt;
        this.encryption = encryption;
        this.email = email;
        this.notifications = notifications;
        this.logger = new common_1.Logger('Auth');
        this.MAX_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10);
        this.LOCK_MINUTES = parseInt(process.env.LOGIN_LOCK_MINUTES || '15', 10);
        this.MIN_PASSWORD_LEN = parseInt(process.env.MIN_PASSWORD_LENGTH || '8', 10);
        this.REQUIRE_2FA_ADMINS = process.env.REQUIRE_2FA_ADMINS === 'true';
        this.DETECT_FOREIGN = process.env.DETECT_FOREIGN_LOGINS === 'true';
        this.NOTIFY_NEW_DEVICE = process.env.NOTIFY_NEW_DEVICE === 'true';
        otplib_1.authenticator.options = { window: 1, step: 30 };
    }
    validatePassword(password) {
        if (!password || password.length < this.MIN_PASSWORD_LEN) {
            throw new common_1.BadRequestException(`Parol kamida ${this.MIN_PASSWORD_LEN} belgi bo'lishi kerak`);
        }
    }
    parseDevice(userAgent) {
        if (!userAgent)
            return "Noma'lum qurilma";
        const ua = new ua_parser_js_1.UAParser(userAgent);
        const browser = ua.getBrowser().name || 'Browser';
        const os = ua.getOS().name || 'OS';
        return `${browser} on ${os}`;
    }
    lookupGeo(ip) {
        if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.')) {
            return { country: 'LOCAL', city: 'Localhost' };
        }
        const cleanIp = ip.replace(/^::ffff:/, '');
        const geo = geoip.lookup(cleanIp);
        if (!geo)
            return {};
        return { country: geo.country, city: geo.city };
    }
    async logAttempt(params) {
        await this.prisma.loginAttempt.create({
            data: {
                email: params.email, userId: params.userId,
                ip: params.ip, userAgent: params.userAgent, country: params.country,
                success: params.success, reason: params.reason,
            },
        });
    }
    async checkAndIncrementFailures(user, alertTo) {
        const newCount = user.failedLoginCount + 1;
        const update = { failedLoginCount: newCount };
        if (newCount >= this.MAX_ATTEMPTS) {
            update.lockedUntil = new Date(Date.now() + this.LOCK_MINUTES * 60 * 1000);
            update.failedLoginCount = 0;
            if (alertTo?.email) {
                this.email.sendFailedLoginAlert(alertTo.email, alertTo.name, newCount).catch(() => { });
            }
        }
        await this.prisma.user.update({ where: { id: user.id }, data: update });
    }
    async login(email, password, twoFactorCode, ip, userAgent) {
        if (!email?.trim() || !password)
            throw new common_1.BadRequestException('Email va parol majburiy');
        const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
        if (!emailRe.test(email.trim()))
            throw new common_1.UnauthorizedException("Email yoki parol noto'g'ri");
        const cleanEmail = email.toLowerCase().trim();
        const geo = this.lookupGeo(ip);
        const device = this.parseDevice(userAgent);
        const users = await this.prisma.user.findMany({
            where: { email: cleanEmail },
            include: { tenant: true },
            orderBy: [
                { status: 'asc' },
                { createdAt: 'desc' },
            ],
        });
        const user = users.find(u => u.status === 'ACTIVE') || users[0] || null;
        if (!user) {
            await this.logAttempt({ email: cleanEmail, ip, userAgent, country: geo.country, success: false, reason: 'wrong_email' });
            await argon2.hash('dummy-string-to-prevent-timing-attack');
            throw new common_1.UnauthorizedException("Email yoki parol noto'g'ri");
        }
        if (user.lockedUntil && user.lockedUntil > new Date()) {
            const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
            await this.logAttempt({ email: cleanEmail, userId: user.id, ip, userAgent, country: geo.country, success: false, reason: 'locked' });
            throw new common_1.ForbiddenException(`Hisob ${minutesLeft} daqiqa muddatga bloklangan`);
        }
        if (user.status !== 'ACTIVE') {
            throw new common_1.ForbiddenException(`Hisob ${user.status} holatida`);
        }
        if (user.tenant && user.tenant.status === 'SUSPENDED' && user.role !== 'PLATFORM_OWNER') {
            throw new common_1.ForbiddenException("Kompaniya hisobi to'xtatilgan");
        }
        const passwordOk = await verifyPassword(user.passwordHash, password);
        if (!passwordOk) {
            await this.logAttempt({ email: cleanEmail, userId: user.id, ip, userAgent, country: geo.country, success: false, reason: 'wrong_password' });
            await this.checkAndIncrementFailures(user, { email: user.email, name: user.name });
            throw new common_1.UnauthorizedException("Email yoki parol noto'g'ri");
        }
        if (user.failedLoginCount > 0 || user.lockedUntil) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: { failedLoginCount: 0, lockedUntil: null },
            });
        }
        if (user.twoFactorEnabled) {
            if (!twoFactorCode) {
                return { requires2FA: true, userId: user.id };
            }
            const secret = this.encryption.decrypt(user.twoFactorSecret);
            if (!secret)
                throw new common_1.UnauthorizedException('2FA sozlamalari xato');
            const isValid = otplib_1.authenticator.verify({ token: twoFactorCode.replace(/\s/g, ''), secret }) ||
                (user.twoFactorBackup || []).some((bc) => this.encryption.decrypt(bc) === twoFactorCode);
            if (!isValid) {
                await this.logAttempt({ email: cleanEmail, userId: user.id, ip, userAgent, country: geo.country, success: false, reason: '2fa_failed' });
                await this.checkAndIncrementFailures(user, { email: user.email, name: user.name });
                throw new common_1.UnauthorizedException("2FA kodi noto'g'ri");
            }
            const backupUsed = (user.twoFactorBackup || []).findIndex((bc) => this.encryption.decrypt(bc) === twoFactorCode);
            if (backupUsed >= 0) {
                const newBackup = [...user.twoFactorBackup];
                newBackup.splice(backupUsed, 1);
                await this.prisma.user.update({ where: { id: user.id }, data: { twoFactorBackup: newBackup } });
            }
        }
        const tokens = await this.generateTokens(user);
        const refreshHash = hashToken(tokens.refreshToken);
        const refreshExpiresInDays = parseInt((process.env.JWT_REFRESH_EXPIRES || '7d').replace('d', ''), 10);
        const existingSessions = await this.prisma.userSession.findMany({
            where: { userId: user.id, revokedAt: null },
        });
        const isNewDevice = existingSessions.length > 0 && !existingSessions.some((s) => s.deviceName === device && s.ip === ip);
        try {
            await this.prisma.userSession.create({
                data: {
                    userId: user.id,
                    refreshTokenHash: refreshHash,
                    ip, userAgent,
                    deviceName: device,
                    country: geo.country,
                    city: geo.city,
                    isCurrent: true,
                    expiresAt: new Date(Date.now() + refreshExpiresInDays * 86400000),
                },
            });
        }
        catch (sessionErr) {
            if (sessionErr?.code === 'P2002') {
                await this.prisma.userSession.updateMany({
                    where: { userId: user.id, revokedAt: null },
                    data: { revokedAt: new Date(), revokedReason: 'duplicate_session' },
                });
                await this.prisma.userSession.create({
                    data: {
                        userId: user.id,
                        refreshTokenHash: refreshHash + '_retry_' + Date.now(),
                        ip, userAgent,
                        deviceName: device,
                        country: geo.country,
                        city: geo.city,
                        isCurrent: true,
                        expiresAt: new Date(Date.now() + refreshExpiresInDays * 86400000),
                    },
                });
            }
        }
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                lastLoginAt: new Date(), lastLoginIp: ip,
                lastSeenAt: new Date(),
                failedLoginCount: 0, lockedUntil: null,
            },
        });
        await this.logAttempt({ email: cleanEmail, userId: user.id, ip, userAgent, country: geo.country, success: true, reason: 'ok' });
        if (isNewDevice && this.NOTIFY_NEW_DEVICE) {
            this.email.sendLoginAlert(user.email, user.name, {
                deviceName: device, ip, country: geo.country, city: geo.city, time: new Date(),
            }).catch(() => { });
            this.notifications.create({
                tenantId: user.tenantId, userId: user.id,
                type: 'SECURITY_NEW_LOGIN',
                title: '🔔 Yangi qurilmadan kirildi',
                body: `${device} — ${geo.city || geo.country || ip || 'noma\'lum'}`,
                metadata: { ip, device, country: geo.country },
            }).catch(() => { });
        }
        if (this.DETECT_FOREIGN && geo.country && geo.country !== 'LOCAL' && geo.country !== 'UZ') {
            this.notifications.create({
                tenantId: user.tenantId, userId: user.id,
                type: 'SECURITY_SUSPICIOUS_ACTIVITY',
                title: '⚠️ Boshqa davlatdan kirish',
                body: `Davlat: ${geo.country}, IP: ${ip}`,
                metadata: { ip, country: geo.country },
            }).catch(() => { });
        }
        return { ...tokens, user: this.sanitize(user) };
    }
    async refresh(refreshToken, ip, userAgent) {
        if (!refreshToken)
            throw new common_1.UnauthorizedException("Token yo'q");
        try {
            await this.jwt.verifyAsync(refreshToken, { secret: process.env.JWT_REFRESH_SECRET });
        }
        catch {
            throw new common_1.UnauthorizedException("Token noto'g'ri yoki muddati tugagan");
        }
        const hash = hashToken(refreshToken);
        const session = await this.prisma.userSession.findUnique({
            where: { refreshTokenHash: hash },
            include: { user: { include: { tenant: true } } },
        });
        if (!session || session.revokedAt || session.expiresAt < new Date()) {
            if (session && !session.revokedAt) {
                await this.prisma.userSession.updateMany({
                    where: { userId: session.userId, revokedAt: null },
                    data: { revokedAt: new Date(), revokedReason: 'token_replay_suspected' },
                });
                this.logger.warn('Refresh token replay suspected for user: ' + session.userId);
            }
            throw new common_1.UnauthorizedException("Token amal qilmaydi");
        }
        const user = session.user;
        if (user.status !== 'ACTIVE')
            throw new common_1.ForbiddenException('Hisob faol emas');
        if (user.tenant?.status === 'SUSPENDED' && user.role !== 'PLATFORM_OWNER') {
            throw new common_1.ForbiddenException("Kompaniya hisobi to'xtatilgan");
        }
        const tokens = await this.generateTokens(user);
        const newHash = hashToken(tokens.refreshToken);
        const refreshExpiresInDays = parseInt((process.env.JWT_REFRESH_EXPIRES || '7d').replace('d', ''), 10);
        await this.prisma.userSession.update({
            where: { id: session.id },
            data: {
                refreshTokenHash: newHash,
                lastActiveAt: new Date(),
                ip, userAgent,
                expiresAt: new Date(Date.now() + refreshExpiresInDays * 86400000),
            },
        });
        return { ...tokens, user: this.sanitize(user) };
    }
    async logout(refreshToken) {
        if (!refreshToken)
            return { ok: true };
        const hash = hashToken(refreshToken);
        await this.prisma.userSession.updateMany({
            where: { refreshTokenHash: hash, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'user_logout' },
        });
        return { ok: true };
    }
    async logoutAll(userId, exceptSessionId) {
        await this.prisma.userSession.updateMany({
            where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
            data: { revokedAt: new Date(), revokedReason: 'logout_all' },
        });
        return { ok: true };
    }
    async me(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { tenant: { select: { name: true, slug: true, plan: true, brandColor: true, status: true, currency: true } } },
        });
        if (!user)
            throw new common_1.UnauthorizedException();
        return this.sanitize(user);
    }
    async createUser(adminTenantId, data) {
        if (!['AGENT', 'MANAGER'].includes(data.role))
            throw new common_1.BadRequestException("Rol noto'g'ri");
        if (!data.email?.trim())
            throw new common_1.BadRequestException('Email majburiy');
        if (!data.name?.trim())
            throw new common_1.BadRequestException('Ism majburiy');
        const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
        if (!emailRe.test(data.email.trim()))
            throw new common_1.BadRequestException("Email formati noto'g'ri");
        this.validatePassword(data.password);
        const exists = await this.prisma.user.findFirst({
            where: { tenantId: adminTenantId, email: data.email.toLowerCase().trim() },
        });
        if (exists)
            throw new common_1.ConflictException('Bu email shu kompaniyada allaqachon mavjud');
        const passwordHash = await hashPassword(data.password);
        const user = await this.prisma.user.create({
            data: {
                tenantId: adminTenantId,
                email: data.email.toLowerCase().trim(),
                passwordHash,
                name: data.name.trim(),
                role: data.role,
                mustChangePassword: false,
            },
        });
        return this.sanitize(user);
    }
    async changePassword(userId, oldPassword, newPassword) {
        if (oldPassword === newPassword) {
            throw new common_1.BadRequestException("Yangi parol eski paroldan farqli bo'lishi kerak");
        }
        this.validatePassword(newPassword);
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.UnauthorizedException();
        const ok = await verifyPassword(user.passwordHash, oldPassword);
        if (!ok)
            throw new common_1.BadRequestException("Eski parol noto'g'ri");
        const newHash = await hashPassword(newPassword);
        await this.prisma.user.update({
            where: { id: userId },
            data: { passwordHash: newHash, passwordChangedAt: new Date(), mustChangePassword: false },
        });
        this.email.sendPasswordChanged(user.email, user.name).catch(() => { });
        this.notifications.create({
            tenantId: user.tenantId, userId: user.id,
            type: 'SECURITY_PASSWORD_CHANGED',
            title: '🔐 Parol o\'zgartirildi',
            body: 'Hisobingiz paroli muvaffaqiyatli o\'zgartirildi',
        }).catch(() => { });
        await this.prisma.userSession.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'password_changed' },
        });
        return { ok: true };
    }
    async setup2FA(userId) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.UnauthorizedException();
        if (user.twoFactorEnabled)
            throw new common_1.BadRequestException('2FA allaqachon yoqilgan');
        const secret = otplib_1.authenticator.generateSecret();
        const otpauth = otplib_1.authenticator.keyuri(user.email, 'Omon CRM', secret);
        const qrCode = await QRCode.toDataURL(otpauth);
        await this.prisma.user.update({
            where: { id: userId },
            data: { twoFactorSecret: this.encryption.encrypt(secret) },
        });
        return { secret, qrCode, otpauth };
    }
    async enable2FA(userId, code) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.UnauthorizedException();
        if (user.twoFactorEnabled)
            throw new common_1.BadRequestException('2FA allaqachon yoqilgan');
        if (!user.twoFactorSecret)
            throw new common_1.BadRequestException('Avval setup2FA chaqiring');
        const secret = this.encryption.decrypt(user.twoFactorSecret);
        if (!secret)
            throw new common_1.BadRequestException('2FA sozlamalari xato');
        const isValid = otplib_1.authenticator.verify({ token: code.replace(/\s/g, ''), secret });
        if (!isValid)
            throw new common_1.BadRequestException("Kod noto'g'ri");
        const backupCodes = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());
        const encryptedBackup = backupCodes.map((c) => this.encryption.encrypt(c));
        await this.prisma.user.update({
            where: { id: userId },
            data: { twoFactorEnabled: true, twoFactorBackup: encryptedBackup },
        });
        this.email.send({
            to: user.email, toName: user.name,
            subject: '🔐 2FA yoqildi — Omon CRM',
            html: `<h2>2FA muvaffaqiyatli yoqildi!</h2>
             <p><b>Backup kodlarni xavfsiz joyda saqlang!</b></p>
             <pre style="background:#f4f6fb;padding:14px;border-radius:8px;font-family:monospace;">${backupCodes.join('\n')}</pre>
             <p style="color:#ef4444;">Telefoningiz yo'qolsa, shu kodlardan birini ishlatasiz.</p>`,
        }).catch(() => { });
        this.notifications.create({
            tenantId: user.tenantId, userId: user.id,
            type: 'SECURITY_2FA_ENABLED',
            title: '✅ 2FA yoqildi',
            body: 'Hisobingiz endi 2 bosqichli tasdiqlash bilan himoyalangan',
        }).catch(() => { });
        return { ok: true, backupCodes };
    }
    async disable2FA(userId, password) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.UnauthorizedException();
        if (!user.twoFactorEnabled)
            throw new common_1.BadRequestException('2FA yoqilmagan');
        const ok = await verifyPassword(user.passwordHash, password);
        if (!ok)
            throw new common_1.UnauthorizedException("Parol noto'g'ri");
        await this.prisma.user.update({
            where: { id: userId },
            data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackup: [] },
        });
        return { ok: true };
    }
    async sessions(userId, currentRefreshToken) {
        const currentHash = currentRefreshToken ? hashToken(currentRefreshToken) : null;
        const sessions = await this.prisma.userSession.findMany({
            where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
            orderBy: { lastActiveAt: 'desc' },
        });
        return sessions.map((s) => ({
            id: s.id, deviceName: s.deviceName,
            ip: s.ip, country: s.country, city: s.city,
            lastActiveAt: s.lastActiveAt, createdAt: s.createdAt,
            isCurrent: currentHash === s.refreshTokenHash,
        }));
    }
    async revokeSession(userId, sessionId) {
        const session = await this.prisma.userSession.findFirst({ where: { id: sessionId, userId } });
        if (!session)
            throw new common_1.BadRequestException('Sessiya topilmadi');
        await this.prisma.userSession.update({
            where: { id: sessionId },
            data: { revokedAt: new Date(), revokedReason: 'manual' },
        });
        return { ok: true };
    }
    async loginHistory(userId) {
        return this.prisma.loginAttempt.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
    }
    async generateTokens(user) {
        const payload = { sub: user.id, email: user.email, role: user.role, tenantId: user.tenantId };
        const [accessToken, refreshToken] = await Promise.all([
            this.jwt.signAsync(payload, {
                secret: process.env.JWT_ACCESS_SECRET,
                expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
            }),
            this.jwt.signAsync(payload, {
                secret: process.env.JWT_REFRESH_SECRET,
                expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
            }),
        ]);
        return { accessToken, refreshToken };
    }
    async forgotPassword(email) {
        const cleanEmail = email.toLowerCase().trim();
        const user = await this.prisma.user.findFirst({ where: { email: cleanEmail } });
        if (!user || user.status !== 'ACTIVE') {
            return { ok: true, message: "Agar email ro'xatdan o'tgan bo'lsa, ko'rsatma yuborildi" };
        }
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000);
        await this.prisma.user.update({
            where: { id: user.id },
            data: { passwordResetToken: tokenHash, passwordResetExpires: expires },
        });
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
        const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(cleanEmail)}`;
        await this.email.sendPasswordReset(user.email, user.name, resetUrl).catch((e) => this.logger.error('Reset email yuborishda xato: ' + e?.message));
        this.logger.log(`Password reset token yaratildi: ${cleanEmail}`);
        return { ok: true, message: "Agar email ro'xatdan o'tgan bo'lsa, ko'rsatma yuborildi" };
    }
    async resetPassword(email, token, newPassword) {
        if (!email?.trim() || !token?.trim() || !newPassword) {
            throw new common_1.BadRequestException('Email, token va yangi parol majburiy');
        }
        this.validatePassword(newPassword);
        const cleanEmail = email.toLowerCase().trim();
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const user = await this.prisma.user.findFirst({
            where: {
                email: cleanEmail,
                passwordResetToken: tokenHash,
                passwordResetExpires: { gt: new Date() },
                status: 'ACTIVE',
            },
        });
        if (!user) {
            throw new common_1.BadRequestException("Token noto'g'ri yoki muddati tugagan. Qayta so'rang.");
        }
        const passwordHash = await hashPassword(newPassword);
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                passwordHash,
                passwordResetToken: null,
                passwordResetExpires: null,
                passwordChangedAt: new Date(),
                mustChangePassword: false,
                failedLoginCount: 0,
                lockedUntil: null,
            },
        });
        await this.prisma.userSession.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'password_reset' },
        });
        await this.email.sendPasswordChanged(user.email, user.name).catch(() => { });
        this.logger.log(`Parol reset qilindi: ${cleanEmail}`);
        return { ok: true, message: "Parol muvaffaqiyatli yangilandi. Endi kirish mumkin." };
    }
    sanitize(user) {
        const { passwordHash, twoFactorSecret, twoFactorBackup, passwordResetToken, passwordResetExpires, failedLoginCount, lockedUntil, ...safe } = user;
        return {
            ...safe,
            twoFactorEnabled: !!user.twoFactorEnabled,
            tenantName: user.tenant?.name,
            tenantSlug: user.tenant?.slug,
            tenantPlan: user.tenant?.plan,
            tenantStatus: user.tenant?.status ?? null,
            tenantCurrency: user.tenant?.currency ?? 'USD',
        };
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        jwt_1.JwtService,
        encryption_service_1.EncryptionService,
        email_service_1.EmailService,
        notifications_service_1.NotificationsService])
], AuthService);
//# sourceMappingURL=auth.service.js.map