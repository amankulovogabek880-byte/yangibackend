import { PrismaService } from '../../prisma/prisma.service';
export declare class ServicesService {
    private _prisma;
    private readonly logger;
    constructor(_prisma: PrismaService);
    private get prisma();
    private verifyBookingAccess;
    private validateData;
    list(tenantId: string, bookingId: string, userId: string, role: string): Promise<any>;
    create(tenantId: string, bookingId: string, userId: string, role: string, data: any): Promise<any>;
    update(tenantId: string, id: string, userId: string, role: string, data: any): Promise<any>;
    delete(tenantId: string, id: string, userId: string, role: string): Promise<{
        ok: boolean;
        deletedId: string;
    }>;
    getTotalForBooking(tenantId: string, bookingId: string, userId: string, role: string): Promise<{
        totalAmount: any;
        count: any;
        byStatus: any;
    }>;
}
export declare class ServicesController {
    private svc;
    constructor(svc: ServicesService);
    list(bookingId: string, u: any): Promise<any>;
    total(bookingId: string, u: any): Promise<{
        totalAmount: any;
        count: any;
        byStatus: any;
    }>;
    create(bookingId: string, body: any, u: any): Promise<any>;
    update(id: string, body: any, u: any): Promise<any>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
        deletedId: string;
    }>;
}
export declare class ServicesModule {
}
