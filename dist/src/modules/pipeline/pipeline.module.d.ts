import { PrismaService } from '../../prisma/prisma.service';
import { PipelineStage } from '../../prisma-types';
import { Prisma } from '@prisma/client';
export declare class PipelineService {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    listPipelines(tenantId: string): Promise<{
        pipelineType: string;
        color: string;
        stages: {
            id: string;
            name: string;
            createdAt: Date;
            tenantId: string;
            order: number;
            pipelineId: string;
            color: string;
            isClosing: boolean;
            isLost: boolean;
        }[];
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        isDefault: boolean;
    }[]>;
    createPipeline(tenantId: string, data: {
        name: string;
        pipelineType?: string;
        color?: string;
    }): Promise<{
        stages: {
            id: string;
            name: string;
            createdAt: Date;
            tenantId: string;
            order: number;
            pipelineId: string;
            color: string;
            isClosing: boolean;
            isLost: boolean;
        }[];
    } & {
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        isDefault: boolean;
    }>;
    updatePipeline(tenantId: string, id: string, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        isDefault: boolean;
    }>;
    deletePipeline(tenantId: string, id: string): Promise<{
        success: boolean;
    }>;
    getBoard(tenantId: string, userId: string, role: string, agentId?: string, pipelineId?: string): Promise<{
        pipeline: {
            pipelineType: string;
            color: string;
            stages: {
                id: string;
                name: string;
                createdAt: Date;
                tenantId: string;
                order: number;
                pipelineId: string;
                color: string;
                isClosing: boolean;
                isLost: boolean;
            }[];
            id: string;
            name: string;
            createdAt: Date;
            tenantId: string;
            isDefault: boolean;
        };
        columns: {
            stage: any;
            clients: {
                id: any;
                fullName: any;
                phone: any;
                tier: any;
                leadScore: any;
                source: any;
                assignedAgent: any;
                stageEnteredAt: any;
                daysInStage: number;
                tags: any;
                totalRevenue: any;
                noContactAttempts: any;
                nextCallAt: any;
                travelDepartDate: any;
                travelDestination: any;
                bookingsCount: any;
                messagesCount: any;
                callsCount: any;
                lastContactAt: any;
            }[];
            count: number;
        }[];
        stages?: undefined;
    } | {
        stages: {
            stage: PipelineStage;
            label: string;
            color: string;
            isClosing: boolean;
            stageKey: PipelineStage;
            clients: {
                id: any;
                fullName: any;
                phone: any;
                tier: any;
                leadScore: any;
                source: any;
                assignedAgent: any;
                stageEnteredAt: any;
                daysInStage: number;
                tags: any;
                totalRevenue: any;
                noContactAttempts: any;
                nextCallAt: any;
                travelDepartDate: any;
                travelDestination: any;
                bookingsCount: any;
                messagesCount: any;
                callsCount: any;
                lastContactAt: any;
            }[];
            count: number;
            totalValue: number;
        }[];
        pipeline?: undefined;
        columns?: undefined;
    }>;
    private mapClient;
    moveStage(tenantId: string, userId: string, role: string, clientId: string, data: {
        stage: string;
        note?: string;
        lostReason?: string;
        lostReasonDetail?: string;
    }): Promise<{
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
        familyMembers: Prisma.JsonValue;
        preferences: Prisma.JsonValue;
        totalSpent: number;
        avgBookingValue: number;
        lifetimeValue: number;
        firstContactAt: Date | null;
        lastContactAt: Date | null;
        lastBookingAt: Date | null;
    }>;
    recordCallAttempt(tenantId: string, agentId: string, clientId: string, data: {
        outcome: string;
        note?: string;
        nextCallAt?: string;
    }): Promise<{
        attempts: any;
        nextCallAt: string;
        outcome: string;
    }>;
    getCustomStages(tenantId: string, pipelineId?: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        order: number;
        pipelineId: string;
        color: string;
        isClosing: boolean;
        isLost: boolean;
    }[]>;
    createCustomStage(tenantId: string, data: {
        name: string;
        color?: string;
        order?: number;
        isClosing?: boolean;
        pipelineId?: string;
    }): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        order: number;
        pipelineId: string;
        color: string;
        isClosing: boolean;
        isLost: boolean;
    }>;
    updateCustomStage(tenantId: string, id: string, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        order: number;
        pipelineId: string;
        color: string;
        isClosing: boolean;
        isLost: boolean;
    }>;
    deleteCustomStage(tenantId: string, id: string): Promise<{
        success: boolean;
    }>;
    reorderCustomStages(tenantId: string, orderedIds: string[]): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        order: number;
        pipelineId: string;
        color: string;
        isClosing: boolean;
        isLost: boolean;
    }[]>;
    getHistory(tenantId: string, clientId: string): Promise<({
        user: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        userId: string | null;
        clientId: string;
        note: string | null;
        fromStage: import(".prisma/client").$Enums.PipelineStage | null;
        toStage: import(".prisma/client").$Enums.PipelineStage;
        durationMs: bigint | null;
    })[]>;
    analytics(tenantId: string): Promise<{
        stageDistribution: (Prisma.PickEnumerable<Prisma.ClientGroupByOutputType, "pipelineStage"[]> & {
            _count: {
                id: number;
            };
        })[];
    }>;
    bulkMove(tenantId: string, userId: string, clientIds: string[], stage: string): Promise<{
        updated: number;
    }>;
    travelNotifications(): Promise<void>;
    taskReminders(): Promise<void>;
}
export declare class PipelineController {
    private svc;
    constructor(svc: PipelineService);
    listPipelines(u: any): Promise<{
        pipelineType: string;
        color: string;
        stages: {
            id: string;
            name: string;
            createdAt: Date;
            tenantId: string;
            order: number;
            pipelineId: string;
            color: string;
            isClosing: boolean;
            isLost: boolean;
        }[];
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        isDefault: boolean;
    }[]>;
    createPipeline(u: any, body: any): Promise<{
        stages: {
            id: string;
            name: string;
            createdAt: Date;
            tenantId: string;
            order: number;
            pipelineId: string;
            color: string;
            isClosing: boolean;
            isLost: boolean;
        }[];
    } & {
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        isDefault: boolean;
    }>;
    updatePipeline(u: any, id: string, body: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        isDefault: boolean;
    }>;
    deletePipeline(u: any, id: string): Promise<{
        success: boolean;
    }>;
    board(u: any, aid?: string, pid?: string): Promise<{
        pipeline: {
            pipelineType: string;
            color: string;
            stages: {
                id: string;
                name: string;
                createdAt: Date;
                tenantId: string;
                order: number;
                pipelineId: string;
                color: string;
                isClosing: boolean;
                isLost: boolean;
            }[];
            id: string;
            name: string;
            createdAt: Date;
            tenantId: string;
            isDefault: boolean;
        };
        columns: {
            stage: any;
            clients: {
                id: any;
                fullName: any;
                phone: any;
                tier: any;
                leadScore: any;
                source: any;
                assignedAgent: any;
                stageEnteredAt: any;
                daysInStage: number;
                tags: any;
                totalRevenue: any;
                noContactAttempts: any;
                nextCallAt: any;
                travelDepartDate: any;
                travelDestination: any;
                bookingsCount: any;
                messagesCount: any;
                callsCount: any;
                lastContactAt: any;
            }[];
            count: number;
        }[];
        stages?: undefined;
    } | {
        stages: {
            stage: PipelineStage;
            label: string;
            color: string;
            isClosing: boolean;
            stageKey: PipelineStage;
            clients: {
                id: any;
                fullName: any;
                phone: any;
                tier: any;
                leadScore: any;
                source: any;
                assignedAgent: any;
                stageEnteredAt: any;
                daysInStage: number;
                tags: any;
                totalRevenue: any;
                noContactAttempts: any;
                nextCallAt: any;
                travelDepartDate: any;
                travelDestination: any;
                bookingsCount: any;
                messagesCount: any;
                callsCount: any;
                lastContactAt: any;
            }[];
            count: number;
            totalValue: number;
        }[];
        pipeline?: undefined;
        columns?: undefined;
    }>;
    analytics(u: any): Promise<{
        stageDistribution: (Prisma.PickEnumerable<Prisma.ClientGroupByOutputType, "pipelineStage"[]> & {
            _count: {
                id: number;
            };
        })[];
    }>;
    history(u: any, id: string): Promise<({
        user: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        userId: string | null;
        clientId: string;
        note: string | null;
        fromStage: import(".prisma/client").$Enums.PipelineStage | null;
        toStage: import(".prisma/client").$Enums.PipelineStage;
        durationMs: bigint | null;
    })[]>;
    moveStage(u: any, id: string, body: any): Promise<{
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
        familyMembers: Prisma.JsonValue;
        preferences: Prisma.JsonValue;
        totalSpent: number;
        avgBookingValue: number;
        lifetimeValue: number;
        firstContactAt: Date | null;
        lastContactAt: Date | null;
        lastBookingAt: Date | null;
    }>;
    moveClient(u: any, id: string, body: any): Promise<{
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
        familyMembers: Prisma.JsonValue;
        preferences: Prisma.JsonValue;
        totalSpent: number;
        avgBookingValue: number;
        lifetimeValue: number;
        firstContactAt: Date | null;
        lastContactAt: Date | null;
        lastBookingAt: Date | null;
    }>;
    bulkMove(u: any, body: {
        clientIds: string[];
        stage: string;
    }): Promise<{
        updated: number;
    }>;
    callAttempt(u: any, id: string, body: any): Promise<{
        attempts: any;
        nextCallAt: string;
        outcome: string;
    }>;
    getStages(u: any, pid?: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        order: number;
        pipelineId: string;
        color: string;
        isClosing: boolean;
        isLost: boolean;
    }[]>;
    createStage(u: any, body: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        order: number;
        pipelineId: string;
        color: string;
        isClosing: boolean;
        isLost: boolean;
    }>;
    updateStage(u: any, id: string, body: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        order: number;
        pipelineId: string;
        color: string;
        isClosing: boolean;
        isLost: boolean;
    }>;
    deleteStage(u: any, id: string): Promise<{
        success: boolean;
    }>;
    reorderStages(u: any, body: {
        orderedIds: string[];
    }): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        tenantId: string;
        order: number;
        pipelineId: string;
        color: string;
        isClosing: boolean;
        isLost: boolean;
    }[]>;
}
export declare class PipelineModule {
}
