import {
  Injectable, UnauthorizedException, BadRequestException, ConflictException,
  ForbiddenException, Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import * as geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  private MAX_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10);
  private LOCK_MINUTES = parseInt(process.env.LOGIN_LOCK_MINUTES || '15', 10);
  private MIN_PASSWORD_LEN = parseInt(process.env.MIN_PASSWORD_LENGTH || '8', 10);
  private REQUIRE_2FA_ADMINS = process.env.REQUIRE_2FA_ADMINS === 'true';
  private DETECT_FOREIGN = process.env.DETECT_FOREIGN_LOGINS === 'true';
  private NOTIFY_NEW_DEVICE = process.env.NOTIFY_NEW_DEVICE === 'true';

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private encryption: EncryptionService,
    private email: EmailService,
    private notifications: NotificationsService,
  ) {
    authenticator.options = { window: 1, step: 30 };
  }

  private validatePassword(password: string): void {
    if (!password || password.length < this.MIN_PASSWORD_LEN) {
      throw new BadRequestException(`Parol kamida ${this.MIN_PASSWORD_LEN} belgi bo'lishi kerak`);
    }
  }

  private parseDevice(userAgent?: string): string {
    if (!userAgent) return "Noma'lum qurilma";
    const ua = new UAParser(userAgent);
    const browser = ua.getBrowser().name || 'Browser';
    const os = ua.getOS().name || 'OS';
    return `${browser} on ${os}`;
  }

  private lookupGeo(ip?: string): { country?: string; city?: string } {
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.')) {
      return { country: 'LOCAL', city: 'Localhost' };
    }
    const cleanIp = ip.replace(/^::ffff:/, '');
    const geo = geoip.lookup(cleanIp);
    if (!geo) return {};
    return { country: geo.country, city: geo.city };
  }

  private async logAttempt(params: {
    email: string; userId?: string; ip?: string; userAgent?: string;
    country?: string; success: boolean; reason?: string;
  }) {
    await this.prisma.loginAttempt.create({
      data: {
        email: params.email, userId: params.userId,
        ip: params.ip, userAgent: params.userAgent, country: params.country,
        success: params.success, reason: params.reason,
      },
    });
  }

  private async checkAndIncrementFailures(user: any, alertTo?: { email: string; name: string }) {
    const newCount = user.failedLoginCount + 1;
    const update: any = { failedLoginCount: newCount };

    if (newCount >= this.MAX_ATTEMPTS) {
      update.lockedUntil = new Date(Date.now() + this.LOCK_MINUTES * 60 * 1000);
      update.failedLoginCount = 0;
      if (alertTo?.email) {
        this.email.sendFailedLoginAlert(alertTo.email, alertTo.name, newCount).catch(() => {});
      }
    }
    await this.prisma.user.update({ where: { id: user.id }, data: update });
  }

  async login(
    email: string, password: string, twoFactorCode: string | undefined,
    ip?: string, userAgent?: string,
  ) {
    if (!email?.trim() || !password) throw new BadRequestException('Email va parol majburiy');
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRe.test(email.trim())) throw new UnauthorizedException("Email yoki parol noto'g'ri");

    const cleanEmail = email.toLowerCase().trim();
    const geo = this.lookupGeo(ip);
    const device = this.parseDevice(userAgent);

    // Bir xil email bir nechta tenantda bo'lishi mumkin — ACTIVE statusni ustun ko'ramiz
    const users = await this.prisma.user.findMany({
      where: { email: cleanEmail },
      include: { tenant: true },
      orderBy: [
        { status: 'asc' },    // ACTIVE < INACTIVE < LOCKED (alifbo tartibida)
        { createdAt: 'desc' }, // Eng yangi
      ],
    });
    // ACTIVE userni birinchi ol, bo'lmasa birinchisini
    const user = users.find(u => u.status === 'ACTIVE') || users[0] || null;

    if (!user) {
      await this.logAttempt({ email: cleanEmail, ip, userAgent, country: geo.country, success: false, reason: 'wrong_email' });
      await argon2.hash('dummy-string-to-prevent-timing-attack');
      throw new UnauthorizedException("Email yoki parol noto'g'ri");
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      await this.logAttempt({ email: cleanEmail, userId: user.id, ip, userAgent, country: geo.country, success: false, reason: 'locked' });
      throw new ForbiddenException(`Hisob ${minutesLeft} daqiqa muddatga bloklangan`);
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException(`Hisob ${user.status} holatida`);
    }

    if (user.tenant && user.tenant.status === 'SUSPENDED' && user.role !== 'PLATFORM_OWNER') {
      throw new ForbiddenException("Kompaniya hisobi to'xtatilgan");
    }

    const passwordOk = await verifyPassword(user.passwordHash, password);
    if (!passwordOk) {
      await this.logAttempt({ email: cleanEmail, userId: user.id, ip, userAgent, country: geo.country, success: false, reason: 'wrong_password' });
      await this.checkAndIncrementFailures(user, { email: user.email, name: user.name });
      throw new UnauthorizedException("Email yoki parol noto'g'ri");
    }

    // Parol to'g'ri — failedLoginCount va lockedUntil ni reset qilamiz
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
      const secret = this.encryption.decrypt(user.twoFactorSecret!);
      if (!secret) throw new UnauthorizedException('2FA sozlamalari xato');

      const isValid =
        authenticator.verify({ token: twoFactorCode.replace(/\s/g, ''), secret }) ||
        (user.twoFactorBackup || []).some((bc) => this.encryption.decrypt(bc) === twoFactorCode);

      if (!isValid) {
        await this.logAttempt({ email: cleanEmail, userId: user.id, ip, userAgent, country: geo.country, success: false, reason: '2fa_failed' });
        await this.checkAndIncrementFailures(user, { email: user.email, name: user.name });
        throw new UnauthorizedException("2FA kodi noto'g'ri");
      }

      const backupUsed = (user.twoFactorBackup || []).findIndex(
        (bc) => this.encryption.decrypt(bc) === twoFactorCode,
      );
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
    const isNewDevice = existingSessions.length > 0 && !existingSessions.some(
      (s) => s.deviceName === device && s.ip === ip,
    );

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
    } catch (sessionErr: any) {
      // TUZATISH: eski `refreshHash + '_retry_'` hack olib tashlandi —
      // u yaroqsiz hash yozib, o'sha sessiyani refresh qilib bo'lmas holga
      // keltirardi. Endi jti tufayli P2002 chiqmaydi; boshqa DB xatolari
      // log qilinadi, lekin login bloklanmaydi.
      this.logger.error('Session yaratishda xato: ' + (sessionErr?.message || sessionErr));
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
      }).catch(() => {});

      this.notifications.create({
        tenantId: user.tenantId, userId: user.id,
        type: 'SECURITY_NEW_LOGIN',
        title: '🔔 Yangi qurilmadan kirildi',
        body: `${device} — ${geo.city || geo.country || ip || 'noma\'lum'}`,
        metadata: { ip, device, country: geo.country },
      }).catch(() => {});
    }

    if (this.DETECT_FOREIGN && geo.country && geo.country !== 'LOCAL' && geo.country !== 'UZ') {
      this.notifications.create({
        tenantId: user.tenantId, userId: user.id,
        type: 'SECURITY_SUSPICIOUS_ACTIVITY',
        title: '⚠️ Boshqa davlatdan kirish',
        body: `Davlat: ${geo.country}, IP: ${ip}`,
        metadata: { ip, country: geo.country },
      }).catch(() => {});
    }

    return { ...tokens, user: this.sanitize(user) };
  }

  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    if (!refreshToken) throw new UnauthorizedException("Token yo'q");

    // 1. Verify JWT signature + expiry
    try {
      await this.jwt.verifyAsync(refreshToken, { secret: process.env.JWT_REFRESH_SECRET });
    } catch {
      throw new UnauthorizedException("Token noto'g'ri yoki muddati tugagan");
    }

    // 2. Check DB session
    const hash = hashToken(refreshToken);
    const session = await this.prisma.userSession.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: { include: { tenant: true } } },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      // Possible replay attack - revoke all sessions for this user if session exists
      if (session && !session.revokedAt) {
        await this.prisma.userSession.updateMany({
          where: { userId: session.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'token_replay_suspected' },
        });
        this.logger.warn('Refresh token replay suspected for user: ' + session.userId);
      }
      throw new UnauthorizedException("Token amal qilmaydi");
    }

    const user = session.user;
    if (user.status !== 'ACTIVE') throw new ForbiddenException('Hisob faol emas');
    if (user.tenant?.status === 'SUSPENDED' && user.role !== 'PLATFORM_OWNER') {
      throw new ForbiddenException("Kompaniya hisobi to'xtatilgan");
    }

    // 3. Rotate refresh token (old one becomes invalid)
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

  async logout(refreshToken: string) {
    if (!refreshToken) return { ok: true };
    const hash = hashToken(refreshToken);
    await this.prisma.userSession.updateMany({
      where: { refreshTokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'user_logout' },
    });
    return { ok: true };
  }

  async logoutAll(userId: string, exceptSessionId?: string) {
    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: 'logout_all' },
    });
    return { ok: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: { select: { name: true, slug: true, plan: true, brandColor: true, status: true, currency: true, settings: true } } },
    });
    if (!user) throw new UnauthorizedException();
    return this.sanitize(user);
  }

  async createUser(adminTenantId: string, data: { email: string; password: string; name: string; role: string }) {
    if (!['AGENT', 'MANAGER'].includes(data.role)) throw new BadRequestException("Rol noto'g'ri");
    if (!data.email?.trim()) throw new BadRequestException('Email majburiy');
    if (!data.name?.trim()) throw new BadRequestException('Ism majburiy');
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRe.test(data.email.trim())) throw new BadRequestException("Email formati noto'g'ri");
    this.validatePassword(data.password);

    const exists = await this.prisma.user.findFirst({
      where: { tenantId: adminTenantId, email: data.email.toLowerCase().trim() },
    });
    if (exists) throw new ConflictException('Bu email shu kompaniyada allaqachon mavjud');

    const passwordHash = await hashPassword(data.password);
    const user = await this.prisma.user.create({
      data: {
        tenantId: adminTenantId,
        email: data.email.toLowerCase().trim(),
        passwordHash,
        name: data.name.trim(),
        role: data.role as any,
        mustChangePassword: false,
      },
    });
    return this.sanitize(user);
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    if (oldPassword === newPassword) {
      throw new BadRequestException("Yangi parol eski paroldan farqli bo'lishi kerak");
    }
    this.validatePassword(newPassword);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const ok = await verifyPassword(user.passwordHash, oldPassword);
    if (!ok) throw new BadRequestException("Eski parol noto'g'ri");

    const newHash = await hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash, passwordChangedAt: new Date(), mustChangePassword: false },
    });

    this.email.sendPasswordChanged(user.email, user.name).catch(() => {});
    this.notifications.create({
      tenantId: user.tenantId, userId: user.id,
      type: 'SECURITY_PASSWORD_CHANGED',
      title: '🔐 Parol o\'zgartirildi',
      body: 'Hisobingiz paroli muvaffaqiyatli o\'zgartirildi',
    }).catch(() => {});

    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'password_changed' },
    });

    return { ok: true };
  }

  async setup2FA(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    if (user.twoFactorEnabled) throw new BadRequestException('2FA allaqachon yoqilgan');

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, 'Omon CRM', secret);
    const qrCode = await QRCode.toDataURL(otpauth);

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: this.encryption.encrypt(secret) },
    });

    return { secret, qrCode, otpauth };
  }

  async enable2FA(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    if (user.twoFactorEnabled) throw new BadRequestException('2FA allaqachon yoqilgan');
    if (!user.twoFactorSecret) throw new BadRequestException('Avval setup2FA chaqiring');

    const secret = this.encryption.decrypt(user.twoFactorSecret);
    if (!secret) throw new BadRequestException('2FA sozlamalari xato');

    const isValid = authenticator.verify({ token: code.replace(/\s/g, ''), secret });
    if (!isValid) throw new BadRequestException("Kod noto'g'ri");

    const backupCodes = Array.from({ length: 10 }, () =>
      crypto.randomBytes(4).toString('hex').toUpperCase(),
    );
    const encryptedBackup = backupCodes.map((c) => this.encryption.encrypt(c)!);

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
    }).catch(() => {});

    this.notifications.create({
      tenantId: user.tenantId, userId: user.id,
      type: 'SECURITY_2FA_ENABLED',
      title: '✅ 2FA yoqildi',
      body: 'Hisobingiz endi 2 bosqichli tasdiqlash bilan himoyalangan',
    }).catch(() => {});

    return { ok: true, backupCodes };
  }

  /**
   * 2FA'ni o'chirish. Tasdiqlash uchun foydalanuvchi QUYIDAGILARDAN BIRINI
   * kiritishi kifoya:
   *   • akkaunt paroli, YOKI
   *   • authenticator ilovasidagi joriy 6 xonali kod, YOKI
   *   • zaxira (backup) kodlardan biri.
   * Shu tufayli parolni eslay olmagan foydalanuvchi ham har kuni kiritadigan
   * kod bilan 2FA'ni o'chira oladi (bloklanib qolmaydi).
   *
   * MUHIM: noto'g'ri kredda 401 EMAS, 400 (BadRequest) qaytariladi — aks holda
   * frontenddagi global 401-interceptor bu xatoni "sessiya tugadi" deb ushlab,
   * foydalanuvchini login sahifasiga uloqtirib yuboradi (o'chirish o'rniga).
   */
  async disable2FA(userId: string, credential: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    if (!user.twoFactorEnabled) throw new BadRequestException('2FA yoqilmagan');

    const cred = (credential || '').trim();
    if (!cred) throw new BadRequestException("Parol yoki kod kiritilmadi");

    // 1) Parol sifatida tekshiramiz
    let verified = await verifyPassword(user.passwordHash, cred);

    // 2) Parol mos kelmasa — authenticator kodi yoki backup kod sifatida tekshiramiz
    if (!verified && user.twoFactorSecret) {
      const clean = cred.replace(/\s/g, '');
      const secret = this.encryption.decrypt(user.twoFactorSecret);
      if (secret && authenticator.verify({ token: clean, secret })) {
        verified = true;
      } else if ((user.twoFactorBackup || []).some((bc) => this.encryption.decrypt(bc) === clean)) {
        verified = true;
      }
    }

    if (!verified) {
      throw new BadRequestException("Parol yoki kod noto'g'ri");
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackup: [] },
    });
    return { ok: true };
  }

  async sessions(userId: string, currentRefreshToken?: string) {
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

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.userSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw new BadRequestException('Sessiya topilmadi');
    await this.prisma.userSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedReason: 'manual' },
    });
    return { ok: true };
  }

  async loginHistory(userId: string) {
    return this.prisma.loginAttempt.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  private async generateTokens(user: any) {
    // TUZATISH: `jti` (unique ID) qo'shildi — bir soniya ichida ikkita login
    // bo'lsa ham token har doim unikal bo'ladi. Bu eski `_retry_` hack'ining
    // ildiz sababi edi (bir xil payload + bir xil iat = bir xil token = P2002).
    const basePayload = { sub: user.id, email: user.email, role: user.role, tenantId: user.tenantId };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync({ ...basePayload, jti: crypto.randomUUID() }, {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
      }),
      this.jwt.signAsync({ ...basePayload, jti: crypto.randomUUID() }, {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
      }),
    ]);
    return { accessToken, refreshToken };
  }


  async forgotPassword(email: string) {
    const cleanEmail = email.toLowerCase().trim();
    const user = await this.prisma.user.findFirst({ where: { email: cleanEmail } });

    // Har doim muvaffaqiyat qaytaramiz — email mavjudligini ochiq aytmaymiz
    if (!user || user.status !== 'ACTIVE') {
      return { ok: true, message: "Agar email ro'xatdan o'tgan bo'lsa, ko'rsatma yuborildi" };
    }

    // Token yaratish (1 soat)
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 soat

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: tokenHash, passwordResetExpires: expires },
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(cleanEmail)}`;

    await this.email.sendPasswordReset(user.email, user.name, resetUrl).catch((e) =>
      this.logger.error('Reset email yuborishda xato: ' + e?.message)
    );

    this.logger.log(`Password reset token yaratildi: ${cleanEmail}`);
    return { ok: true, message: "Agar email ro'xatdan o'tgan bo'lsa, ko'rsatma yuborildi" };
  }

  async resetPassword(email: string, token: string, newPassword: string) {
    if (!email?.trim() || !token?.trim() || !newPassword) {
      throw new BadRequestException('Email, token va yangi parol majburiy');
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
      throw new BadRequestException("Token noto'g'ri yoki muddati tugagan. Qayta so'rang.");
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

    // Barcha sessiyalarni yopish
    await this.prisma.userSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'password_reset' },
    });

    await this.email.sendPasswordChanged(user.email, user.name).catch(() => {});

    this.logger.log(`Parol reset qilindi: ${cleanEmail}`);
    return { ok: true, message: "Parol muvaffaqiyatli yangilandi. Endi kirish mumkin." };
  }

  private sanitize(user: any) {
    const {
      passwordHash, twoFactorSecret, twoFactorBackup, passwordResetToken,
      passwordResetExpires, failedLoginCount, lockedUntil,
      ...safe
    } = user;
    return {
      ...safe,
      twoFactorEnabled: !!user.twoFactorEnabled,
      tenantName: user.tenant?.name,
      tenantSlug: user.tenant?.slug,
      tenantPlan: user.tenant?.plan,
      tenantStatus: user.tenant?.status ?? null,
      tenantCurrency: (user.tenant as any)?.currency ?? 'USD',
      // v26: shu kompaniyada AI (qo'ng'iroq transkripsiyasi + Claude
      // tahlili) yoqilganmi — frontend shunga qarab AI bo'limlarini
      // (badge, "AI tahlil" tugmasi, koching xulosasi) ko'rsatadi yoki
      // yashiradi. O'CHIQ bo'lsa ham yozuv (recording)lar odatdagidek
      // ko'rinadi — faqat AI ustama chiqmaydi.
      tenantAiEnabled: (user.tenant as any)?.settings?.aiEnabled === true,
    };
  }
}