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
exports.PipelineModule = exports.PipelineController = exports.PipelineService = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const schedule_1 = require("@nestjs/schedule");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
;
const STAGE_LABELS_UZ = {
    NEW_LEAD: 'Yangi lid', CONTACTED: 'Aloqa o\'rnatildi',
    INTERESTED: 'Qiziqdi', OFFER_SENT: 'Taklif yuborildi',
    NEGOTIATION: 'Muzokara', DEPOSIT_PAID: 'Avans olindi',
    CONFIRMED: 'Tasdiqlandi', TRAVELING: 'Sayohatda',
    COMPLETED: 'Yakunlandi', LOST: 'Yo\'qotildi',
};
const STAGE_COLORS = {
    NEW_LEAD: '#6366f1', CONTACTED: '#3b82f6', INTERESTED: '#06b6d4',
    OFFER_SENT: '#8b5cf6', NEGOTIATION: '#a855f7', DEPOSIT_PAID: '#22c55e',
    CONFIRMED: '#10b981', TRAVELING: '#84cc16', COMPLETED: '#64748b', LOST: '#dc2626',
};
const TERMINAL_STAGES = ['COMPLETED', 'LOST'];
const AUTO_TRANSITIONS = {
    DID_NOT_COME: 'NEGOTIATION',
};
const V10_STAGE_KEYS = {
    'Yangi lid': 'NEW_LEAD',
    'Aloqa o\'rnatildi': 'CONTACTED',
    'Aloqa o\'rnatilmadi': 'INTERESTED',
    'Taklif yuborildi': 'OFFER_SENT',
    'Qayta aloqa': 'NEGOTIATION',
    'Offisga chaqirildi': 'DEPOSIT_PAID',
    'Keldi': 'CONFIRMED',
    'Kelmadi': 'TRAVELING',
    'Avans to\'landi': 'DEPOSIT_PAID',
    'To\'landi': 'COMPLETED',
    'Yo\'qotildi': 'LOST',
    'Sayohatga ketuvchilar': 'CONFIRMED',
    'Sayohatdagilar': 'TRAVELING',
    'Sayohatdan qaytganlar': 'COMPLETED',
};
let PipelineService = class PipelineService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger('Pipeline');
    }
    async listPipelines(tenantId) {
        const pipelines = await this.prisma.pipeline.findMany({
            where: { tenantId },
            include: { stages: { orderBy: { order: 'asc' } } },
            orderBy: { createdAt: 'asc' },
        });
        return pipelines.map(pl => ({
            ...pl,
            pipelineType: pl.name.includes('Sayohat') || pl.name.includes('Post') || pl.name.includes('POST')
                ? 'POST_SALE' : 'NEW_SALE',
            color: pl.isDefault ? '#3d7eff' : '#10b981',
        }));
    }
    async createPipeline(tenantId, data) {
        const isPost = data.pipelineType === 'POST_SALE';
        const pl = await this.prisma.pipeline.create({
            data: {
                tenantId,
                name: data.name,
                isDefault: false,
            },
        });
        const stages = isPost ? [
            { name: 'Sayohatga ketuvchilar', color: '#6366f1', order: 1 },
            { name: 'Sayohatdagilar', color: '#10b981', order: 2 },
            { name: 'Sayohatdan qaytganlar', color: '#8b5cf6', order: 3, isClosing: true },
        ] : [
            { name: 'Yangi lid', color: '#6366f1', order: 1 },
            { name: 'Aloqa o\'rnatildi', color: '#3b82f6', order: 2 },
            { name: 'Aloqa o\'rnatilmadi', color: '#f97316', order: 3 },
            { name: 'Taklif yuborildi', color: '#8b5cf6', order: 4 },
            { name: 'Qayta aloqa', color: '#06b6d4', order: 5 },
            { name: 'Offisga chaqirildi', color: '#f59e0b', order: 6 },
            { name: 'Keldi', color: '#10b981', order: 7 },
            { name: 'Kelmadi', color: '#ef4444', order: 8 },
            { name: 'Avans to\'landi', color: '#22c55e', order: 9 },
            { name: 'To\'landi', color: '#16a34a', order: 10, isClosing: true },
            { name: 'Yo\'qotildi', color: '#dc2626', order: 11, isLost: true },
        ];
        for (const s of stages) {
            await this.prisma.customStage.create({
                data: {
                    tenantId,
                    pipelineId: pl.id,
                    name: s.name,
                    color: s.color,
                    order: s.order,
                    isClosing: s.isClosing || false,
                    isLost: s.isLost || false,
                },
            });
        }
        return this.prisma.pipeline.findUnique({
            where: { id: pl.id },
            include: { stages: { orderBy: { order: 'asc' } } },
        });
    }
    async updatePipeline(tenantId, id, data) {
        const pl = await this.prisma.pipeline.findFirst({ where: { id, tenantId } });
        if (!pl)
            throw new common_1.NotFoundException('Pipeline topilmadi');
        return this.prisma.pipeline.update({ where: { id }, data: { name: data.name || pl.name } });
    }
    async deletePipeline(tenantId, id) {
        const pl = await this.prisma.pipeline.findFirst({ where: { id, tenantId } });
        if (!pl)
            throw new common_1.NotFoundException('Pipeline topilmadi');
        if (pl.isDefault)
            throw new common_1.BadRequestException('Default pipeline o\'chirilmaydi');
        await this.prisma.pipeline.delete({ where: { id } });
        return { success: true };
    }
    async getBoard(tenantId, userId, role, agentId, pipelineId) {
        const where = { tenantId, status: 'ACTIVE' };
        if (role === 'AGENT')
            where.assignedAgentId = userId;
        else if (agentId)
            where.assignedAgentId = agentId;
        const clients = await this.prisma.client.findMany({
            where,
            include: {
                assignedAgent: { select: { id: true, name: true, avatarUrl: true } },
                _count: { select: { bookings: true, conversations: true, calls: true } },
            },
            orderBy: { pipelineStageAt: 'desc' },
            take: 500,
        });
        if (pipelineId) {
            const pipeline = await this.prisma.pipeline.findFirst({
                where: { id: pipelineId, tenantId },
                include: { stages: { orderBy: { order: 'asc' } } },
            });
            if (!pipeline)
                throw new common_1.NotFoundException('Pipeline topilmadi');
            const columns = (pipeline.stages || []).map((stage) => {
                const stageEnumKey = V10_STAGE_KEYS[stage.name] || null;
                const isFirstStage = (pipeline.stages || []).sort((a, b) => a.order - b.order)[0]?.id === stage.id;
                const stageClients = clients.filter((c) => {
                    if (stageEnumKey)
                        return c.pipelineStage === stageEnumKey;
                    if (c.pipelineStage === 'CUSTOM_' + stage.id)
                        return true;
                    if (isFirstStage && (c.pipelineStage === 'NEW_LEAD' || !clients.some((cl) => (pipeline.stages || []).some((s) => {
                        const k = V10_STAGE_KEYS[s.name];
                        return cl.id === c.id && (cl.pipelineStage === ('CUSTOM_' + s.id) || (k && cl.pipelineStage === k));
                    }))))
                        return true;
                    return false;
                });
                return {
                    stage: {
                        ...stage,
                        stageKey: stageEnumKey || `CUSTOM_${stage.id}`,
                        label: stage.name,
                    },
                    clients: stageClients.map((c) => this.mapClient(c)),
                    count: stageClients.length,
                };
            });
            const pipelineType = pipeline.name.includes('Sayohat') ? 'POST_SALE' : 'NEW_SALE';
            return { pipeline: { ...pipeline, pipelineType, color: pipeline.isDefault ? '#3d7eff' : '#10b981' }, columns };
        }
        const ALL_STAGES = [
            'NEW_LEAD', 'CONTACTED', 'INTERESTED', 'OFFER_SENT',
            'NEGOTIATION', 'DEPOSIT_PAID', 'CONFIRMED', 'TRAVELING',
            'COMPLETED', 'LOST',
        ];
        const stages = ALL_STAGES.map((stage) => ({
            stage,
            label: STAGE_LABELS_UZ[stage] || stage,
            color: STAGE_COLORS[stage] || '#64748b',
            isClosing: TERMINAL_STAGES.includes(stage),
            stageKey: stage,
            clients: clients.filter((c) => c.pipelineStage === stage).map((c) => this.mapClient(c)),
            count: 0,
            totalValue: 0,
        }));
        for (const s of stages) {
            s.count = s.clients.length;
            s.totalValue = s.clients.reduce((sum, c) => sum + (c.totalRevenue || 0), 0);
        }
        try {
            const customStages = await this.prisma.customStage.findMany({
                where: { tenantId },
                orderBy: { order: 'asc' },
            });
            for (const cs of customStages) {
                const stageEnumKey = V10_STAGE_KEYS[cs.name];
                const csClients = clients.filter((c) => c.pipelineStage === `CUSTOM_${cs.id}` ||
                    (stageEnumKey && c.pipelineStage === stageEnumKey)).map((c) => this.mapClient(c));
                stages.push({
                    stage: `CUSTOM_${cs.id}`,
                    customStageId: cs.id,
                    stageKey: stageEnumKey || `CUSTOM_${cs.id}`,
                    label: cs.name,
                    color: cs.color,
                    isClosing: cs.isClosing,
                    clients: csClients,
                    count: csClients.length,
                    totalValue: csClients.reduce((s, c) => s + (c.totalRevenue || 0), 0),
                    isCustom: true,
                });
            }
        }
        catch (e) {
        }
        return { stages };
    }
    mapClient(c) {
        const prefs = c.preferences || {};
        return {
            id: c.id,
            fullName: c.fullName,
            phone: c.phone,
            tier: c.tier,
            leadScore: c.leadScore,
            source: c.source,
            assignedAgent: c.assignedAgent,
            stageEnteredAt: c.pipelineStageAt,
            daysInStage: Math.floor((Date.now() - new Date(c.pipelineStageAt).getTime()) / 86400000),
            tags: c.tags,
            totalRevenue: c.totalRevenue,
            noContactAttempts: prefs.noContactAttempts || 0,
            nextCallAt: prefs.nextCallAt || null,
            travelDepartDate: prefs.travelDepartDate || null,
            travelDestination: prefs.travelDestination || null,
            bookingsCount: c._count.bookings,
            messagesCount: c._count.conversations,
            callsCount: c._count.calls,
            lastContactAt: c.lastContactAt,
        };
    }
    async moveStage(tenantId, userId, role, clientId, data) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        const toStage = data.stage;
        const isCustomStage = toStage.startsWith('CUSTOM_');
        const updateData = {
            pipelineStage: (isCustomStage ? toStage : toStage),
            pipelineStageAt: new Date(),
        };
        if ((toStage === 'LOST' || toStage.includes('LOST')) && data.lostReason) {
            updateData.lostReason = data.lostReason;
        }
        if (toStage === 'INTERESTED') {
            const prefs = client.preferences || {};
            prefs.noContactAttempts = 0;
            prefs.nextCallAt = new Date(Date.now() + 24 * 3600000).toISOString();
            updateData.preferences = prefs;
        }
        await this.prisma.client.update({ where: { id: clientId }, data: updateData });
        await this.prisma.clientTimeline.create({
            data: {
                clientId, userId, type: 'stage_change',
                title: `Bosqich: ${client.pipelineStage} → ${toStage}`,
                description: data.note || null,
                metadata: { from: client.pipelineStage, to: toStage, lostReasonDetail: data.lostReasonDetail },
            },
        }).catch(() => { });
        if (toStage === 'TRAVELING') {
            setTimeout(async () => {
                try {
                    await this.prisma.client.update({
                        where: { id: clientId },
                        data: { pipelineStage: 'NEGOTIATION', pipelineStageAt: new Date() },
                    });
                }
                catch { }
            }, 3000);
        }
        return this.prisma.client.findUnique({ where: { id: clientId } });
    }
    async recordCallAttempt(tenantId, agentId, clientId, data) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        const prefs = client.preferences || {};
        const attempts = (prefs.noContactAttempts || 0) + 1;
        const nextCallAt = data.nextCallAt || new Date(Date.now() + 24 * 3600000).toISOString();
        prefs.noContactAttempts = attempts;
        prefs.nextCallAt = nextCallAt;
        prefs.lastCallOutcome = data.outcome;
        if (!prefs.callHistory)
            prefs.callHistory = [];
        prefs.callHistory.push({ attemptNo: attempts, outcome: data.outcome, note: data.note, at: new Date().toISOString() });
        const updateData = { preferences: prefs };
        if (attempts >= 6 && data.outcome === 'NO_ANSWER') {
            updateData.pipelineStage = 'LOST';
            updateData.lostReason = 'NO_RESPONSE';
            updateData.pipelineStageAt = new Date();
        }
        await this.prisma.client.update({ where: { id: clientId }, data: updateData });
        if (attempts < 6) {
            await this.prisma.task.create({
                data: {
                    tenantId, creatorId: agentId, assigneeId: agentId, clientId,
                    title: `${client.fullName}ga qo'ng'iroq (${attempts}/6)`,
                    priority: 'HIGH', status: 'TODO', dueAt: new Date(nextCallAt),
                },
            }).catch(() => { });
            await this.prisma.notification.create({
                data: {
                    tenantId, userId: agentId, type: 'CALL_REMINDER',
                    title: `${client.fullName}ga qo'ng'iroq (${attempts}/6)`,
                    body: `Keyingi: ${new Date(nextCallAt).toLocaleDateString('uz-UZ')}`,
                    link: `/clients/${clientId}`, metadata: {},
                },
            }).catch(() => { });
        }
        return { attempts, nextCallAt, outcome: data.outcome };
    }
    async getCustomStages(tenantId, pipelineId) {
        const where = { tenantId };
        if (pipelineId)
            where.pipelineId = pipelineId;
        return this.prisma.customStage.findMany({ where, orderBy: { order: 'asc' } });
    }
    async createCustomStage(tenantId, data) {
        let pipelineId = data.pipelineId;
        if (!pipelineId) {
            let pl = await this.prisma.pipeline.findFirst({ where: { tenantId, isDefault: true } });
            if (!pl)
                pl = await this.prisma.pipeline.findFirst({ where: { tenantId } });
            if (!pl)
                throw new common_1.BadRequestException('Pipeline topilmadi');
            pipelineId = pl.id;
        }
        const last = await this.prisma.customStage.findFirst({
            where: { tenantId, pipelineId },
            orderBy: { order: 'desc' },
        });
        return this.prisma.customStage.create({
            data: {
                tenantId, pipelineId, name: data.name,
                color: data.color || '#3d7eff',
                order: data.order ?? ((last?.order ?? 0) + 1),
                isClosing: data.isClosing || false,
            },
        });
    }
    async updateCustomStage(tenantId, id, data) {
        const s = await this.prisma.customStage.findFirst({ where: { id, tenantId } });
        if (!s)
            throw new common_1.NotFoundException();
        return this.prisma.customStage.update({ where: { id }, data: { name: data.name || s.name, color: data.color || s.color, order: data.order ?? s.order } });
    }
    async deleteCustomStage(tenantId, id) {
        const s = await this.prisma.customStage.findFirst({ where: { id, tenantId } });
        if (!s)
            throw new common_1.NotFoundException();
        if (s.isClosing)
            throw new common_1.BadRequestException('Bu bosqich o\'chirilmaydi');
        await this.prisma.customStage.delete({ where: { id } });
        return { success: true };
    }
    async reorderCustomStages(tenantId, orderedIds) {
        await Promise.all(orderedIds.map((id, i) => this.prisma.customStage.updateMany({ where: { id, tenantId }, data: { order: i + 1 } })));
        return this.getCustomStages(tenantId);
    }
    async getHistory(tenantId, clientId) {
        return this.prisma.stageHistory.findMany({
            where: { clientId },
            include: { user: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
    }
    async analytics(tenantId) {
        const groups = await this.prisma.client.groupBy({
            by: ['pipelineStage'],
            where: { tenantId, status: 'ACTIVE' },
            _count: { id: true },
        });
        return { stageDistribution: groups };
    }
    async bulkMove(tenantId, userId, clientIds, stage) {
        await this.prisma.client.updateMany({
            where: { id: { in: clientIds }, tenantId },
            data: { pipelineStage: stage, pipelineStageAt: new Date() },
        });
        return { updated: clientIds.length };
    }
    async travelNotifications() {
        const now = new Date();
        const travelingClients = await this.prisma.client.findMany({
            where: {
                pipelineStage: { in: ['CONFIRMED', 'TRAVELING'] },
                status: 'ACTIVE',
            },
            take: 100,
        });
        for (const c of travelingClients) {
            const prefs = c.preferences || {};
            if (!prefs.travelDepartDate || !c.assignedAgentId)
                continue;
            const depart = new Date(prefs.travelDepartDate);
            const diff = depart.getTime() - now.getTime();
            if (diff > 0 && diff < 25 * 3600000 && !prefs.departureNotified) {
                await this.prisma.notification.create({
                    data: {
                        tenantId: c.tenantId, userId: c.assignedAgentId,
                        type: 'STAGE_CHANGED',
                        title: `${c.fullName} ertaga sayohatga ketadi!`,
                        body: 'Omadli yo\'l tiling.', link: `/clients/${c.id}`, metadata: {},
                    },
                }).catch(() => { });
                await this.prisma.task.create({
                    data: {
                        tenantId: c.tenantId, creatorId: c.assignedAgentId,
                        assigneeId: c.assignedAgentId, clientId: c.id,
                        title: `${c.fullName}ga omadli yo'l tiling`,
                        priority: 'HIGH', status: 'TODO', dueAt: depart,
                    },
                }).catch(() => { });
                await this.prisma.client.update({
                    where: { id: c.id },
                    data: { preferences: { ...prefs, departureNotified: true } },
                }).catch(() => { });
            }
        }
        const noContactClients = await this.prisma.client.findMany({
            where: { pipelineStage: 'INTERESTED', status: 'ACTIVE' },
            take: 100,
        });
        for (const c of noContactClients) {
            const prefs = c.preferences || {};
            if (!prefs.nextCallAt || !c.assignedAgentId)
                continue;
            if (new Date(prefs.nextCallAt) <= now) {
                await this.prisma.notification.create({
                    data: {
                        tenantId: c.tenantId, userId: c.assignedAgentId,
                        type: 'FOLLOWUP_DUE',
                        title: `${c.fullName}ga qo'ng'iroq vaqti!`,
                        body: `${(prefs.noContactAttempts || 0) + 1}/6 urinish`,
                        link: `/clients/${c.id}`, metadata: {},
                    },
                }).catch(() => { });
            }
        }
    }
    async taskReminders() {
        const now = new Date();
        const in15 = new Date(now.getTime() + 15 * 60000);
        const tasks = await this.prisma.task.findMany({
            where: { status: { in: ['TODO', 'IN_PROGRESS'] }, dueAt: { gte: now, lte: in15 } },
            include: { client: { select: { fullName: true } } },
        });
        for (const t of tasks) {
            if (!t.assigneeId)
                continue;
            await this.prisma.notification.create({
                data: {
                    tenantId: t.tenantId, userId: t.assigneeId, type: 'TASK_DUE',
                    title: `Vazifa: ${t.title}`,
                    body: t.client ? `Klient: ${t.client.fullName}` : '15 daqiqa qoldi',
                    link: t.clientId ? `/clients/${t.clientId}` : '/tasks', metadata: {},
                },
            }).catch(() => { });
        }
    }
};
exports.PipelineService = PipelineService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_HOUR),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PipelineService.prototype, "travelNotifications", null);
__decorate([
    (0, schedule_1.Cron)('*/5 * * * *'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PipelineService.prototype, "taskReminders", null);
exports.PipelineService = PipelineService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], PipelineService);
let PipelineController = class PipelineController {
    constructor(svc) {
        this.svc = svc;
    }
    listPipelines(u) { return this.svc.listPipelines(u.tenantId); }
    createPipeline(u, body) { return this.svc.createPipeline(u.tenantId, body); }
    updatePipeline(u, id, body) { return this.svc.updatePipeline(u.tenantId, id, body); }
    deletePipeline(u, id) { return this.svc.deletePipeline(u.tenantId, id); }
    board(u, aid, pid) {
        return this.svc.getBoard(u.tenantId, u.id || u.sub, u.role, aid, pid);
    }
    analytics(u) { return this.svc.analytics(u.tenantId); }
    history(u, id) { return this.svc.getHistory(u.tenantId, id); }
    moveStage(u, id, body) {
        return this.svc.moveStage(u.tenantId, u.id || u.sub, u.role, id, body);
    }
    moveClient(u, id, body) {
        return this.svc.moveStage(u.tenantId, u.id || u.sub, u.role, id, body);
    }
    bulkMove(u, body) {
        return this.svc.bulkMove(u.tenantId, u.id || u.sub, body.clientIds, body.stage);
    }
    callAttempt(u, id, body) {
        return this.svc.recordCallAttempt(u.tenantId, u.id || u.sub, id, body);
    }
    getStages(u, pid) { return this.svc.getCustomStages(u.tenantId, pid); }
    createStage(u, body) { return this.svc.createCustomStage(u.tenantId, body); }
    updateStage(u, id, body) { return this.svc.updateCustomStage(u.tenantId, id, body); }
    deleteStage(u, id) { return this.svc.deleteCustomStage(u.tenantId, id); }
    reorderStages(u, body) {
        return this.svc.reorderCustomStages(u.tenantId, body.orderedIds);
    }
};
exports.PipelineController = PipelineController;
__decorate([
    (0, common_1.Get)('pipelines'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "listPipelines", null);
__decorate([
    (0, common_1.Post)('pipelines'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "createPipeline", null);
__decorate([
    (0, common_1.Patch)('pipelines/:id'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "updatePipeline", null);
__decorate([
    (0, common_1.Delete)('pipelines/:id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "deletePipeline", null);
__decorate([
    (0, common_1.Get)('board'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('agentId')),
    __param(2, (0, common_1.Query)('pipelineId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "board", null);
__decorate([
    (0, common_1.Get)('analytics'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "analytics", null);
__decorate([
    (0, common_1.Get)('client/:id/history'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "history", null);
__decorate([
    (0, common_1.Patch)('client/:id/stage'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "moveStage", null);
__decorate([
    (0, common_1.Patch)('move/:clientId'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('clientId')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "moveClient", null);
__decorate([
    (0, common_1.Post)('bulk-move'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "bulkMove", null);
__decorate([
    (0, common_1.Post)('call-attempt/:clientId'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('clientId')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "callAttempt", null);
__decorate([
    (0, common_1.Get)('stages'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('pipelineId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "getStages", null);
__decorate([
    (0, common_1.Post)('stages'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "createStage", null);
__decorate([
    (0, common_1.Patch)('stages/:id'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "updateStage", null);
__decorate([
    (0, common_1.Delete)('stages/:id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "deleteStage", null);
__decorate([
    (0, common_1.Post)('stages/reorder'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PipelineController.prototype, "reorderStages", null);
exports.PipelineController = PipelineController = __decorate([
    (0, swagger_1.ApiTags)('Pipeline'),
    (0, swagger_1.ApiBearerAuth)('JWT'),
    (0, common_1.Controller)('pipeline'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [PipelineService])
], PipelineController);
let PipelineModule = class PipelineModule {
};
exports.PipelineModule = PipelineModule;
exports.PipelineModule = PipelineModule = __decorate([
    (0, common_1.Module)({
        controllers: [PipelineController],
        providers: [PipelineService],
        exports: [PipelineService],
    })
], PipelineModule);
//# sourceMappingURL=pipeline.module.js.map