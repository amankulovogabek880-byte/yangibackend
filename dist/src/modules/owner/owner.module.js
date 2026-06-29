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
exports.OwnerModule = exports.OwnerController = exports.OwnerService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
const auth_service_1 = require("../auth/auth.service");
const backup_service_1 = require("../backup/backup.service");
const helpers_1 = require("../../common/utils/helpers");
;
const PLANS = ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'];
const STATUSES = ['ACTIVE', 'TRIAL', 'SUSPENDED'];
const PLAN_LIMITS = {
    FREE: { users: 2, clients: 100, bookings: 20 },
    STARTER: { users: 5, clients: 500, bookings: 100 },
    PROFESSIONAL: { users: 20, clients: 5000, bookings: 1000 },
    ENTERPRISE: { users: 999, clients: 999999, bookings: 999999 },
};
let OwnerService = class OwnerService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getStats() {
        const [totalTenants, activeTenants, totalUsers, totalBookings, payments] = await Promise.all([
            this.prisma.tenant.count({ where: { slug: { not: '_platform' } } }),
            this.prisma.tenant.count({ where: { slug: { not: '_platform' }, status: 'ACTIVE' } }),
            this.prisma.user.count({ where: { role: { not: 'PLATFORM_OWNER' } } }),
            this.prisma.booking.count(),
            this.prisma.payment.aggregate({ where: { status: 'COMPLETED' }, _sum: { amount: true } }),
        ]);
        return {
            tenants: totalTenants, activeTenants, users: totalUsers,
            bookings: totalBookings, totalRevenue: payments._sum.amount || 0,
        };
    }
    async getLeaderboard() {
        const [bookingStats, users] = await Promise.all([
            this.prisma.booking.groupBy({
                by: ['agentId'],
                where: { status: { not: 'CANCELLED' }, agentId: { not: null } },
                _count: { id: true },
                _sum: { profit: true, totalPrice: true },
                orderBy: { _sum: { totalPrice: 'desc' } },
                take: 20,
            }),
            this.prisma.user.findMany({
                where: { role: { in: ['AGENT', 'MANAGER'] }, status: 'ACTIVE' },
                select: { id: true, name: true, avatarUrl: true, tenant: { select: { name: true } } },
            }),
        ]);
        const userMap = new Map(users.map((u) => [u.id, u]));
        return bookingStats
            .map((s) => {
            const u = userMap.get(s.agentId);
            if (!u)
                return null;
            return {
                id: u.id, name: u.name, avatarUrl: u.avatarUrl,
                tenantName: u.tenant?.name,
                revenue: Number(s._sum.totalPrice) || 0,
                profit: Number(s._sum.profit) || 0,
                bookings: s._count.id,
            };
        })
            .filter(Boolean)
            .slice(0, 10);
    }
    async getCompanies() {
        const tenants = await this.prisma.tenant.findMany({
            where: { slug: { not: '_platform' } },
            include: {
                _count: { select: { users: true, clients: true, bookings: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        return tenants;
    }
    async getCompany(id) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id },
            include: {
                users: { select: { id: true, name: true, email: true, role: true, status: true } },
                _count: { select: { users: true, clients: true, bookings: true, payments: true } },
            },
        });
        if (!tenant)
            throw new common_1.NotFoundException('Topilmadi');
        return tenant;
    }
    async createCompany(data) {
        if (!data.name?.trim())
            throw new common_1.BadRequestException('name majburiy');
        if (!data.slug?.trim())
            throw new common_1.BadRequestException('slug majburiy');
        if (!data.adminEmail?.trim())
            throw new common_1.BadRequestException('adminEmail majburiy');
        if (!data.adminName?.trim())
            throw new common_1.BadRequestException('adminName majburiy');
        if (!data.adminPassword || data.adminPassword.length < 8) {
            throw new common_1.BadRequestException("Parol kamida 8 belgi bo'lishi kerak");
        }
        const slug = data.slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');
        if (slug === '_platform')
            throw new common_1.BadRequestException('Bu nomdan foydalanish mumkin emas');
        const adminEmail = data.adminEmail.toLowerCase().trim();
        const slugExists = await this.prisma.tenant.findUnique({ where: { slug } });
        if (slugExists)
            throw new common_1.BadRequestException(`"${slug}" slug allaqachon band`);
        const emailExists = await this.prisma.user.findFirst({ where: { email: adminEmail } });
        if (emailExists)
            throw new common_1.BadRequestException(`Bu email (${adminEmail}) allaqachon mavjud`);
        const plan = (0, helpers_1.safeEnum)(data.plan, PLANS, 'STARTER');
        const limits = PLAN_LIMITS[plan];
        const passwordHash = await (0, auth_service_1.hashPassword)(data.adminPassword);
        const result = await this.prisma.$transaction(async (tx) => {
            const tenant = await tx.tenant.create({
                data: {
                    name: data.name.trim(), slug,
                    status: 'ACTIVE', plan,
                    maxUsers: limits.users,
                    maxClients: limits.clients,
                    maxBookings: limits.bookings,
                    leadAssignmentStrategy: 'ROUND_ROBIN',
                },
            });
            const admin = await tx.user.create({
                data: {
                    tenantId: tenant.id,
                    email: adminEmail,
                    passwordHash,
                    name: data.adminName.trim(),
                    role: 'TENANT_ADMIN',
                    status: 'ACTIVE',
                    mustChangePassword: false,
                },
            });
            return { tenant, adminEmail: admin.email };
        });
        return {
            ...result.tenant,
            adminEmail: result.adminEmail,
            message: `Kompaniya yaratildi. Admin: ${result.adminEmail}`,
        };
    }
    async setStatus(id, status) {
        const s = (0, helpers_1.safeEnum)(status, STATUSES, 'ACTIVE');
        return this.prisma.tenant.update({
            where: { id },
            data: { status: s },
            select: { id: true, name: true, status: true },
        });
    }
    async updateCompany(id, data) {
        const tenant = await this.prisma.tenant.findUnique({ where: { id } });
        if (!tenant)
            throw new common_1.NotFoundException("Kompaniya topilmadi");
        const updateData = {};
        if (data.name?.trim())
            updateData.name = data.name.trim();
        if (data.plan)
            updateData.plan = (0, helpers_1.safeEnum)(data.plan, ['FREE', 'STARTER', 'PRO', 'ENTERPRISE'], 'FREE');
        if (data.timezone)
            updateData.timezone = data.timezone;
        if (data.currency)
            updateData.currency = data.currency;
        if (data.country !== undefined)
            updateData.country = data.country;
        if (data.city !== undefined)
            updateData.city = data.city;
        if (data.phone !== undefined)
            updateData.phone = data.phone;
        if (data.email !== undefined)
            updateData.email = data.email;
        if (data.website !== undefined)
            updateData.website = data.website;
        return this.prisma.tenant.update({
            where: { id },
            data: updateData,
            select: { id: true, name: true, status: true, plan: true },
        });
    }
    async deleteCompany(id) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id },
            include: { _count: { select: { users: true, clients: true, bookings: true } } },
        });
        if (!tenant)
            throw new common_1.NotFoundException("Kompaniya topilmadi");
        const counts = tenant._count;
        await this.prisma.tenant.delete({ where: { id } });
        return {
            ok: true,
            deletedTenant: tenant.name,
            affected: counts,
            message: `Kompaniya "${tenant.name}" o'chirildi. ` +
                `${counts.users} foydalanuvchi, ${counts.clients} klient, ${counts.bookings} booking ham o'chirildi.`,
        };
    }
    async getRecentLogins(limit = 50) {
        const attempts = await this.prisma.loginAttempt.findMany({
            take: Math.min(limit, 100),
            orderBy: { createdAt: 'desc' },
            include: {
                user: {
                    select: {
                        id: true, name: true, email: true, role: true,
                        tenant: { select: { id: true, name: true, slug: true } },
                    },
                },
            },
        });
        return attempts.map((a) => ({
            id: a.id,
            email: a.email,
            ip: a.ip,
            country: a.country,
            success: a.success,
            reason: a.reason,
            userAgent: a.userAgent,
            createdAt: a.createdAt,
            user: a.user ? {
                id: a.user.id,
                name: a.user.name,
                role: a.user.role,
                tenant: a.user.tenant,
            } : null,
        }));
    }
};
exports.OwnerService = OwnerService;
exports.OwnerService = OwnerService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], OwnerService);
let OwnerController = class OwnerController {
    constructor(svc, backup) {
        this.svc = svc;
        this.backup = backup;
    }
    stats() { return this.svc.getStats(); }
    leaderboard() { return this.svc.getLeaderboard(); }
    companies() { return this.svc.getCompanies(); }
    company(id) { return this.svc.getCompany(id); }
    create(body) { return this.svc.createCompany(body); }
    status(id, body) {
        return this.svc.setStatus(id, body.status);
    }
    updateCompany(id, body) {
        return this.svc.updateCompany(id, body);
    }
    deleteCompany(id) {
        return this.svc.deleteCompany(id);
    }
    async triggerBackup() {
        return this.backup.triggerManual();
    }
    recentLogins(limit) {
        return this.svc.getRecentLogins(limit ? parseInt(limit) : 50);
    }
};
exports.OwnerController = OwnerController;
__decorate([
    (0, common_1.Get)('stats'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], OwnerController.prototype, "stats", null);
__decorate([
    (0, common_1.Get)('leaderboard'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], OwnerController.prototype, "leaderboard", null);
__decorate([
    (0, common_1.Get)('companies'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], OwnerController.prototype, "companies", null);
__decorate([
    (0, common_1.Get)('companies/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OwnerController.prototype, "company", null);
__decorate([
    (0, common_1.Post)('companies'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OwnerController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)('companies/:id/status'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], OwnerController.prototype, "status", null);
__decorate([
    (0, common_1.Patch)('companies/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], OwnerController.prototype, "updateCompany", null);
__decorate([
    (0, common_1.Delete)('companies/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OwnerController.prototype, "deleteCompany", null);
__decorate([
    (0, common_1.Post)('backup'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], OwnerController.prototype, "triggerBackup", null);
__decorate([
    (0, common_1.Get)('recent-logins'),
    __param(0, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OwnerController.prototype, "recentLogins", null);
exports.OwnerController = OwnerController = __decorate([
    (0, common_1.Controller)('owner'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('PLATFORM_OWNER'),
    __metadata("design:paramtypes", [OwnerService,
        backup_service_1.BackupService])
], OwnerController);
let OwnerModule = class OwnerModule {
};
exports.OwnerModule = OwnerModule;
exports.OwnerModule = OwnerModule = __decorate([
    (0, common_1.Module)({
        controllers: [OwnerController],
        providers: [OwnerService, backup_service_1.BackupService],
    })
], OwnerModule);
//# sourceMappingURL=owner.module.js.map