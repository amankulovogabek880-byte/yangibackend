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
exports.RoundRobinModule = exports.RoundRobinController = exports.RoundRobinService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
const notifications_service_1 = require("../notifications/notifications.service");
const audit_module_1 = require("../audit/audit.module");
let RoundRobinService = class RoundRobinService {
    constructor(_prisma, notifications, audit) {
        this._prisma = _prisma;
        this.notifications = notifications;
        this.audit = audit;
        this.logger = new common_1.Logger('RoundRobin');
    }
    get prisma() {
        return this._prisma;
    }
    async getNextAgent(tenantId) {
        const agents = await this.prisma.user.findMany({
            where: {
                tenantId,
                status: 'ACTIVE',
                isPausedFromAssignment: false,
                role: { in: ['AGENT', 'MANAGER', 'TENANT_ADMIN'] },
            },
            select: {
                id: true,
                lastAssignedAt: true,
                dailyLeadLimit: true,
            },
        });
        if (!agents || agents.length === 0) {
            this.logger.warn(`[ROUND ROBIN] Tenant: ${tenantId} — faol agent yo'q`);
            return null;
        }
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const available = [];
        for (const agent of agents) {
            if (!agent.dailyLeadLimit) {
                available.push(agent);
                continue;
            }
            const todayCount = await this.prisma.client.count({
                where: {
                    assignedAgentId: agent.id,
                    createdAt: { gte: todayStart },
                },
            });
            if (todayCount < agent.dailyLeadLimit) {
                available.push(agent);
            }
        }
        if (available.length === 0) {
            this.logger.warn(`[ROUND ROBIN] Tenant: ${tenantId} — barcha agentlar kunlik limitga yetdi`);
            return null;
        }
        available.sort((a, b) => {
            const aTime = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
            const bTime = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
            return aTime - bTime;
        });
        const chosen = available[0];
        try {
            await this.prisma.user.update({
                where: { id: chosen.id },
                data: { lastAssignedAt: new Date() },
            });
        }
        catch (err) {
            this.logger.error(`[ROUND ROBIN] lastAssignedAt yangilanmadi agent=${chosen.id}: ${err?.message}`);
        }
        this.logger.log(`[ROUND ROBIN] Tenant: ${tenantId} | Agent: ${chosen.id} | lastAssigned: ${chosen.lastAssignedAt}`);
        return chosen.id;
    }
    async assignNewLead(params) {
        const { tenantId, clientId, clientName, source } = params;
        const agentId = await this.getNextAgent(tenantId);
        if (!agentId) {
            this.logger.warn(`[ROUND ROBIN] Lead: ${clientId} — agent topilmadi, tayinlanmadi`);
            return null;
        }
        try {
            await this.prisma.client.update({
                where: { id: clientId },
                data: { assignedAgentId: agentId },
            });
        }
        catch (err) {
            this.logger.error(`[ROUND ROBIN] client.update xato client=${clientId}: ${err?.message}`);
            return null;
        }
        await this.prisma.clientTimeline.create({
            data: {
                clientId,
                userId: agentId,
                type: 'assigned',
                title: '🎯 Avtomatik tayinlandi (Round Robin)',
                metadata: { autoAssigned: true, source: source || 'SYSTEM' },
            },
        }).catch((err) => {
            this.logger.error(`[ROUND ROBIN] timeline.create xato: ${err?.message}`);
        });
        await this.notifications.create({
            tenantId,
            userId: agentId,
            type: 'CLIENT_ASSIGNED',
            title: `🎯 Yangi lead: ${clientName}`,
            body: `Sizga yangi mijoz avtomatik tayinlandi. Manba: ${source || 'SYSTEM'}`,
            link: `/clients/${clientId}`,
            metadata: { clientId, source, autoAssigned: true },
        }).catch((err) => {
            this.logger.error(`[ROUND ROBIN] notification.create xato: ${err?.message}`);
        });
        this.audit.log({
            tenantId,
            userId: agentId,
            action: 'ASSIGN',
            entity: 'client',
            entityId: clientId,
            metadata: { auto: true, strategy: 'ROUND_ROBIN', source },
        });
        this.logger.log(`[ROUND ROBIN] Lead: ${clientId} | Agent: ${agentId} | Tenant: ${tenantId} | Source: ${source || 'SYSTEM'}`);
        return agentId;
    }
    async assignUnassigned(tenantId) {
        const unassigned = await this.prisma.client.findMany({
            where: { tenantId, assignedAgentId: null },
            select: { id: true, fullName: true, source: true },
            orderBy: { createdAt: 'asc' },
        });
        let assigned = 0;
        let skipped = 0;
        for (const client of unassigned) {
            const agentId = await this.getNextAgent(tenantId);
            if (!agentId) {
                skipped++;
                continue;
            }
            await this.prisma.client.update({
                where: { id: client.id },
                data: { assignedAgentId: agentId },
            }).catch(() => { });
            await this.prisma.clientTimeline.create({
                data: {
                    clientId: client.id,
                    userId: agentId,
                    type: 'assigned',
                    title: '🔄 Qayta tayinlandi (Admin)',
                    metadata: { autoAssigned: true, strategy: 'REASSIGN_ALL' },
                },
            }).catch(() => { });
            this.logger.log(`[ROUND ROBIN] Reassign: Lead=${client.id} → Agent=${agentId}`);
            assigned++;
        }
        return { assigned, skipped };
    }
    async autoAssignClient(tenantId, clientId) {
        const client = await this.prisma.client.findFirst({
            where: { id: clientId, tenantId },
            select: { id: true, fullName: true, source: true },
        });
        if (!client)
            return null;
        return this.assignNewLead({
            tenantId,
            clientId,
            clientName: client.fullName,
            source: client.source,
        });
    }
    async setStrategy(tenantId, strategy) {
        const valid = ['MANUAL', 'ROUND_ROBIN'];
        const s = valid.includes(strategy) ? strategy : 'ROUND_ROBIN';
        return this.prisma.tenant.update({
            where: { id: tenantId },
            data: { leadAssignmentStrategy: s },
        });
    }
    async getStrategy(tenantId) {
        const t = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { leadAssignmentStrategy: true },
        });
        return { strategy: t?.leadAssignmentStrategy || 'ROUND_ROBIN' };
    }
    async getQueue(tenantId) {
        const agents = await this.prisma.user.findMany({
            where: {
                tenantId,
                status: 'ACTIVE',
                role: { in: ['AGENT', 'MANAGER', 'TENANT_ADMIN'] },
            },
            select: {
                id: true,
                name: true,
                avatarUrl: true,
                role: true,
                lastAssignedAt: true,
                isPausedFromAssignment: true,
                dailyLeadLimit: true,
                _count: { select: { assignedClients: true } },
            },
        });
        agents.sort((a, b) => {
            const aTime = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
            const bTime = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
            return aTime - bTime;
        });
        return agents.map((a, idx) => ({
            id: a.id,
            name: a.name,
            avatarUrl: a.avatarUrl,
            role: a.role,
            lastAssignedAt: a.lastAssignedAt,
            isPaused: a.isPausedFromAssignment,
            dailyLeadLimit: a.dailyLeadLimit,
            activeClients: a._count.assignedClients,
            position: idx + 1,
            isNext: idx === 0 && !a.isPausedFromAssignment,
        }));
    }
    async pauseAgent(tenantId, agentId, reason, until) {
        await this.prisma.user.update({
            where: { id: agentId, tenantId },
            data: {
                isPausedFromAssignment: true,
                pausedReason: reason || null,
                pausedUntil: until ? new Date(until) : null,
            },
        });
        return { success: true };
    }
    async unpauseAgent(tenantId, agentId) {
        await this.prisma.user.update({
            where: { id: agentId, tenantId },
            data: {
                isPausedFromAssignment: false,
                pausedReason: null,
                pausedUntil: null,
            },
        });
        return { success: true };
    }
    async setDailyLimit(tenantId, agentId, limit) {
        if (limit < 0)
            throw new common_1.BadRequestException("Limit 0 yoki undan ko'p bo'lishi kerak");
        await this.prisma.user.update({
            where: { id: agentId, tenantId },
            data: { dailyLeadLimit: Math.max(0, limit) },
        });
        return { success: true };
    }
};
exports.RoundRobinService = RoundRobinService;
exports.RoundRobinService = RoundRobinService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_service_1.NotificationsService,
        audit_module_1.AuditService])
], RoundRobinService);
let RoundRobinController = class RoundRobinController {
    constructor(svc) {
        this.svc = svc;
    }
    getStrategy(u) {
        return this.svc.getStrategy(u.tenantId);
    }
    setStrategy(body, u) {
        return this.svc.setStrategy(u.tenantId, body.strategy);
    }
    queue(u) {
        return this.svc.getQueue(u.tenantId);
    }
    assign(clientId, u) {
        return this.svc.autoAssignClient(u.tenantId, clientId);
    }
    assignAll(u) {
        return this.svc.assignUnassigned(u.tenantId);
    }
    pauseAgent(u, agentId, body) {
        return this.svc.pauseAgent(u.tenantId, agentId, body.reason, body.until);
    }
    unpauseAgent(u, agentId) {
        return this.svc.unpauseAgent(u.tenantId, agentId);
    }
    setDailyLimit(u, agentId, body) {
        return this.svc.setDailyLimit(u.tenantId, agentId, body.limit);
    }
};
exports.RoundRobinController = RoundRobinController;
__decorate([
    (0, common_1.Get)('strategy'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], RoundRobinController.prototype, "getStrategy", null);
__decorate([
    (0, common_1.Post)('strategy'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], RoundRobinController.prototype, "setStrategy", null);
__decorate([
    (0, common_1.Get)('queue'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], RoundRobinController.prototype, "queue", null);
__decorate([
    (0, common_1.Post)('assign/:clientId'),
    __param(0, (0, common_1.Param)('clientId')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], RoundRobinController.prototype, "assign", null);
__decorate([
    (0, common_1.Post)('assign-unassigned'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], RoundRobinController.prototype, "assignAll", null);
__decorate([
    (0, common_1.Post)('agents/:agentId/pause'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('agentId')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], RoundRobinController.prototype, "pauseAgent", null);
__decorate([
    (0, common_1.Post)('agents/:agentId/unpause'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('agentId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], RoundRobinController.prototype, "unpauseAgent", null);
__decorate([
    (0, common_1.Patch)('agents/:agentId/daily-limit'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('agentId')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], RoundRobinController.prototype, "setDailyLimit", null);
exports.RoundRobinController = RoundRobinController = __decorate([
    (0, common_1.Controller)('lead-assignment'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [RoundRobinService])
], RoundRobinController);
let RoundRobinModule = class RoundRobinModule {
};
exports.RoundRobinModule = RoundRobinModule;
exports.RoundRobinModule = RoundRobinModule = __decorate([
    (0, common_1.Module)({
        controllers: [RoundRobinController],
        providers: [RoundRobinService],
        exports: [RoundRobinService],
    })
], RoundRobinModule);
//# sourceMappingURL=round-robin.module.js.map