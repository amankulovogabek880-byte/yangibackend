import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
export declare class TasksService {
    private prisma;
    private notifications;
    constructor(prisma: PrismaService, notifications: NotificationsService);
    list(tenantId: string, userId: string, role: string, params: any): Promise<{
        data: ({
            client: {
                id: string;
                fullName: string;
            };
            creator: {
                id: string;
                name: string;
            };
            assignee: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            status: import(".prisma/client").$Enums.TaskStatus;
            createdAt: Date;
            updatedAt: Date;
            tags: string[];
            tenantId: string;
            title: string;
            description: string | null;
            clientId: string | null;
            bookingId: string | null;
            dueAt: Date | null;
            creatorId: string;
            assigneeId: string;
            priority: import(".prisma/client").$Enums.TaskPriority;
            completedAt: Date | null;
            recurrence: string | null;
            parentId: string | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    create(tenantId: string, userId: string, data: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.TaskStatus;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        title: string;
        description: string | null;
        clientId: string | null;
        bookingId: string | null;
        dueAt: Date | null;
        creatorId: string;
        assigneeId: string;
        priority: import(".prisma/client").$Enums.TaskPriority;
        completedAt: Date | null;
        recurrence: string | null;
        parentId: string | null;
    }>;
    update(tenantId: string, id: string, userId: string, role: string, data: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.TaskStatus;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        title: string;
        description: string | null;
        clientId: string | null;
        bookingId: string | null;
        dueAt: Date | null;
        creatorId: string;
        assigneeId: string;
        priority: import(".prisma/client").$Enums.TaskPriority;
        completedAt: Date | null;
        recurrence: string | null;
        parentId: string | null;
    }>;
    delete(tenantId: string, id: string, userId: string, role: string): Promise<{
        ok: boolean;
    }>;
}
export declare class TasksController {
    private svc;
    constructor(svc: TasksService);
    list(u: any, status?: string, assigneeId?: string, clientId?: string, bookingId?: string, priority?: string, page?: any, limit?: any): Promise<{
        data: ({
            client: {
                id: string;
                fullName: string;
            };
            creator: {
                id: string;
                name: string;
            };
            assignee: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            status: import(".prisma/client").$Enums.TaskStatus;
            createdAt: Date;
            updatedAt: Date;
            tags: string[];
            tenantId: string;
            title: string;
            description: string | null;
            clientId: string | null;
            bookingId: string | null;
            dueAt: Date | null;
            creatorId: string;
            assigneeId: string;
            priority: import(".prisma/client").$Enums.TaskPriority;
            completedAt: Date | null;
            recurrence: string | null;
            parentId: string | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    create(body: any, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.TaskStatus;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        title: string;
        description: string | null;
        clientId: string | null;
        bookingId: string | null;
        dueAt: Date | null;
        creatorId: string;
        assigneeId: string;
        priority: import(".prisma/client").$Enums.TaskPriority;
        completedAt: Date | null;
        recurrence: string | null;
        parentId: string | null;
    }>;
    update(id: string, body: any, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.TaskStatus;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        title: string;
        description: string | null;
        clientId: string | null;
        bookingId: string | null;
        dueAt: Date | null;
        creatorId: string;
        assigneeId: string;
        priority: import(".prisma/client").$Enums.TaskPriority;
        completedAt: Date | null;
        recurrence: string | null;
        parentId: string | null;
    }>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    changeStatus(id: string, body: {
        status: string;
    }, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.TaskStatus;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        title: string;
        description: string | null;
        clientId: string | null;
        bookingId: string | null;
        dueAt: Date | null;
        creatorId: string;
        assigneeId: string;
        priority: import(".prisma/client").$Enums.TaskPriority;
        completedAt: Date | null;
        recurrence: string | null;
        parentId: string | null;
    }>;
    board(u: any, assigneeId?: string): Promise<Record<string, any[]>>;
}
export declare class TasksModule {
}
