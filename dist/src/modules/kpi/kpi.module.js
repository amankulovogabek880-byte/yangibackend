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
exports.KpiModule = exports.KpiController = exports.KpiService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const helpers_1 = require("../../common/utils/helpers");
;
const METRICS = ['REVENUE', 'BOOKINGS', 'NEW_CLIENTS', 'CONVERSIONS', 'CALLS', 'MESSAGES', 'TASKS_COMPLETED'];
const PERIODS = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'];
let KpiService = class KpiService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getTiers(tenantId) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { kpiTiers: true },
        });
        if (!tenant)
            throw new common_1.BadRequestException('Tenant topilmadi');
        try {
            const tiers = Array.isArray(tenant.kpiTiers)
                ? tenant.kpiTiers
                : JSON.parse(tenant.kpiTiers || '[]');
            return (tiers || []).sort((a, b) => a.minRevenue - b.minRevenue);
        }
        catch {
            return [];
        }
    }
    async saveTiers(tenantId, tiers) {
        if (!Array.isArray(tiers) || tiers.length === 0) {
            throw new common_1.BadRequestException('Kamita 1 ta tier bo\'lishi kerak');
        }
        const sorted = [...tiers].sort((a, b) => a.minRevenue - b.minRevenue);
        for (let i = 0; i < sorted.length; i++) {
            const tier = sorted[i];
            if (tier.minRevenue < 0 || tier.commissionPercent < 0 || tier.commissionPercent > 100) {
                throw new common_1.BadRequestException(`Tier ${i + 1}: Noto'g'ri qiymatlar`);
            }
            if (i > 0) {
                const prev = sorted[i - 1];
                if (prev.maxRevenue !== null && prev.maxRevenue !== tier.minRevenue) {
                    throw new common_1.BadRequestException(`Tier ${i + 1}: Gap detected`);
                }
            }
            if (i === sorted.length - 1) {
                tier.maxRevenue = null;
            }
        }
        await this.prisma.tenant.update({
            where: { id: tenantId },
            data: { kpiTiers: sorted },
        });
        return sorted;
    }
    calculateCommission(revenue, tiers) {
        if (!Array.isArray(tiers) || tiers.length === 0) {
            return { percent: 0, amount: 0 };
        }
        const sorted = (tiers || []).sort((a, b) => a.minRevenue - b.minRevenue);
        for (const tier of sorted) {
            const inRange = revenue >= tier.minRevenue &&
                (tier.maxRevenue === null || revenue < tier.maxRevenue);
            if (inRange) {
                return {
                    percent: tier.commissionPercent,
                    amount: Math.round((revenue * tier.commissionPercent) / 100),
                };
            }
        }
        const lastTier = sorted[sorted.length - 1];
        return {
            percent: lastTier?.commissionPercent || 0,
            amount: Math.round((revenue * (lastTier?.commissionPercent || 0)) / 100),
        };
    }
    async list(tenantId, userId, role) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.OR = [{ userId }, { userId: null }];
        else if (userId)
            where.userId = userId;
        return this.prisma.kpi.findMany({
            where,
            include: { user: { select: { id: true, name: true } } },
            orderBy: [{ endDate: 'desc' }],
        });
    }
    async create(tenantId, actorRole, data) {
        if (!['TENANT_ADMIN', 'MANAGER'].includes(actorRole)) {
            throw new common_1.BadRequestException("Ruxsat yo'q");
        }
        if (!data.target || data.target <= 0) {
            throw new common_1.BadRequestException('Target musbat bo\'lishi kerak');
        }
        return this.prisma.kpi.create({
            data: {
                tenantId,
                userId: data.userId || null,
                metric: (0, helpers_1.safeEnum)(data.metric, METRICS, 'REVENUE'),
                period: (0, helpers_1.safeEnum)(data.period, PERIODS, 'MONTHLY'),
                target: Number(data.target),
                bonus: data.bonus ? Number(data.bonus) : undefined,
                startDate: new Date(data.startDate),
                endDate: new Date(data.endDate),
                notes: data.notes,
            },
        });
    }
    async update(tenantId, actorRole, id, data) {
        if (!['TENANT_ADMIN', 'MANAGER'].includes(actorRole)) {
            throw new common_1.BadRequestException("Ruxsat yo'q");
        }
        const kpi = await this.prisma.kpi.findFirst({ where: { id, tenantId } });
        if (!kpi)
            throw new common_1.NotFoundException('KPI topilmadi');
        const { id: _i, tenantId: _t, ...safe } = data;
        if (safe.startDate)
            safe.startDate = new Date(safe.startDate);
        if (safe.endDate)
            safe.endDate = new Date(safe.endDate);
        if (safe.metric)
            safe.metric = (0, helpers_1.safeEnum)(safe.metric, METRICS, kpi.metric);
        if (safe.period)
            safe.period = (0, helpers_1.safeEnum)(safe.period, PERIODS, kpi.period);
        if (safe.target)
            safe.target = Number(safe.target);
        return this.prisma.kpi.update({ where: { id }, data: safe });
    }
    async delete(tenantId, actorRole, id) {
        if (!['TENANT_ADMIN', 'MANAGER'].includes(actorRole)) {
            throw new common_1.BadRequestException("Ruxsat yo'q");
        }
        await this.prisma.kpi.deleteMany({ where: { id, tenantId } });
        return { ok: true };
    }
    async progress(tenantId, kpiId) {
        const kpi = await this.prisma.kpi.findFirst({ where: { id: kpiId, tenantId } });
        if (!kpi)
            throw new common_1.NotFoundException('KPI topilmadi');
        const start = kpi.startDate, end = kpi.endDate;
        let actual = 0;
        if (kpi.metric === 'REVENUE') {
            const r = await this.prisma.payment.aggregate({
                where: {
                    tenantId, status: 'COMPLETED',
                    paidAt: { gte: start, lte: end },
                    ...(kpi.userId ? { booking: { agentId: kpi.userId } } : {}),
                },
                _sum: { amount: true },
            });
            actual = r._sum.amount || 0;
        }
        else if (kpi.metric === 'BOOKINGS') {
            actual = await this.prisma.booking.count({
                where: {
                    tenantId, createdAt: { gte: start, lte: end },
                    status: { not: 'CANCELLED' },
                    ...(kpi.userId ? { agentId: kpi.userId } : {}),
                },
            });
        }
        else if (kpi.metric === 'NEW_CLIENTS') {
            actual = await this.prisma.client.count({
                where: {
                    tenantId, createdAt: { gte: start, lte: end },
                    ...(kpi.userId ? { assignedAgentId: kpi.userId } : {}),
                },
            });
        }
        else if (kpi.metric === 'CONVERSIONS') {
            const leadsWhere = { tenantId, createdAt: { gte: start, lte: end } };
            if (kpi.userId)
                leadsWhere.assignedAgentId = kpi.userId;
            const leads = await this.prisma.client.count({ where: leadsWhere });
            const converted = await this.prisma.client.count({
                where: { ...leadsWhere, totalBookings: { gt: 0 } },
            });
            actual = leads > 0 ? (converted / leads) * 100 : 0;
        }
        else if (kpi.metric === 'CALLS') {
            actual = await this.prisma.call.count({
                where: {
                    tenantId, createdAt: { gte: start, lte: end },
                    ...(kpi.userId ? { agentId: kpi.userId } : {}),
                },
            });
        }
        else if (kpi.metric === 'TASKS_COMPLETED') {
            actual = await this.prisma.task.count({
                where: {
                    tenantId, status: 'DONE', completedAt: { gte: start, lte: end },
                    ...(kpi.userId ? { assigneeId: kpi.userId } : {}),
                },
            });
        }
        const pct = kpi.target > 0 ? Math.min(200, Math.round((actual / kpi.target) * 100)) : 0;
        return { kpi, actual, progressPct: pct, isMet: actual >= kpi.target };
    }
};
exports.KpiService = KpiService;
exports.KpiService = KpiService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], KpiService);
let KpiController = class KpiController {
    constructor(svc) {
        this.svc = svc;
    }
    getTiers(u) {
        return this.svc.getTiers(u.tenantId);
    }
    saveTiers(u, body) {
        if (!['TENANT_ADMIN', 'OWNER'].includes(u.role)) {
            throw new common_1.BadRequestException('Ruxsat yo\'q');
        }
        return this.svc.saveTiers(u.tenantId, body.tiers);
    }
    list(u, userId) {
        return this.svc.list(u.tenantId, userId || u.sub, u.role);
    }
    progress(id, u) {
        return this.svc.progress(u.tenantId, id);
    }
    create(body, u) {
        return this.svc.create(u.tenantId, u.role, body);
    }
    update(id, body, u) {
        return this.svc.update(u.tenantId, u.role, id, body);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, u.role, id);
    }
};
exports.KpiController = KpiController;
__decorate([
    (0, common_1.Get)('tiers'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], KpiController.prototype, "getTiers", null);
__decorate([
    (0, common_1.Put)('tiers'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], KpiController.prototype, "saveTiers", null);
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('userId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], KpiController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(':id/progress'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], KpiController.prototype, "progress", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], KpiController.prototype, "create", null);
__decorate([
    (0, common_1.Put)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], KpiController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], KpiController.prototype, "delete", null);
exports.KpiController = KpiController = __decorate([
    (0, common_1.Controller)('kpi'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [KpiService])
], KpiController);
let KpiModule = class KpiModule {
};
exports.KpiModule = KpiModule;
exports.KpiModule = KpiModule = __decorate([
    (0, common_1.Module)({
        controllers: [KpiController],
        providers: [KpiService],
    })
], KpiModule);
//# sourceMappingURL=kpi.module.js.map