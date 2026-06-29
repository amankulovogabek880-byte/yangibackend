import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
export declare function hashPassword(password: string): Promise<string>;
export declare function verifyPassword(hash: string, password: string): Promise<boolean>;
export declare class AuthService {
    private prisma;
    private jwt;
    private encryption;
    private email;
    private notifications;
    private readonly logger;
    private MAX_ATTEMPTS;
    private LOCK_MINUTES;
    private MIN_PASSWORD_LEN;
    private REQUIRE_2FA_ADMINS;
    private DETECT_FOREIGN;
    private NOTIFY_NEW_DEVICE;
    constructor(prisma: PrismaService, jwt: JwtService, encryption: EncryptionService, email: EmailService, notifications: NotificationsService);
    private validatePassword;
    private parseDevice;
    private lookupGeo;
    private logAttempt;
    private checkAndIncrementFailures;
    login(email: string, password: string, twoFactorCode: string | undefined, ip?: string, userAgent?: string): Promise<{
        requires2FA: boolean;
        userId: string;
    } | {
        user: any;
        accessToken: string;
        refreshToken: string;
        requires2FA?: undefined;
        userId?: undefined;
    }>;
    refresh(refreshToken: string, ip?: string, userAgent?: string): Promise<{
        user: any;
        accessToken: string;
        refreshToken: string;
    }>;
    logout(refreshToken: string): Promise<{
        ok: boolean;
    }>;
    logoutAll(userId: string, exceptSessionId?: string): Promise<{
        ok: boolean;
    }>;
    me(userId: string): Promise<any>;
    createUser(adminTenantId: string, data: {
        email: string;
        password: string;
        name: string;
        role: string;
    }): Promise<any>;
    changePassword(userId: string, oldPassword: string, newPassword: string): Promise<{
        ok: boolean;
    }>;
    setup2FA(userId: string): Promise<{
        secret: string;
        qrCode: string;
        otpauth: string;
    }>;
    enable2FA(userId: string, code: string): Promise<{
        ok: boolean;
        backupCodes: string[];
    }>;
    disable2FA(userId: string, password: string): Promise<{
        ok: boolean;
    }>;
    sessions(userId: string, currentRefreshToken?: string): Promise<{
        id: string;
        deviceName: string;
        ip: string;
        country: string;
        city: string;
        lastActiveAt: Date;
        createdAt: Date;
        isCurrent: boolean;
    }[]>;
    revokeSession(userId: string, sessionId: string): Promise<{
        ok: boolean;
    }>;
    loginHistory(userId: string): Promise<{
        id: string;
        createdAt: Date;
        email: string;
        country: string | null;
        userId: string | null;
        ip: string | null;
        userAgent: string | null;
        success: boolean;
        reason: string | null;
    }[]>;
    private generateTokens;
    forgotPassword(email: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    resetPassword(email: string, token: string, newPassword: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    private sanitize;
}
