"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookingsModule = exports.BookingsController = exports.BookingsService = void 0;
const event_emitter_1 = require("@nestjs/event-emitter");
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const helpers_1 = require("../../common/utils/helpers");
const clients_service_1 = require("../clients/clients.service");
const notifications_service_1 = require("../notifications/notifications.service");
const realtime_gateway_1 = require("../realtime/realtime.gateway");
const audit_module_1 = require("../audit/audit.module");
;
const STATUSES = ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const TOUR_TYPES = ['PACKAGE', 'INDIVIDUAL', 'GROUP', 'VISA_SUPPORT', 'HOTEL_ONLY', 'FLIGHT_ONLY', 'CRUISE'];
const CURRENCIES = ['USD', 'UZS', 'EUR', 'RUB'];
let BookingsService = class BookingsService {
    constructor(prisma, eventEmitter, clients, notifications, realtime, audit) {
        this.prisma = prisma;
        this.eventEmitter = eventEmitter;
        this.clients = clients;
        this.notifications = notifications;
        this.realtime = realtime;
        this.audit = audit;
        this.logger = new common_1.Logger('Bookings');
    }
    where(tenantId, userId, role, extra = {}) {
        const where = { tenantId, ...extra };
        if (role === 'AGENT')
            where.agentId = userId;
        return where;
    }
    async findAll(tenantId, userId, role, params) {
        const { skip, take, page, limit } = (0, helpers_1.paginate)(params.page, params.limit);
        const where = this.where(tenantId, userId, role);
        if (params.status)
            where.status = params.status;
        if (params.clientId)
            where.clientId = params.clientId;
        if (params.search?.trim()) {
            where.OR = [
                { bookingRef: { contains: params.search, mode: 'insensitive' } },
                { tourName: { contains: params.search, mode: 'insensitive' } },
                { destination: { contains: params.search, mode: 'insensitive' } },
                { client: { fullName: { contains: params.search, mode: 'insensitive' } } },
            ];
        }
        const [data, total] = await Promise.all([
            this.prisma.booking.findMany({
                where, skip, take,
                include: {
                    client: { select: { id: true, fullName: true, phone: true, tier: true } },
                    agent: { select: { id: true, name: true } },
                },
                orderBy: { createdAt: 'desc' },
            }),
            this.prisma.booking.count({ where }),
        ]);
        return { data, meta: (0, helpers_1.meta)(total, page, limit) };
    }
    async findOne(tenantId, id, userId, role) {
        const where = this.where(tenantId, userId, role, { id });
        const booking = await this.prisma.booking.findFirst({
            where,
            include: {
                client: true,
                agent: { select: { id: true, name: true, email: true } },
                payments: { orderBy: { paidAt: 'desc' } },
                tasks: { orderBy: { createdAt: 'desc' } },
                documents: { orderBy: { createdAt: 'desc' } },
                calls: { orderBy: { createdAt: 'desc' }, take: 20 },
            },
        });
        if (!booking)
            throw new common_1.NotFoundException('Booking topilmadi');
        try {
            this.eventEmitter.emit('booking.created', {
                tenantId: booking.tenantId,
                clientId: booking.clientId,
                bookingId: booking.id,
                assignedAgentId: booking.agentId,
            });
        }
        catch { }
        return booking;
    }
    async create(tenantId, userId, role, data) {
        if (!data.clientId)
            throw new common_1.BadRequestException('clientId majburiy');
        if (!data.tourName?.trim())
            throw new common_1.BadRequestException('tourName majburiy');
        if (!data.destination?.trim())
            throw new common_1.BadRequestException('destination majburiy');
        const totalPrice = Number(data.totalPrice);
        if (!Number.isFinite(totalPrice) || totalPrice <= 0) {
            throw new common_1.BadRequestException('totalPrice musbat bo\'lishi kerak');
        }
        const client = await this.prisma.client.findFirst({
            where: { id: data.clientId, tenantId },
        });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        const count = await this.prisma.booking.count({ where: { tenantId } });
        let bookingRef = (0, helpers_1.generateRef)('TRV', count);
        const existingRef = await this.prisma.booking.findFirst({ where: { bookingRef } });
        if (existingRef) {
            bookingRef = (0, helpers_1.generateRef)('TRV', count + Math.floor(Math.random() * 1000) + 1);
        }
        const agentId = (role === 'AGENT' ? userId : data.agentId) || userId;
        const supplierCost = Number(data.supplierCost) || 0;
        const discount = Number(data.discount) || 0;
        const autoProfit = Math.max(0, totalPrice - supplierCost - discount);
        const manualProfit = data.profit !== undefined ? Number(data.profit) : autoProfit;
        const booking = await this.prisma.booking.create({
            data: {
                tenantId,
                bookingRef,
                clientId: data.clientId,
                agentId,
                tourName: data.tourName.trim(),
                destination: data.destination.trim(),
                country: data.country,
                tourType: (0, helpers_1.safeEnum)(data.tourType, TOUR_TYPES, 'PACKAGE'),
                description: data.description,
                departureDate: data.departureDate ? new Date(data.departureDate) : undefined,
                returnDate: data.returnDate ? new Date(data.returnDate) : undefined,
                duration: data.duration ? Number(data.duration) : undefined,
                adults: Number(data.adults) || 1,
                children: Number(data.children) || 0,
                infants: Number(data.infants) || 0,
                totalPrice,
                currency: (0, helpers_1.safeEnum)(data.currency, CURRENCIES, 'USD'),
                discount,
                commissionAmount: Number(data.commission) || 0,
                profit: manualProfit,
                status: (0, helpers_1.safeEnum)(data.status, STATUSES, 'DRAFT'),
                statusHistory: [{
                        status: data.status || 'DRAFT',
                        at: new Date().toISOString(),
                        by: userId,
                    }],
                includesVisa: !!data.includesVisa,
                includesFlights: !!data.includesFlights,
                includesHotel: !!data.includesHotel,
                includesMeals: !!data.includesMeals,
                includesTransfer: !!data.includesTransfer,
                includesInsurance: !!data.includesInsurance,
                hotelName: data.hotelName,
                hotelCity: data.hotelCity,
                hotelStars: data.hotelStars ? Number(data.hotelStars) : undefined,
                hotelCheckIn: data.hotelCheckIn ? new Date(data.hotelCheckIn) : undefined,
                hotelCheckOut: data.hotelCheckOut ? new Date(data.hotelCheckOut) : undefined,
                hotelAddress: data.hotelAddress,
                mealPlan: data.mealPlan,
                roomType: data.roomType,
                airline: data.airline,
                flightNumber: data.flightNumber,
                departureAirport: data.departureAirport,
                arrivalAirport: data.arrivalAirport,
                departureTime: data.departureTime ? new Date(data.departureTime) : undefined,
                arrivalTime: data.arrivalTime ? new Date(data.arrivalTime) : undefined,
                flightClass: data.flightClass,
                pnr: data.pnr,
                returnAirline: data.returnAirline,
                returnFlightNumber: data.returnFlightNumber,
                returnDepartureTime: data.returnDepartureTime ? new Date(data.returnDepartureTime) : undefined,
                returnArrivalTime: data.returnArrivalTime ? new Date(data.returnArrivalTime) : undefined,
                returnPnr: data.returnPnr,
                taxiPickupAddress: data.taxiPickupAddress,
                taxiDropoffAddress: data.taxiDropoffAddress,
                taxiPickupTime: data.taxiPickupTime ? new Date(data.taxiPickupTime) : undefined,
                taxiDriverName: data.taxiDriverName,
                taxiDriverPhone: data.taxiDriverPhone,
                taxiCompany: data.taxiCompany,
                insuranceCompany: data.insuranceCompany,
                insurancePolicyNo: data.insurancePolicyNo,
                insuranceStartDate: data.insuranceStartDate ? new Date(data.insuranceStartDate) : undefined,
                insuranceEndDate: data.insuranceEndDate ? new Date(data.insuranceEndDate) : undefined,
                insuranceCoverage: data.insuranceCoverage,
                visaStatus: data.visaStatus,
                visaType: data.visaType,
                visaNumber: data.visaNumber,
                visaIssueDate: data.visaIssueDate ? new Date(data.visaIssueDate) : undefined,
                visaExpiryDate: data.visaExpiryDate ? new Date(data.visaExpiryDate) : undefined,
                supplierName: data.supplierName,
                supplierContact: data.supplierContact,
                supplierCost,
                supplierRef: data.supplierRef,
                supplierPaid: Number(data.supplierPaid) || 0,
                supplierNotes: data.supplierNotes,
                notes: data.notes,
                internalNotes: data.internalNotes,
            },
        });
        await this.prisma.client.update({
            where: { id: client.id },
            data: { lastContactAt: new Date(), lastBookingAt: new Date() },
        });
        await this.clients.addTimeline(client.id, 'booking_created', `Booking yaratildi: ${booking.bookingRef}`, `${booking.tourName} • $${booking.totalPrice}`, { userId, bookingId: booking.id });
        await this.clients.recalcStats(client.id);
        if (agentId && agentId !== userId) {
            await this.notifications.create({
                tenantId,
                userId: agentId,
                type: 'BOOKING_CREATED',
                title: '✈️ Sizga yangi booking',
                body: `${client.fullName} — ${booking.tourName} • $${booking.totalPrice}`,
                link: `/bookings/${booking.id}`,
                metadata: { bookingId: booking.id, clientId: client.id },
            });
        }
        try {
            this.realtime.emitToTenant(tenantId, 'dashboard:update', {
                type: 'booking_created',
                bookingId: booking.id,
                agentId,
                totalPrice: booking.totalPrice,
                profit: booking.profit,
            });
        }
        catch { }
        this.audit.log({
            tenantId, userId,
            action: 'CREATE', entity: 'booking', entityId: booking.id,
            metadata: { bookingRef: booking.bookingRef, totalPrice: booking.totalPrice, clientId: client.id },
        });
        return booking;
    }
    async update(tenantId, id, userId, role, data) {
        const existing = await this.findOne(tenantId, id, userId, role);
        const { id: _, tenantId: _t, bookingRef: _br, createdAt: _c, client: _cl, agent: _ag, payments: _p, tasks: _ta, documents: _d, calls: _ca, paidAmount: _pa, profit: _pr, ...safe } = data;
        if (safe.departureDate)
            safe.departureDate = new Date(safe.departureDate);
        if (safe.returnDate)
            safe.returnDate = new Date(safe.returnDate);
        let statusHistory = existing.statusHistory;
        if (safe.status && safe.status !== existing.status) {
            safe.status = (0, helpers_1.safeEnum)(safe.status, STATUSES, existing.status);
            statusHistory = [
                ...(Array.isArray(statusHistory) ? statusHistory : []),
                { status: safe.status, at: new Date().toISOString(), by: userId },
            ];
            safe.statusHistory = statusHistory;
            await this.clients.addTimeline(existing.clientId, 'booking_status', `Booking status: ${safe.status}`, `${existing.bookingRef}`, { userId, bookingId: id, from: existing.status, to: safe.status });
        }
        if (safe.tourType)
            safe.tourType = (0, helpers_1.safeEnum)(safe.tourType, TOUR_TYPES, existing.tourType);
        if (safe.currency)
            safe.currency = (0, helpers_1.safeEnum)(safe.currency, CURRENCIES, existing.currency);
        const dateFields = [
            'hotelCheckIn', 'hotelCheckOut', 'departureTime', 'arrivalTime',
            'returnDepartureTime', 'returnArrivalTime', 'taxiPickupTime',
            'insuranceStartDate', 'insuranceEndDate', 'visaIssueDate', 'visaExpiryDate',
        ];
        for (const f of dateFields) {
            if (safe[f])
                safe[f] = new Date(safe[f]);
        }
        if (safe.totalPrice !== undefined ||
            safe.supplierCost !== undefined ||
            safe.discount !== undefined) {
            const total = Number(safe.totalPrice ?? existing.totalPrice);
            const cost = Number(safe.supplierCost ?? existing.supplierCost ?? 0);
            const discount = Number(safe.discount ?? existing.discount ?? 0);
            safe.profit = Math.max(0, total - cost - discount);
        }
        if (role === 'AGENT') {
            delete safe.supplierName;
            delete safe.supplierContact;
            delete safe.supplierCost;
            delete safe.supplierRef;
            delete safe.supplierPaid;
            delete safe.supplierNotes;
        }
        const updated = await this.prisma.booking.update({ where: { id }, data: (0, helpers_1.clean)(safe) });
        if (safe.totalPrice !== undefined || safe.supplierCost !== undefined || safe.discount !== undefined) {
            await this.clients.recalcStats(existing.clientId).catch(() => { });
        }
        if (safe.status && ['CONFIRMED', 'COMPLETED'].includes(safe.status) &&
            !['CONFIRMED', 'COMPLETED'].includes(existing.status)) {
            const profit = updated.profit || 0;
            if (profit > 0 && updated.agentId) {
                const tenant = await this.prisma.tenant.findUnique({
                    where: { id: tenantId },
                    select: { agentCommissionPercent: true, managerCommissionPercent: true },
                });
                const agentPct = tenant?.agentCommissionPercent || 10;
                const agentAmt = +(profit * agentPct / 100).toFixed(2);
                await this.prisma.commission.upsert({
                    where: { bookingId: id },
                    update: { totalProfit: profit, agentAmount: agentAmt, agentPercent: agentPct },
                    create: {
                        tenantId, bookingId: id, agentId: updated.agentId,
                        totalProfit: profit, agentPercent: agentPct, managerPercent: 0,
                        agentAmount: agentAmt, managerAmount: 0,
                        companyAmount: profit - agentAmt,
                    },
                }).catch(() => { });
            }
            if (updated.agentId && updated.agentId !== userId) {
                await this.notifications.create({
                    tenantId, userId: updated.agentId,
                    type: 'BOOKING_UPDATED',
                    title: `✅ Booking tasdiqlandi`,
                    body: `${updated.bookingRef} — ${safe.status}`,
                    link: `/bookings/${id}`,
                    metadata: { bookingId: id, status: safe.status },
                }).catch(() => { });
            }
            try {
                this.realtime.emitToTenant(tenantId, 'booking:confirmed', { bookingId: id, status: safe.status });
            }
            catch { }
        }
        this.audit.log({
            tenantId, userId,
            action: 'UPDATE', entity: 'booking', entityId: id,
            changes: { before: { status: existing.status }, after: { status: safe.status || existing.status } },
        });
        return updated;
    }
    async delete(tenantId, id, userId, role) {
        if (role === 'AGENT')
            throw new common_1.BadRequestException("Agentlar booking o'chira olmaydi");
        const b = await this.findOne(tenantId, id, userId, role);
        await this.prisma.booking.delete({ where: { id } });
        await this.clients.recalcStats(b.clientId).catch(() => { });
        await this.clients.addTimeline(b.clientId, 'booking_deleted', `Booking o'chirildi: ${b.bookingRef}`, b.tourName, { userId, bookingId: id }).catch(() => { });
        if (b.agentId && b.agentId !== userId) {
            await this.notifications.create({
                tenantId, userId: b.agentId,
                type: 'BOOKING_UPDATED',
                title: `🗑 Booking o'chirildi`,
                body: `${b.bookingRef} — ${b.tourName}`,
                metadata: { bookingId: id },
            }).catch(() => { });
        }
        this.audit.log({
            tenantId, userId,
            action: 'DELETE', entity: 'booking', entityId: id,
            metadata: { bookingRef: b.bookingRef, tourName: b.tourName },
        });
        return { ok: true };
    }
};
exports.BookingsService = BookingsService;
exports.BookingsService = BookingsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        event_emitter_1.EventEmitter2,
        clients_service_1.ClientsService,
        notifications_service_1.NotificationsService,
        realtime_gateway_1.RealtimeGateway,
        audit_module_1.AuditService])
], BookingsService);
let BookingsController = class BookingsController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, search, status, clientId, page, limit) {
        return this.svc.findAll(u.tenantId, u.sub, u.role, { search, status, clientId, page, limit });
    }
    one(id, u) {
        return this.svc.findOne(u.tenantId, id, u.sub, u.role);
    }
    create(body, u) {
        return this.svc.create(u.tenantId, u.sub, u.role, body);
    }
    update(id, body, u) {
        return this.svc.update(u.tenantId, id, u.sub, u.role, body);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, id, u.sub, u.role);
    }
};
exports.BookingsController = BookingsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('search')),
    __param(2, (0, common_1.Query)('status')),
    __param(3, (0, common_1.Query)('clientId')),
    __param(4, (0, common_1.Query)('page')),
    __param(5, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, Object, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "one", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "create", null);
__decorate([
    (0, common_1.Put)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "delete", null);
exports.BookingsController = BookingsController = __decorate([
    (0, common_1.Controller)('bookings'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [BookingsService])
], BookingsController);
let BookingsModule = class BookingsModule {
};
exports.BookingsModule = BookingsModule;
exports.BookingsModule = BookingsModule = __decorate([
    (0, common_1.Module)({
        imports: [],
        controllers: [BookingsController],
        providers: [BookingsService],
        exports: [BookingsService],
    })
], BookingsModule);
//# sourceMappingURL=bookings.module.js.map