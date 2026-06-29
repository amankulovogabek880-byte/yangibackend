import { PrismaService } from '../../prisma/prisma.service';
export declare class LeadScoringService {
    private prisma;
    constructor(prisma: PrismaService);
    calculateScore(clientData: any): Promise<number>;
    scoreClient(tenantId: string, clientId: string): Promise<number>;
    recalculateAll(tenantId: string): Promise<{
        updated: number;
    }>;
}
export declare class LeadScoringController {
    private svc;
    constructor(svc: LeadScoringService);
    recalculate(u: any): Promise<{
        updated: number;
    }>;
}
export declare class LeadScoringModule {
}
