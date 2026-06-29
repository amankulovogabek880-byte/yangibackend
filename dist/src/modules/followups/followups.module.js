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
exports.FollowUpsModule = exports.FollowUpsController = exports.FollowUpsService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const notifications_service_1 = require("../notifications/notifications.service");
let FollowUpsService = class FollowUpsService {
    constructor(prisma, notifications) {
        this.prisma = prisma;
        this.notifications = notifications;
    }
    async list(tenantId, userId, role, params) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.agentId = userId;
        if (params.done !== undefined)
            where.done = params.done === 'true' ? true : params.done === 'false' ? false : undefined;
        if (params.clientId)
            where.clientId = params.clientId;
        return this.prisma.followUp.findMany({
            where,
            include: {
                agent: { select: { id: true, name: true } },
                client: { select: { id: true, fullName: true, phone: true } },
            },
            orderBy: [{ done: 'asc' }, { dueAt: 'asc' }],
            take: 200,
        });
    }
    async create(tenantId, userId, data) {
        if (!data.title?.trim())
            throw new common_1.BadRequestException('Sarlavha majburiy');
        if (!data.dueAt)
            throw new common_1.BadRequestException('Vaqt majburiy');
        const due = new Date(data.dueAt);
        if (isNaN(due.getTime()))
            throw new common_1.BadRequestException("Vaqt noto'g'ri");
        return this.prisma.followUp.create({
            data: {
                tenantId,
                agentId: data.agentId || userId,
                clientId: data.clientId,
                title: data.title.trim(),
                note: data.note,
                dueAt: due,
            },
        });
    }
    async complete(tenantId, userId, role, id) {
        const where = { id, tenantId };
        if (role === 'AGENT')
            where.agentId = userId;
        const fu = await this.prisma.followUp.findFirst({ where });
        if (!fu)
            throw new common_1.NotFoundException("Eslatma topilmadi");
        return this.prisma.followUp.update({
            where: { id }, data: { done: true, doneAt: new Date() },
        });
    }
    async delete(tenantId, userId, role, id) {
        const where = { id, tenantId };
        if (role === 'AGENT')
            where.agentId = userId;
        const fu = await this.prisma.followUp.findFirst({ where });
        if (!fu)
            throw new common_1.NotFoundException("Eslatma topilmadi");
        await this.prisma.followUp.delete({ where: { id } });
        return { ok: true };
    }
    async checkDueFollowUps() {
        const now = new Date();
        const due = await this.prisma.followUp.findMany({
            where: { done: false, dueAt: { lte: now }, notifiedAt: null },
            include: { client: { select: { fullName: true } } },
            take: 100,
        });
        for (const fu of due) {
            try {
                await this.notifications.create({
                    tenantId: fu.tenantId,
                    userId: fu.agentId,
                    type: 'FOLLOWUP_DUE',
                    title: `⏰ Eslatma: ${fu.title}`,
                    body: fu.client ? `${fu.client.fullName} — ${fu.note || ''}`.trim() : fu.note || undefined,
                    link: fu.clientId ? `/clients/${fu.clientId}` : '/followups',
                    metadata: { followUpId: fu.id },
                });
                await this.prisma.followUp.update({
                    where: { id: fu.id }, data: { notifiedAt: now },
                });
            }
            catch { }
        }
    }
};
exports.FollowUpsService = FollowUpsService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_MINUTE),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], FollowUpsService.prototype, "checkDueFollowUps", null);
exports.FollowUpsService = FollowUpsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_service_1.NotificationsService])
], FollowUpsService);
let FollowUpsController = class FollowUpsController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, done, clientId) {
        return this.svc.list(u.tenantId, u.sub, u.role, { done, clientId });
    }
    create(body, u) {
        return this.svc.create(u.tenantId, u.sub, body);
    }
    complete(id, u) {
        return this.svc.complete(u.tenantId, u.sub, u.role, id);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, u.sub, u.role, id);
    }
    async calendar(u, from, to) {
        const fromDate = from ? new Date(from) : new Date();
        const toDate = to ? new Date(to) : (() => {
            const d = new Date(fromDate);
            d.setDate(d.getDate() + 30);
            return d;
        })();
        const where = {
            tenantId: u.tenantId,
            dueAt: { gte: fromDate, lte: toDate },
        };
        if (u.role === 'AGENT')
            where.assigneeId = u.sub;
        const items = await this.svc.prisma.followUp.findMany({
            where,
            include: {
                client: { select: { id: true, fullName: true, phone: true } },
                assignee: { select: { id: true, name: true } },
            },
            orderBy: { dueAt: 'asc' },
        });
        const byDate = {};
        items.forEach((f) => {
            const k = f.dueAt.toISOString().slice(0, 10);
            if (!byDate[k])
                byDate[k] = [];
            byDate[k].push(f);
        });
        return { items, byDate };
    }
};
exports.FollowUpsController = FollowUpsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('done')),
    __param(2, (0, common_1.Query)('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], FollowUpsController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FollowUpsController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id/complete'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], FollowUpsController.prototype, "complete", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], FollowUpsController.prototype, "delete", null);
__decorate([
    (0, common_1.Get)('calendar'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('from')),
    __param(2, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], FollowUpsController.prototype, "calendar", null);
exports.FollowUpsController = FollowUpsController = __decorate([
    (0, common_1.Controller)('followups'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [FollowUpsService])
], FollowUpsController);
let FollowUpsModule = class FollowUpsModule {
};
exports.FollowUpsModule = FollowUpsModule;
exports.FollowUpsModule = FollowUpsModule = __decorate([
    (0, common_1.Module)({
        controllers: [FollowUpsController],
        providers: [FollowUpsService],
    })
], FollowUpsModule);
//# sourceMappingURL=followups.module.js.map