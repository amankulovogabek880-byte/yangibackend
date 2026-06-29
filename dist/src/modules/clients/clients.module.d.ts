import { ClientsService } from './clients.service';
export declare class ClientsController {
    private svc;
    constructor(svc: ClientsService);
    list(u: any, search?: string, status?: string, tier?: string, source?: string, stage?: string, agentId?: string, tag?: string, sortBy?: any, page?: any, limit?: any): Promise<{
        data: ({
            _count: {
                bookings: number;
            };
            assignedAgent: {
                id: string;
                name: string;
                avatarUrl: string;
            };
        } & {
            id: string;
            status: import(".prisma/client").$Enums.ClientStatus;
            createdAt: Date;
            updatedAt: Date;
            tags: string[];
            tenantId: string;
            email: string | null;
            phone: string | null;
            telegramId: string | null;
            language: import(".prisma/client").$Enums.Language;
            totalBookings: number;
            totalRevenue: number;
            lostReason: import(".prisma/client").$Enums.LostReason | null;
            leadScore: number;
            assignedAgentId: string | null;
            fullName: string;
            phone2: string | null;
            passportNo: string | null;
            passportExpiry: Date | null;
            passportCountry: string | null;
            dateOfBirth: Date | null;
            nationality: string | null;
            country: string | null;
            gender: string | null;
            address: string | null;
            city: string | null;
            tier: import(".prisma/client").$Enums.ClientTier;
            source: import(".prisma/client").$Enums.LeadSource;
            utmSource: string | null;
            utmMedium: string | null;
            utmCampaign: string | null;
            utmTerm: string | null;
            utmContent: string | null;
            sourceCampaign: string | null;
            referrerUrl: string | null;
            pipelineStage: import(".prisma/client").$Enums.PipelineStage;
            pipelineStageAt: Date;
            notes: string | null;
            internalNotes: string | null;
            telegramUsername: string | null;
            instagramHandle: string | null;
            whatsappPhone: string | null;
            familyMembers: import("@prisma/client/runtime/library").JsonValue;
            preferences: import("@prisma/client/runtime/library").JsonValue;
            totalSpent: number;
            avgBookingValue: number;
            lifetimeValue: number;
            firstContactAt: Date | null;
            lastContactAt: Date | null;
            lastBookingAt: Date | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    stats(u: any): Promise<{
        total: number;
        newThisMonth: number;
        bySource: (import(".prisma/client").Prisma.PickEnumerable<import(".prisma/client").Prisma.ClientGroupByOutputType, "source"[]> & {
            _count: {
                id: number;
            };
        })[];
        byTier: (import(".prisma/client").Prisma.PickEnumerable<import(".prisma/client").Prisma.ClientGroupByOutputType, "tier"[]> & {
            _count: {
                id: number;
            };
        })[];
        byStage: (import(".prisma/client").Prisma.PickEnumerable<import(".prisma/client").Prisma.ClientGroupByOutputType, "pipelineStage"[]> & {
            _count: {
                id: number;
            };
        })[];
    }>;
    one(id: string, u: any): Promise<any>;
    timeline(id: string, u: any): Promise<{
        id: string;
        createdAt: Date;
        userId: string | null;
        type: string;
        title: string;
        description: string | null;
        metadata: import("@prisma/client/runtime/library").JsonValue;
        clientId: string;
    }[]>;
    create(body: any, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.ClientStatus;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        email: string | null;
        phone: string | null;
        telegramId: string | null;
        language: import(".prisma/client").$Enums.Language;
        totalBookings: number;
        totalRevenue: number;
        lostReason: import(".prisma/client").$Enums.LostReason | null;
        leadScore: number;
        assignedAgentId: string | null;
        fullName: string;
        phone2: string | null;
        passportNo: string | null;
        passportExpiry: Date | null;
        passportCountry: string | null;
        dateOfBirth: Date | null;
        nationality: string | null;
        country: string | null;
        gender: string | null;
        address: string | null;
        city: string | null;
        tier: import(".prisma/client").$Enums.ClientTier;
        source: import(".prisma/client").$Enums.LeadSource;
        utmSource: string | null;
        utmMedium: string | null;
        utmCampaign: string | null;
        utmTerm: string | null;
        utmContent: string | null;
        sourceCampaign: string | null;
        referrerUrl: string | null;
        pipelineStage: import(".prisma/client").$Enums.PipelineStage;
        pipelineStageAt: Date;
        notes: string | null;
        internalNotes: string | null;
        telegramUsername: string | null;
        instagramHandle: string | null;
        whatsappPhone: string | null;
        familyMembers: import("@prisma/client/runtime/library").JsonValue;
        preferences: import("@prisma/client/runtime/library").JsonValue;
        totalSpent: number;
        avgBookingValue: number;
        lifetimeValue: number;
        firstContactAt: Date | null;
        lastContactAt: Date | null;
        lastBookingAt: Date | null;
    }>;
    update(id: string, body: any, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.ClientStatus;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        email: string | null;
        phone: string | null;
        telegramId: string | null;
        language: import(".prisma/client").$Enums.Language;
        totalBookings: number;
        totalRevenue: number;
        lostReason: import(".prisma/client").$Enums.LostReason | null;
        leadScore: number;
        assignedAgentId: string | null;
        fullName: string;
        phone2: string | null;
        passportNo: string | null;
        passportExpiry: Date | null;
        passportCountry: string | null;
        dateOfBirth: Date | null;
        nationality: string | null;
        country: string | null;
        gender: string | null;
        address: string | null;
        city: string | null;
        tier: import(".prisma/client").$Enums.ClientTier;
        source: import(".prisma/client").$Enums.LeadSource;
        utmSource: string | null;
        utmMedium: string | null;
        utmCampaign: string | null;
        utmTerm: string | null;
        utmContent: string | null;
        sourceCampaign: string | null;
        referrerUrl: string | null;
        pipelineStage: import(".prisma/client").$Enums.PipelineStage;
        pipelineStageAt: Date;
        notes: string | null;
        internalNotes: string | null;
        telegramUsername: string | null;
        instagramHandle: string | null;
        whatsappPhone: string | null;
        familyMembers: import("@prisma/client/runtime/library").JsonValue;
        preferences: import("@prisma/client/runtime/library").JsonValue;
        totalSpent: number;
        avgBookingValue: number;
        lifetimeValue: number;
        firstContactAt: Date | null;
        lastContactAt: Date | null;
        lastBookingAt: Date | null;
    }>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    addNote(id: string, note: string, u: any): Promise<{
        id: string;
        createdAt: Date;
        userId: string | null;
        type: string;
        title: string;
        description: string | null;
        metadata: import("@prisma/client/runtime/library").JsonValue;
        clientId: string;
    }>;
    setTier(id: string, tier: string, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.ClientStatus;
        createdAt: Date;
        updatedAt: Date;
        tags: string[];
        tenantId: string;
        email: string | null;
        phone: string | null;
        telegramId: string | null;
        language: import(".prisma/client").$Enums.Language;
        totalBookings: number;
        totalRevenue: number;
        lostReason: import(".prisma/client").$Enums.LostReason | null;
        leadScore: number;
        assignedAgentId: string | null;
        fullName: string;
        phone2: string | null;
        passportNo: string | null;
        passportExpiry: Date | null;
        passportCountry: string | null;
        dateOfBirth: Date | null;
        nationality: string | null;
        country: string | null;
        gender: string | null;
        address: string | null;
        city: string | null;
        tier: import(".prisma/client").$Enums.ClientTier;
        source: import(".prisma/client").$Enums.LeadSource;
        utmSource: string | null;
        utmMedium: string | null;
        utmCampaign: string | null;
        utmTerm: string | null;
        utmContent: string | null;
        sourceCampaign: string | null;
        referrerUrl: string | null;
        pipelineStage: import(".prisma/client").$Enums.PipelineStage;
        pipelineStageAt: Date;
        notes: string | null;
        internalNotes: string | null;
        telegramUsername: string | null;
        instagramHandle: string | null;
        whatsappPhone: string | null;
        familyMembers: import("@prisma/client/runtime/library").JsonValue;
        preferences: import("@prisma/client/runtime/library").JsonValue;
        totalSpent: number;
        avgBookingValue: number;
        lifetimeValue: number;
        firstContactAt: Date | null;
        lastContactAt: Date | null;
        lastBookingAt: Date | null;
    }>;
    getConversation(id: string, u: any): Promise<{
        conversationId: string;
        isNew: boolean;
    }>;
    checkConversation(id: string, u: any): Promise<{
        exists: boolean;
        conversationId: any;
        conversation?: undefined;
    } | {
        exists: boolean;
        conversationId: string;
        conversation: {
            id: string;
            channel: import(".prisma/client").$Enums.Channel;
            isResolved: boolean;
            unreadCount: number;
            lastMessageAt: Date;
            lastMessageText: string;
        };
    }>;
    callClient(id: string, u: any): Promise<{
        callId: string;
        id: string;
        phone: string;
        message: string;
    }>;
    exportCsv(u: any): Promise<{
        csv: string;
        count: number;
    }>;
    statsBySource(u: any): Promise<{
        source: string;
        count: number;
        revenue: number;
    }[]>;
    statsByStage(u: any): Promise<{
        stage: import(".prisma/client").$Enums.PipelineStage;
        count: number;
    }[]>;
}
export declare class ClientsModule {
}
