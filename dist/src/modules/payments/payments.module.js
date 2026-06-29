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
exports.PaymentsModule = exports.PaymentsController = exports.PaymentsService = void 0;
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
const METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'PAYME', 'CLICK', 'UZUM', 'CRYPTO', 'OTHER'];
const STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'];
const CURRENCIES = ['USD', 'UZS', 'EUR', 'RUB'];
let PaymentsService = class PaymentsService {
    constructor(prisma, clients, notifications, realtime, audit) {
        this.prisma = prisma;
        this.clients = clients;
        this.notifications = notifications;
        this.realtime = realtime;
        this.audit = audit;
    }
    async findAll(tenantId, userId, role, params) {
        const { skip, take, page, limit } = (0, helpers_1.paginate)(params.page, params.limit);
        const where = { tenantId };
        if (params.method)
            where.method = params.method;
        if (params.bookingId)
            where.bookingId = params.bookingId;
        if (params.clientId)
            where.clientId = params.clientId;
        if (role === 'AGENT') {
            where.booking = { agentId: userId };
        }
        const [data, total] = await Promise.all([
            this.prisma.payment.findMany({
                where, skip, take,
                include: {
                    client: { select: { id: true, fullName: true, phone: true } },
                    booking: { select: { id: true, bookingRef: true, tourName: true } },
                },
                orderBy: { paidAt: 'desc' },
            }),
            this.prisma.payment.count({ where }),
        ]);
        return { data, meta: (0, helpers_1.meta)(total, page, limit) };
    }
    async stats(tenantId, userId, role) {
        const monthStart = new Date(new Date().setDate(1));
        monthStart.setHours(0, 0, 0, 0);
        const where = { tenantId, status: 'COMPLETED', paidAt: { gte: monthStart } };
        if (role === 'AGENT')
            where.booking = { agentId: userId };
        const [total, byMethod, pendingBookings] = await Promise.all([
            this.prisma.payment.aggregate({ where, _sum: { amount: true }, _count: { id: true } }),
            this.prisma.payment.groupBy({
                by: ['method'], where, _sum: { amount: true }, _count: { id: true },
            }),
            this.prisma.booking.findMany({
                where: {
                    tenantId,
                    status: { notIn: ['CANCELLED', 'COMPLETED'] },
                    ...(role === 'AGENT' ? { agentId: userId } : {}),
                },
                select: {
                    id: true, bookingRef: true, totalPrice: true, paidAmount: true,
                    client: { select: { fullName: true } },
                },
                take: 20,
            }),
        ]);
        return {
            total, byMethod,
            pendingBookings: pendingBookings.filter((b) => b.paidAmount < b.totalPrice),
        };
    }
    async addManual(tenantId, userId, role, data) {
        if (!data.bookingId)
            throw new common_1.BadRequestException('bookingId majburiy');
        const amount = Number(data.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new common_1.BadRequestException('amount musbat bo\'lishi kerak');
        }
        const booking = await this.prisma.booking.findFirst({
            where: { id: data.bookingId, tenantId },
        });
        if (!booking)
            throw new common_1.NotFoundException('Booking topilmadi');
        if (role === 'AGENT' && booking.agentId !== userId) {
            throw new common_1.NotFoundException('Booking topilmadi');
        }
        const payment = await this.prisma.payment.create({
            data: {
                tenantId,
                bookingId: booking.id,
                clientId: booking.clientId,
                amount,
                currency: (0, helpers_1.safeEnum)(data.currency, CURRENCIES, booking.currency),
                method: (0, helpers_1.safeEnum)(data.method, METHODS, 'CASH'),
                status: (0, helpers_1.safeEnum)(data.status, STATUSES, 'COMPLETED'),
                uzsRate: data.uzsRate ? Number(data.uzsRate) : undefined,
                note: data.note,
                externalRef: data.externalRef,
                receiptUrl: data.receiptUrl,
                paidAt: data.paidAt ? new Date(data.paidAt) : new Date(),
            },
        });
        const newPaid = booking.paidAmount + amount;
        await this.prisma.booking.update({
            where: { id: booking.id },
            data: { paidAmount: newPaid },
        });
        await this.clients.recalcStats(booking.clientId);
        await this.clients.addTimeline(booking.clientId, 'payment', `To'lov: $${amount}`, `${booking.bookingRef} • ${data.method || 'CASH'}`, { userId, paymentId: payment.id, bookingId: booking.id });
        if (booking.agentId && booking.agentId !== userId) {
            await this.notifications.create({
                tenantId,
                userId: booking.agentId,
                type: 'PAYMENT_RECEIVED',
                title: `💰 To'lov qabul qilindi`,
                body: `${booking.bookingRef}: $${amount}`,
                link: `/bookings/${booking.id}`,
                metadata: { bookingId: booking.id },
            });
        }
        try {
            this.realtime.emitToTenant(tenantId, 'dashboard:update', {
                type: 'payment_received',
                bookingId: booking.id,
                agentId: booking.agentId,
                amount,
            });
        }
        catch { }
        this.audit.log({
            tenantId, userId,
            action: 'CREATE', entity: 'payment', entityId: payment.id,
            metadata: { amount, bookingId: booking.id, method: payment.method },
        });
        return payment;
    }
    async refund(tenantId, id, userId, role, reason) {
        if (role === 'AGENT')
            throw new common_1.BadRequestException('Refund qilish uchun ruxsat yo\'q');
        const payment = await this.prisma.payment.findFirst({ where: { id, tenantId } });
        if (!payment)
            throw new common_1.NotFoundException('To\'lov topilmadi');
        if (payment.status === 'REFUNDED') {
            throw new common_1.BadRequestException('Bu to\'lov allaqachon qaytarilgan');
        }
        const updated = await this.prisma.payment.update({
            where: { id },
            data: { status: 'REFUNDED', note: reason ? `Qaytarildi: ${reason}` : 'Qaytarildi' },
        });
        const booking = await this.prisma.booking.findUnique({ where: { id: payment.bookingId } });
        if (booking) {
            await this.prisma.booking.update({
                where: { id: booking.id },
                data: { paidAmount: Math.max(0, booking.paidAmount - payment.amount) },
            });
            await this.clients.recalcStats(booking.clientId);
        }
        return updated;
    }
};
exports.PaymentsService = PaymentsService;
exports.PaymentsService = PaymentsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        clients_service_1.ClientsService,
        notifications_service_1.NotificationsService,
        realtime_gateway_1.RealtimeGateway,
        audit_module_1.AuditService])
], PaymentsService);
let PaymentsController = class PaymentsController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, method, bookingId, clientId, page, limit) {
        return this.svc.findAll(u.tenantId, u.sub, u.role, { method, bookingId, clientId, page, limit });
    }
    stats(u) {
        return this.svc.stats(u.tenantId, u.sub, u.role);
    }
    manual(body, u) {
        return this.svc.addManual(u.tenantId, u.sub, u.role, body);
    }
    refund(id, body, u) {
        return this.svc.refund(u.tenantId, id, u.sub, u.role, body?.reason);
    }
    async export(u, method, from, to) {
        const result = await this.svc.findAll(u.tenantId, u.sub, u.role, {
            method, page: 1, limit: 10000,
        });
        const rows = result.data || [];
        const headers = ['Sana', 'Booking', 'Klient', 'Summa', 'Valyuta', 'Usul', 'Holat', 'Izoh'];
        const csv = [
            headers.join(','),
            ...rows.map((p) => [
                p.paidAt ? new Date(p.paidAt).toISOString().slice(0, 10) : '',
                p.booking?.bookingRef || '',
                (p.booking?.client?.fullName || '').replace(/,/g, ';'),
                p.amount,
                p.currency,
                p.method,
                p.status,
                (p.note || '').replace(/[\r\n,]/g, ' '),
            ].join(',')),
        ].join('\n');
        return { csv, count: rows.length };
    }
};
exports.PaymentsController = PaymentsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('method')),
    __param(2, (0, common_1.Query)('bookingId')),
    __param(3, (0, common_1.Query)('clientId')),
    __param(4, (0, common_1.Query)('page')),
    __param(5, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, Object, Object]),
    __metadata("design:returntype", void 0)
], PaymentsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)('stats'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PaymentsController.prototype, "stats", null);
__decorate([
    (0, common_1.Post)('manual'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PaymentsController.prototype, "manual", null);
__decorate([
    (0, common_1.Post)(':id/refund'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], PaymentsController.prototype, "refund", null);
__decorate([
    (0, common_1.Get)('export'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('method')),
    __param(2, (0, common_1.Query)('from')),
    __param(3, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "export", null);
exports.PaymentsController = PaymentsController = __decorate([
    (0, common_1.Controller)('payments'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [PaymentsService])
], PaymentsController);
let PaymentsModule = class PaymentsModule {
};
exports.PaymentsModule = PaymentsModule;
exports.PaymentsModule = PaymentsModule = __decorate([
    (0, common_1.Module)({
        controllers: [PaymentsController],
        providers: [PaymentsService],
    })
], PaymentsModule);
//# sourceMappingURL=payments.module.js.map