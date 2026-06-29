import { PrismaService } from '../../prisma/prisma.service';
export declare class CommandPaletteService {
    private prisma;
    constructor(prisma: PrismaService);
    search(tenantId: string, userId: string, role: string, query: string): Promise<{
        results: any[];
        actions: ({
            type: string;
            id: string;
            title: string;
            subtitle: string;
            url: string;
            icon: string;
            shortcut: string;
            keywords: string[];
        } | {
            type: string;
            id: string;
            title: string;
            subtitle: string;
            url: string;
            icon: string;
            keywords: string[];
            shortcut?: undefined;
        })[];
        query?: undefined;
    } | {
        query: string;
        results: {
            type: string;
            id: string;
            title: string;
            subtitle: string;
            icon: string;
            url: string;
        }[];
        actions: ({
            type: string;
            id: string;
            title: string;
            subtitle: string;
            url: string;
            icon: string;
            shortcut: string;
            keywords: string[];
        } | {
            type: string;
            id: string;
            title: string;
            subtitle: string;
            url: string;
            icon: string;
            keywords: string[];
            shortcut?: undefined;
        })[];
    }>;
    private getActions;
}
export declare class CommandPaletteController {
    private svc;
    constructor(svc: CommandPaletteService);
    search(q: string, u: any): Promise<{
        results: any[];
        actions: ({
            type: string;
            id: string;
            title: string;
            subtitle: string;
            url: string;
            icon: string;
            shortcut: string;
            keywords: string[];
        } | {
            type: string;
            id: string;
            title: string;
            subtitle: string;
            url: string;
            icon: string;
            keywords: string[];
            shortcut?: undefined;
        })[];
        query?: undefined;
    } | {
        query: string;
        results: {
            type: string;
            id: string;
            title: string;
            subtitle: string;
            icon: string;
            url: string;
        }[];
        actions: ({
            type: string;
            id: string;
            title: string;
            subtitle: string;
            url: string;
            icon: string;
            shortcut: string;
            keywords: string[];
        } | {
            type: string;
            id: string;
            title: string;
            subtitle: string;
            url: string;
            icon: string;
            keywords: string[];
            shortcut?: undefined;
        })[];
    }>;
}
export declare class CommandPaletteModule {
}
