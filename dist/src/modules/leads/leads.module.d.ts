import { ExecutionContext, CanActivate } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RoundRobinService } from '../v9/round-robin.module';
export declare function hashApiKey(raw: string): string;
export declare class ApiKeyGuard implements CanActivate {
    private prisma;
    constructor(prisma: PrismaService);
    canActivate(ctx: ExecutionContext): Promise<boolean>;
}
export declare class LeadsService {
    private prisma;
    private notifications;
    private roundRobin;
    constructor(prisma: PrismaService, notifications: NotificationsService, roundRobin: RoundRobinService);
    pickAgent(tenantId: string): Promise<string | null>;
    importLead(tenantId: string, data: any): Promise<{
        id: string;
        assignedAgentId: string;
        isDuplicate: boolean;
    }>;
    listKeys(tenantId: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        isActive: boolean;
        prefix: string;
        scopes: string[];
        lastUsedAt: Date;
    }[]>;
    createKey(tenantId: string, name: string): Promise<{
        id: string;
        name: string;
        key: string;
        prefix: string;
        warning: string;
    }>;
    revokeKey(tenantId: string, id: string): Promise<{
        ok: boolean;
    }>;
}
export declare class PublicLeadsController {
    private svc;
    constructor(svc: LeadsService);
    import(body: any, req: any): Promise<{
        id: string;
        assignedAgentId: string;
        isDuplicate: boolean;
    }>;
}
export declare class ApiKeysController {
    private svc;
    constructor(svc: LeadsService);
    list(u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        isActive: boolean;
        prefix: string;
        scopes: string[];
        lastUsedAt: Date;
    }[]>;
    create(body: any, u: any): Promise<{
        id: string;
        name: string;
        key: string;
        prefix: string;
        warning: string;
    }>;
    revoke(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    testSend(id: string, body: any, u: any): Promise<{
        id: string;
        assignedAgentId: string;
        isDuplicate: boolean;
    }>;
}
export declare class LeadsModule {
}
