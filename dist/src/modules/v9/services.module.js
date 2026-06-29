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
exports.ServicesModule = exports.ServicesController = exports.ServicesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const VALID_TYPES = [
    'TAXI', 'TRANSFER', 'INSURANCE', 'VISA', 'SIM_CARD',
    'VIP_MEET', 'GUIDE', 'HOTEL_UPGRADE', 'TOUR_GUIDE',
    'EXCURSION', 'RESTAURANT', 'OTHER',
];
const VALID_STATUSES = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];
let ServicesService = class ServicesService {
    constructor(_prisma) {
        this._prisma = _prisma;
        this.logger = new common_1.Logger('ServicesService');
    }
    get prisma() { return this._prisma; }
    async verifyBookingAccess(tenantId, bookingId, userId, role) {
        if (!bookingId) {
            throw new common_1.BadRequestException('bookingId kerak');
        }
        const where = { id: bookingId, tenantId };
        if (role === 'AGENT')
            where.agentId = userId;
        const booking = await this._prisma.booking.findFirst({ where });
        if (!booking) {
            throw new common_1.NotFoundException('Booking topilmadi yoki sizning ruxsatingiz yo\'q');
        }
        return booking;
    }
    validateData(data, isUpdate = false) {
        const errors = [];
        if (!isUpdate || data.type !== undefined) {
            if (!isUpdate && !data.type)
                errors.push('Xizmat turi (type) kerak');
            if (data.type && !VALID_TYPES.includes(data.type)) {
                errors.push(`Type noto'g'ri. Ruxsat etilgan: ${VALID_TYPES.join(', ')}`);
            }
        }
        if (!isUpdate || data.name !== undefined) {
            if (!isUpdate && !data.name?.trim())
                errors.push('Xizmat nomi kerak');
            if (data.name !== undefined && (typeof data.name !== 'string' || !data.name.trim())) {
                errors.push("Xizmat nomi bo'sh bo'lishi mumkin emas");
            }
        }
        if (!isUpdate || data.price !== undefined) {
            const price = Number(data.price);
            if (!isUpdate && (data.price === undefined || data.price === null)) {
                errors.push('Narx kerak');
            }
            else if (data.price !== undefined && (isNaN(price) || price < 0)) {
                errors.push("Narx noto'g'ri (manfiy bo'lmasligi kerak)");
            }
        }
        if (data.quantity !== undefined && data.quantity !== null) {
            const qty = Number(data.quantity);
            if (isNaN(qty) || qty < 1) {
                errors.push("Miqdor 1 dan kichik bo'lmasligi kerak");
            }
        }
        if (data.status && !VALID_STATUSES.includes(data.status)) {
            errors.push(`Status noto'g'ri. Ruxsat: ${VALID_STATUSES.join(', ')}`);
        }
        if (data.date) {
            const d = new Date(data.date);
            if (isNaN(d.getTime())) {
                errors.push("Sana noto'g'ri formatda");
            }
        }
        if (errors.length > 0) {
            throw new common_1.BadRequestException(errors.join('; '));
        }
    }
    async list(tenantId, bookingId, userId, role) {
        await this.verifyBookingAccess(tenantId, bookingId, userId, role);
        try {
            return await this.prisma.bookingService.findMany({
                where: { bookingId, tenantId },
                orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
            });
        }
        catch (e) {
            this.logger.error(`Services list error: ${e.message}`);
            if (e.message?.includes('booking_services') || e.code === 'P2021') {
                throw new common_1.BadRequestException("Database jadval topilmadi. Backend admin'iga ayting: `npx prisma db push` ishga tushirsin");
            }
            throw e;
        }
    }
    async create(tenantId, bookingId, userId, role, data) {
        await this.verifyBookingAccess(tenantId, bookingId, userId, role);
        this.validateData(data, false);
        const price = Number(data.price);
        const quantity = Number(data.quantity) || 1;
        const totalAmount = price * quantity;
        try {
            const service = await this.prisma.bookingService.create({
                data: {
                    tenantId,
                    bookingId,
                    type: data.type,
                    name: data.name.trim(),
                    description: data.description?.trim() || null,
                    fromLocation: data.fromLocation?.trim() || null,
                    toLocation: data.toLocation?.trim() || null,
                    date: data.date ? new Date(data.date) : null,
                    time: data.time?.trim() || null,
                    price,
                    quantity,
                    totalAmount,
                    status: data.status || 'PENDING',
                    notes: data.notes?.trim() || null,
                    providerName: data.providerName?.trim() || null,
                    providerPhone: data.providerPhone?.trim() || null,
                },
            });
            try {
                const booking = await this._prisma.booking.findUnique({
                    where: { id: bookingId },
                    select: { clientId: true },
                });
                if (booking?.clientId) {
                    await this._prisma.clientTimeline.create({
                        data: {
                            clientId: booking.clientId,
                            userId,
                            type: 'service_added',
                            title: `🛎 Xizmat qo'shildi: ${data.name}`,
                            description: `${data.type} • ${totalAmount}`,
                            metadata: {
                                bookingId,
                                serviceId: service.id,
                                type: data.type,
                                totalAmount,
                            },
                        },
                    });
                }
            }
            catch (timelineErr) {
                this.logger.warn(`Timeline yozilmadi: ${timelineErr.message}`);
            }
            this.logger.log(`Service yaratildi: ${service.id} (${data.type}) — ${totalAmount}`);
            return service;
        }
        catch (e) {
            this.logger.error(`Service yaratilmadi: ${e.message}`, e.stack);
            if (e.code === 'P2002') {
                throw new common_1.BadRequestException("Bu xizmat allaqachon mavjud");
            }
            if (e.code === 'P2003') {
                throw new common_1.BadRequestException("Booking topilmadi yoki o'chirilgan");
            }
            if (e.code === 'P2021' || e.message?.includes('booking_services')) {
                throw new common_1.BadRequestException("Database jadval topilmadi. `npx prisma db push` ishga tushiring");
            }
            if (e.code === 'P2025') {
                throw new common_1.NotFoundException("Booking topilmadi");
            }
            throw new common_1.BadRequestException(`Xizmat yaratilmadi: ${e.message}`);
        }
    }
    async update(tenantId, id, userId, role, data) {
        if (!id)
            throw new common_1.BadRequestException('id kerak');
        const existing = await this.prisma.bookingService.findFirst({
            where: { id, tenantId },
        });
        if (!existing) {
            throw new common_1.NotFoundException("Xizmat topilmadi");
        }
        await this.verifyBookingAccess(tenantId, existing.bookingId, userId, role);
        this.validateData(data, true);
        const safe = {};
        if (data.type !== undefined)
            safe.type = data.type;
        if (data.name !== undefined)
            safe.name = data.name.trim();
        if (data.description !== undefined)
            safe.description = data.description?.trim() || null;
        if (data.fromLocation !== undefined)
            safe.fromLocation = data.fromLocation?.trim() || null;
        if (data.toLocation !== undefined)
            safe.toLocation = data.toLocation?.trim() || null;
        if (data.date !== undefined)
            safe.date = data.date ? new Date(data.date) : null;
        if (data.time !== undefined)
            safe.time = data.time?.trim() || null;
        if (data.price !== undefined)
            safe.price = Number(data.price);
        if (data.quantity !== undefined)
            safe.quantity = Number(data.quantity);
        if (data.status !== undefined)
            safe.status = data.status;
        if (data.notes !== undefined)
            safe.notes = data.notes?.trim() || null;
        if (data.providerName !== undefined)
            safe.providerName = data.providerName?.trim() || null;
        if (data.providerPhone !== undefined)
            safe.providerPhone = data.providerPhone?.trim() || null;
        if (safe.price !== undefined || safe.quantity !== undefined) {
            const newPrice = safe.price !== undefined ? safe.price : existing.price;
            const newQty = safe.quantity !== undefined ? safe.quantity : existing.quantity;
            safe.totalAmount = newPrice * newQty;
        }
        try {
            const updated = await this.prisma.bookingService.update({
                where: { id },
                data: safe,
            });
            this.logger.log(`Service yangilandi: ${id}`);
            return updated;
        }
        catch (e) {
            this.logger.error(`Service yangilanmadi: ${e.message}`);
            throw new common_1.BadRequestException(`Xizmat yangilanmadi: ${e.message}`);
        }
    }
    async delete(tenantId, id, userId, role) {
        if (!id)
            throw new common_1.BadRequestException('id kerak');
        const existing = await this.prisma.bookingService.findFirst({
            where: { id, tenantId },
        });
        if (!existing) {
            throw new common_1.NotFoundException("Xizmat topilmadi");
        }
        await this.verifyBookingAccess(tenantId, existing.bookingId, userId, role);
        try {
            await this.prisma.bookingService.delete({ where: { id } });
            this.logger.log(`Service o'chirildi: ${id}`);
            return { ok: true, deletedId: id };
        }
        catch (e) {
            this.logger.error(`Service o'chirilmadi: ${e.message}`);
            throw new common_1.BadRequestException(`Xizmat o'chirilmadi: ${e.message}`);
        }
    }
    async getTotalForBooking(tenantId, bookingId, userId, role) {
        await this.verifyBookingAccess(tenantId, bookingId, userId, role);
        try {
            const result = await this.prisma.bookingService.aggregate({
                where: { bookingId, tenantId, status: { not: 'CANCELLED' } },
                _sum: { totalAmount: true },
                _count: { id: true },
            });
            const byStatus = await this.prisma.bookingService.groupBy({
                by: ['status'],
                where: { bookingId, tenantId },
                _count: { id: true },
                _sum: { totalAmount: true },
            });
            return {
                totalAmount: result._sum.totalAmount || 0,
                count: result._count.id,
                byStatus: byStatus.reduce((acc, s) => {
                    acc[s.status] = {
                        count: s._count.id,
                        totalAmount: s._sum.totalAmount || 0,
                    };
                    return acc;
                }, {}),
            };
        }
        catch (e) {
            this.logger.error(`Total hisoblanmadi: ${e.message}`);
            if (e.code === 'P2021' || e.message?.includes('booking_services')) {
                return { totalAmount: 0, count: 0, byStatus: {} };
            }
            throw e;
        }
    }
};
exports.ServicesService = ServicesService;
exports.ServicesService = ServicesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ServicesService);
let ServicesController = class ServicesController {
    constructor(svc) {
        this.svc = svc;
    }
    list(bookingId, u) {
        return this.svc.list(u.tenantId, bookingId, u.sub, u.role);
    }
    total(bookingId, u) {
        return this.svc.getTotalForBooking(u.tenantId, bookingId, u.sub, u.role);
    }
    create(bookingId, body, u) {
        return this.svc.create(u.tenantId, bookingId, u.sub, u.role, body);
    }
    update(id, body, u) {
        return this.svc.update(u.tenantId, id, u.sub, u.role, body);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, id, u.sub, u.role);
    }
};
exports.ServicesController = ServicesController;
__decorate([
    (0, common_1.Get)('booking/:bookingId'),
    __param(0, (0, common_1.Param)('bookingId')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "list", null);
__decorate([
    (0, common_1.Get)('booking/:bookingId/total'),
    __param(0, (0, common_1.Param)('bookingId')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "total", null);
__decorate([
    (0, common_1.Post)('booking/:bookingId'),
    __param(0, (0, common_1.Param)('bookingId')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "delete", null);
exports.ServicesController = ServicesController = __decorate([
    (0, common_1.Controller)('services'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [ServicesService])
], ServicesController);
let ServicesModule = class ServicesModule {
};
exports.ServicesModule = ServicesModule;
exports.ServicesModule = ServicesModule = __decorate([
    (0, common_1.Module)({
        controllers: [ServicesController],
        providers: [ServicesService],
        exports: [ServicesService],
    })
], ServicesModule);
//# sourceMappingURL=services.module.js.map