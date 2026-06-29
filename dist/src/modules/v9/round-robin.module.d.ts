import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.module';
export declare class RoundRobinService {
    private _prisma;
    private notifications;
    private audit;
    private readonly logger;
    constructor(_prisma: PrismaService, notifications: NotificationsService, audit: AuditService);
    private get prisma();
    getNextAgent(tenantId: string): Promise<string | null>;
    assignNewLead(params: {
        tenantId: string;
        clientId: string;
        clientName: string;
        source?: string;
    }): Promise<string | null>;
    assignUnassigned(tenantId: string): Promise<{
        assigned: number;
        skipped: number;
    }>;
    autoAssignClient(tenantId: string, clientId: string): Promise<string | null>;
    setStrategy(tenantId: string, strategy: string): Promise<any>;
    getStrategy(tenantId: string): Promise<{
        strategy: any;
    }>;
    getQueue(tenantId: string): Promise<any>;
    pauseAgent(tenantId: string, agentId: string, reason?: string, until?: string): Promise<{
        success: boolean;
    }>;
    unpauseAgent(tenantId: string, agentId: string): Promise<{
        success: boolean;
    }>;
    setDailyLimit(tenantId: string, agentId: string, limit: number): Promise<{
        success: boolean;
    }>;
}
export declare class RoundRobinController {
    private svc;
    constructor(svc: RoundRobinService);
    getStrategy(u: any): Promise<{
        strategy: any;
    }>;
    setStrategy(body: {
        strategy: string;
    }, u: any): Promise<any>;
    queue(u: any): Promise<any>;
    assign(clientId: string, u: any): Promise<string>;
    assignAll(u: any): Promise<{
        assigned: number;
        skipped: number;
    }>;
    pauseAgent(u: any, agentId: string, body: {
        reason?: string;
        until?: string;
    }): Promise<{
        success: boolean;
    }>;
    unpauseAgent(u: any, agentId: string): Promise<{
        success: boolean;
    }>;
    setDailyLimit(u: any, agentId: string, body: {
        limit: number;
    }): Promise<{
        success: boolean;
    }>;
}
export declare class RoundRobinModule {
}
