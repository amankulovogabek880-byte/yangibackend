import { PrismaService } from '../../prisma/prisma.service';
import { ClientsService } from '../clients/clients.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuditService } from '../audit/audit.module';
import { Prisma } from '@prisma/client';
export declare class PaymentsService {
    private prisma;
    private clients;
    private notifications;
    private realtime;
    private audit;
    constructor(prisma: PrismaService, clients: ClientsService, notifications: NotificationsService, realtime: RealtimeGateway, audit: AuditService);
    findAll(tenantId: string, userId: string, role: string, params: any): Promise<{
        data: ({
            client: {
                id: string;
                phone: string;
                fullName: string;
            };
            booking: {
                id: string;
                bookingRef: string;
                tourName: string;
            };
        } & {
            id: string;
            status: import(".prisma/client").$Enums.PaymentStatus;
            currency: import(".prisma/client").$Enums.Currency;
            createdAt: Date;
            tenantId: string;
            clientId: string;
            amount: number;
            uzsRate: number | null;
            method: import(".prisma/client").$Enums.PaymentMethod;
            externalRef: string | null;
            receiptUrl: string | null;
            note: string | null;
            paidAt: Date;
            bookingId: string;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    stats(tenantId: string, userId: string, role: string): Promise<{
        total: Prisma.GetPaymentAggregateType<{
            where: any;
            _sum: {
                amount: true;
            };
            _count: {
                id: true;
            };
        }>;
        byMethod: (Prisma.PickEnumerable<Prisma.PaymentGroupByOutputType, "method"[]> & {
            _count: {
                id: number;
            };
            _sum: {
                amount: number;
            };
        })[];
        pendingBookings: {
            id: string;
            client: {
                fullName: string;
            };
            bookingRef: string;
            totalPrice: number;
            paidAmount: number;
        }[];
    }>;
    addManual(tenantId: string, userId: string, role: string, data: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.PaymentStatus;
        currency: import(".prisma/client").$Enums.Currency;
        createdAt: Date;
        tenantId: string;
        clientId: string;
        amount: number;
        uzsRate: number | null;
        method: import(".prisma/client").$Enums.PaymentMethod;
        externalRef: string | null;
        receiptUrl: string | null;
        note: string | null;
        paidAt: Date;
        bookingId: string;
    }>;
    refund(tenantId: string, id: string, userId: string, role: string, reason?: string): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.PaymentStatus;
        currency: import(".prisma/client").$Enums.Currency;
        createdAt: Date;
        tenantId: string;
        clientId: string;
        amount: number;
        uzsRate: number | null;
        method: import(".prisma/client").$Enums.PaymentMethod;
        externalRef: string | null;
        receiptUrl: string | null;
        note: string | null;
        paidAt: Date;
        bookingId: string;
    }>;
}
export declare class PaymentsController {
    private svc;
    constructor(svc: PaymentsService);
    list(u: any, method?: string, bookingId?: string, clientId?: string, page?: any, limit?: any): Promise<{
        data: ({
            client: {
                id: string;
                phone: string;
                fullName: string;
            };
            booking: {
                id: string;
                bookingRef: string;
                tourName: string;
            };
        } & {
            id: string;
            status: import(".prisma/client").$Enums.PaymentStatus;
            currency: import(".prisma/client").$Enums.Currency;
            createdAt: Date;
            tenantId: string;
            clientId: string;
            amount: number;
            uzsRate: number | null;
            method: import(".prisma/client").$Enums.PaymentMethod;
            externalRef: string | null;
            receiptUrl: string | null;
            note: string | null;
            paidAt: Date;
            bookingId: string;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    stats(u: any): Promise<{
        total: Prisma.GetPaymentAggregateType<{
            where: any;
            _sum: {
                amount: true;
            };
            _count: {
                id: true;
            };
        }>;
        byMethod: (Prisma.PickEnumerable<Prisma.PaymentGroupByOutputType, "method"[]> & {
            _count: {
                id: number;
            };
            _sum: {
                amount: number;
            };
        })[];
        pendingBookings: {
            id: string;
            client: {
                fullName: string;
            };
            bookingRef: string;
            totalPrice: number;
            paidAmount: number;
        }[];
    }>;
    manual(body: any, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.PaymentStatus;
        currency: import(".prisma/client").$Enums.Currency;
        createdAt: Date;
        tenantId: string;
        clientId: string;
        amount: number;
        uzsRate: number | null;
        method: import(".prisma/client").$Enums.PaymentMethod;
        externalRef: string | null;
        receiptUrl: string | null;
        note: string | null;
        paidAt: Date;
        bookingId: string;
    }>;
    refund(id: string, body: any, u: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.PaymentStatus;
        currency: import(".prisma/client").$Enums.Currency;
        createdAt: Date;
        tenantId: string;
        clientId: string;
        amount: number;
        uzsRate: number | null;
        method: import(".prisma/client").$Enums.PaymentMethod;
        externalRef: string | null;
        receiptUrl: string | null;
        note: string | null;
        paidAt: Date;
        bookingId: string;
    }>;
    export(u: any, method?: string, from?: string, to?: string): Promise<{
        csv: string;
        count: number;
    }>;
}
export declare class PaymentsModule {
}
