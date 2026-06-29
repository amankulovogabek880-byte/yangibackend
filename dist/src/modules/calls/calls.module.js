"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallsModule = exports.CallsController = exports.CallsService = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const encryption_service_1 = require("../../common/encryption/encryption.service");
const notifications_service_1 = require("../notifications/notifications.service");
const realtime_gateway_1 = require("../realtime/realtime.gateway");
const phone_providers_module_1 = require("../phone-providers/phone-providers.module");
;
let CallsService = class CallsService {
    constructor(prisma, encryption, notifications, realtime, providerFactory) {
        this.prisma = prisma;
        this.encryption = encryption;
        this.notifications = notifications;
        this.realtime = realtime;
        this.providerFactory = providerFactory;
        this.logger = new common_1.Logger('Calls');
    }
    async initiate(tenantId, userId, data) {
        if (!data.toPhone)
            throw new common_1.BadRequestException('Telefon raqami kerak');
        const toMasked = this.encryption.maskPhone(data.toPhone);
        const toRaw = this.encryption.encrypt(data.toPhone);
        const agent = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, callbackPhone: true, extension: true },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent topilmadi');
        let clientName = 'Notanish';
        if (data.clientId) {
            const c = await this.prisma.client.findFirst({
                where: { id: data.clientId, tenantId },
                select: { fullName: true },
            });
            if (c)
                clientName = c.fullName;
        }
        const call = await this.prisma.call.create({
            data: {
                tenantId, agentId: userId,
                clientId: data.clientId, bookingId: data.bookingId,
                toMasked, toRaw,
                direction: 'OUTBOUND', status: 'QUEUED',
            },
        });
        this.realtime.emitToUser(userId, 'call:queued', {
            callId: call.id, clientName, phone: toMasked, clientId: data.clientId,
        });
        const provider = await this.providerFactory.getProvider(tenantId);
        try {
            const result = await provider.initiate({
                toPhone: data.toPhone,
                agentId: userId,
                agentPhone: agent.callbackPhone || undefined,
                agentExtension: agent.extension || undefined,
                clientName,
            });
            await this.prisma.call.update({
                where: { id: call.id },
                data: { providerCallId: result.providerCallId, status: 'INITIATED', startedAt: new Date() },
            });
            if (provider.name === 'STUB') {
                this.logger.warn('STUB provider ishlatilmoqda. ' +
                    'Sozlamalar → Telefon dan OnlinePBX yoki Custom SIP sozlang!');
                this.simulateStubCall(call.id, userId, tenantId);
                this.realtime.emitToUser(userId, 'call:warning', {
                    callId: call.id,
                    message: 'Sinov rejimi: real qongiroq emas. Sozlamalar → Telefon dan provayder sozlang.',
                });
            }
            return {
                id: call.id,
                providerCallId: result.providerCallId,
                providerName: provider.name,
                status: result.status,
                clientAction: result.clientAction,
            };
        }
        catch (e) {
            this.logger.error(`Qongiroq xatosi: ${e.message}`);
            await this.prisma.call.update({
                where: { id: call.id },
                data: { status: 'FAILED', notes: `Xato: ${e.message}` },
            });
            this.realtime.emitToUser(userId, 'call:failed', { callId: call.id, error: e.message });
            throw new common_1.BadRequestException(`Qongiroq xatosi: ${e.message}`);
        }
    }
    async simulateStubCall(callId, userId, tenantId) {
        setTimeout(async () => {
            const c = await this.prisma.call.findUnique({ where: { id: callId } });
            if (!c || c.status === 'COMPLETED')
                return;
            await this.prisma.call.update({ where: { id: callId }, data: { status: 'RINGING' } });
            this.realtime.emitToUser(userId, 'call:status', { callId, status: 'RINGING' });
        }, 2000);
        setTimeout(async () => {
            const c = await this.prisma.call.findUnique({ where: { id: callId } });
            if (!c || c.status === 'COMPLETED')
                return;
            const answered = Math.random() > 0.2;
            if (answered) {
                await this.prisma.call.update({ where: { id: callId }, data: { status: 'IN_PROGRESS' } });
                this.realtime.emitToUser(userId, 'call:status', { callId, status: 'IN_PROGRESS' });
            }
            else {
                await this.prisma.call.update({
                    where: { id: callId },
                    data: { status: 'NO_ANSWER', endedAt: new Date() },
                });
                this.realtime.emitToUser(userId, 'call:status', { callId, status: 'NO_ANSWER' });
            }
        }, 5500);
    }
    async hangup(tenantId, userId, callId) {
        const call = await this.prisma.call.findFirst({
            where: { id: callId, tenantId, agentId: userId },
        });
        if (!call)
            throw new common_1.NotFoundException('Qongiroq topilmadi');
        if (call.status === 'COMPLETED' || call.status === 'CANCELED')
            return call;
        const duration = call.startedAt
            ? Math.round((Date.now() - new Date(call.startedAt).getTime()) / 1000)
            : 0;
        const provider = await this.providerFactory.getProvider(tenantId);
        if (provider.hangup && call.providerCallId) {
            try {
                await provider.hangup(call.providerCallId);
            }
            catch { }
        }
        const updated = await this.prisma.call.update({
            where: { id: callId },
            data: { status: 'COMPLETED', endedAt: new Date(), duration },
        });
        this.realtime.emitToUser(userId, 'call:status', { callId, status: 'COMPLETED', duration });
        return updated;
    }
    async handleWebhook(body) {
        const providerName = this.providerFactory.identifyProvider(body);
        if (!providerName) {
            this.logger.warn(`Webhook: provayder aniqlanmadi - ${JSON.stringify(body).slice(0, 200)}`);
            return { ok: true };
        }
        const tempProvider = providerName === 'ONLINEPBX'
            ? new (await Promise.resolve().then(() => __importStar(require('../phone-providers/onlinepbx.provider')))).OnlinePbxProvider({})
            : new (await Promise.resolve().then(() => __importStar(require('../phone-providers/twilio.provider')))).TwilioProvider({});
        const event = tempProvider.parseWebhook?.(body);
        if (!event)
            return { ok: true };
        const call = await this.prisma.call.findFirst({
            where: { providerCallId: event.providerCallId },
        });
        if (!call) {
            this.logger.warn(`Webhook: call topilmadi ${event.providerCallId}`);
            return { ok: true };
        }
        const statusMap = {
            queued: 'QUEUED', initiated: 'INITIATED', ringing: 'RINGING',
            in_progress: 'IN_PROGRESS', completed: 'COMPLETED',
            busy: 'BUSY', failed: 'FAILED', no_answer: 'NO_ANSWER', canceled: 'CANCELED',
        };
        const newStatus = statusMap[event.status] || call.status;
        const updateData = { status: newStatus };
        if (event.duration && event.duration > 0)
            updateData.duration = event.duration;
        if (event.recordingUrl)
            updateData.recordingUrl = event.recordingUrl;
        if (['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY'].includes(newStatus)) {
            updateData.endedAt = new Date();
        }
        await this.prisma.call.update({ where: { id: call.id }, data: updateData });
        this.realtime.emitToUser(call.agentId, 'call:status', {
            callId: call.id, status: newStatus,
            duration: event.duration,
            recordingUrl: event.recordingUrl,
        });
        if (newStatus === 'NO_ANSWER' || newStatus === 'BUSY') {
            this.notifications.create({
                tenantId: call.tenantId,
                userId: call.agentId,
                type: 'CALL_MISSED',
                title: 'Javob berilmadi',
                body: `Raqam: ${call.toMasked}`,
                link: call.clientId ? `/clients/${call.clientId}` : '/calls',
                metadata: { callId: call.id },
            }).catch(() => { });
        }
        return { ok: true };
    }
    async getActive(userId) {
        return this.prisma.call.findFirst({
            where: {
                agentId: userId,
                status: { in: ['QUEUED', 'INITIATED', 'RINGING', 'IN_PROGRESS'] },
            },
            include: { client: { select: { id: true, fullName: true, phone: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }
    async getStats(tenantId, userId, role) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const where = { tenantId, createdAt: { gte: today } };
        if (role === 'AGENT')
            where.agentId = userId;
        const [total, answered, missed, durSum] = await Promise.all([
            this.prisma.call.count({ where }),
            this.prisma.call.count({ where: { ...where, status: 'COMPLETED' } }),
            this.prisma.call.count({ where: { ...where, status: { in: ['NO_ANSWER', 'BUSY', 'FAILED'] } } }),
            this.prisma.call.aggregate({ where, _sum: { duration: true } }),
        ]);
        const totalDuration = durSum._sum.duration || 0;
        return {
            total, completed: answered, answered, missed, noAnswer: missed,
            totalDuration,
            avgDuration: total > 0 ? Math.round(totalDuration / total) : 0,
            totalMinutes: Math.round(totalDuration / 60),
            answerRate: total > 0 ? Math.round((answered / total) * 100) : 0,
        };
    }
    async addNote(tenantId, userId, callId, notes) {
        const call = await this.prisma.call.findFirst({ where: { id: callId, tenantId } });
        if (!call)
            throw new common_1.NotFoundException();
        if (call.agentId !== userId) {
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            if (!user || !['TENANT_ADMIN', 'MANAGER'].includes(user.role))
                throw new common_1.ForbiddenException();
        }
        return this.prisma.call.update({ where: { id: callId }, data: { notes } });
    }
    async list(tenantId, userId, role, params) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.agentId = userId;
        if (params.clientId)
            where.clientId = params.clientId;
        if (params.status)
            where.status = params.status;
        if (params.direction)
            where.direction = params.direction;
        const limit = Number(params.limit) || 50;
        const skip = ((Number(params.page) || 1) - 1) * limit;
        const [data, total] = await Promise.all([
            this.prisma.call.findMany({
                where,
                include: {
                    agent: { select: { id: true, name: true } },
                    client: { select: { id: true, fullName: true, phone: true } },
                },
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip,
            }),
            this.prisma.call.count({ where }),
        ]);
        return { data, total, page: Number(params.page) || 1, limit };
    }
    async logManual(tenantId, userId, data) {
        return this.prisma.call.create({
            data: {
                tenantId, agentId: userId,
                clientId: data.clientId, bookingId: data.bookingId,
                direction: data.direction || 'OUTBOUND',
                status: 'COMPLETED',
                duration: Number(data.duration) || 0,
                notes: data.notes,
                startedAt: new Date(), endedAt: new Date(),
            },
        });
    }
};
exports.CallsService = CallsService;
exports.CallsService = CallsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService,
        notifications_service_1.NotificationsService,
        realtime_gateway_1.RealtimeGateway,
        phone_providers_module_1.PhoneProviderFactory])
], CallsService);
let CallsController = class CallsController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, clientId, status, direction, page, limit) {
        return this.svc.list(u.tenantId, u.sub, u.role, { clientId, status, direction, page, limit });
    }
    active(u) {
        return this.svc.getActive(u.sub);
    }
    stats(u) {
        return this.svc.getStats(u.tenantId, u.sub, u.role);
    }
    initiate(body, u) {
        return this.svc.initiate(u.tenantId, u.sub, body);
    }
    hangup(id, u) {
        return this.svc.hangup(u.tenantId, u.sub, id);
    }
    note(id, body, u) {
        return this.svc.addNote(u.tenantId, u.sub, id, body.notes);
    }
    log(body, u) {
        return this.svc.logManual(u.tenantId, u.sub, body);
    }
    webhook(body) {
        return this.svc.handleWebhook(body);
    }
};
exports.CallsController = CallsController;
__decorate([
    (0, swagger_1.ApiOperation)({ summary: "Qo'ng'iroqlar tarixi" }),
    (0, common_1.Get)(),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('clientId')),
    __param(2, (0, common_1.Query)('status')),
    __param(3, (0, common_1.Query)('direction')),
    __param(4, (0, common_1.Query)('page')),
    __param(5, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, String]),
    __metadata("design:returntype", void 0)
], CallsController.prototype, "list", null);
__decorate([
    (0, swagger_1.ApiOperation)({ summary: "Joriy faol qo'ng'iroq" }),
    (0, common_1.Get)('active'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], CallsController.prototype, "active", null);
__decorate([
    (0, swagger_1.ApiOperation)({ summary: "Bugungi qo'ng'iroq statistikasi" }),
    (0, common_1.Get)('stats'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], CallsController.prototype, "stats", null);
__decorate([
    (0, swagger_1.ApiOperation)({
        summary: 'Click-to-Call: qongiroq boshlash',
        description: [
            'OnlinePBX orqali chiquvchi qongiroq boshlaydi.',
            '1. Agent extensioniga qongiroq qiladi',
            '2. Agent koteradi',
            '3. Klient raqamiga ulanadi',
            '',
            'Kerakli sozlamalar: Settings -> Telefon -> OnlinePBX',
        ].join('\n'),
    }),
    (0, swagger_1.ApiBody)({
        schema: {
            example: { toPhone: '+998901234567', clientId: 'optional_client_id' },
        },
    }),
    (0, common_1.Post)('initiate'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CallsController.prototype, "initiate", null);
__decorate([
    (0, swagger_1.ApiOperation)({ summary: "Qo'ng'iroqni tugatish" }),
    (0, common_1.Post)(':id/hangup'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], CallsController.prototype, "hangup", null);
__decorate([
    (0, swagger_1.ApiOperation)({ summary: "Qo'ng'iroqqa izoh qo'shish" }),
    (0, common_1.Post)(':id/note'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], CallsController.prototype, "note", null);
__decorate([
    (0, swagger_1.ApiOperation)({ summary: "Qo'ng'iroqni qo'lda yozish" }),
    (0, common_1.Post)('log'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CallsController.prototype, "log", null);
__decorate([
    (0, swagger_1.ApiOperation)({
        summary: 'OnlinePBX / Twilio Webhook',
        description: [
            'OnlinePBX qongiroq holati ozgarganda ushbu endpointni chaqiradi.',
            '',
            'Webhook URL (OnlinePBX kabinetiga kiriting):',
            'POST https://yourdomain.com/api/v1/calls/webhook',
            '',
            'OnlinePBX payload namunasi:',
            '{ "uuid": "xxx", "status": "completed", "duration_seconds": 45, "recording_url": "https://..." }',
        ].join('\n'),
    }),
    (0, swagger_1.ApiBody)({
        schema: {
            example: {
                uuid: 'call-uuid-from-onlinepbx',
                status: 'completed',
                duration_seconds: 45,
                recording_url: 'https://onlinepbx.uz/recordings/xxx.mp3',
            },
        },
    }),
    (0, common_1.Post)('webhook'),
    (0, decorators_1.Public)(),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], CallsController.prototype, "webhook", null);
exports.CallsController = CallsController = __decorate([
    (0, swagger_1.ApiTags)('IP Telefoniya (Calls)'),
    (0, swagger_1.ApiBearerAuth)('JWT'),
    (0, common_1.Controller)('calls'),
    __metadata("design:paramtypes", [CallsService])
], CallsController);
let CallsModule = class CallsModule {
};
exports.CallsModule = CallsModule;
exports.CallsModule = CallsModule = __decorate([
    (0, common_1.Module)({
        imports: [phone_providers_module_1.PhoneProvidersModule],
        controllers: [CallsController],
        providers: [CallsService],
        exports: [CallsService],
    })
], CallsModule);
//# sourceMappingURL=calls.module.js.map