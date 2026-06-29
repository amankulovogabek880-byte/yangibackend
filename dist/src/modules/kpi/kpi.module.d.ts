import { PrismaService } from '../../prisma/prisma.service';
export declare class KpiService {
    private prisma;
    constructor(prisma: PrismaService);
    getTiers(tenantId: string): Promise<any>;
    saveTiers(tenantId: string, tiers: any[]): Promise<any[]>;
    calculateCommission(revenue: number, tiers: any[]): {
        percent: number;
        amount: number;
    };
    list(tenantId: string, userId?: string, role?: string): Promise<({
        user: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        userId: string | null;
        metric: import(".prisma/client").$Enums.KpiMetric;
        period: import(".prisma/client").$Enums.KpiPeriod;
        target: number;
        bonus: number | null;
        startDate: Date;
        endDate: Date;
    })[]>;
    create(tenantId: string, actorRole: string, data: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        userId: string | null;
        metric: import(".prisma/client").$Enums.KpiMetric;
        period: import(".prisma/client").$Enums.KpiPeriod;
        target: number;
        bonus: number | null;
        startDate: Date;
        endDate: Date;
    }>;
    update(tenantId: string, actorRole: string, id: string, data: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        userId: string | null;
        metric: import(".prisma/client").$Enums.KpiMetric;
        period: import(".prisma/client").$Enums.KpiPeriod;
        target: number;
        bonus: number | null;
        startDate: Date;
        endDate: Date;
    }>;
    delete(tenantId: string, actorRole: string, id: string): Promise<{
        ok: boolean;
    }>;
    progress(tenantId: string, kpiId: string): Promise<{
        kpi: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            notes: string | null;
            userId: string | null;
            metric: import(".prisma/client").$Enums.KpiMetric;
            period: import(".prisma/client").$Enums.KpiPeriod;
            target: number;
            bonus: number | null;
            startDate: Date;
            endDate: Date;
        };
        actual: number;
        progressPct: number;
        isMet: boolean;
    }>;
}
export declare class KpiController {
    private svc;
    constructor(svc: KpiService);
    getTiers(u: any): Promise<any>;
    saveTiers(u: any, body: {
        tiers: any[];
    }): Promise<any[]>;
    list(u: any, userId?: string): Promise<({
        user: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        userId: string | null;
        metric: import(".prisma/client").$Enums.KpiMetric;
        period: import(".prisma/client").$Enums.KpiPeriod;
        target: number;
        bonus: number | null;
        startDate: Date;
        endDate: Date;
    })[]>;
    progress(id: string, u: any): Promise<{
        kpi: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            notes: string | null;
            userId: string | null;
            metric: import(".prisma/client").$Enums.KpiMetric;
            period: import(".prisma/client").$Enums.KpiPeriod;
            target: number;
            bonus: number | null;
            startDate: Date;
            endDate: Date;
        };
        actual: number;
        progressPct: number;
        isMet: boolean;
    }>;
    create(body: any, u: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        userId: string | null;
        metric: import(".prisma/client").$Enums.KpiMetric;
        period: import(".prisma/client").$Enums.KpiPeriod;
        target: number;
        bonus: number | null;
        startDate: Date;
        endDate: Date;
    }>;
    update(id: string, body: any, u: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        userId: string | null;
        metric: import(".prisma/client").$Enums.KpiMetric;
        period: import(".prisma/client").$Enums.KpiPeriod;
        target: number;
        bonus: number | null;
        startDate: Date;
        endDate: Date;
    }>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
}
export declare class KpiModule {
}
