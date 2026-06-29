import { PrismaService } from '../../prisma/prisma.service';
export declare class AuditService {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    log(data: {
        tenantId?: string;
        userId?: string;
        action: string;
        entity: string;
        entityId?: string;
        changes?: any;
        metadata?: any;
        ip?: string;
        userAgent?: string;
    }): Promise<void>;
    list(tenantId: string, params: {
        entity?: string;
        action?: string;
        userId?: string;
        from?: string;
        to?: string;
        page?: any;
        limit?: any;
    }): Promise<{
        data: ({
            user: {
                id: string;
                name: string;
                role: import(".prisma/client").$Enums.Role;
            };
        } & {
            id: string;
            createdAt: Date;
            tenantId: string | null;
            userId: string | null;
            metadata: import("@prisma/client/runtime/library").JsonValue;
            action: import(".prisma/client").$Enums.AuditAction;
            entity: string;
            entityId: string | null;
            changes: import("@prisma/client/runtime/library").JsonValue | null;
            ip: string | null;
            userAgent: string | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
}
export declare class AuditController {
    private svc;
    constructor(svc: AuditService);
    list(u: any, entity?: string, action?: string, userId?: string, from?: string, to?: string, page?: any, limit?: any): Promise<{
        data: ({
            user: {
                id: string;
                name: string;
                role: import(".prisma/client").$Enums.Role;
            };
        } & {
            id: string;
            createdAt: Date;
            tenantId: string | null;
            userId: string | null;
            metadata: import("@prisma/client/runtime/library").JsonValue;
            action: import(".prisma/client").$Enums.AuditAction;
            entity: string;
            entityId: string | null;
            changes: import("@prisma/client/runtime/library").JsonValue | null;
            ip: string | null;
            userAgent: string | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
}
export declare class AuditModule {
}
