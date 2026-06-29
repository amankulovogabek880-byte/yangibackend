import { PrismaService } from '../../prisma/prisma.service';
export declare class DocumentsService {
    private prisma;
    constructor(prisma: PrismaService);
    list(tenantId: string, userId: string, role: string, params: any): Promise<{
        data: ({
            client: {
                id: string;
                fullName: string;
            };
            booking: {
                id: string;
                bookingRef: string;
            };
            uploadedBy: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            name: string;
            createdAt: Date;
            updatedAt: Date;
            expiresAt: Date | null;
            tenantId: string;
            description: string | null;
            clientId: string | null;
            category: import(".prisma/client").$Enums.DocumentCategory;
            bookingId: string | null;
            fileUrl: string;
            fileMimeType: string;
            fileSize: number;
            uploadedById: string;
            fileName: string;
            documentNo: string | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    create(tenantId: string, userId: string, file: Express.Multer.File, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
        tenantId: string;
        description: string | null;
        clientId: string | null;
        category: import(".prisma/client").$Enums.DocumentCategory;
        bookingId: string | null;
        fileUrl: string;
        fileMimeType: string;
        fileSize: number;
        uploadedById: string;
        fileName: string;
        documentNo: string | null;
    }>;
    delete(tenantId: string, userId: string, role: string, id: string): Promise<{
        ok: boolean;
    }>;
}
export declare class DocumentsController {
    private svc;
    constructor(svc: DocumentsService);
    list(u: any, clientId?: string, bookingId?: string, category?: string, page?: any, limit?: any): Promise<{
        data: ({
            client: {
                id: string;
                fullName: string;
            };
            booking: {
                id: string;
                bookingRef: string;
            };
            uploadedBy: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            name: string;
            createdAt: Date;
            updatedAt: Date;
            expiresAt: Date | null;
            tenantId: string;
            description: string | null;
            clientId: string | null;
            category: import(".prisma/client").$Enums.DocumentCategory;
            bookingId: string | null;
            fileUrl: string;
            fileMimeType: string;
            fileSize: number;
            uploadedById: string;
            fileName: string;
            documentNo: string | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    upload(file: Express.Multer.File, body: any, u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
        tenantId: string;
        description: string | null;
        clientId: string | null;
        category: import(".prisma/client").$Enums.DocumentCategory;
        bookingId: string | null;
        fileUrl: string;
        fileMimeType: string;
        fileSize: number;
        uploadedById: string;
        fileName: string;
        documentNo: string | null;
    }>;
    delete(id: string, u: any): Promise<{
        ok: boolean;
    }>;
}
export declare class DocumentsModule {
}
