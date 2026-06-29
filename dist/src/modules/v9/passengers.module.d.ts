import { PrismaService } from '../../prisma/prisma.service';
export declare class PassengersService {
    private _prisma;
    constructor(_prisma: PrismaService);
    private get prisma();
    private verifyBookingAccess;
    list(tenantId: string, bookingId: string, userId: string, role: string): Promise<any>;
    create(tenantId: string, bookingId: string, userId: string, role: string, data: any): Promise<any>;
    update(tenantId: string, passengerId: string, userId: string, role: string, data: any): Promise<any>;
    delete(tenantId: string, passengerId: string, userId: string, role: string): Promise<{
        ok: boolean;
    }>;
    stats(tenantId: string, bookingId: string, userId: string, role: string): Promise<{
        total: any;
        adults: any;
        children: any;
        infants: any;
        seniors: any;
        totalIndividualPrices: any;
    }>;
}
export declare class PassengersController {
    private svc;
    constructor(svc: PassengersService);
    list(bookingId: string, u: any): Promise<any>;
    stats(bookingId: string, u: any): Promise<{
        total: any;
        adults: any;
        children: any;
        infants: any;
        seniors: any;
        totalIndividualPrices: any;
    }>;
    create(bookingId: string, body: any, u: any): Promise<any>;
    update(id: string, body: any, u: any): Promise<any>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
}
export declare class PassengersModule {
}
