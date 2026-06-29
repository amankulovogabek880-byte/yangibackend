import { PrismaService } from '../../prisma/prisma.service';
export declare class AutoReplyService {
    private prisma;
    constructor(prisma: PrismaService);
    list(tenantId: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        source: string | null;
        isActive: boolean;
        channel: string;
        template: string;
        delayMs: number;
        triggerCount: number;
    }[]>;
    create(tenantId: string, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        source: string | null;
        isActive: boolean;
        channel: string;
        template: string;
        delayMs: number;
        triggerCount: number;
    }>;
    update(tenantId: string, ruleId: string, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        source: string | null;
        isActive: boolean;
        channel: string;
        template: string;
        delayMs: number;
        triggerCount: number;
    }>;
    delete(tenantId: string, ruleId: string): Promise<{
        success: boolean;
    }>;
    toggle(tenantId: string, ruleId: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        source: string | null;
        isActive: boolean;
        channel: string;
        template: string;
        delayMs: number;
        triggerCount: number;
    }>;
    renderTemplate(template: string, client: any): Promise<string>;
    triggerRules(tenantId: string, clientId: string, source: string): Promise<void>;
}
export declare class AutoReplyController {
    private svc;
    constructor(svc: AutoReplyService);
    list(u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        source: string | null;
        isActive: boolean;
        channel: string;
        template: string;
        delayMs: number;
        triggerCount: number;
    }[]>;
    create(u: any, body: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        source: string | null;
        isActive: boolean;
        channel: string;
        template: string;
        delayMs: number;
        triggerCount: number;
    }>;
    update(u: any, id: string, body: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        source: string | null;
        isActive: boolean;
        channel: string;
        template: string;
        delayMs: number;
        triggerCount: number;
    }>;
    delete(u: any, id: string): Promise<{
        success: boolean;
    }>;
    toggle(u: any, id: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        source: string | null;
        isActive: boolean;
        channel: string;
        template: string;
        delayMs: number;
        triggerCount: number;
    }>;
}
export declare class AutoReplyModule {
}
