import { PrismaService } from '../../prisma/prisma.service';
import { RoundRobinService } from './round-robin.module';
export declare class LeadFormsService {
    private prisma;
    private roundRobin;
    constructor(prisma: PrismaService, roundRobin: RoundRobinService);
    list(tenantId: string): Promise<{
        id: string;
        name: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        description: string | null;
        isActive: boolean;
        fields: import("@prisma/client/runtime/library").JsonValue;
        theme: import("@prisma/client/runtime/library").JsonValue;
        successMsg: string;
        redirectUrl: string | null;
        submitCount: number;
        lastSubmitAt: Date | null;
    }[]>;
    getBySlug(tenantId: string, slug: string): Promise<{
        id: string;
        name: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        description: string | null;
        isActive: boolean;
        fields: import("@prisma/client/runtime/library").JsonValue;
        theme: import("@prisma/client/runtime/library").JsonValue;
        successMsg: string;
        redirectUrl: string | null;
        submitCount: number;
        lastSubmitAt: Date | null;
    }>;
    create(tenantId: string, data: any): Promise<{
        id: string;
        name: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        description: string | null;
        isActive: boolean;
        fields: import("@prisma/client/runtime/library").JsonValue;
        theme: import("@prisma/client/runtime/library").JsonValue;
        successMsg: string;
        redirectUrl: string | null;
        submitCount: number;
        lastSubmitAt: Date | null;
    }>;
    update(tenantId: string, formId: string, data: any): Promise<{
        id: string;
        name: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        description: string | null;
        isActive: boolean;
        fields: import("@prisma/client/runtime/library").JsonValue;
        theme: import("@prisma/client/runtime/library").JsonValue;
        successMsg: string;
        redirectUrl: string | null;
        submitCount: number;
        lastSubmitAt: Date | null;
    }>;
    delete(tenantId: string, formId: string): Promise<{
        success: boolean;
    }>;
    submit(tenantId: string, slug: string, data: any): Promise<{
        success: boolean;
        message: string;
        clientId: string;
        assignedAgentId: string;
    }>;
    getStats(tenantId: string, formId: string): Promise<{
        submitCount: number;
        lastSubmitAt: Date;
    }>;
}
export declare class LeadFormsController {
    private svc;
    constructor(svc: LeadFormsService);
    list(u: any): Promise<{
        id: string;
        name: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        description: string | null;
        isActive: boolean;
        fields: import("@prisma/client/runtime/library").JsonValue;
        theme: import("@prisma/client/runtime/library").JsonValue;
        successMsg: string;
        redirectUrl: string | null;
        submitCount: number;
        lastSubmitAt: Date | null;
    }[]>;
    stats(u: any, id: string): Promise<{
        submitCount: number;
        lastSubmitAt: Date;
    }>;
    create(u: any, body: any): Promise<{
        id: string;
        name: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        description: string | null;
        isActive: boolean;
        fields: import("@prisma/client/runtime/library").JsonValue;
        theme: import("@prisma/client/runtime/library").JsonValue;
        successMsg: string;
        redirectUrl: string | null;
        submitCount: number;
        lastSubmitAt: Date | null;
    }>;
    update(u: any, id: string, body: any): Promise<{
        id: string;
        name: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        description: string | null;
        isActive: boolean;
        fields: import("@prisma/client/runtime/library").JsonValue;
        theme: import("@prisma/client/runtime/library").JsonValue;
        successMsg: string;
        redirectUrl: string | null;
        submitCount: number;
        lastSubmitAt: Date | null;
    }>;
    delete(u: any, id: string): Promise<{
        success: boolean;
    }>;
}
export declare class PublicFormController {
    private svc;
    constructor(svc: LeadFormsService);
    getForm(tenantId: string, slug: string): Promise<{
        id: string;
        name: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        description: string | null;
        isActive: boolean;
        fields: import("@prisma/client/runtime/library").JsonValue;
        theme: import("@prisma/client/runtime/library").JsonValue;
        successMsg: string;
        redirectUrl: string | null;
        submitCount: number;
        lastSubmitAt: Date | null;
    }>;
    submitForm(tenantId: string, slug: string, body: any): Promise<{
        success: boolean;
        message: string;
        clientId: string;
        assignedAgentId: string;
    }>;
}
export declare class LeadFormsModule {
}
