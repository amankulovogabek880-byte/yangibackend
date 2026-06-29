import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType } from '../../prisma-types';
import { EmailService } from '../email/email.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
interface CreateNotificationDto {
    tenantId: string;
    userId: string;
    type: NotificationType;
    title: string;
    body?: string;
    link?: string;
    metadata?: any;
}
export declare class NotificationsService {
    private prisma;
    private email;
    private realtime;
    private readonly logger;
    constructor(prisma: PrismaService, email: EmailService, realtime: RealtimeGateway);
    create(data: CreateNotificationDto): Promise<{
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
    }>;
    private shouldSendEmail;
    private buildEmailHtml;
    private sendTelegramAlert;
    createBulk(notifications: CreateNotificationDto[]): Promise<{
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
    list(userId: string, unreadOnly?: boolean, limit?: number): Promise<{
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
    unreadCount(userId: string): Promise<{
        count: number;
    }>;
    markRead(userId: string, id: string, tenantId: string): Promise<{
        ok: boolean;
    }>;
    markAllRead(userId: string, tenantId: string): Promise<{
        ok: boolean;
        updated: number;
    }>;
    delete(userId: string, id: string, tenantId: string): Promise<{
        ok: boolean;
    }>;
    deleteAll(userId: string, tenantId: string): Promise<{
        ok: boolean;
        deleted: number;
    }>;
}
export {};
