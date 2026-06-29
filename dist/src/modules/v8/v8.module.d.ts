import { PrismaService } from '../../prisma/prisma.service';
export declare class V8Service {
    private prisma;
    constructor(prisma: PrismaService);
    checkDuplicate(tenantId: string, params: {
        phone?: string;
        email?: string;
        telegramUsername?: string;
    }): Promise<{
        found: boolean;
        matches: any[];
        count?: undefined;
    } | {
        found: boolean;
        count: number;
        matches: {
            id: string;
            createdAt: Date;
            email: string;
            phone: string;
            totalBookings: number;
            totalRevenue: number;
            fullName: string;
            tier: import(".prisma/client").$Enums.ClientTier;
            pipelineStage: import(".prisma/client").$Enums.PipelineStage;
            telegramUsername: string;
            assignedAgent: {
                id: string;
                name: string;
            };
        }[];
    }>;
    pickAgentForNewLead(tenantId: string): Promise<string | null>;
    reassignClient(tenantId: string, clientId: string, newAgentId: string | null): Promise<{
        id: string;
        fullName: string;
        assignedAgent: {
            id: string;
            name: string;
        };
    }>;
    bulkAssign(tenantId: string, ids: string[], agentId: string | null): Promise<{
        updated: number;
    }>;
    bulkChangeStage(tenantId: string, ids: string[], stage: string): Promise<{
        updated: number;
    }>;
    bulkAddTag(tenantId: string, ids: string[], tag: string): Promise<{
        updated: number;
    }>;
    bulkDelete(tenantId: string, ids: string[], userId: string): Promise<{
        deleted: number;
    }>;
    listSavedFilters(tenantId: string, userId: string, resource?: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        userId: string;
        isPinned: boolean;
        resource: string;
        filters: import("@prisma/client/runtime/library").JsonValue;
        sortOrder: number;
    }[]>;
    createSavedFilter(tenantId: string, userId: string, data: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        userId: string;
        isPinned: boolean;
        resource: string;
        filters: import("@prisma/client/runtime/library").JsonValue;
        sortOrder: number;
    }>;
    deleteSavedFilter(tenantId: string, userId: string, id: string): Promise<{
        ok: boolean;
    }>;
    static DEFAULT_CHECKLIST: string[];
    getChecklist(tenantId: string, bookingId: string): Promise<{
        items: ({
            doneBy: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            notes: string | null;
            bookingId: string;
            doneAt: Date | null;
            sortOrder: number;
            item: string;
            isDone: boolean;
            doneById: string | null;
        })[];
        total: number;
        done: number;
        progress: number;
    }>;
    toggleChecklistItem(tenantId: string, itemId: string, userId: string, isDone: boolean): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        bookingId: string;
        doneAt: Date | null;
        sortOrder: number;
        item: string;
        isDone: boolean;
        doneById: string | null;
    }>;
    addChecklistItem(tenantId: string, bookingId: string, item: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        bookingId: string;
        doneAt: Date | null;
        sortOrder: number;
        item: string;
        isDone: boolean;
        doneById: string | null;
    }>;
    deleteChecklistItem(tenantId: string, itemId: string): Promise<{
        ok: boolean;
    }>;
    createCommissionFromBooking(tenantId: string, bookingId: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        agentId: string;
        paidAt: Date | null;
        bookingId: string;
        managerId: string | null;
        totalProfit: number;
        agentPercent: number;
        managerPercent: number;
        agentAmount: number;
        managerAmount: number;
        companyAmount: number;
        isPaid: boolean;
    }>;
    listCommissions(tenantId: string, userId: string, role: string): Promise<({
        booking: {
            id: string;
            client: {
                fullName: string;
            };
            bookingRef: string;
            tourName: string;
        };
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        agentId: string;
        paidAt: Date | null;
        bookingId: string;
        managerId: string | null;
        totalProfit: number;
        agentPercent: number;
        managerPercent: number;
        agentAmount: number;
        managerAmount: number;
        companyAmount: number;
        isPaid: boolean;
    })[]>;
    markCommissionPaid(tenantId: string, id: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        agentId: string;
        paidAt: Date | null;
        bookingId: string;
        managerId: string | null;
        totalProfit: number;
        agentPercent: number;
        managerPercent: number;
        agentAmount: number;
        managerAmount: number;
        companyAmount: number;
        isPaid: boolean;
    }>;
    getClient360(tenantId: string, clientId: string, userId: string, role: string): Promise<{
        client: {
            bookings: ({
                payments: {
                    id: string;
                    currency: import(".prisma/client").$Enums.Currency;
                    amount: number;
                    method: import(".prisma/client").$Enums.PaymentMethod;
                    paidAt: Date;
                }[];
                agent: {
                    id: string;
                    name: string;
                };
            } & {
                id: string;
                status: import(".prisma/client").$Enums.BookingStatus;
                currency: import(".prisma/client").$Enums.Currency;
                createdAt: Date;
                updatedAt: Date;
                tenantId: string;
                country: string | null;
                notes: string | null;
                internalNotes: string | null;
                description: string | null;
                clientId: string;
                bookingRef: string;
                tourName: string;
                destination: string;
                tourType: import(".prisma/client").$Enums.TourType;
                departureDate: Date | null;
                returnDate: Date | null;
                duration: number | null;
                adults: number;
                children: number;
                infants: number;
                totalPrice: number;
                paidAmount: number;
                discount: number;
                commissionPercent: number;
                profit: number;
                commissionAmount: number;
                statusHistory: import("@prisma/client/runtime/library").JsonValue;
                includesVisa: boolean;
                includesFlights: boolean;
                includesHotel: boolean;
                includesMeals: boolean;
                includesTransfer: boolean;
                includesInsurance: boolean;
                hotelName: string | null;
                hotelCity: string | null;
                hotelStars: number | null;
                hotelCheckIn: Date | null;
                hotelCheckOut: Date | null;
                mealPlan: string | null;
                roomType: string | null;
                hotelAddress: string | null;
                airline: string | null;
                flightNumber: string | null;
                departureAirport: string | null;
                arrivalAirport: string | null;
                departureTime: Date | null;
                arrivalTime: Date | null;
                flightClass: string | null;
                pnr: string | null;
                returnAirline: string | null;
                returnFlightNumber: string | null;
                returnDepartureTime: Date | null;
                returnArrivalTime: Date | null;
                returnPnr: string | null;
                taxiPickupAddress: string | null;
                taxiDropoffAddress: string | null;
                taxiPickupTime: Date | null;
                taxiDriverName: string | null;
                taxiDriverPhone: string | null;
                taxiCompany: string | null;
                insuranceCompany: string | null;
                insurancePolicyNo: string | null;
                insuranceStartDate: Date | null;
                insuranceEndDate: Date | null;
                insuranceCoverage: string | null;
                visaStatus: string | null;
                visaType: string | null;
                visaNumber: string | null;
                visaIssueDate: Date | null;
                visaExpiryDate: Date | null;
                supplierName: string | null;
                supplierContact: string | null;
                supplierCost: number | null;
                supplierRef: string | null;
                supplierPaid: number;
                supplierNotes: string | null;
                cancelReason: string | null;
                agentId: string | null;
            })[];
            assignedAgent: {
                id: string;
                name: string;
                email: string;
                phone: string;
            };
            timeline: {
                id: string;
                createdAt: Date;
                userId: string | null;
                type: string;
                title: string;
                description: string | null;
                metadata: import("@prisma/client/runtime/library").JsonValue;
                clientId: string;
            }[];
        } & {
            id: string;
            status: import(".prisma/client").$Enums.ClientStatus;
            createdAt: Date;
            updatedAt: Date;
            tags: string[];
            tenantId: string;
            email: string | null;
            phone: string | null;
            telegramId: string | null;
            language: import(".prisma/client").$Enums.Language;
            totalBookings: number;
            totalRevenue: number;
            lostReason: import(".prisma/client").$Enums.LostReason | null;
            leadScore: number;
            assignedAgentId: string | null;
            fullName: string;
            phone2: string | null;
            passportNo: string | null;
            passportExpiry: Date | null;
            passportCountry: string | null;
            dateOfBirth: Date | null;
            nationality: string | null;
            country: string | null;
            gender: string | null;
            address: string | null;
            city: string | null;
            tier: import(".prisma/client").$Enums.ClientTier;
            source: import(".prisma/client").$Enums.LeadSource;
            utmSource: string | null;
            utmMedium: string | null;
            utmCampaign: string | null;
            utmTerm: string | null;
            utmContent: string | null;
            sourceCampaign: string | null;
            referrerUrl: string | null;
            pipelineStage: import(".prisma/client").$Enums.PipelineStage;
            pipelineStageAt: Date;
            notes: string | null;
            internalNotes: string | null;
            telegramUsername: string | null;
            instagramHandle: string | null;
            whatsappPhone: string | null;
            familyMembers: import("@prisma/client/runtime/library").JsonValue;
            preferences: import("@prisma/client/runtime/library").JsonValue;
            totalSpent: number;
            avgBookingValue: number;
            lifetimeValue: number;
            firstContactAt: Date | null;
            lastContactAt: Date | null;
            lastBookingAt: Date | null;
        };
        financial: {
            totalSpent: number;
            totalProfit: number;
            totalPaid: number;
            balance: number;
            bookingsCount: number;
        };
        activeConversation: {
            id: string;
            channel: import(".prisma/client").$Enums.Channel;
            unreadCount: number;
            lastMessageAt: Date;
        };
        tasks: ({
            assignee: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            status: import(".prisma/client").$Enums.TaskStatus;
            createdAt: Date;
            updatedAt: Date;
            tags: string[];
            tenantId: string;
            title: string;
            description: string | null;
            clientId: string | null;
            bookingId: string | null;
            dueAt: Date | null;
            creatorId: string;
            assigneeId: string;
            priority: import(".prisma/client").$Enums.TaskPriority;
            completedAt: Date | null;
            recurrence: string | null;
            parentId: string | null;
        })[];
        invoices: {
            id: string;
            status: import(".prisma/client").$Enums.InvoiceStatus;
            currency: import(".prisma/client").$Enums.Currency;
            createdAt: Date;
            paidAmount: number;
            profit: number;
            invoiceNumber: string;
            providerCost: number;
            salePrice: number;
            dueDate: Date;
        }[];
        documents: {
            id: string;
            createdAt: Date;
            fileUrl: string;
            fileMimeType: string;
            fileSize: number;
            fileName: string;
            uploadedBy: {
                name: string;
            };
        }[];
        followUps: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            title: string;
            clientId: string | null;
            agentId: string;
            note: string | null;
            dueAt: Date;
            done: boolean;
            doneAt: Date | null;
            notifiedAt: Date | null;
        }[];
    }>;
}
export declare class V8Controller {
    private svc;
    constructor(svc: V8Service);
    checkDuplicate(u: any, phone?: string, email?: string, telegramUsername?: string): Promise<{
        found: boolean;
        matches: any[];
        count?: undefined;
    } | {
        found: boolean;
        count: number;
        matches: {
            id: string;
            createdAt: Date;
            email: string;
            phone: string;
            totalBookings: number;
            totalRevenue: number;
            fullName: string;
            tier: import(".prisma/client").$Enums.ClientTier;
            pipelineStage: import(".prisma/client").$Enums.PipelineStage;
            telegramUsername: string;
            assignedAgent: {
                id: string;
                name: string;
            };
        }[];
    }>;
    reassign(id: string, body: {
        agentId: string | null;
    }, u: any): Promise<{
        id: string;
        fullName: string;
        assignedAgent: {
            id: string;
            name: string;
        };
    }>;
    bulkAssign(body: {
        ids: string[];
        agentId: string | null;
    }, u: any): Promise<{
        updated: number;
    }>;
    bulkStage(body: {
        ids: string[];
        stage: string;
    }, u: any): Promise<{
        updated: number;
    }>;
    bulkTag(body: {
        ids: string[];
        tag: string;
    }, u: any): Promise<{
        updated: number;
    }>;
    bulkDelete(body: {
        ids: string[];
    }, u: any): Promise<{
        deleted: number;
    }>;
    listFilters(u: any, resource?: string): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        userId: string;
        isPinned: boolean;
        resource: string;
        filters: import("@prisma/client/runtime/library").JsonValue;
        sortOrder: number;
    }[]>;
    createFilter(body: any, u: any): Promise<{
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        userId: string;
        isPinned: boolean;
        resource: string;
        filters: import("@prisma/client/runtime/library").JsonValue;
        sortOrder: number;
    }>;
    deleteFilter(id: string, u: any): Promise<{
        ok: boolean;
    }>;
    getChecklist(id: string, u: any): Promise<{
        items: ({
            doneBy: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            notes: string | null;
            bookingId: string;
            doneAt: Date | null;
            sortOrder: number;
            item: string;
            isDone: boolean;
            doneById: string | null;
        })[];
        total: number;
        done: number;
        progress: number;
    }>;
    toggleItem(itemId: string, body: {
        isDone: boolean;
    }, u: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        bookingId: string;
        doneAt: Date | null;
        sortOrder: number;
        item: string;
        isDone: boolean;
        doneById: string | null;
    }>;
    addChecklistItem(id: string, body: {
        item: string;
    }, u: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        bookingId: string;
        doneAt: Date | null;
        sortOrder: number;
        item: string;
        isDone: boolean;
        doneById: string | null;
    }>;
    deleteChecklistItem(itemId: string, u: any): Promise<{
        ok: boolean;
    }>;
    listCommissions(u: any): Promise<({
        booking: {
            id: string;
            client: {
                fullName: string;
            };
            bookingRef: string;
            tourName: string;
        };
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        agentId: string;
        paidAt: Date | null;
        bookingId: string;
        managerId: string | null;
        totalProfit: number;
        agentPercent: number;
        managerPercent: number;
        agentAmount: number;
        managerAmount: number;
        companyAmount: number;
        isPaid: boolean;
    })[]>;
    createCommission(id: string, u: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        agentId: string;
        paidAt: Date | null;
        bookingId: string;
        managerId: string | null;
        totalProfit: number;
        agentPercent: number;
        managerPercent: number;
        agentAmount: number;
        managerAmount: number;
        companyAmount: number;
        isPaid: boolean;
    }>;
    markPaid(id: string, u: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        notes: string | null;
        agentId: string;
        paidAt: Date | null;
        bookingId: string;
        managerId: string | null;
        totalProfit: number;
        agentPercent: number;
        managerPercent: number;
        agentAmount: number;
        managerAmount: number;
        companyAmount: number;
        isPaid: boolean;
    }>;
    getClient360(id: string, u: any): Promise<{
        client: {
            bookings: ({
                payments: {
                    id: string;
                    currency: import(".prisma/client").$Enums.Currency;
                    amount: number;
                    method: import(".prisma/client").$Enums.PaymentMethod;
                    paidAt: Date;
                }[];
                agent: {
                    id: string;
                    name: string;
                };
            } & {
                id: string;
                status: import(".prisma/client").$Enums.BookingStatus;
                currency: import(".prisma/client").$Enums.Currency;
                createdAt: Date;
                updatedAt: Date;
                tenantId: string;
                country: string | null;
                notes: string | null;
                internalNotes: string | null;
                description: string | null;
                clientId: string;
                bookingRef: string;
                tourName: string;
                destination: string;
                tourType: import(".prisma/client").$Enums.TourType;
                departureDate: Date | null;
                returnDate: Date | null;
                duration: number | null;
                adults: number;
                children: number;
                infants: number;
                totalPrice: number;
                paidAmount: number;
                discount: number;
                commissionPercent: number;
                profit: number;
                commissionAmount: number;
                statusHistory: import("@prisma/client/runtime/library").JsonValue;
                includesVisa: boolean;
                includesFlights: boolean;
                includesHotel: boolean;
                includesMeals: boolean;
                includesTransfer: boolean;
                includesInsurance: boolean;
                hotelName: string | null;
                hotelCity: string | null;
                hotelStars: number | null;
                hotelCheckIn: Date | null;
                hotelCheckOut: Date | null;
                mealPlan: string | null;
                roomType: string | null;
                hotelAddress: string | null;
                airline: string | null;
                flightNumber: string | null;
                departureAirport: string | null;
                arrivalAirport: string | null;
                departureTime: Date | null;
                arrivalTime: Date | null;
                flightClass: string | null;
                pnr: string | null;
                returnAirline: string | null;
                returnFlightNumber: string | null;
                returnDepartureTime: Date | null;
                returnArrivalTime: Date | null;
                returnPnr: string | null;
                taxiPickupAddress: string | null;
                taxiDropoffAddress: string | null;
                taxiPickupTime: Date | null;
                taxiDriverName: string | null;
                taxiDriverPhone: string | null;
                taxiCompany: string | null;
                insuranceCompany: string | null;
                insurancePolicyNo: string | null;
                insuranceStartDate: Date | null;
                insuranceEndDate: Date | null;
                insuranceCoverage: string | null;
                visaStatus: string | null;
                visaType: string | null;
                visaNumber: string | null;
                visaIssueDate: Date | null;
                visaExpiryDate: Date | null;
                supplierName: string | null;
                supplierContact: string | null;
                supplierCost: number | null;
                supplierRef: string | null;
                supplierPaid: number;
                supplierNotes: string | null;
                cancelReason: string | null;
                agentId: string | null;
            })[];
            assignedAgent: {
                id: string;
                name: string;
                email: string;
                phone: string;
            };
            timeline: {
                id: string;
                createdAt: Date;
                userId: string | null;
                type: string;
                title: string;
                description: string | null;
                metadata: import("@prisma/client/runtime/library").JsonValue;
                clientId: string;
            }[];
        } & {
            id: string;
            status: import(".prisma/client").$Enums.ClientStatus;
            createdAt: Date;
            updatedAt: Date;
            tags: string[];
            tenantId: string;
            email: string | null;
            phone: string | null;
            telegramId: string | null;
            language: import(".prisma/client").$Enums.Language;
            totalBookings: number;
            totalRevenue: number;
            lostReason: import(".prisma/client").$Enums.LostReason | null;
            leadScore: number;
            assignedAgentId: string | null;
            fullName: string;
            phone2: string | null;
            passportNo: string | null;
            passportExpiry: Date | null;
            passportCountry: string | null;
            dateOfBirth: Date | null;
            nationality: string | null;
            country: string | null;
            gender: string | null;
            address: string | null;
            city: string | null;
            tier: import(".prisma/client").$Enums.ClientTier;
            source: import(".prisma/client").$Enums.LeadSource;
            utmSource: string | null;
            utmMedium: string | null;
            utmCampaign: string | null;
            utmTerm: string | null;
            utmContent: string | null;
            sourceCampaign: string | null;
            referrerUrl: string | null;
            pipelineStage: import(".prisma/client").$Enums.PipelineStage;
            pipelineStageAt: Date;
            notes: string | null;
            internalNotes: string | null;
            telegramUsername: string | null;
            instagramHandle: string | null;
            whatsappPhone: string | null;
            familyMembers: import("@prisma/client/runtime/library").JsonValue;
            preferences: import("@prisma/client/runtime/library").JsonValue;
            totalSpent: number;
            avgBookingValue: number;
            lifetimeValue: number;
            firstContactAt: Date | null;
            lastContactAt: Date | null;
            lastBookingAt: Date | null;
        };
        financial: {
            totalSpent: number;
            totalProfit: number;
            totalPaid: number;
            balance: number;
            bookingsCount: number;
        };
        activeConversation: {
            id: string;
            channel: import(".prisma/client").$Enums.Channel;
            unreadCount: number;
            lastMessageAt: Date;
        };
        tasks: ({
            assignee: {
                id: string;
                name: string;
            };
        } & {
            id: string;
            status: import(".prisma/client").$Enums.TaskStatus;
            createdAt: Date;
            updatedAt: Date;
            tags: string[];
            tenantId: string;
            title: string;
            description: string | null;
            clientId: string | null;
            bookingId: string | null;
            dueAt: Date | null;
            creatorId: string;
            assigneeId: string;
            priority: import(".prisma/client").$Enums.TaskPriority;
            completedAt: Date | null;
            recurrence: string | null;
            parentId: string | null;
        })[];
        invoices: {
            id: string;
            status: import(".prisma/client").$Enums.InvoiceStatus;
            currency: import(".prisma/client").$Enums.Currency;
            createdAt: Date;
            paidAmount: number;
            profit: number;
            invoiceNumber: string;
            providerCost: number;
            salePrice: number;
            dueDate: Date;
        }[];
        documents: {
            id: string;
            createdAt: Date;
            fileUrl: string;
            fileMimeType: string;
            fileSize: number;
            fileName: string;
            uploadedBy: {
                name: string;
            };
        }[];
        followUps: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            title: string;
            clientId: string | null;
            agentId: string;
            note: string | null;
            dueAt: Date;
            done: boolean;
            doneAt: Date | null;
            notifiedAt: Date | null;
        }[];
    }>;
}
export declare class V8Module {
}
