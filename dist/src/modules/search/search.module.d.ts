import { PrismaService } from '../../prisma/prisma.service';
export declare class SearchService {
    private prisma;
    constructor(prisma: PrismaService);
    global(tenantId: string, userId: string, role: string, q: string): Promise<{
        clients: {
            id: string;
            email: string;
            phone: string;
            fullName: string;
            tier: import(".prisma/client").$Enums.ClientTier;
            pipelineStage: import(".prisma/client").$Enums.PipelineStage;
        }[];
        bookings: {
            id: string;
            status: import(".prisma/client").$Enums.BookingStatus;
            client: {
                id: string;
                fullName: string;
            };
            bookingRef: string;
            tourName: string;
            destination: string;
            totalPrice: number;
        }[];
        conversations: {
            id: string;
            channel: import(".prisma/client").$Enums.Channel;
            firstName: string;
            lastName: string;
            username: string;
            lastMessageText: string;
        }[];
        tasks: {
            id: string;
            status: import(".prisma/client").$Enums.TaskStatus;
            title: string;
            dueAt: Date;
            priority: import(".prisma/client").$Enums.TaskPriority;
        }[];
        invoices: {
            id: string;
            status: import(".prisma/client").$Enums.InvoiceStatus;
            currency: import(".prisma/client").$Enums.Currency;
            client: {
                id: string;
                fullName: string;
            };
            invoiceNumber: string;
            salePrice: number;
        }[];
        documents: {
            id: string;
            name: string;
            client: {
                id: string;
                fullName: string;
            };
            category: import(".prisma/client").$Enums.DocumentCategory;
            fileUrl: string;
            fileName: string;
        }[];
    }>;
}
export declare class SearchController {
    private svc;
    constructor(svc: SearchService);
    global(u: any, q: string): Promise<{
        clients: {
            id: string;
            email: string;
            phone: string;
            fullName: string;
            tier: import(".prisma/client").$Enums.ClientTier;
            pipelineStage: import(".prisma/client").$Enums.PipelineStage;
        }[];
        bookings: {
            id: string;
            status: import(".prisma/client").$Enums.BookingStatus;
            client: {
                id: string;
                fullName: string;
            };
            bookingRef: string;
            tourName: string;
            destination: string;
            totalPrice: number;
        }[];
        conversations: {
            id: string;
            channel: import(".prisma/client").$Enums.Channel;
            firstName: string;
            lastName: string;
            username: string;
            lastMessageText: string;
        }[];
        tasks: {
            id: string;
            status: import(".prisma/client").$Enums.TaskStatus;
            title: string;
            dueAt: Date;
            priority: import(".prisma/client").$Enums.TaskPriority;
        }[];
        invoices: {
            id: string;
            status: import(".prisma/client").$Enums.InvoiceStatus;
            currency: import(".prisma/client").$Enums.Currency;
            client: {
                id: string;
                fullName: string;
            };
            invoiceNumber: string;
            salePrice: number;
        }[];
        documents: {
            id: string;
            name: string;
            client: {
                id: string;
                fullName: string;
            };
            category: import(".prisma/client").$Enums.DocumentCategory;
            fileUrl: string;
            fileName: string;
        }[];
    }>;
}
export declare class SearchModule {
}
