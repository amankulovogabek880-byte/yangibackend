import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ClientsService } from '../clients/clients.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { RoundRobinService } from '../v9/round-robin.module';
interface WhatsAppConfig {
    instanceId: string;
    token: string;
    webhookUrl?: string;
}
export declare class WhatsAppService {
    private prisma;
    private notifications;
    private clients;
    private realtime;
    private roundRobin;
    private readonly logger;
    constructor(prisma: PrismaService, notifications: NotificationsService, clients: ClientsService, realtime: RealtimeGateway, roundRobin: RoundRobinService);
    private getConfig;
    saveConfig(tenantId: string, config: WhatsAppConfig): Promise<{
        ok: boolean;
    }>;
    getConfigMasked(tenantId: string): Promise<{
        connected: boolean;
        instanceId?: undefined;
        token?: undefined;
        webhookUrl?: undefined;
    } | {
        connected: boolean;
        instanceId: string;
        token: string;
        webhookUrl: string;
    }>;
    sendMessage(tenantId: string, to: string, message: string, mediaUrl?: string): Promise<{
        ok: boolean;
        messageId: any;
    }>;
    handleWebhook(tenantId: string, payload: any): Promise<{
        ok: boolean;
    }>;
    getStatus(tenantId: string): Promise<{
        connected: boolean;
        status: string;
        phoneNumber?: undefined;
        battery?: undefined;
        error?: undefined;
    } | {
        connected: boolean;
        status: any;
        phoneNumber: any;
        battery: any;
        error?: undefined;
    } | {
        connected: boolean;
        status: string;
        error: any;
        phoneNumber?: undefined;
        battery?: undefined;
    }>;
    sendBookingConfirmation(tenantId: string, phone: string, data: {
        clientName: string;
        tourName: string;
        bookingRef: string;
        departureDate?: string;
        totalPrice?: number;
        currency?: string;
    }): Promise<{
        ok: boolean;
        messageId: any;
    }>;
    sendPaymentReminder(tenantId: string, phone: string, data: {
        clientName: string;
        amount: number;
        currency: string;
        bookingRef: string;
        dueDate?: string;
    }): Promise<{
        ok: boolean;
        messageId: any;
    }>;
}
export declare class WhatsAppController {
    private svc;
    constructor(svc: WhatsAppService);
    getConfig(u: any): Promise<{
        connected: boolean;
        instanceId?: undefined;
        token?: undefined;
        webhookUrl?: undefined;
    } | {
        connected: boolean;
        instanceId: string;
        token: string;
        webhookUrl: string;
    }>;
    saveConfig(body: {
        instanceId: string;
        token: string;
        webhookUrl?: string;
    }, u: any): Promise<{
        ok: boolean;
    }>;
    status(u: any): Promise<{
        connected: boolean;
        status: string;
        phoneNumber?: undefined;
        battery?: undefined;
        error?: undefined;
    } | {
        connected: boolean;
        status: any;
        phoneNumber: any;
        battery: any;
        error?: undefined;
    } | {
        connected: boolean;
        status: string;
        error: any;
        phoneNumber?: undefined;
        battery?: undefined;
    }>;
    send(body: {
        to: string;
        message: string;
        mediaUrl?: string;
    }, u: any): Promise<{
        ok: boolean;
        messageId: any;
    }>;
    sendBooking(body: any, u: any): Promise<{
        ok: boolean;
        messageId: any;
    }>;
    sendPayment(body: any, u: any): Promise<{
        ok: boolean;
        messageId: any;
    }>;
}
export declare class WhatsAppWebhookController {
    private svc;
    constructor(svc: WhatsAppService);
    webhook(tenantId: string, body: any): Promise<{
        ok: boolean;
    }>;
    verify(): {
        status: string;
        service: string;
    };
}
export declare class WhatsAppModule {
}
export {};
