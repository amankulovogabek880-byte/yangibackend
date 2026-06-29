import { PrismaService } from '../../prisma/prisma.service';
export declare class TenantsService {
    private prisma;
    constructor(prisma: PrismaService);
    getSettings(tenantId: string): Promise<{
        id: string;
        name: string;
        slug: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
        logoUrl: string;
        brandColor: string;
        timezone: string;
        locale: import(".prisma/client").$Enums.Language;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
        maxUsers: number;
        maxClients: number;
        maxBookings: number;
        createdAt: Date;
        expiresAt: Date;
    }>;
    updateSettings(tenantId: string, data: any): Promise<{
        id: string;
        name: string;
        brandColor: string;
        timezone: string;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
    }>;
    updatePhoneProvider(tenantId: string, data: {
        provider: string;
        config: any;
    }): Promise<{
        id: string;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
    }>;
    getPhoneProvider(tenantId: string): Promise<{
        provider: import(".prisma/client").$Enums.PhoneProvider;
        config: any;
    }>;
    getSourceRouting(tenantId: string): Promise<string | number | true | import("@prisma/client/runtime/library").JsonObject | import("@prisma/client/runtime/library").JsonArray>;
    updateSourceRouting(tenantId: string, sourceRouting: any): Promise<{
        id: string;
        sourceRouting: import("@prisma/client/runtime/library").JsonValue;
    }>;
    stats(tenantId: string): Promise<{
        usage: {
            users: number;
            clients: number;
            bookings: number;
        };
        limits: {
            plan: import(".prisma/client").$Enums.SubscriptionPlan;
            maxUsers: number;
            maxClients: number;
            maxBookings: number;
        };
    }>;
}
export declare class TenantsController {
    private svc;
    constructor(svc: TenantsService);
    get(u: any): Promise<{
        id: string;
        name: string;
        slug: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
        logoUrl: string;
        brandColor: string;
        timezone: string;
        locale: import(".prisma/client").$Enums.Language;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
        maxUsers: number;
        maxClients: number;
        maxBookings: number;
        createdAt: Date;
        expiresAt: Date;
    }>;
    update(body: any, u: any): Promise<{
        id: string;
        name: string;
        brandColor: string;
        timezone: string;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
    }>;
    stats(u: any): Promise<{
        usage: {
            users: number;
            clients: number;
            bookings: number;
        };
        limits: {
            plan: import(".prisma/client").$Enums.SubscriptionPlan;
            maxUsers: number;
            maxClients: number;
            maxBookings: number;
        };
    }>;
    getPhone(u: any): Promise<{
        provider: import(".prisma/client").$Enums.PhoneProvider;
        config: any;
    }>;
    updatePhone(body: {
        provider: string;
        config: any;
    }, u: any): Promise<{
        id: string;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
    }>;
    getSourceRouting(u: any): Promise<string | number | true | import("@prisma/client/runtime/library").JsonObject | import("@prisma/client/runtime/library").JsonArray>;
    updateSourceRouting(body: any, u: any): Promise<{
        id: string;
        sourceRouting: import("@prisma/client/runtime/library").JsonValue;
    }>;
}
export declare class TenantsModule {
}
