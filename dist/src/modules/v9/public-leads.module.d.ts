import { PrismaService } from '../../prisma/prisma.service';
import { RoundRobinService } from './round-robin.module';
import { LeadScoringService } from './lead-scoring.module';
import { AutoReplyService } from './auto-reply.module';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.module';
import { RealtimeGateway } from '../realtime/realtime.gateway';
export declare class PublicLeadsService {
    private prisma;
    private roundRobin;
    private scoring;
    private autoReply;
    private notifications;
    private audit;
    private realtime;
    private readonly logger;
    constructor(prisma: PrismaService, roundRobin: RoundRobinService, scoring: LeadScoringService, autoReply: AutoReplyService, notifications: NotificationsService, audit: AuditService, realtime: RealtimeGateway);
    createLead(tenantId: string, apiKey: string, data: {
        fullName?: string;
        phone?: string;
        email?: string;
        telegramUsername?: string;
        message?: string;
        source?: string;
        utmSource?: string;
        utmMedium?: string;
        utmCampaign?: string;
        tourInterest?: string;
        country?: string;
        city?: string;
        tgChatId?: string;
        tgFirstName?: string;
        tgLastName?: string;
    }, meta?: {
        ip?: string;
        userAgent?: string;
    }): Promise<{
        ok: boolean;
        clientId: any;
        isDuplicate: boolean;
        assignedAgentId: any;
        message: string;
    }>;
    listApiKeys(tenantId: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        expiresAt: Date;
        isActive: boolean;
        prefix: string;
        scopes: string[];
        lastUsedAt: Date;
    }[]>;
    createApiKey(tenantId: string, name: string, expiresInDays?: number): Promise<{
        key: string;
        warning: string;
        id: string;
        name: string;
        createdAt: Date;
        expiresAt: Date;
        prefix: string;
        scopes: string[];
    }>;
    revokeApiKey(tenantId: string, id: string): Promise<{
        ok: boolean;
    }>;
    deleteApiKey(tenantId: string, id: string): Promise<{
        ok: boolean;
    }>;
}
export declare class PublicLeadsController {
    private svc;
    constructor(svc: PublicLeadsService);
    create(tenantId: string, body: any, queryKey: string, headerKey: string, req: any): Promise<{
        ok: boolean;
        clientId: any;
        isDuplicate: boolean;
        assignedAgentId: any;
        message: string;
    }>;
}
export declare class ApiKeysController {
    private svc;
    constructor(svc: PublicLeadsService);
    list(u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        expiresAt: Date;
        isActive: boolean;
        prefix: string;
        scopes: string[];
        lastUsedAt: Date;
    }[]>;
    create(body: {
        name: string;
        expiresInDays?: number;
    }, u: any): Promise<{
        key: string;
        warning: string;
        id: string;
        name: string;
        createdAt: Date;
        expiresAt: Date;
        prefix: string;
        scopes: string[];
    }>;
    revoke(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    guide(u: any): {
        endpoint: string;
        auth: string[];
        required: string[];
        optional: string[];
        example: {
            curl: string;
        };
    };
}
export declare class WebhookLogsController {
    private svc;
    private get prisma();
    constructor(svc: PublicLeadsService);
    list(u: any, apiKeyId?: string, success?: string, limit?: string): Promise<{
        data: any;
        total: any;
        stats: {
            successCount: any;
            failedCount: any;
            successRate: number;
        };
    }>;
    one(id: string, u: any): Promise<any>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
}
export declare class PublicLeadsModule {
}
