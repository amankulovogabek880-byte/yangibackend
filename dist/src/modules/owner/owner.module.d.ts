import { PrismaService } from '../../prisma/prisma.service';
import { BackupService } from '../backup/backup.service';
export declare class OwnerService {
    private prisma;
    constructor(prisma: PrismaService);
    getStats(): Promise<{
        tenants: number;
        activeTenants: number;
        users: number;
        bookings: number;
        totalRevenue: number;
    }>;
    getLeaderboard(): Promise<{
        id: any;
        name: any;
        avatarUrl: any;
        tenantName: any;
        revenue: number;
        profit: number;
        bookings: any;
    }[]>;
    getCompanies(): Promise<({
        _count: {
            users: number;
            clients: number;
            bookings: number;
        };
    } & {
        id: string;
        name: string;
        slug: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
        logoUrl: string | null;
        brandColor: string | null;
        timezone: string;
        locale: import(".prisma/client").$Enums.Language;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
        leadAssignmentStrategy: import(".prisma/client").$Enums.LeadAssignmentStrategy;
        sourceRouting: import("@prisma/client/runtime/library").JsonValue | null;
        agentCommissionPercent: number;
        managerCommissionPercent: number;
        kpiTiers: import("@prisma/client/runtime/library").JsonValue;
        maxUsers: number;
        maxClients: number;
        maxBookings: number;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
    })[]>;
    getCompany(id: string): Promise<{
        users: {
            id: string;
            name: string;
            status: import(".prisma/client").$Enums.UserStatus;
            email: string;
            role: import(".prisma/client").$Enums.Role;
        }[];
        _count: {
            users: number;
            clients: number;
            bookings: number;
            payments: number;
        };
    } & {
        id: string;
        name: string;
        slug: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
        logoUrl: string | null;
        brandColor: string | null;
        timezone: string;
        locale: import(".prisma/client").$Enums.Language;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
        leadAssignmentStrategy: import(".prisma/client").$Enums.LeadAssignmentStrategy;
        sourceRouting: import("@prisma/client/runtime/library").JsonValue | null;
        agentCommissionPercent: number;
        managerCommissionPercent: number;
        kpiTiers: import("@prisma/client/runtime/library").JsonValue;
        maxUsers: number;
        maxClients: number;
        maxBookings: number;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
    }>;
    createCompany(data: {
        name: string;
        slug: string;
        adminName: string;
        adminEmail: string;
        adminPassword: string;
        plan?: string;
    }): Promise<{
        adminEmail: string;
        message: string;
        id: string;
        name: string;
        slug: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
        logoUrl: string | null;
        brandColor: string | null;
        timezone: string;
        locale: import(".prisma/client").$Enums.Language;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
        leadAssignmentStrategy: import(".prisma/client").$Enums.LeadAssignmentStrategy;
        sourceRouting: import("@prisma/client/runtime/library").JsonValue | null;
        agentCommissionPercent: number;
        managerCommissionPercent: number;
        kpiTiers: import("@prisma/client/runtime/library").JsonValue;
        maxUsers: number;
        maxClients: number;
        maxBookings: number;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
    }>;
    setStatus(id: string, status: string): Promise<{
        id: string;
        name: string;
        status: import(".prisma/client").$Enums.TenantStatus;
    }>;
    updateCompany(id: string, data: {
        name?: string;
        plan?: string;
        timezone?: string;
        currency?: string;
        country?: string;
        city?: string;
        phone?: string;
        email?: string;
        website?: string;
    }): Promise<{
        id: string;
        name: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
    }>;
    deleteCompany(id: string): Promise<{
        ok: boolean;
        deletedTenant: string;
        affected: {
            users: number;
            clients: number;
            bookings: number;
        };
        message: string;
    }>;
    getRecentLogins(limit?: number): Promise<{
        id: string;
        email: string;
        ip: string;
        country: string;
        success: boolean;
        reason: string;
        userAgent: string;
        createdAt: Date;
        user: {
            id: string;
            name: string;
            role: import(".prisma/client").$Enums.Role;
            tenant: {
                id: string;
                name: string;
                slug: string;
            };
        };
    }[]>;
}
export declare class OwnerController {
    private svc;
    private backup;
    constructor(svc: OwnerService, backup: BackupService);
    stats(): Promise<{
        tenants: number;
        activeTenants: number;
        users: number;
        bookings: number;
        totalRevenue: number;
    }>;
    leaderboard(): Promise<{
        id: any;
        name: any;
        avatarUrl: any;
        tenantName: any;
        revenue: number;
        profit: number;
        bookings: any;
    }[]>;
    companies(): Promise<({
        _count: {
            users: number;
            clients: number;
            bookings: number;
        };
    } & {
        id: string;
        name: string;
        slug: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
        logoUrl: string | null;
        brandColor: string | null;
        timezone: string;
        locale: import(".prisma/client").$Enums.Language;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
        leadAssignmentStrategy: import(".prisma/client").$Enums.LeadAssignmentStrategy;
        sourceRouting: import("@prisma/client/runtime/library").JsonValue | null;
        agentCommissionPercent: number;
        managerCommissionPercent: number;
        kpiTiers: import("@prisma/client/runtime/library").JsonValue;
        maxUsers: number;
        maxClients: number;
        maxBookings: number;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
    })[]>;
    company(id: string): Promise<{
        users: {
            id: string;
            name: string;
            status: import(".prisma/client").$Enums.UserStatus;
            email: string;
            role: import(".prisma/client").$Enums.Role;
        }[];
        _count: {
            users: number;
            clients: number;
            bookings: number;
            payments: number;
        };
    } & {
        id: string;
        name: string;
        slug: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
        logoUrl: string | null;
        brandColor: string | null;
        timezone: string;
        locale: import(".prisma/client").$Enums.Language;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
        leadAssignmentStrategy: import(".prisma/client").$Enums.LeadAssignmentStrategy;
        sourceRouting: import("@prisma/client/runtime/library").JsonValue | null;
        agentCommissionPercent: number;
        managerCommissionPercent: number;
        kpiTiers: import("@prisma/client/runtime/library").JsonValue;
        maxUsers: number;
        maxClients: number;
        maxBookings: number;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
    }>;
    create(body: any): Promise<{
        adminEmail: string;
        message: string;
        id: string;
        name: string;
        slug: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
        logoUrl: string | null;
        brandColor: string | null;
        timezone: string;
        locale: import(".prisma/client").$Enums.Language;
        currency: import(".prisma/client").$Enums.Currency;
        settings: import("@prisma/client/runtime/library").JsonValue;
        phoneProvider: import(".prisma/client").$Enums.PhoneProvider;
        phoneConfig: import("@prisma/client/runtime/library").JsonValue;
        leadAssignmentStrategy: import(".prisma/client").$Enums.LeadAssignmentStrategy;
        sourceRouting: import("@prisma/client/runtime/library").JsonValue | null;
        agentCommissionPercent: number;
        managerCommissionPercent: number;
        kpiTiers: import("@prisma/client/runtime/library").JsonValue;
        maxUsers: number;
        maxClients: number;
        maxBookings: number;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
    }>;
    status(id: string, body: any): Promise<{
        id: string;
        name: string;
        status: import(".prisma/client").$Enums.TenantStatus;
    }>;
    updateCompany(id: string, body: any): Promise<{
        id: string;
        name: string;
        status: import(".prisma/client").$Enums.TenantStatus;
        plan: import(".prisma/client").$Enums.SubscriptionPlan;
    }>;
    deleteCompany(id: string): Promise<{
        ok: boolean;
        deletedTenant: string;
        affected: {
            users: number;
            clients: number;
            bookings: number;
        };
        message: string;
    }>;
    triggerBackup(): Promise<{
        ok: boolean;
        file?: string;
        size?: number;
        error?: string;
    }>;
    recentLogins(limit?: string): Promise<{
        id: string;
        email: string;
        ip: string;
        country: string;
        success: boolean;
        reason: string;
        userAgent: string;
        createdAt: Date;
        user: {
            id: string;
            name: string;
            role: import(".prisma/client").$Enums.Role;
            tenant: {
                id: string;
                name: string;
                slug: string;
            };
        };
    }[]>;
}
export declare class OwnerModule {
}
