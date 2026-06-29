import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.module';
export declare class ApprovalsService {
    private _prisma;
    private notifications;
    private audit;
    constructor(_prisma: PrismaService, notifications: NotificationsService, audit: AuditService);
    private get prisma();
    create(tenantId: string, requesterId: string, data: {
        type: string;
        entityType: string;
        entityId: string;
        title: string;
        reason?: string;
        oldValue?: any;
        newValue?: any;
        amount?: number;
    }): Promise<any>;
    list(tenantId: string, userId: string, role: string, params: {
        status?: string;
        type?: string;
        mine?: string;
    }): Promise<any>;
    findOne(tenantId: string, id: string, userId: string, role: string): Promise<any>;
    approve(tenantId: string, id: string, reviewerId: string, role: string, note?: string): Promise<any>;
    reject(tenantId: string, id: string, reviewerId: string, role: string, note?: string): Promise<any>;
    cancel(tenantId: string, id: string, userId: string): Promise<any>;
    private applyApproval;
    private typeLabel;
}
export declare class ApprovalsController {
    private svc;
    constructor(svc: ApprovalsService);
    list(u: any, status?: string, type?: string, mine?: string): Promise<any>;
    one(id: string, u: any): Promise<any>;
    create(body: any, u: any): Promise<any>;
    approve(id: string, body: {
        note?: string;
    }, u: any): Promise<any>;
    reject(id: string, body: {
        note?: string;
    }, u: any): Promise<any>;
    cancel(id: string, u: any): Promise<any>;
}
export declare class ApprovalsModule {
}
