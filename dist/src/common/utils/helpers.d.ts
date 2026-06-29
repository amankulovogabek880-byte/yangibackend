export declare function safeEnum<T extends string>(val: any, list: readonly T[], def: T): T;
export declare function toInt(val: any, def: number): number;
export declare function toFloat(val: any, def?: number): number;
export declare function paginate(page: any, limit: any, maxLimit?: number): {
    skip: number;
    take: number;
    page: number;
    limit: number;
};
export declare function meta(total: number, page: number, limit: number): {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
};
export declare function calculateLeadScore(client: {
    source?: string;
    totalBookings?: number;
    totalRevenue?: number;
    pipelineStage?: string;
    tier?: string;
    email?: string | null;
    passportNo?: string | null;
    daysSinceContact?: number;
}): number;
export declare function generateRef(prefix: string, count: number): string;
export declare function clean<T extends Record<string, any>>(obj: T): Partial<T>;
export declare function pickNextAgent(prisma: any, tenantId: string): Promise<string | null>;
