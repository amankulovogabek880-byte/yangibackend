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
exports.InstagramModule = exports.InstagramController = exports.InstagramService = void 0;
const round_robin_module_1 = require("../v9/round-robin.module");
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const realtime_gateway_1 = require("../realtime/realtime.gateway");
const botSessionsCache = new Map();
let InstagramService = class InstagramService {
    constructor(prisma, realtime, roundRobin) {
        this.prisma = prisma;
        this.realtime = realtime;
        this.roundRobin = roundRobin;
        this.logger = new common_1.Logger('Instagram');
    }
    async getConfig(tenantId) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { settings: true },
        });
        const s = tenant?.settings || {};
        const defaultSteps = [
            { id: 'name', question: 'Ismingizni yozing', field: 'name' },
            { id: 'destination', question: 'Qayerga sayohat qilmoqchisiz?', field: 'destination' },
            { id: 'phone', question: 'Telefon raqamingizni yozing (+998...)', field: 'phone' },
            { id: 'date', question: 'Qachon ketmoqchisiz?', field: 'date' },
        ];
        return {
            accessToken: s.instagramAccessToken || null,
            pageId: s.instagramPageId || null,
            verifyToken: s.instagramVerifyToken || 'omoncrm_verify',
            botName: s.instagramBotName || 'Travel Bot',
            greetingMessage: s.instagramGreeting || 'Salom! Sizga yordam berishdan mamnunman.',
            farewell: s.instagramFarewell || 'Rahmat! Tez orada siz bilan boglanamiz.',
            assignToAgentId: s.instagramAssignAgentId || null,
            isEnabled: !!s.instagramAccessToken,
            botSteps: s.instagramBotSteps || defaultSteps,
        };
    }
    async saveConfig(tenantId, data) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { settings: true },
        });
        const cur = tenant?.settings || {};
        await this.prisma.tenant.update({
            where: { id: tenantId },
            data: {
                settings: {
                    ...cur,
                    instagramAccessToken: data.accessToken ?? cur.instagramAccessToken,
                    instagramPageId: data.pageId ?? cur.instagramPageId,
                    instagramVerifyToken: data.verifyToken ?? cur.instagramVerifyToken,
                    instagramBotName: data.botName ?? cur.instagramBotName,
                    instagramGreeting: data.greetingMessage ?? cur.instagramGreeting,
                    instagramFarewell: data.farewell ?? cur.instagramFarewell,
                    instagramBotSteps: data.botSteps ?? cur.instagramBotSteps,
                    instagramAssignAgentId: data.assignToAgentId ?? cur.instagramAssignAgentId,
                },
            },
        });
        return this.getConfig(tenantId);
    }
    verifyWebhook(tenantId, mode, token, challenge, verifyToken) {
        if (mode === 'subscribe' && token === (verifyToken || 'omoncrm_verify')) {
            return challenge;
        }
        throw new common_1.BadRequestException('Webhook verification failed');
    }
    async processWebhook(tenantId, body, signature) {
        if (body?.object !== 'instagram')
            return { ok: true };
        if (signature && process.env.NODE_ENV === 'production') {
            const config = await this.getConfig(tenantId);
            if (config.accessToken) {
                try {
                    const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
                    const expected = 'sha256=' + crypto.createHmac('sha256', config.accessToken)
                        .update(JSON.stringify(body)).digest('hex');
                    if (signature !== expected) {
                        this.logger.warn('Instagram webhook: invalid signature');
                        return { ok: false };
                    }
                }
                catch { }
            }
        }
        const entries = body?.entry || [];
        for (const entry of entries) {
            for (const event of (entry?.messaging || [])) {
                if (event?.message && !event.message.is_echo) {
                    await this.handleMessage(tenantId, event).catch((e) => this.logger.error('Instagram msg error: ' + e.message));
                }
            }
        }
        return { ok: true };
    }
    async handleMessage(tenantId, event) {
        const senderId = event.sender?.id;
        const text = (event.message?.text || '').trim();
        if (!senderId || !text)
            return;
        const config = await this.getConfig(tenantId);
        if (!config.isEnabled)
            return;
        const key = senderId + ':' + tenantId;
        let session = botSessionsCache.get(key);
        if (!session) {
            session = await this.getSession(tenantId, senderId);
            if (session)
                botSessionsCache.set(key, session);
        }
        if (!session) {
            session = { step: 'ASK_NAME', instagramUserId: senderId, tenantId, startedAt: new Date() };
            botSessionsCache.set(key, session);
            await this.saveSession(tenantId, senderId, session);
            const steps = config.botSteps || [];
            const firstQ = steps.length > 0 ? String.fromCharCode(10) + steps[0].question : '';
            await this.reply(config.accessToken, senderId, config.greetingMessage + firstQ);
            session.stepIndex = 0;
            await this.saveSession(tenantId, senderId, session);
            return;
        }
        let next = '';
        if (session.step === 'ASK_NAME') {
            session.name = text;
            session.step = 'ASK_DESTINATION';
            await this.saveSession(tenantId, senderId, session);
            next = 'Rahmat ' + text + '! Qayerga sayohat qilmoqchisiz? (Masalan: Dubay, Turkiya, Tailand)';
        }
        else if (session.step === 'ASK_DESTINATION') {
            session.destination = text;
            session.step = 'ASK_PHONE';
            await this.saveSession(tenantId, senderId, session);
            next = 'Ajoyib! Telefon raqamingizni yuboring (+998XXXXXXXXX)';
        }
        else if (session.step === 'ASK_PHONE') {
            session.phone = text;
            session.step = 'ASK_DATE';
            await this.saveSession(tenantId, senderId, session);
            next = 'Qachon ketmoqchisiz? (oy yoki aniq sana kiriting)';
        }
        else if (session.step === 'ASK_DATE') {
            session.date = text;
            session.step = 'DONE';
            next = 'Rahmat ' + (session.name || '') + '! Menejerimiz tez orada siz bilan boglanadi. Yaxshi kun!';
            await this.createLead(tenantId, { ...session }, config);
            botSessionsCache.delete(key);
            await this.deleteSession(tenantId, senderId);
        }
        else {
            botSessionsCache.delete(key);
            await this.deleteSession(tenantId, senderId);
            const fresh = { step: 'ASK_NAME', instagramUserId: senderId, tenantId, startedAt: new Date() };
            botSessionsCache.set(key, fresh);
            next = config.greetingMessage;
        }
        if (next)
            await this.reply(config.accessToken, senderId, next);
    }
    async createLead(tenantId, s, config) {
        let agentId = config.assignToAgentId;
        if (!agentId) {
            agentId = await this.roundRobin.getNextAgent(tenantId);
        }
        if (s.phone) {
            const dup = await this.prisma.client.findFirst({ where: { tenantId, phone: s.phone } });
            if (dup) {
                this.logger.log('Instagram duplicate phone: ' + s.phone);
                return dup;
            }
        }
        const client = await this.prisma.client.create({
            data: {
                tenantId,
                fullName: s.name || 'Instagram foydalanuvchi',
                phone: s.phone || '',
                source: 'INSTAGRAM',
                pipelineStage: 'NEW_LEAD',
                pipelineStageAt: new Date(),
                assignedAgentId: agentId,
                notes: ['Instagram bot orqali keldi', s.destination ? 'Yonalish: ' + s.destination : '', s.date ? 'Sana: ' + s.date : ''].filter(Boolean).join('\n'),
                preferences: {
                    travelDestination: s.destination,
                    travelDateRequest: s.date,
                    instagramUserId: s.instagramUserId,
                },
            },
        });
        await this.prisma.clientTimeline.create({
            data: {
                clientId: client.id,
                type: 'created',
                title: 'Instagram bot orqali yangi lead',
                description: 'Yonalish: ' + s.destination + ' | Tel: ' + s.phone + ' | Sana: ' + s.date,
                metadata: { source: 'instagram_bot', instagramUserId: s.instagramUserId },
            },
        }).catch(() => { });
        if (agentId) {
            this.realtime.emitToUser(agentId, 'lead:new', {
                clientId: client.id, source: 'INSTAGRAM',
                name: s.name, phone: s.phone, destination: s.destination,
            });
        }
        this.realtime.emitToTenant(tenantId, 'lead:new', { clientId: client.id, source: 'INSTAGRAM' });
        this.logger.log('New Instagram lead: ' + client.id + ' - ' + s.name);
        return client;
    }
    async reply(accessToken, recipientId, text) {
        if (!accessToken) {
            this.logger.warn('Instagram: no accessToken');
            return;
        }
        try {
            const res = await fetch('https://graph.facebook.com/v18.0/me/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
                body: JSON.stringify({ recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                this.logger.error('Instagram send failed: ' + JSON.stringify(err));
            }
        }
        catch (e) {
            this.logger.error('Instagram send error: ' + e.message);
        }
    }
    async getSession(tenantId, senderId) {
        try {
            const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
            const sessions = tenant?.settings?.instagramSessions || {};
            return sessions[senderId] || null;
        }
        catch {
            return null;
        }
    }
    async saveSession(tenantId, senderId, session) {
        try {
            const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
            const cur = tenant?.settings || {};
            const sessions = cur.instagramSessions || {};
            sessions[senderId] = { ...session, savedAt: new Date().toISOString() };
            const keys = Object.keys(sessions);
            if (keys.length > 200) {
                const oldest = keys.sort((a, b) => (sessions[a].savedAt || '') < (sessions[b].savedAt || '') ? -1 : 1).slice(0, keys.length - 200);
                oldest.forEach(k => delete sessions[k]);
            }
            await this.prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...cur, instagramSessions: sessions } } });
        }
        catch (e) {
            this.logger.warn('saveSession error: ' + e.message);
        }
    }
    async deleteSession(tenantId, senderId) {
        try {
            const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
            const cur = tenant?.settings || {};
            const sessions = cur.instagramSessions || {};
            delete sessions[senderId];
            await this.prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...cur, instagramSessions: sessions } } });
            botSessionsCache.delete(senderId + ':' + tenantId);
        }
        catch (e) {
            this.logger.warn('deleteSession error: ' + e.message);
        }
    }
    async getStats(tenantId) {
        const [total, thisMonth] = await Promise.all([
            this.prisma.client.count({ where: { tenantId, source: 'INSTAGRAM' } }),
            this.prisma.client.count({
                where: { tenantId, source: 'INSTAGRAM', createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
            }),
        ]);
        return { total, thisMonth, activeSessions: botSessionsCache.size };
    }
};
exports.InstagramService = InstagramService;
exports.InstagramService = InstagramService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        realtime_gateway_1.RealtimeGateway,
        round_robin_module_1.RoundRobinService])
], InstagramService);
let InstagramController = class InstagramController {
    constructor(svc) {
        this.svc = svc;
    }
    async verifyWebhook(tenantId, mode, token, challenge) {
        const config = await this.svc.getConfig(tenantId);
        return this.svc.verifyWebhook(tenantId, mode, token, challenge, config.verifyToken);
    }
    webhook(tenantId, body, sig) {
        return this.svc.processWebhook(tenantId, body, sig);
    }
    getConfig(u) {
        return this.svc.getConfig(u.tenantId);
    }
    saveConfig(u, body) {
        return this.svc.saveConfig(u.tenantId, body);
    }
    stats(u) {
        return this.svc.getStats(u.tenantId);
    }
};
exports.InstagramController = InstagramController;
__decorate([
    (0, common_1.Get)('webhook/:tenantId'),
    (0, decorators_1.Public)(),
    __param(0, (0, common_1.Param)('tenantId')),
    __param(1, (0, common_1.Query)('hub.mode')),
    __param(2, (0, common_1.Query)('hub.verify_token')),
    __param(3, (0, common_1.Query)('hub.challenge')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], InstagramController.prototype, "verifyWebhook", null);
__decorate([
    (0, common_1.Post)('webhook/:tenantId'),
    (0, decorators_1.Public)(),
    __param(0, (0, common_1.Param)('tenantId')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Query)('signature')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, String]),
    __metadata("design:returntype", void 0)
], InstagramController.prototype, "webhook", null);
__decorate([
    (0, swagger_1.ApiOperation)({ summary: 'Instagram bot sozlamalarini olish' }),
    (0, swagger_1.ApiBearerAuth)('JWT'),
    (0, common_1.Get)('config'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], InstagramController.prototype, "getConfig", null);
__decorate([
    (0, swagger_1.ApiOperation)({ summary: 'Instagram bot sozlamalarini saqlash' }),
    (0, swagger_1.ApiBearerAuth)('JWT'),
    (0, common_1.Post)('config'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], InstagramController.prototype, "saveConfig", null);
__decorate([
    (0, swagger_1.ApiOperation)({ summary: 'Instagram statistikasi' }),
    (0, swagger_1.ApiBearerAuth)('JWT'),
    (0, common_1.Get)('stats'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], InstagramController.prototype, "stats", null);
exports.InstagramController = InstagramController = __decorate([
    (0, swagger_1.ApiTags)('Instagram Lead Bot'),
    (0, common_1.Controller)('instagram'),
    __metadata("design:paramtypes", [InstagramService])
], InstagramController);
let InstagramModule = class InstagramModule {
};
exports.InstagramModule = InstagramModule;
exports.InstagramModule = InstagramModule = __decorate([
    (0, common_1.Module)({
        controllers: [InstagramController],
        imports: [round_robin_module_1.RoundRobinModule],
        providers: [InstagramService],
        exports: [InstagramService],
    })
], InstagramModule);
//# sourceMappingURL=instagram.module.js.map