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
exports.UsersModule = exports.UsersController = exports.UsersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
;
const auth_service_1 = require("../auth/auth.service");
const ALLOWED_CREATE_ROLES = ['AGENT', 'MANAGER', 'ACCOUNTANT'];
const ALLOWED_EDIT_ROLES = ['TENANT_ADMIN', 'MANAGER', 'AGENT', 'ACCOUNTANT'];
let UsersService = class UsersService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findAll(tenantId) {
        return this.prisma.user.findMany({
            where: { tenantId, role: { not: 'PLATFORM_OWNER' } },
            select: {
                id: true, name: true, email: true, role: true, phone: true,
                status: true, avatarUrl: true, twoFactorEnabled: true,
                totalBookings: true, totalRevenue: true, totalClients: true,
                conversionRate: true,
                lastLoginAt: true, lastSeenAt: true, createdAt: true,
                _count: { select: { assignedClients: true, bookings: true } },
            },
            orderBy: [{ status: 'asc' }, { name: 'asc' }],
        });
    }
    async getTeam(tenantId) {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { agentCommissionPercent: true, currency: true },
        });
        const users = await this.prisma.user.findMany({
            where: { tenantId, role: { not: 'PLATFORM_OWNER' } },
            select: {
                id: true, name: true, email: true, role: true, phone: true,
                status: true, avatarUrl: true, callbackPhone: true, extension: true,
                lastLoginAt: true, createdAt: true,
            },
            orderBy: [{ role: 'asc' }, { name: 'asc' }],
        });
        const result = await Promise.all(users.map(async (u) => {
            const [leadsCount, bookingsCount, monthBookings] = await Promise.all([
                this.prisma.client.count({ where: { tenantId, assignedAgentId: u.id } }),
                this.prisma.booking.count({
                    where: { tenantId, agentId: u.id, status: { not: 'CANCELLED' } },
                }),
                this.prisma.booking.aggregate({
                    where: {
                        tenantId, agentId: u.id,
                        status: { in: ['CONFIRMED', 'COMPLETED'] },
                        createdAt: { gte: monthStart },
                    },
                    _sum: { totalPrice: true, profit: true },
                }),
            ]);
            const monthRevenue = monthBookings._sum.totalPrice || 0;
            const monthProfit = monthBookings._sum.profit || 0;
            const monthSalary = +(monthProfit * (tenant?.agentCommissionPercent || 10) / 100).toFixed(2);
            return {
                ...u,
                stats: {
                    leadsTotal: leadsCount,
                    bookingsTotal: bookingsCount,
                    monthRevenue,
                    monthProfit,
                    monthSalary,
                },
            };
        }));
        return result;
    }
    async findOne(tenantId, id) {
        const user = await this.prisma.user.findFirst({
            where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
            select: {
                id: true, name: true, email: true, role: true, phone: true,
                status: true, avatarUrl: true, language: true,
                totalBookings: true, totalRevenue: true, conversionRate: true,
                lastLoginAt: true, createdAt: true,
                twoFactorEnabled: true,
                callbackPhone: true, extension: true,
            },
        });
        if (!user)
            throw new common_1.NotFoundException('Topilmadi');
        return user;
    }
    async create(tenantId, creatorRole, data) {
        if (!['TENANT_ADMIN', 'MANAGER'].includes(creatorRole)) {
            throw new common_1.BadRequestException('Sizda yangi agent yaratish huquqi yo\'q');
        }
        if (!data.email?.trim() || !data.password || !data.name?.trim()) {
            throw new common_1.BadRequestException('Email, parol va ism majburiy');
        }
        if (data.password.length < 8) {
            throw new common_1.BadRequestException("Parol kamida 8 belgi bo'lishi kerak");
        }
        const role = ALLOWED_CREATE_ROLES.includes(data.role) ? data.role : 'AGENT';
        if (creatorRole === 'MANAGER' && role !== 'AGENT') {
            throw new common_1.BadRequestException("Manager faqat agent yarata oladi");
        }
        const email = data.email.toLowerCase().trim();
        const exists = await this.prisma.user.findFirst({ where: { tenantId, email } });
        if (exists)
            throw new common_1.ConflictException("Bu email shu kompaniyada allaqachon mavjud");
        const passwordHash = await (0, auth_service_1.hashPassword)(data.password);
        const user = await this.prisma.user.create({
            data: {
                tenantId,
                email,
                passwordHash,
                name: data.name.trim(),
                phone: data.phone?.trim(),
                role,
                status: 'ACTIVE',
                language: data.language || 'UZ',
                mustChangePassword: false,
            },
            select: {
                id: true, name: true, email: true, role: true,
                phone: true, status: true, createdAt: true,
            },
        });
        return user;
    }
    async toggle(tenantId, id) {
        const u = await this.prisma.user.findFirst({
            where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
        });
        if (!u)
            throw new common_1.NotFoundException('Topilmadi');
        return this.prisma.user.update({
            where: { id },
            data: { status: u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
            select: { id: true, status: true },
        });
    }
    async update(tenantId, id, editorRole, data) {
        const u = await this.prisma.user.findFirst({
            where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
        });
        if (!u)
            throw new common_1.NotFoundException('Topilmadi');
        const safe = {};
        if (typeof data.name === 'string')
            safe.name = data.name.trim();
        if (typeof data.phone === 'string')
            safe.phone = data.phone.trim();
        if (typeof data.avatarUrl === 'string')
            safe.avatarUrl = data.avatarUrl;
        if (typeof data.language === 'string' && ['UZ', 'RU', 'EN'].includes(data.language)) {
            safe.language = data.language;
        }
        if (data.role && editorRole === 'TENANT_ADMIN' && ALLOWED_EDIT_ROLES.includes(data.role)) {
            safe.role = data.role;
        }
        if (typeof data.notifyInApp === 'boolean')
            safe.notifyInApp = data.notifyInApp;
        if (typeof data.notifyEmail === 'boolean')
            safe.notifyEmail = data.notifyEmail;
        if (typeof data.notifyTelegram === 'boolean')
            safe.notifyTelegram = data.notifyTelegram;
        if (typeof data.callbackPhone === 'string')
            safe.callbackPhone = data.callbackPhone.trim() || null;
        if (typeof data.extension === 'string')
            safe.extension = data.extension.trim() || null;
        return this.prisma.user.update({
            where: { id },
            data: safe,
            select: {
                id: true, name: true, email: true, role: true, phone: true,
                status: true, language: true, callbackPhone: true, extension: true,
            },
        });
    }
    async delete(tenantId, id, deleterId) {
        if (id === deleterId) {
            throw new common_1.BadRequestException("O'zingizni o'chira olmaysiz");
        }
        const u = await this.prisma.user.findFirst({
            where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
        });
        if (!u)
            throw new common_1.NotFoundException('Topilmadi');
        if (u.role === 'TENANT_ADMIN') {
            const adminCount = await this.prisma.user.count({
                where: { tenantId, role: 'TENANT_ADMIN', status: 'ACTIVE' },
            });
            if (adminCount <= 1) {
                throw new common_1.BadRequestException("Kompaniyada kamida 1 ta admin qolishi kerak");
            }
        }
        await this.prisma.client.updateMany({
            where: { assignedAgentId: id },
            data: { assignedAgentId: null },
        });
        await this.prisma.booking.updateMany({
            where: { agentId: id },
            data: { agentId: null },
        });
        await this.prisma.conversation.updateMany({
            where: { assignedAgentId: id },
            data: { assignedAgentId: null },
        });
        await this.prisma.user.delete({ where: { id } });
        return { ok: true };
    }
    async resetPassword(tenantId, id, newPassword) {
        if (!newPassword || newPassword.length < 8) {
            throw new common_1.BadRequestException("Parol kamida 8 belgi");
        }
        const u = await this.prisma.user.findFirst({
            where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
        });
        if (!u)
            throw new common_1.NotFoundException('Topilmadi');
        const passwordHash = await (0, auth_service_1.hashPassword)(newPassword);
        await this.prisma.user.update({
            where: { id },
            data: {
                passwordHash,
                mustChangePassword: true,
                failedLoginCount: 0,
                lockedUntil: null,
            },
        });
        await this.prisma.userSession.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'password_reset_by_admin' },
        });
        return { ok: true };
    }
    async updateMyTelegramUsername(userId, username) {
        return this.prisma.user.update({
            where: { id: userId },
            data: { telegramUsername: username },
            select: { id: true, name: true, telegramUsername: true },
        });
    }
    async updateMe(userId, data) {
        const safe = {};
        if (typeof data.name === 'string')
            safe.name = data.name.trim();
        if (typeof data.phone === 'string')
            safe.phone = data.phone.trim();
        if (typeof data.avatarUrl === 'string')
            safe.avatarUrl = data.avatarUrl;
        if (typeof data.language === 'string' && ['UZ', 'RU', 'EN'].includes(data.language)) {
            safe.language = data.language;
        }
        if (typeof data.notifyInApp === 'boolean')
            safe.notifyInApp = data.notifyInApp;
        if (typeof data.notifyEmail === 'boolean')
            safe.notifyEmail = data.notifyEmail;
        if (typeof data.notifyTelegram === 'boolean')
            safe.notifyTelegram = data.notifyTelegram;
        if (typeof data.timezone === 'string')
            safe.timezone = data.timezone;
        if (typeof data.callbackPhone === 'string')
            safe.callbackPhone = data.callbackPhone.trim();
        if (typeof data.extension === 'string')
            safe.extension = data.extension.trim();
        return this.prisma.user.update({
            where: { id: userId },
            data: safe,
            select: {
                id: true, name: true, email: true, role: true, phone: true,
                avatarUrl: true, language: true, timezone: true,
                notifyInApp: true, notifyEmail: true, notifyTelegram: true,
                callbackPhone: true, extension: true,
            },
        });
    }
};
exports.UsersService = UsersService;
exports.UsersService = UsersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], UsersService);
let UsersController = class UsersController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u) {
        return this.svc.findAll(u.tenantId);
    }
    team(u) {
        return this.svc.getTeam(u.tenantId);
    }
    me(u) {
        return this.svc.findOne(u.tenantId, u.sub);
    }
    async updateMyTelegram(u, body) {
        if (!body.telegramUsername?.trim())
            throw new common_1.BadRequestException('Username kerak');
        const username = body.telegramUsername.replace('@', '').trim();
        return this.svc.updateMyTelegramUsername(u.id || u.sub, username);
    }
    updateMe(body, u) {
        return this.svc.updateMe(u.sub, body);
    }
    one(id, u) {
        return this.svc.findOne(u.tenantId, id);
    }
    create(body, u) {
        return this.svc.create(u.tenantId, u.role, body);
    }
    update(id, body, u) {
        return this.svc.update(u.tenantId, id, u.role, body);
    }
    toggle(id, u) {
        return this.svc.toggle(u.tenantId, id);
    }
    resetPassword(id, body, u) {
        return this.svc.resetPassword(u.tenantId, id, body.newPassword);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, id, u.sub);
    }
};
exports.UsersController = UsersController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "list", null);
__decorate([
    (0, common_1.Get)('team'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "team", null);
__decorate([
    (0, common_1.Get)('me'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "me", null);
__decorate([
    (0, common_1.Post)('me/telegram'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "updateMyTelegram", null);
__decorate([
    (0, common_1.Patch)('me'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "updateMe", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "one", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "update", null);
__decorate([
    (0, common_1.Patch)(':id/toggle'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "toggle", null);
__decorate([
    (0, common_1.Post)(':id/reset-password'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "resetPassword", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "delete", null);
exports.UsersController = UsersController = __decorate([
    (0, common_1.Controller)('users'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [UsersService])
], UsersController);
let UsersModule = class UsersModule {
};
exports.UsersModule = UsersModule;
exports.UsersModule = UsersModule = __decorate([
    (0, common_1.Module)({
        controllers: [UsersController],
        providers: [UsersService],
        exports: [UsersService],
    })
], UsersModule);
//# sourceMappingURL=users.module.js.map