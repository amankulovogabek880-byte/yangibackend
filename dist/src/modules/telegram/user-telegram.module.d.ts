import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
export declare class UserTelegramService implements OnModuleInit {
    private prisma;
    private realtime;
    private readonly logger;
    constructor(prisma: PrismaService, realtime: RealtimeGateway);
    onModuleInit(): Promise<void>;
    private restoreSession;
    sendCode(tenantId: string, userId: string, data: {
        phone: string;
        apiId?: number;
        apiHash?: string;
    }): Promise<{
        status: string;
        accountId: string;
        phone?: undefined;
        message?: undefined;
    } | {
        status: string;
        phone: string;
        message: string;
        accountId?: undefined;
    }>;
    verifyCode(tenantId: string, userId: string, data: {
        phone: string;
        code: string;
        apiId?: number;
        apiHash?: string;
    }): Promise<{
        status: string;
        accountId: string;
        name: string;
        username: any;
        message: string;
    } | {
        status: string;
        message: string;
        accountId?: undefined;
        name?: undefined;
        username?: undefined;
    }>;
    verify2FA(tenantId: string, userId: string, data: {
        phone: string;
        password: string;
        apiId?: number;
        apiHash?: string;
    }): Promise<{
        status: string;
        accountId: string;
        name: string;
    }>;
    private startListening;
    sendPersonalMessage(tenantId: string, agentId: string, data: {
        phone?: string;
        username?: string;
        userId?: string;
        text: string;
        clientId?: string;
    }): Promise<{
        ok: boolean;
        conversationId: string;
        message: string;
    }>;
    getMyAccount(tenantId: string, userId: string): Promise<{
        isOnline: boolean;
        id: string;
        name: string;
        createdAt: Date;
        isActive: boolean;
        phoneNumber: string;
        config: import("@prisma/client/runtime/library").JsonValue;
    }>;
    disconnect(tenantId: string, userId: string): Promise<{
        ok: boolean;
    }>;
}
export declare class UserTelegramController {
    private svc;
    constructor(svc: UserTelegramService);
    sendCode(u: any, body: any): Promise<{
        status: string;
        accountId: string;
        phone?: undefined;
        message?: undefined;
    } | {
        status: string;
        phone: string;
        message: string;
        accountId?: undefined;
    }>;
    verifyCode(u: any, body: any): Promise<{
        status: string;
        accountId: string;
        name: string;
        username: any;
        message: string;
    } | {
        status: string;
        message: string;
        accountId?: undefined;
        name?: undefined;
        username?: undefined;
    }>;
    verify2FA(u: any, body: any): Promise<{
        status: string;
        accountId: string;
        name: string;
    }>;
    sendMessage(u: any, body: any): Promise<{
        ok: boolean;
        conversationId: string;
        message: string;
    }>;
    getMyAccount(u: any): Promise<{
        isOnline: boolean;
        id: string;
        name: string;
        createdAt: Date;
        isActive: boolean;
        phoneNumber: string;
        config: import("@prisma/client/runtime/library").JsonValue;
    }>;
    disconnect(u: any): Promise<{
        ok: boolean;
    }>;
}
export declare class UserTelegramModule {
}
