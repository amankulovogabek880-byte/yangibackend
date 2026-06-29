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
exports.AutomationsModule = exports.AutomationsController = exports.AutomationsService = void 0;
const common_1 = require("@nestjs/common");
const event_emitter_1 = require("@nestjs/event-emitter");
const event_emitter_2 = require("@nestjs/event-emitter");
const prisma_service_1 = require("../../prisma/prisma.service");
const notifications_service_1 = require("../notifications/notifications.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
const helpers_1 = require("../../common/utils/helpers");
;
const TRIGGERS = [
    'LEAD_CREATED', 'STAGE_CHANGED', 'BOOKING_CREATED', 'PAYMENT_RECEIVED',
    'NO_RESPONSE_24H', 'NO_RESPONSE_7D', 'TAG_ADDED', 'CALL_MISSED',
];
let AutomationsService = class AutomationsService {
    constructor(prisma, eventEmitter, notifications) {
        this.prisma = prisma;
        this.eventEmitter = eventEmitter;
        this.notifications = notifications;
    }
    async executeAutomation(tenantId, trigger, context) {
        try {
            const automations = await this.prisma.automation.findMany({
                where: { tenantId, trigger: trigger, isActive: true },
            });
            for (const automation of automations) {
                const actions = Array.isArray(automation.actions) ? automation.actions : [];
                for (const action of actions) {
                    try {
                        if (action.type === 'SEND_NOTIFICATION') {
                            const targetId = context.assignedAgentId || context.userId;
                            if (targetId) {
                                await this.notifications.create({
                                    tenantId, userId: targetId, type: 'SYSTEM',
                                    title: action.title || 'Avtomatik bildirishnoma',
                                    body: action.message || '',
                                    link: context.clientId ? `/clients/${context.clientId}` : undefined,
                                    metadata: { automationId: automation.id, trigger },
                                });
                            }
                        }
                        else if (action.type === 'CHANGE_STAGE') {
                            if (context.clientId && action.stage) {
                                await this.prisma.client.update({
                                    where: { id: context.clientId },
                                    data: { pipelineStage: action.stage },
                                });
                            }
                        }
                        else if (action.type === 'ASSIGN_AGENT') {
                            if (context.clientId && action.agentId) {
                                await this.prisma.client.update({
                                    where: { id: context.clientId },
                                    data: { assignedAgentId: action.agentId },
                                });
                            }
                        }
                        else if (action.type === 'CREATE_TASK') {
                            if (context.clientId) {
                                await this.prisma.task.create({
                                    data: {
                                        tenantId,
                                        title: action.title || 'Avtomatik vazifa',
                                        clientId: context.clientId,
                                        assigneeId: context.assignedAgentId || null,
                                        creatorId: context.assignedAgentId || null,
                                        dueAt: action.dueDays ? new Date(Date.now() + action.dueDays * 86400000) : null,
                                        priority: action.priority || 'MEDIUM',
                                        status: 'TODO',
                                    },
                                });
                            }
                        }
                    }
                    catch (ae) {
                        console.error(`[Automation] action error [${automation.id}]:`, ae?.message);
                    }
                }
                await this.prisma.automation.update({
                    where: { id: automation.id },
                    data: { runCount: { increment: 1 }, lastRunAt: new Date() },
                });
            }
        }
        catch (e) {
            console.error(`[Automation] executor error [${trigger}]:`, e?.message);
        }
    }
    async onLeadCreated(p) {
        await this.executeAutomation(p.tenantId, 'LEAD_CREATED', p);
    }
    async onStageChanged(p) {
        await this.executeAutomation(p.tenantId, 'STAGE_CHANGED', p);
    }
    async onBookingCreated(p) {
        await this.executeAutomation(p.tenantId, 'BOOKING_CREATED', p);
    }
    async onPaymentReceived(p) {
        await this.executeAutomation(p.tenantId, 'PAYMENT_RECEIVED', p);
    }
    async list(tenantId) {
        return this.prisma.automation.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
        });
    }
    async findOne(tenantId, id) {
        const a = await this.prisma.automation.findFirst({ where: { id, tenantId } });
        if (!a)
            throw new common_1.NotFoundException('Topilmadi');
        return a;
    }
    async create(tenantId, data) {
        if (!data.name?.trim())
            throw new common_1.BadRequestException('name majburiy');
        if (!Array.isArray(data.actions) || !data.actions.length) {
            throw new common_1.BadRequestException('actions kerak');
        }
        return this.prisma.automation.create({
            data: {
                tenantId,
                name: data.name.trim(),
                trigger: (0, helpers_1.safeEnum)(data.trigger, TRIGGERS, 'LEAD_CREATED'),
                conditions: data.conditions || {},
                actions: data.actions,
                isActive: data.isActive ?? true,
            },
        });
    }
    async update(tenantId, id, data) {
        await this.findOne(tenantId, id);
        const { id: _, tenantId: _t, runCount: _r, lastRunAt: _l, ...safe } = data;
        if (safe.trigger)
            safe.trigger = (0, helpers_1.safeEnum)(safe.trigger, TRIGGERS, 'LEAD_CREATED');
        return this.prisma.automation.update({ where: { id }, data: safe });
    }
    async delete(tenantId, id) {
        await this.findOne(tenantId, id);
        await this.prisma.automation.delete({ where: { id } });
        return { ok: true };
    }
    async toggle(tenantId, id) {
        const a = await this.findOne(tenantId, id);
        return this.prisma.automation.update({
            where: { id }, data: { isActive: !a.isActive },
        });
    }
};
exports.AutomationsService = AutomationsService;
__decorate([
    (0, event_emitter_1.OnEvent)('lead.created'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AutomationsService.prototype, "onLeadCreated", null);
__decorate([
    (0, event_emitter_1.OnEvent)('stage.changed'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AutomationsService.prototype, "onStageChanged", null);
__decorate([
    (0, event_emitter_1.OnEvent)('booking.created'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AutomationsService.prototype, "onBookingCreated", null);
__decorate([
    (0, event_emitter_1.OnEvent)('payment.received'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AutomationsService.prototype, "onPaymentReceived", null);
exports.AutomationsService = AutomationsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        event_emitter_2.EventEmitter2,
        notifications_service_1.NotificationsService])
], AutomationsService);
let AutomationsController = class AutomationsController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u) {
        return this.svc.list(u.tenantId);
    }
    one(id, u) {
        return this.svc.findOne(u.tenantId, id);
    }
    create(body, u) {
        return this.svc.create(u.tenantId, body);
    }
    update(id, body, u) {
        return this.svc.update(u.tenantId, id, body);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, id);
    }
    toggle(id, u) {
        return this.svc.toggle(u.tenantId, id);
    }
};
exports.AutomationsController = AutomationsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AutomationsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], AutomationsController.prototype, "one", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], AutomationsController.prototype, "create", null);
__decorate([
    (0, common_1.Put)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], AutomationsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], AutomationsController.prototype, "delete", null);
__decorate([
    (0, common_1.Post)(':id/toggle'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], AutomationsController.prototype, "toggle", null);
exports.AutomationsController = AutomationsController = __decorate([
    (0, common_1.Controller)('automations'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __metadata("design:paramtypes", [AutomationsService])
], AutomationsController);
let AutomationsModule = class AutomationsModule {
};
exports.AutomationsModule = AutomationsModule;
exports.AutomationsModule = AutomationsModule = __decorate([
    (0, common_1.Module)({
        imports: [],
        controllers: [AutomationsController],
        providers: [AutomationsService],
        exports: [AutomationsService],
    })
], AutomationsModule);
//# sourceMappingURL=automations.module.js.map