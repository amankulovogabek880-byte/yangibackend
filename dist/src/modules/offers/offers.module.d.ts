import { PrismaService } from '../../prisma/prisma.service';
export declare class OffersService {
    private prisma;
    constructor(prisma: PrismaService);
    list(tenantId: string, clientId: string): Promise<any>;
    create(tenantId: string, agentId: string, data: any): Promise<{
        id: string;
        agentId: string;
        tourName: any;
        destination: any;
        departDate: any;
        returnDate: any;
        pax: any;
        actualPrice: number;
        markup: number;
        clientPrice: number;
        currency: any;
        hotelName: any;
        hotelStars: any;
        includesVisa: any;
        includesFlight: boolean;
        includesHotel: boolean;
        notes: any;
        status: string;
        createdAt: string;
    }>;
    send(tenantId: string, clientId: string, offerId: string): Promise<{
        success: boolean;
    }>;
}
export declare class OffersController {
    private svc;
    constructor(svc: OffersService);
    list(u: any, id: string): Promise<any>;
    create(u: any, body: any): Promise<{
        id: string;
        agentId: string;
        tourName: any;
        destination: any;
        departDate: any;
        returnDate: any;
        pax: any;
        actualPrice: number;
        markup: number;
        clientPrice: number;
        currency: any;
        hotelName: any;
        hotelStars: any;
        includesVisa: any;
        includesFlight: boolean;
        includesHotel: boolean;
        notes: any;
        status: string;
        createdAt: string;
    }>;
    send(u: any, body: any, offerId: string): Promise<{
        success: boolean;
    }>;
}
export declare class OffersModule {
}
