import { NotificationsService } from './notifications.service';
export declare class NotificationsController {
    private svc;
    constructor(svc: NotificationsService);
    list(u: any, unread?: string): Promise<{
        id: string;
        createdAt: Date;
        tenantId: string;
        userId: string;
        type: import(".prisma/client").$Enums.NotificationType;
        title: string;
        metadata: import("@prisma/client/runtime/library").JsonValue;
        link: string | null;
        body: string | null;
        isRead: boolean;
        readAt: Date | null;
    }[]>;
    count(u: any): Promise<{
        count: number;
    }>;
    read(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    readAll(u: any): Promise<{
        ok: boolean;
        updated: number;
    }>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    deleteAll(u: any): Promise<{
        ok: boolean;
        deleted: number;
    }>;
}
