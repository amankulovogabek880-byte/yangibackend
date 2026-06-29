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
exports.ApprovalsModule = exports.ApprovalsController = exports.ApprovalsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
const notifications_service_1 = require("../notifications/notifications.service");
const audit_module_1 = require("../audit/audit.module");
let ApprovalsService = class ApprovalsService {
    constructor(_prisma, notifications, audit) {
        this._prisma = _prisma;
        this.notifications = notifications;
        this.audit = audit;
    }
    get prisma() { return this._prisma; }
    async create(tenantId, requesterId, data) {
        if (!data.type)
            throw new common_1.BadRequestException('type kerak');
        if (!data.entityType || !data.entityId) {
            throw new common_1.BadRequestException('entityType va entityId kerak');
        }
        if (!data.title?.trim())
            throw new common_1.BadRequestException('Sarlavha kerak');
        const request = await this.prisma.approvalRequest.create({
            data: {
                tenantId,
                requesterId,
                type: data.type,
                status: 'PENDING',
                entityType: data.entityType,
                entityId: data.entityId,
                title: data.title.trim(),
                reason: data.reason,
                oldValue: data.oldValue || null,
                newValue: data.newValue || null,
                amount: data.amount,
            },
            include: {
                requester: { select: { id: true, name: true } },
            },
        });
        const admins = await this.prisma.user.findMany({
            where: { tenantId, role: { in: ['TENANT_ADMIN', 'MANAGER'] }, status: 'ACTIVE' },
            select: { id: true },
        });
        for (const admin of admins) {
            await this.notifications.create({
                tenantId,
                userId: admin.id,
                type: 'APPROVAL_REQUESTED',
                title: `🔔 Tasdiq so'raldi: ${data.title}`,
                body: `${request.requester.name} ${this.typeLabel(data.type)} bo'yicha tasdiq so'rayapti`,
                link: `/approvals/${request.id}`,
                metadata: { approvalId: request.id, type: data.type },
            });
        }
        this.audit.log({
            tenantId, userId: requesterId,
            action: 'CREATE', entity: 'approval', entityId: request.id,
            metadata: { type: data.type, entityType: data.entityType, entityId: data.entityId },
        });
        return request;
    }
    async list(tenantId, userId, role, params) {
        const where = { tenantId };
        if (params.status)
            where.status = params.status;
        if (params.type)
            where.type = params.type;
        if (role === 'AGENT') {
            where.requesterId = userId;
        }
        else if (params.mine === 'true') {
            where.requesterId = userId;
        }
        return this.prisma.approvalRequest.findMany({
            where,
            include: {
                requester: { select: { id: true, name: true, avatarUrl: true } },
                reviewer: { select: { id: true, name: true, avatarUrl: true } },
            },
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
            take: 100,
        });
    }
    async findOne(tenantId, id, userId, role) {
        const request = await this.prisma.approvalRequest.findFirst({
            where: { id, tenantId },
            include: {
                requester: { select: { id: true, name: true, avatarUrl: true, email: true } },
                reviewer: { select: { id: true, name: true, avatarUrl: true, email: true } },
            },
        });
        if (!request)
            throw new common_1.NotFoundException();
        if (role === 'AGENT' && request.requesterId !== userId) {
            throw new common_1.ForbiddenException();
        }
        return request;
    }
    async approve(tenantId, id, reviewerId, role, note) {
        if (!['TENANT_ADMIN', 'MANAGER'].includes(role)) {
            throw new common_1.ForbiddenException('Faqat admin yoki manager tasdiqlay oladi');
        }
        const request = await this.prisma.approvalRequest.findFirst({
            where: { id, tenantId },
        });
        if (!request)
            throw new common_1.NotFoundException();
        if (request.status !== 'PENDING') {
            throw new common_1.BadRequestException('Bu so\'rov allaqachon ko\'rib chiqilgan');
        }
        const updated = await this.prisma.approvalRequest.update({
            where: { id },
            data: {
                status: 'APPROVED',
                reviewerId,
                reviewNote: note,
                reviewedAt: new Date(),
            },
        });
        await this.applyApproval(tenantId, updated);
        await this.notifications.create({
            tenantId,
            userId: request.requesterId,
            type: 'APPROVAL_APPROVED',
            title: `✅ Tasdiqlandi: ${request.title}`,
            body: note || 'So\'rovingiz tasdiqlandi',
            link: `/approvals/${request.id}`,
            metadata: { approvalId: request.id },
        });
        this.audit.log({
            tenantId, userId: reviewerId,
            action: 'UPDATE', entity: 'approval', entityId: request.id,
            metadata: { action: 'approved', note },
        });
        return updated;
    }
    async reject(tenantId, id, reviewerId, role, note) {
        if (!['TENANT_ADMIN', 'MANAGER'].includes(role)) {
            throw new common_1.ForbiddenException('Faqat admin yoki manager rad eta oladi');
        }
        const request = await this.prisma.approvalRequest.findFirst({
            where: { id, tenantId },
        });
        if (!request)
            throw new common_1.NotFoundException();
        if (request.status !== 'PENDING') {
            throw new common_1.BadRequestException('Bu so\'rov allaqachon ko\'rib chiqilgan');
        }
        const updated = await this.prisma.approvalRequest.update({
            where: { id },
            data: {
                status: 'REJECTED',
                reviewerId,
                reviewNote: note,
                reviewedAt: new Date(),
            },
        });
        await this.notifications.create({
            tenantId,
            userId: request.requesterId,
            type: 'APPROVAL_REJECTED',
            title: `❌ Rad etildi: ${request.title}`,
            body: note || 'So\'rovingiz rad etildi',
            link: `/approvals/${request.id}`,
            metadata: { approvalId: request.id },
        });
        this.audit.log({
            tenantId, userId: reviewerId,
            action: 'UPDATE', entity: 'approval', entityId: request.id,
            metadata: { action: 'rejected', note },
        });
        return updated;
    }
    async cancel(tenantId, id, userId) {
        const request = await this.prisma.approvalRequest.findFirst({
            where: { id, tenantId, requesterId: userId },
        });
        if (!request)
            throw new common_1.NotFoundException();
        if (request.status !== 'PENDING') {
            throw new common_1.BadRequestException('Faqat kutilayotgan so\'rovni bekor qilish mumkin');
        }
        return this.prisma.approvalRequest.update({
            where: { id },
            data: { status: 'CANCELLED' },
        });
    }
    async applyApproval(tenantId, request) {
        try {
            switch (request.type) {
                case 'DISCOUNT':
                case 'PRICE_CHANGE':
                    if (request.entityType === 'booking' && request.newValue?.totalPrice) {
                        await this.prisma.booking.update({
                            where: { id: request.entityId },
                            data: { totalPrice: request.newValue.totalPrice },
                        });
                    }
                    break;
                case 'BOOKING_CANCEL':
                    if (request.entityType === 'booking') {
                        await this.prisma.booking.update({
                            where: { id: request.entityId },
                            data: {
                                status: 'CANCELLED',
                                cancelReason: request.reason || 'Approval orqali bekor qilindi',
                            },
                        });
                    }
                    break;
                case 'REFUND':
                    if (request.entityType === 'booking' || request.entityType === 'BOOKING') {
                        await this.prisma.booking.update({
                            where: { id: request.entityId },
                            data: {
                                status: 'CANCELLED',
                                cancelReason: request.reason || `Refund: ${request.amount || 0}`,
                                profit: 0,
                            },
                        });
                        try {
                            const booking = await this.prisma.booking.findUnique({
                                where: { id: request.entityId },
                                select: { tenantId: true, clientId: true, currency: true },
                            });
                            if (booking) {
                                await this.prisma.payment.create({
                                    data: {
                                        tenantId: booking.tenantId,
                                        clientId: booking.clientId,
                                        bookingId: request.entityId,
                                        amount: -Math.abs(request.amount || 0),
                                        currency: booking.currency || 'USD',
                                        method: 'CASH',
                                        status: 'COMPLETED',
                                        paidAt: new Date(),
                                        note: `↩️ Refund: ${request.reason || 'Approval orqali'}`,
                                    },
                                });
                            }
                        }
                        catch (e) {
                        }
                    }
                    break;
                case 'PAYMENT_DELETE':
                    if (request.entityType === 'payment') {
                        await this.prisma.payment.delete({
                            where: { id: request.entityId },
                        });
                    }
                    break;
                case 'COMMISSION_OVERRIDE':
                    break;
            }
        }
        catch (e) {
            console.error('Approval apply error:', e);
        }
    }
    typeLabel(type) {
        const labels = {
            DISCOUNT: '💰 Chegirma',
            REFUND: '↩️ Pul qaytarish',
            PRICE_CHANGE: '💵 Narx o\'zgarishi',
            BOOKING_CANCEL: '❌ Booking bekor',
            PAYMENT_DELETE: '🗑 To\'lov o\'chirish',
            COMMISSION_OVERRIDE: '📊 Komissiya o\'zgarishi',
            OTHER: 'Boshqa',
        };
        return labels[type] || type;
    }
};
exports.ApprovalsService = ApprovalsService;
exports.ApprovalsService = ApprovalsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_service_1.NotificationsService,
        audit_module_1.AuditService])
], ApprovalsService);
let ApprovalsController = class ApprovalsController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, status, type, mine) {
        return this.svc.list(u.tenantId, u.sub, u.role, { status, type, mine });
    }
    one(id, u) {
        return this.svc.findOne(u.tenantId, id, u.sub, u.role);
    }
    create(body, u) {
        return this.svc.create(u.tenantId, u.sub, body);
    }
    approve(id, body, u) {
        return this.svc.approve(u.tenantId, id, u.sub, u.role, body.note);
    }
    reject(id, body, u) {
        return this.svc.reject(u.tenantId, id, u.sub, u.role, body.note);
    }
    cancel(id, u) {
        return this.svc.cancel(u.tenantId, id, u.sub);
    }
};
exports.ApprovalsController = ApprovalsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('status')),
    __param(2, (0, common_1.Query)('type')),
    __param(3, (0, common_1.Query)('mine')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", void 0)
], ApprovalsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ApprovalsController.prototype, "one", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], ApprovalsController.prototype, "create", null);
__decorate([
    (0, common_1.Post)(':id/approve'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], ApprovalsController.prototype, "approve", null);
__decorate([
    (0, common_1.Post)(':id/reject'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], ApprovalsController.prototype, "reject", null);
__decorate([
    (0, common_1.Post)(':id/cancel'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ApprovalsController.prototype, "cancel", null);
exports.ApprovalsController = ApprovalsController = __decorate([
    (0, common_1.Controller)('approvals'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [ApprovalsService])
], ApprovalsController);
let ApprovalsModule = class ApprovalsModule {
};
exports.ApprovalsModule = ApprovalsModule;
exports.ApprovalsModule = ApprovalsModule = __decorate([
    (0, common_1.Module)({
        controllers: [ApprovalsController],
        providers: [ApprovalsService],
        exports: [ApprovalsService],
    })
], ApprovalsModule);
//# sourceMappingURL=approvals.module.js.map