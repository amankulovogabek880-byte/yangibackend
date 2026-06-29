import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PhoneProviderFactory } from '../phone-providers/phone-providers.module';
export declare class CallsService {
    private prisma;
    private encryption;
    private notifications;
    private realtime;
    private providerFactory;
    private readonly logger;
    constructor(prisma: PrismaService, encryption: EncryptionService, notifications: NotificationsService, realtime: RealtimeGateway, providerFactory: PhoneProviderFactory);
    initiate(tenantId: string, userId: string, data: {
        toPhone: string;
        clientId?: string;
        bookingId?: string;
    }): Promise<{
        id: string;
        providerCallId: string;
        providerName: string;
        status: string;
        clientAction: {
            type: "tel" | "redirect" | "none";
            payload: string;
        };
    }>;
    private simulateStubCall;
    hangup(tenantId: string, userId: string, callId: string): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.CallStatus;
        createdAt: Date;
        tenantId: string;
        notes: string | null;
        clientId: string | null;
        duration: number;
        agentId: string | null;
        bookingId: string | null;
        direction: import(".prisma/client").$Enums.CallDirection;
        providerCallId: string | null;
        fromMasked: string | null;
        toMasked: string | null;
        fromRaw: string | null;
        toRaw: string | null;
        recordingUrl: string | null;
        transcript: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
    }>;
    handleWebhook(body: any): Promise<{
        ok: boolean;
    }>;
    getActive(userId: string): Promise<{
        client: {
            id: string;
            phone: string;
            fullName: string;
        };
    } & {
        id: string;
        status: import(".prisma/client").$Enums.CallStatus;
        createdAt: Date;
        tenantId: string;
        notes: string | null;
        clientId: string | null;
        duration: number;
        agentId: string | null;
        bookingId: string | null;
        direction: import(".prisma/client").$Enums.CallDirection;
        providerCallId: string | null;
        fromMasked: string | null;
        toMasked: string | null;
        fromRaw: string | null;
        toRaw: string | null;
        recordingUrl: string | null;
        transcript: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
    }>;
    getStats(tenantId: string, userId: string, role: string): Promise<{
        total: number;
        completed: number;
        answered: number;
        missed: number;
        noAnswer: number;
        totalDuration: number;
        avgDuration: number;
        totalMinutes: number;
        answerRate: number;
    }>;
    addNote(tenantId: string, userId: string, callId: string, notes: string): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.CallStatus;
        createdAt: Date;
        tenantId: string;
        notes: string | null;
        clientId: string | null;
        duration: number;
        agentId: string | null;
        bookingId: string | null;
        direction: import(".prisma/client").$Enums.CallDirection;
        providerCallId: string | null;
        fromMasked: string | null;
        toMasked: string | null;
        fromRaw: string | null;
        toRaw: string | null;
        recordingUrl: string | null;
        transcript: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
    }>;
    list(tenantId: string, userId: string, role: string, params: any): Promise<{
        data: ({
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
            status: import(".prisma/client").$Enums.CallStatus;
            createdAt: Date;
            tenantId: string;
            notes: string | null;
            clientId: string | null;
            duration: number;
            agentId: string | null;
            bookingId: string | null;
            direction: import(".prisma/client").$Enums.CallDirection;
            providerCallId: string | null;
            fromMasked: string | null;
            toMasked: string | null;
            fromRaw: string | null;
            toRaw: string | null;
            recordingUrl: string | null;
            transcript: string | null;
            startedAt: Date | null;
            answeredAt: Date | null;
            endedAt: Date | null;
        })[];
        total: number;
        page: number;
        limit: number;
    }>;
    logManual(tenantId: string, userId: string, data: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.CallStatus;
        createdAt: Date;
        tenantId: string;
        notes: string | null;
        clientId: string | null;
        duration: number;
        agentId: string | null;
        bookingId: string | null;
        direction: import(".prisma/client").$Enums.CallDirection;
        providerCallId: string | null;
        fromMasked: string | null;
        toMasked: string | null;
        fromRaw: string | null;
        toRaw: string | null;
        recordingUrl: string | null;
        transcript: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
    }>;
}
export declare class CallsController {
    private svc;
    constructor(svc: CallsService);
    list(u: any, clientId?: string, status?: string, direction?: string, page?: string, limit?: string): Promise<{
        data: ({
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
            status: import(".prisma/client").$Enums.CallStatus;
            createdAt: Date;
            tenantId: string;
            notes: string | null;
            clientId: string | null;
            duration: number;
            agentId: string | null;
            bookingId: string | null;
            direction: import(".prisma/client").$Enums.CallDirection;
            providerCallId: string | null;
            fromMasked: string | null;
            toMasked: string | null;
            fromRaw: string | null;
            toRaw: string | null;
            recordingUrl: string | null;
            transcript: string | null;
            startedAt: Date | null;
            answeredAt: Date | null;
            endedAt: Date | null;
        })[];
        total: number;
        page: number;
        limit: number;
    }>;
    active(u: any): Promise<{
        client: {
            id: string;
            phone: string;
            fullName: string;
        };
    } & {
        id: string;
        status: import(".prisma/client").$Enums.CallStatus;
        createdAt: Date;
        tenantId: string;
        notes: string | null;
        clientId: string | null;
        duration: number;
        agentId: string | null;
        bookingId: string | null;
        direction: import(".prisma/client").$Enums.CallDirection;
        providerCallId: string | null;
        fromMasked: string | null;
        toMasked: string | null;
        fromRaw: string | null;
        toRaw: string | null;
        recordingUrl: string | null;
        transcript: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
    }>;
    stats(u: any): Promise<{
        total: number;
        completed: number;
        answered: number;
        missed: number;
        noAnswer: number;
        totalDuration: number;
        avgDuration: number;
        totalMinutes: number;
        answerRate: number;
    }>;
    initiate(body: any, u: any): Promise<{
        id: string;
        providerCallId: string;
        providerName: string;
        status: string;
        clientAction: {
            type: "tel" | "redirect" | "none";
            payload: string;
        };
    }>;
    hangup(id: string, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.CallStatus;
        createdAt: Date;
        tenantId: string;
        notes: string | null;
        clientId: string | null;
        duration: number;
        agentId: string | null;
        bookingId: string | null;
        direction: import(".prisma/client").$Enums.CallDirection;
        providerCallId: string | null;
        fromMasked: string | null;
        toMasked: string | null;
        fromRaw: string | null;
        toRaw: string | null;
        recordingUrl: string | null;
        transcript: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
    }>;
    note(id: string, body: {
        notes: string;
    }, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.CallStatus;
        createdAt: Date;
        tenantId: string;
        notes: string | null;
        clientId: string | null;
        duration: number;
        agentId: string | null;
        bookingId: string | null;
        direction: import(".prisma/client").$Enums.CallDirection;
        providerCallId: string | null;
        fromMasked: string | null;
        toMasked: string | null;
        fromRaw: string | null;
        toRaw: string | null;
        recordingUrl: string | null;
        transcript: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
    }>;
    log(body: any, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.CallStatus;
        createdAt: Date;
        tenantId: string;
        notes: string | null;
        clientId: string | null;
        duration: number;
        agentId: string | null;
        bookingId: string | null;
        direction: import(".prisma/client").$Enums.CallDirection;
        providerCallId: string | null;
        fromMasked: string | null;
        toMasked: string | null;
        fromRaw: string | null;
        toRaw: string | null;
        recordingUrl: string | null;
        transcript: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
    }>;
    webhook(body: any): Promise<{
        ok: boolean;
    }>;
}
export declare class CallsModule {
}
