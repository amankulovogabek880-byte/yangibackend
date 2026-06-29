import { PrismaService } from '../../prisma/prisma.service';
export declare class HealthService {
    private prisma;
    constructor(prisma: PrismaService);
    check(): Promise<{
        status: string;
        timestamp: string;
        uptime: number;
        version: string;
        nodeVersion: string;
        environment: string;
        database: {
            status: string;
            responseMs: number;
        };
        memory: {
            heapUsedMB: number;
            heapTotalMB: number;
            rssMB: number;
        };
    }>;
    ready(): Promise<{
        ready: boolean;
    }>;
}
export declare class HealthController {
    private svc;
    constructor(svc: HealthService);
    health(): Promise<{
        status: string;
        timestamp: string;
        uptime: number;
        version: string;
        nodeVersion: string;
        environment: string;
        database: {
            status: string;
            responseMs: number;
        };
        memory: {
            heapUsedMB: number;
            heapTotalMB: number;
            rssMB: number;
        };
    }>;
    ready(): Promise<{
        ready: boolean;
    }>;
    live(): {
        alive: boolean;
        time: string;
    };
}
export declare class HealthModule {
}
