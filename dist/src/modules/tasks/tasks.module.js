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
exports.TasksModule = exports.TasksController = exports.TasksService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const helpers_1 = require("../../common/utils/helpers");
const notifications_service_1 = require("../notifications/notifications.service");
;
const STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
let TasksService = class TasksService {
    constructor(prisma, notifications) {
        this.prisma = prisma;
        this.notifications = notifications;
    }
    async list(tenantId, userId, role, params) {
        const { skip, take, page, limit } = (0, helpers_1.paginate)(params.page, params.limit);
        const where = { tenantId };
        if (role === 'AGENT')
            where.assigneeId = userId;
        if (params.status)
            where.status = params.status;
        if (params.assigneeId && role !== 'AGENT')
            where.assigneeId = params.assigneeId;
        if (params.clientId)
            where.clientId = params.clientId;
        if (params.bookingId)
            where.bookingId = params.bookingId;
        if (params.priority)
            where.priority = params.priority;
        const [data, total] = await Promise.all([
            this.prisma.task.findMany({
                where, skip, take,
                include: {
                    creator: { select: { id: true, name: true } },
                    assignee: { select: { id: true, name: true } },
                    client: { select: { id: true, fullName: true } },
                },
                orderBy: [{ status: 'asc' }, { priority: 'desc' }, { dueAt: 'asc' }],
            }),
            this.prisma.task.count({ where }),
        ]);
        return { data, meta: (0, helpers_1.meta)(total, page, limit) };
    }
    async create(tenantId, userId, data) {
        if (!data.title?.trim())
            throw new common_1.BadRequestException('title majburiy');
        const task = await this.prisma.task.create({
            data: {
                tenantId,
                creatorId: userId,
                assigneeId: data.assigneeId || userId,
                clientId: data.clientId,
                bookingId: data.bookingId,
                title: data.title.trim(),
                description: data.description,
                status: (0, helpers_1.safeEnum)(data.status, STATUSES, 'TODO'),
                priority: (0, helpers_1.safeEnum)(data.priority, PRIORITIES, 'MEDIUM'),
                dueAt: data.dueAt ? new Date(data.dueAt) : undefined,
                recurrence: data.recurrence,
                tags: Array.isArray(data.tags) ? data.tags : [],
            },
        });
        if (task.assigneeId !== userId) {
            await this.notifications.create({
                tenantId,
                userId: task.assigneeId,
                type: 'TASK_ASSIGNED',
                title: '📋 Sizga vazifa tayinlandi',
                body: task.title,
                link: `/tasks?id=${task.id}`,
                metadata: { taskId: task.id },
            }).catch(() => { });
        }
        return task;
    }
    async update(tenantId, id, userId, role, data) {
        const t = await this.prisma.task.findFirst({ where: { id, tenantId } });
        if (!t)
            throw new common_1.NotFoundException('Topilmadi');
        if (role === 'AGENT' && t.assigneeId !== userId && t.creatorId !== userId) {
            throw new common_1.NotFoundException('Topilmadi');
        }
        const { id: _, tenantId: _t, creatorId: _c, createdAt: _ca, ...safe } = data;
        if (safe.dueAt)
            safe.dueAt = new Date(safe.dueAt);
        if (safe.status)
            safe.status = (0, helpers_1.safeEnum)(safe.status, STATUSES, t.status);
        if (safe.priority)
            safe.priority = (0, helpers_1.safeEnum)(safe.priority, PRIORITIES, t.priority);
        if (safe.status === 'DONE' && !t.completedAt)
            safe.completedAt = new Date();
        const updated = await this.prisma.task.update({ where: { id }, data: (0, helpers_1.clean)(safe) });
        if (safe.status === 'DONE' && t.status !== 'DONE' && t.creatorId && t.creatorId !== userId) {
            await this.notifications.create({
                tenantId, userId: t.creatorId,
                type: 'TASK_ASSIGNED',
                title: '✅ Vazifa bajarildi',
                body: t.title,
                link: t.clientId ? `/clients/${t.clientId}` : '/tasks',
                metadata: { taskId: id },
            }).catch(() => { });
        }
        if (safe.status === 'IN_PROGRESS' && t.status === 'TODO' && t.assigneeId && t.assigneeId !== userId) {
            await this.notifications.create({
                tenantId, userId: t.assigneeId,
                type: 'TASK_ASSIGNED',
                title: '🔄 Vazifa boshlandi',
                body: t.title,
                metadata: { taskId: id },
            }).catch(() => { });
        }
        return updated;
    }
    async delete(tenantId, id, userId, role) {
        const t = await this.prisma.task.findFirst({ where: { id, tenantId } });
        if (!t)
            throw new common_1.NotFoundException('Topilmadi');
        if (role === 'AGENT' && t.creatorId !== userId) {
            throw new common_1.BadRequestException("Faqat o'zingiz yaratgan vazifani o'chira olasiz");
        }
        await this.prisma.task.delete({ where: { id } });
        return { ok: true };
    }
};
exports.TasksService = TasksService;
exports.TasksService = TasksService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_service_1.NotificationsService])
], TasksService);
let TasksController = class TasksController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, status, assigneeId, clientId, bookingId, priority, page, limit) {
        return this.svc.list(u.tenantId, u.sub, u.role, {
            status, assigneeId, clientId, bookingId, priority, page, limit,
        });
    }
    create(body, u) {
        return this.svc.create(u.tenantId, u.sub, body);
    }
    update(id, body, u) {
        return this.svc.update(u.tenantId, id, u.sub, u.role, body);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, id, u.sub, u.role);
    }
    changeStatus(id, body, u) {
        return this.svc.update(u.tenantId, id, u.sub, u.role, { status: body.status });
    }
    async board(u, assigneeId) {
        const result = await this.svc.list(u.tenantId, u.sub, u.role, {
            assigneeId, page: 1, limit: 500,
        });
        const tasks = result.data || [];
        const statuses = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
        const board = {};
        statuses.forEach((s) => (board[s] = []));
        tasks.forEach((t) => {
            if (board[t.status])
                board[t.status].push(t);
        });
        return board;
    }
};
exports.TasksController = TasksController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('status')),
    __param(2, (0, common_1.Query)('assigneeId')),
    __param(3, (0, common_1.Query)('clientId')),
    __param(4, (0, common_1.Query)('bookingId')),
    __param(5, (0, common_1.Query)('priority')),
    __param(6, (0, common_1.Query)('page')),
    __param(7, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, String, Object, Object]),
    __metadata("design:returntype", void 0)
], TasksController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TasksController.prototype, "create", null);
__decorate([
    (0, common_1.Put)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], TasksController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], TasksController.prototype, "delete", null);
__decorate([
    (0, common_1.Patch)(':id/status'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], TasksController.prototype, "changeStatus", null);
__decorate([
    (0, common_1.Get)('board'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('assigneeId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], TasksController.prototype, "board", null);
exports.TasksController = TasksController = __decorate([
    (0, common_1.Controller)('tasks'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [TasksService])
], TasksController);
let TasksModule = class TasksModule {
};
exports.TasksModule = TasksModule;
exports.TasksModule = TasksModule = __decorate([
    (0, common_1.Module)({
        controllers: [TasksController],
        providers: [TasksService],
    })
], TasksModule);
//# sourceMappingURL=tasks.module.js.map