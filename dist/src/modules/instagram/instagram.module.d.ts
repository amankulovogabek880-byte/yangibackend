import { RoundRobinService } from '../v9/round-robin.module';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
export declare class InstagramService {
    private prisma;
    private realtime;
    private roundRobin;
    private readonly logger;
    constructor(prisma: PrismaService, realtime: RealtimeGateway, roundRobin: RoundRobinService);
    getConfig(tenantId: string): Promise<{
        accessToken: any;
        pageId: any;
        verifyToken: any;
        botName: any;
        greetingMessage: any;
        farewell: any;
        assignToAgentId: any;
        isEnabled: boolean;
        botSteps: any;
    }>;
    saveConfig(tenantId: string, data: {
        accessToken?: string;
        pageId?: string;
        verifyToken?: string;
        botName?: string;
        greetingMessage?: string;
        assignToAgentId?: string;
    }): Promise<{
        accessToken: any;
        pageId: any;
        verifyToken: any;
        botName: any;
        greetingMessage: any;
        farewell: any;
        assignToAgentId: any;
        isEnabled: boolean;
        botSteps: any;
    }>;
    verifyWebhook(tenantId: string, mode: string, token: string, challenge: string, verifyToken: string): string;
    processWebhook(tenantId: string, body: any, signature?: string): Promise<{
        ok: boolean;
    }>;
    private handleMessage;
    private createLead;
    private reply;
    private getSession;
    private saveSession;
    private deleteSession;
    getStats(tenantId: string): Promise<{
        total: number;
        thisMonth: number;
        activeSessions: number;
    }>;
}
export declare class InstagramController {
    private svc;
    constructor(svc: InstagramService);
    verifyWebhook(tenantId: string, mode: string, token: string, challenge: string): Promise<string>;
    webhook(tenantId: string, body: any, sig?: string): Promise<{
        ok: boolean;
    }>;
    getConfig(u: any): Promise<{
        accessToken: any;
        pageId: any;
        verifyToken: any;
        botName: any;
        greetingMessage: any;
        farewell: any;
        assignToAgentId: any;
        isEnabled: boolean;
        botSteps: any;
    }>;
    saveConfig(u: any, body: any): Promise<{
        accessToken: any;
        pageId: any;
        verifyToken: any;
        botName: any;
        greetingMessage: any;
        farewell: any;
        assignToAgentId: any;
        isEnabled: boolean;
        botSteps: any;
    }>;
    stats(u: any): Promise<{
        total: number;
        thisMonth: number;
        activeSessions: number;
    }>;
}
export declare class InstagramModule {
}
