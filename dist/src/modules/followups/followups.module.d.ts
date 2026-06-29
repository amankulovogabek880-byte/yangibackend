import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
export declare class FollowUpsService {
    private prisma;
    private notifications;
    constructor(prisma: PrismaService, notifications: NotificationsService);
    list(tenantId: string, userId: string, role: string, params: any): Promise<({
        client: {
            id: string;
            phone: string;
            fullName: string;
        };
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        title: string;
        clientId: string | null;
        agentId: string;
        note: string | null;
        dueAt: Date;
        done: boolean;
        doneAt: Date | null;
        notifiedAt: Date | null;
    })[]>;
    create(tenantId: string, userId: string, data: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        title: string;
        clientId: string | null;
        agentId: string;
        note: string | null;
        dueAt: Date;
        done: boolean;
        doneAt: Date | null;
        notifiedAt: Date | null;
    }>;
    complete(tenantId: string, userId: string, role: string, id: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        title: string;
        clientId: string | null;
        agentId: string;
        note: string | null;
        dueAt: Date;
        done: boolean;
        doneAt: Date | null;
        notifiedAt: Date | null;
    }>;
    delete(tenantId: string, userId: string, role: string, id: string): Promise<{
        ok: boolean;
    }>;
    checkDueFollowUps(): Promise<void>;
}
export declare class FollowUpsController {
    private svc;
    constructor(svc: FollowUpsService);
    list(u: any, done?: string, clientId?: string): Promise<({
        client: {
            id: string;
            phone: string;
            fullName: string;
        };
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        title: string;
        clientId: string | null;
        agentId: string;
        note: string | null;
        dueAt: Date;
        done: boolean;
        doneAt: Date | null;
        notifiedAt: Date | null;
    })[]>;
    create(body: any, u: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        title: string;
        clientId: string | null;
        agentId: string;
        note: string | null;
        dueAt: Date;
        done: boolean;
        doneAt: Date | null;
        notifiedAt: Date | null;
    }>;
    complete(id: string, u: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        title: string;
        clientId: string | null;
        agentId: string;
        note: string | null;
        dueAt: Date;
        done: boolean;
        doneAt: Date | null;
        notifiedAt: Date | null;
    }>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    calendar(u: any, from?: string, to?: string): Promise<{
        items: any;
        byDate: Record<string, any[]>;
    }>;
}
export declare class FollowUpsModule {
}
