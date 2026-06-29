import { Request } from 'express';
import { AuthService } from './auth.service';
export declare class AuthController {
    private auth;
    constructor(auth: AuthService);
    login(body: {
        email: string;
        password: string;
        twoFactorCode?: string;
    }, req: Request): Promise<{
        requires2FA: boolean;
        userId: string;
    } | {
        user: any;
        accessToken: string;
        refreshToken: string;
        requires2FA?: undefined;
        userId?: undefined;
    }>;
    refresh(body: {
        refreshToken: string;
    }, req: Request): Promise<{
        user: any;
        accessToken: string;
        refreshToken: string;
    }>;
    logout(body: {
        refreshToken: string;
    }): Promise<{
        ok: boolean;
    }>;
    logoutAll(u: any): Promise<{
        ok: boolean;
    }>;
    me(u: any): Promise<any>;
    changePassword(u: any, body: {
        oldPassword: string;
        newPassword: string;
    }): Promise<{
        ok: boolean;
    }>;
    setup2FA(u: any): Promise<{
        secret: string;
        qrCode: string;
        otpauth: string;
    }>;
    enable2FA(u: any, body: {
        code: string;
    }): Promise<{
        ok: boolean;
        backupCodes: string[];
    }>;
    disable2FA(u: any, body: {
        password: string;
    }): Promise<{
        ok: boolean;
    }>;
    sessions(u: any, req: Request): Promise<{
        id: string;
        deviceName: string;
        ip: string;
        country: string;
        city: string;
        lastActiveAt: Date;
        createdAt: Date;
        isCurrent: boolean;
    }[]>;
    revokeSession(u: any, id: string): Promise<{
        ok: boolean;
    }>;
    forgotPassword(body: {
        email: string;
    }): Promise<{
        ok: boolean;
        message: string;
    }>;
    resetPassword(body: {
        email: string;
        token: string;
        newPassword: string;
    }): Promise<{
        ok: boolean;
        message: string;
    }>;
    loginHistory(u: any): Promise<{
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
    createUser(u: any, body: any): Promise<any>;
}
