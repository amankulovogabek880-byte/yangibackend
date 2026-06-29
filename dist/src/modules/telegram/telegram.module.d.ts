import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ClientsService } from '../clients/clients.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Prisma } from '@prisma/client';
export declare class TelegramService implements OnModuleInit, OnModuleDestroy {
    private prisma;
    private notifications;
    private clients;
    private realtime;
    private readonly logger;
    private bots;
    constructor(prisma: PrismaService, notifications: NotificationsService, clients: ClientsService, realtime: RealtimeGateway);
    onModuleInit(): Promise<void>;
    onModuleDestroy(): Promise<void>;
    private startBot;
    private pickAgent;
    private inferType;
    private handleIncoming;
    sendMessage(tenantId: string, conversationId: string, text: string, agentId: string, agentRole: string, isInternal?: boolean): Promise<{
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        text: string | null;
        duration: number | null;
        agentId: string | null;
        errorMessage: string | null;
        isRead: boolean;
        conversationId: string;
        externalMsgId: string | null;
        direction: import(".prisma/client").$Enums.MessageDirection;
        messageType: import(".prisma/client").$Enums.MessageType;
        fileUrl: string | null;
        fileMimeType: string | null;
        fileSize: number | null;
        thumbnailUrl: string | null;
        caption: string | null;
        replyToId: string | null;
        forwardedFrom: string | null;
        isInternal: boolean;
        isDelivered: boolean;
        isFailed: boolean;
    }>;
    sendMedia(tenantId: string, conversationId: string, agentId: string, agentRole: string, data: {
        fileUrl: string;
        mimeType?: string;
        caption?: string;
        mediaType?: 'photo' | 'document' | 'video';
    }): Promise<{
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        text: string | null;
        duration: number | null;
        agentId: string | null;
        errorMessage: string | null;
        isRead: boolean;
        conversationId: string;
        externalMsgId: string | null;
        direction: import(".prisma/client").$Enums.MessageDirection;
        messageType: import(".prisma/client").$Enums.MessageType;
        fileUrl: string | null;
        fileMimeType: string | null;
        fileSize: number | null;
        thumbnailUrl: string | null;
        caption: string | null;
        replyToId: string | null;
        forwardedFrom: string | null;
        isInternal: boolean;
        isDelivered: boolean;
        isFailed: boolean;
    }>;
    sendTemplate(tenantId: string, conversationId: string, agentId: string, agentRole: string, templateId: string): Promise<{
        sent: number;
        messages: any[];
    }>;
    sendInvoiceFromInbox(tenantId: string, conversationId: string, agentId: string, agentRole: string, data: {
        bookingId: string;
        salePrice: number;
        providerCost?: number;
        discount?: number;
        notes?: string;
        currency?: string;
        dueDate?: string;
    }): Promise<{
        invoice: {
            id: string;
            status: import(".prisma/client").$Enums.InvoiceStatus;
            currency: import(".prisma/client").$Enums.Currency;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            notes: string | null;
            internalNotes: string | null;
            clientId: string;
            paidAmount: number;
            discount: number;
            profit: number;
            agentId: string | null;
            paidAt: Date | null;
            bookingId: string;
            sentAt: Date | null;
            invoiceNumber: string;
            providerCost: number;
            salePrice: number;
            taxAmount: number;
            totalAmount: number;
            issuedAt: Date;
            dueDate: Date | null;
            items: Prisma.JsonValue;
            pdfUrl: string | null;
            pdfGeneratedAt: Date | null;
            sentViaTelegram: boolean;
        };
        message: {
            agent: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            createdAt: Date;
            text: string | null;
            duration: number | null;
            agentId: string | null;
            errorMessage: string | null;
            isRead: boolean;
            conversationId: string;
            externalMsgId: string | null;
            direction: import(".prisma/client").$Enums.MessageDirection;
            messageType: import(".prisma/client").$Enums.MessageType;
            fileUrl: string | null;
            fileMimeType: string | null;
            fileSize: number | null;
            thumbnailUrl: string | null;
            caption: string | null;
            replyToId: string | null;
            forwardedFrom: string | null;
            isInternal: boolean;
            isDelivered: boolean;
            isFailed: boolean;
        };
    }>;
    private formatInvoiceMessage;
    claim(tenantId: string, conversationId: string, userId: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        avatarUrl: string | null;
        assignedAgentId: string | null;
        clientId: string | null;
        channel: import(".prisma/client").$Enums.Channel;
        externalChatId: string;
        externalUserId: string | null;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        startPayload: string | null;
        isResolved: boolean;
        isPinned: boolean;
        isMuted: boolean;
        unreadCount: number;
        lastMessageAt: Date | null;
        lastMessageText: string | null;
        lastMessageType: import(".prisma/client").$Enums.MessageType | null;
        accountId: string | null;
    }>;
    connectBot(tenantId: string, token: string, name: string, userId?: string): Promise<{
        botToken: any;
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        userId: string | null;
        isActive: boolean;
        channel: import(".prisma/client").$Enums.Channel;
        botUsername: string | null;
        isPersonal: boolean;
        phoneNumber: string | null;
        apiId: string | null;
        apiHash: string | null;
        sessionData: string | null;
        config: Prisma.JsonValue;
    }>;
    startNewConversation(tenantId: string, userId: string, data: {
        chatId?: string;
        username?: string;
        text: string;
        clientId?: string;
        accountId?: string;
    }): Promise<{
        conversationId: string;
        ok: boolean;
    }>;
    disconnectBot(tenantId: string, accountId: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        userId: string | null;
        isActive: boolean;
        channel: import(".prisma/client").$Enums.Channel;
        botToken: string | null;
        botUsername: string | null;
        isPersonal: boolean;
        phoneNumber: string | null;
        apiId: string | null;
        apiHash: string | null;
        sessionData: string | null;
        config: Prisma.JsonValue;
    }>;
    getConversations(tenantId: string, userId: string, role: string, params: any): Promise<{
        data: any[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    getMessages(tenantId: string, userId: string, role: string, conversationId: string): Promise<{
        messages: ({
            agent: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            createdAt: Date;
            text: string | null;
            duration: number | null;
            agentId: string | null;
            errorMessage: string | null;
            isRead: boolean;
            conversationId: string;
            externalMsgId: string | null;
            direction: import(".prisma/client").$Enums.MessageDirection;
            messageType: import(".prisma/client").$Enums.MessageType;
            fileUrl: string | null;
            fileMimeType: string | null;
            fileSize: number | null;
            thumbnailUrl: string | null;
            caption: string | null;
            replyToId: string | null;
            forwardedFrom: string | null;
            isInternal: boolean;
            isDelivered: boolean;
            isFailed: boolean;
        })[];
        conversation: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tags: string[];
            tenantId: string;
            avatarUrl: string | null;
            assignedAgentId: string | null;
            clientId: string | null;
            channel: import(".prisma/client").$Enums.Channel;
            externalChatId: string;
            externalUserId: string | null;
            firstName: string | null;
            lastName: string | null;
            username: string | null;
            startPayload: string | null;
            isResolved: boolean;
            isPinned: boolean;
            isMuted: boolean;
            unreadCount: number;
            lastMessageAt: Date | null;
            lastMessageText: string | null;
            lastMessageType: import(".prisma/client").$Enums.MessageType | null;
            accountId: string | null;
        };
    }>;
    assignAgent(tenantId: string, conversationId: string, agentId: string | null): Promise<{
        ok: boolean;
    }>;
    resolve(tenantId: string, conversationId: string): Promise<{
        ok: boolean;
    }>;
    linkClient(tenantId: string, conversationId: string, clientId: string): Promise<{
        ok: boolean;
    }>;
    getAccounts(tenantId: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        isActive: boolean;
        channel: import(".prisma/client").$Enums.Channel;
        botUsername: string;
    }[]>;
    getTemplates(tenantId: string, userId: string, role: string, filters?: {
        category?: string;
        language?: string;
    }): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        language: import(".prisma/client").$Enums.Language;
        userId: string | null;
        text: string;
        category: string | null;
        mediaUrl: string | null;
        mediaType: string | null;
        mediaCaption: string | null;
        attachments: Prisma.JsonValue;
        isActive: boolean;
        useCount: number;
    }[]>;
    createTemplate(tenantId: string, userId: string, role: string, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        language: import(".prisma/client").$Enums.Language;
        userId: string | null;
        text: string;
        category: string | null;
        mediaUrl: string | null;
        mediaType: string | null;
        mediaCaption: string | null;
        attachments: Prisma.JsonValue;
        isActive: boolean;
        useCount: number;
    }>;
    updateTemplate(tenantId: string, userId: string, role: string, id: string, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        language: import(".prisma/client").$Enums.Language;
        userId: string | null;
        text: string;
        category: string | null;
        mediaUrl: string | null;
        mediaType: string | null;
        mediaCaption: string | null;
        attachments: Prisma.JsonValue;
        isActive: boolean;
        useCount: number;
    }>;
    deleteTemplate(tenantId: string, userId: string, role: string, id: string): Promise<{
        ok: boolean;
    }>;
}
export declare class TelegramController {
    private svc;
    constructor(svc: TelegramService);
    accounts(u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        isActive: boolean;
        channel: import(".prisma/client").$Enums.Channel;
        botUsername: string;
    }[]>;
    connect(body: any, u: any): Promise<{
        botToken: any;
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        userId: string | null;
        isActive: boolean;
        channel: import(".prisma/client").$Enums.Channel;
        botUsername: string | null;
        isPersonal: boolean;
        phoneNumber: string | null;
        apiId: string | null;
        apiHash: string | null;
        sessionData: string | null;
        config: Prisma.JsonValue;
    }>;
    connectPersonal(body: any, u: any): Promise<{
        botToken: any;
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        userId: string | null;
        isActive: boolean;
        channel: import(".prisma/client").$Enums.Channel;
        botUsername: string | null;
        isPersonal: boolean;
        phoneNumber: string | null;
        apiId: string | null;
        apiHash: string | null;
        sessionData: string | null;
        config: Prisma.JsonValue;
    }>;
    disconnect(id: string, u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        userId: string | null;
        isActive: boolean;
        channel: import(".prisma/client").$Enums.Channel;
        botToken: string | null;
        botUsername: string | null;
        isPersonal: boolean;
        phoneNumber: string | null;
        apiId: string | null;
        apiHash: string | null;
        sessionData: string | null;
        config: Prisma.JsonValue;
    }>;
    startNew(body: {
        chatId?: string;
        username?: string;
        text: string;
        clientId?: string;
        accountId?: string;
    }, u: any): Promise<{
        conversationId: string;
        ok: boolean;
    }>;
    conversations(u: any, resolved?: string, channel?: string, agentId?: string, unassigned?: string, page?: any, limit?: any): Promise<any[]>;
    messages(id: string, u: any): Promise<{
        messages: ({
            agent: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            createdAt: Date;
            text: string | null;
            duration: number | null;
            agentId: string | null;
            errorMessage: string | null;
            isRead: boolean;
            conversationId: string;
            externalMsgId: string | null;
            direction: import(".prisma/client").$Enums.MessageDirection;
            messageType: import(".prisma/client").$Enums.MessageType;
            fileUrl: string | null;
            fileMimeType: string | null;
            fileSize: number | null;
            thumbnailUrl: string | null;
            caption: string | null;
            replyToId: string | null;
            forwardedFrom: string | null;
            isInternal: boolean;
            isDelivered: boolean;
            isFailed: boolean;
        })[];
        conversation: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tags: string[];
            tenantId: string;
            avatarUrl: string | null;
            assignedAgentId: string | null;
            clientId: string | null;
            channel: import(".prisma/client").$Enums.Channel;
            externalChatId: string;
            externalUserId: string | null;
            firstName: string | null;
            lastName: string | null;
            username: string | null;
            startPayload: string | null;
            isResolved: boolean;
            isPinned: boolean;
            isMuted: boolean;
            unreadCount: number;
            lastMessageAt: Date | null;
            lastMessageText: string | null;
            lastMessageType: import(".prisma/client").$Enums.MessageType | null;
            accountId: string | null;
        };
    }>;
    send(id: string, body: any, u: any): Promise<{
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        text: string | null;
        duration: number | null;
        agentId: string | null;
        errorMessage: string | null;
        isRead: boolean;
        conversationId: string;
        externalMsgId: string | null;
        direction: import(".prisma/client").$Enums.MessageDirection;
        messageType: import(".prisma/client").$Enums.MessageType;
        fileUrl: string | null;
        fileMimeType: string | null;
        fileSize: number | null;
        thumbnailUrl: string | null;
        caption: string | null;
        replyToId: string | null;
        forwardedFrom: string | null;
        isInternal: boolean;
        isDelivered: boolean;
        isFailed: boolean;
    }>;
    sendMedia(id: string, body: any, u: any): Promise<{
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        text: string | null;
        duration: number | null;
        agentId: string | null;
        errorMessage: string | null;
        isRead: boolean;
        conversationId: string;
        externalMsgId: string | null;
        direction: import(".prisma/client").$Enums.MessageDirection;
        messageType: import(".prisma/client").$Enums.MessageType;
        fileUrl: string | null;
        fileMimeType: string | null;
        fileSize: number | null;
        thumbnailUrl: string | null;
        caption: string | null;
        replyToId: string | null;
        forwardedFrom: string | null;
        isInternal: boolean;
        isDelivered: boolean;
        isFailed: boolean;
    }>;
    sendTemplate(id: string, templateId: string, u: any): Promise<{
        sent: number;
        messages: any[];
    }>;
    sendInvoice(id: string, body: any, u: any): Promise<{
        invoice: {
            id: string;
            status: import(".prisma/client").$Enums.InvoiceStatus;
            currency: import(".prisma/client").$Enums.Currency;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            notes: string | null;
            internalNotes: string | null;
            clientId: string;
            paidAmount: number;
            discount: number;
            profit: number;
            agentId: string | null;
            paidAt: Date | null;
            bookingId: string;
            sentAt: Date | null;
            invoiceNumber: string;
            providerCost: number;
            salePrice: number;
            taxAmount: number;
            totalAmount: number;
            issuedAt: Date;
            dueDate: Date | null;
            items: Prisma.JsonValue;
            pdfUrl: string | null;
            pdfGeneratedAt: Date | null;
            sentViaTelegram: boolean;
        };
        message: {
            agent: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            createdAt: Date;
            text: string | null;
            duration: number | null;
            agentId: string | null;
            errorMessage: string | null;
            isRead: boolean;
            conversationId: string;
            externalMsgId: string | null;
            direction: import(".prisma/client").$Enums.MessageDirection;
            messageType: import(".prisma/client").$Enums.MessageType;
            fileUrl: string | null;
            fileMimeType: string | null;
            fileSize: number | null;
            thumbnailUrl: string | null;
            caption: string | null;
            replyToId: string | null;
            forwardedFrom: string | null;
            isInternal: boolean;
            isDelivered: boolean;
            isFailed: boolean;
        };
    }>;
    assign(id: string, body: any, u: any): Promise<{
        ok: boolean;
    }>;
    claim(id: string, u: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        avatarUrl: string | null;
        assignedAgentId: string | null;
        clientId: string | null;
        channel: import(".prisma/client").$Enums.Channel;
        externalChatId: string;
        externalUserId: string | null;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        startPayload: string | null;
        isResolved: boolean;
        isPinned: boolean;
        isMuted: boolean;
        unreadCount: number;
        lastMessageAt: Date | null;
        lastMessageText: string | null;
        lastMessageType: import(".prisma/client").$Enums.MessageType | null;
        accountId: string | null;
    }>;
    resolve(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    link(id: string, body: any, u: any): Promise<{
        ok: boolean;
    }>;
    templates(u: any, category?: string, language?: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        language: import(".prisma/client").$Enums.Language;
        userId: string | null;
        text: string;
        category: string | null;
        mediaUrl: string | null;
        mediaType: string | null;
        mediaCaption: string | null;
        attachments: Prisma.JsonValue;
        isActive: boolean;
        useCount: number;
    }[]>;
    createTemplate(body: any, u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        language: import(".prisma/client").$Enums.Language;
        userId: string | null;
        text: string;
        category: string | null;
        mediaUrl: string | null;
        mediaType: string | null;
        mediaCaption: string | null;
        attachments: Prisma.JsonValue;
        isActive: boolean;
        useCount: number;
    }>;
    updateTemplate(id: string, body: any, u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        language: import(".prisma/client").$Enums.Language;
        userId: string | null;
        text: string;
        category: string | null;
        mediaUrl: string | null;
        mediaType: string | null;
        mediaCaption: string | null;
        attachments: Prisma.JsonValue;
        isActive: boolean;
        useCount: number;
    }>;
    deleteTemplate(id: string, u: any): Promise<{
        ok: boolean;
    }>;
}
export declare class TelegramModule {
}
