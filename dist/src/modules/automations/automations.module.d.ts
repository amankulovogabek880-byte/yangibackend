import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
export declare class AutomationsService {
    private prisma;
    private eventEmitter;
    private notifications;
    constructor(prisma: PrismaService, eventEmitter: EventEmitter2, notifications: NotificationsService);
    private executeAutomation;
    onLeadCreated(p: {
        tenantId: string;
        clientId: string;
        assignedAgentId?: string;
    }): Promise<void>;
    onStageChanged(p: {
        tenantId: string;
        clientId: string;
        stage: string;
        assignedAgentId?: string;
    }): Promise<void>;
    onBookingCreated(p: {
        tenantId: string;
        clientId: string;
        bookingId: string;
        assignedAgentId?: string;
    }): Promise<void>;
    onPaymentReceived(p: {
        tenantId: string;
        clientId: string;
        amount: number;
    }): Promise<void>;
    list(tenantId: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }[]>;
    findOne(tenantId: string, id: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }>;
    create(tenantId: string, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }>;
    update(tenantId: string, id: string, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }>;
    delete(tenantId: string, id: string): Promise<{
        ok: boolean;
    }>;
    toggle(tenantId: string, id: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }>;
}
export declare class AutomationsController {
    private svc;
    constructor(svc: AutomationsService);
    list(u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }[]>;
    one(id: string, u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }>;
    create(body: any, u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }>;
    update(id: string, body: any, u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    toggle(id: string, u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        isActive: boolean;
        trigger: import(".prisma/client").$Enums.AutomationTrigger;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        actions: import("@prisma/client/runtime/library").JsonValue;
        runCount: number;
        lastRunAt: Date | null;
    }>;
}
export declare class AutomationsModule {
}
