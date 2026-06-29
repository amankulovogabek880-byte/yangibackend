import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EncryptionService } from '../../common/encryption/encryption.service';
export declare class TelegramPersonalService {
    private prisma;
    private realtime;
    private encryption;
    private readonly logger;
    constructor(prisma: PrismaService, realtime: RealtimeGateway, encryption: EncryptionService);
    private getClient;
    sendCode(userId: string, tenantId: string, phone: string, apiId: number, apiHash: string): Promise<{
        sent: boolean;
        phoneCodeHash: string;
    }>;
    verifyCode(userId: string, tenantId: string, code: string, password?: string): Promise<{
        need2fa: boolean;
        connected?: undefined;
    } | {
        connected: boolean;
        need2fa?: undefined;
    }>;
    getDialogs(userId: string, tenantId: string): Promise<any[]>;
    getMessages(userId: string, tenantId: string, conversationId: string): Promise<any>;
    sendMessage(userId: string, tenantId: string, conversationId: string, text: string, fileBase64?: string, fileName?: string): Promise<any>;
    searchUser(userId: string, tenantId: string, query: string): Promise<{
        id: string;
        firstName: any;
        lastName: any;
        username: any;
        phone: any;
    }>;
    startChat(userId: string, tenantId: string, externalUserId: string, firstMessage?: string): Promise<any>;
    private handleIncoming;
    getStatus(userId: string, tenantId: string): Promise<{
        connected: boolean;
        online?: undefined;
        phone?: undefined;
        since?: undefined;
    } | {
        connected: boolean;
        online: boolean;
        phone: any;
        since: any;
    }>;
    disconnect(userId: string, tenantId: string): Promise<{
        disconnected: boolean;
    }>;
    restoreAllSessions(): Promise<void>;
}
export declare class TelegramPersonalController {
    private svc;
    constructor(svc: TelegramPersonalService);
    status(u: any): Promise<{
        connected: boolean;
        online?: undefined;
        phone?: undefined;
        since?: undefined;
    } | {
        connected: boolean;
        online: boolean;
        phone: any;
        since: any;
    }>;
    connect(u: any, body: {
        phone: string;
        apiId: number;
        apiHash: string;
    }): Promise<{
        sent: boolean;
        phoneCodeHash: string;
    }>;
    verifyCode(u: any, body: {
        code: string;
        password?: string;
    }): Promise<{
        need2fa: boolean;
        connected?: undefined;
    } | {
        connected: boolean;
        need2fa?: undefined;
    }>;
    disconnect(u: any): Promise<{
        disconnected: boolean;
    }>;
    dialogs(u: any): Promise<any[]>;
    messages(u: any, id: string): Promise<any>;
    send(u: any, body: {
        conversationId: string;
        text: string;
        fileBase64?: string;
        fileName?: string;
    }): Promise<any>;
    search(u: any, body: {
        query: string;
    }): Promise<{
        id: string;
        firstName: any;
        lastName: any;
        username: any;
        phone: any;
    }>;
    startChat(u: any, body: {
        externalUserId: string;
        firstMessage?: string;
    }): Promise<any>;
}
export declare class TelegramPersonalModule {
}
