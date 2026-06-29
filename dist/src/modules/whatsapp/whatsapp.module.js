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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhatsAppModule = exports.WhatsAppWebhookController = exports.WhatsAppController = exports.WhatsAppService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
const notifications_service_1 = require("../notifications/notifications.service");
const clients_service_1 = require("../clients/clients.service");
const realtime_gateway_1 = require("../realtime/realtime.gateway");
const axios_1 = __importDefault(require("axios"));
const round_robin_module_1 = require("../v9/round-robin.module");
let WhatsAppService = class WhatsAppService {
    constructor(prisma, notifications, clients, realtime, roundRobin) {
        this.prisma = prisma;
        this.notifications = notifications;
        this.clients = clients;
        this.realtime = realtime;
        this.roundRobin = roundRobin;
        this.logger = new common_1.Logger('WhatsApp');
    }
    async getConfig(tenantId) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { settings: true },
        });
        const settings = tenant?.settings;
        const cfg = settings?.whatsapp;
        if (!cfg?.instanceId || !cfg?.token)
            return null;
        return cfg;
    }
    async saveConfig(tenantId, config) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { settings: true },
        });
        const existing = tenant?.settings || {};
        await this.prisma.tenant.update({
            where: { id: tenantId },
            data: {
                settings: {
                    ...existing,
                    whatsapp: {
                        instanceId: config.instanceId.trim(),
                        token: config.token.trim(),
                        webhookUrl: config.webhookUrl?.trim() || '',
                    },
                },
            },
        });
        return { ok: true };
    }
    async getConfigMasked(tenantId) {
        const cfg = await this.getConfig(tenantId);
        if (!cfg)
            return { connected: false };
        return {
            connected: true,
            instanceId: cfg.instanceId,
            token: cfg.token.slice(0, 6) + '••••••••',
            webhookUrl: cfg.webhookUrl,
        };
    }
    async sendMessage(tenantId, to, message, mediaUrl) {
        const cfg = await this.getConfig(tenantId);
        if (!cfg)
            throw new common_1.BadRequestException('WhatsApp sozlanmagan. Settings → WhatsApp');
        const phone = to.replace(/[^0-9]/g, '');
        if (phone.length < 9)
            throw new common_1.BadRequestException("Telefon raqam noto'g'ri");
        const baseUrl = `https://api.ultramsg.com/${cfg.instanceId}`;
        try {
            let response;
            if (mediaUrl) {
                const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(mediaUrl);
                const endpoint = isImage ? '/messages/image' : '/messages/document';
                response = await axios_1.default.post(`${baseUrl}${endpoint}`, {
                    token: cfg.token,
                    to: phone,
                    image: isImage ? mediaUrl : undefined,
                    document: !isImage ? mediaUrl : undefined,
                    caption: message,
                }, { timeout: 15000 });
            }
            else {
                response = await axios_1.default.post(`${baseUrl}/messages/chat`, {
                    token: cfg.token,
                    to: phone,
                    body: message,
                }, { timeout: 15000 });
            }
            const msgId = response.data?.id || response.data?.sent;
            this.logger.log(`WhatsApp yuborildi → ${phone}: ${msgId}`);
            return { ok: true, messageId: msgId };
        }
        catch (e) {
            const err = e.response?.data?.error || e.message;
            this.logger.error(`WhatsApp xato (${phone}): ${err}`);
            throw new common_1.BadRequestException(`WhatsApp xato: ${err}`);
        }
    }
    async handleWebhook(tenantId, payload) {
        this.logger.debug(`WhatsApp webhook: ${JSON.stringify(payload).slice(0, 200)}`);
        const msgData = payload?.data;
        if (!msgData || msgData.fromMe)
            return { ok: true };
        const from = (msgData.from || '').replace('@c.us', '').replace(/[^0-9]/g, '');
        const text = msgData.body || '';
        const msgType = msgData.type || 'chat';
        if (!from || !text)
            return { ok: true };
        let client = await this.prisma.client.findFirst({
            where: { tenantId, phone: { contains: from.slice(-9) } },
        });
        if (!client) {
            try {
                const pushName = msgData.pushName || msgData.notifyName || `WA_${from.slice(-9)}`;
                const waAgent = await this.roundRobin.getNextAgent(tenantId);
                client = await this.prisma.client.create({
                    data: {
                        tenantId,
                        fullName: pushName,
                        phone: `+${from}`,
                        source: 'WHATSAPP',
                        notes: `WhatsApp orqali kelgan lead`,
                        lastContactAt: new Date(),
                        firstContactAt: new Date(),
                        assignedAgentId: waAgent,
                    },
                });
                this.logger.log(`Yangi WhatsApp lead: ${pushName} (${from})`);
            }
            catch {
                return { ok: true };
            }
        }
        let conv = await this.prisma.conversation.findFirst({
            where: { tenantId, channel: 'WHATSAPP', externalChatId: from },
        });
        if (!conv) {
            conv = await this.prisma.conversation.create({
                data: {
                    tenantId,
                    channel: 'WHATSAPP',
                    externalChatId: from,
                    clientId: client.id,
                    firstName: client.fullName,
                },
            });
        }
        await this.prisma.message.create({
            data: {
                conversationId: conv.id,
                direction: 'INBOUND',
                messageType: (msgType === 'chat' ? 'TEXT' : 'PHOTO'),
                text,
                externalMsgId: msgData.id,
            },
        });
        await this.prisma.conversation.update({
            where: { id: conv.id },
            data: {
                lastMessageAt: new Date(),
                lastMessageText: text.slice(0, 200),
                unreadCount: { increment: 1 },
            },
        });
        if (conv.assignedAgentId) {
            await this.notifications.create({
                tenantId,
                userId: conv.assignedAgentId,
                type: 'NEW_MESSAGE',
                title: `📱 WhatsApp: ${client.fullName}`,
                body: text.slice(0, 80),
                link: `/inbox`,
                metadata: { conversationId: conv.id, clientId: client.id },
            }).catch(() => { });
        }
        try {
            this.realtime.emitToTenant(tenantId, 'message:new', {
                conversationId: conv.id, channel: 'WHATSAPP',
                clientName: client.fullName, text: text.slice(0, 100),
            });
        }
        catch { }
        return { ok: true };
    }
    async getStatus(tenantId) {
        const cfg = await this.getConfig(tenantId);
        if (!cfg)
            return { connected: false, status: 'not_configured' };
        try {
            const res = await axios_1.default.get(`https://api.ultramsg.com/${cfg.instanceId}/instance/status?token=${cfg.token}`, { timeout: 10000 });
            return {
                connected: true,
                status: res.data?.status?.accountStatus?.status || 'unknown',
                phoneNumber: res.data?.status?.accountInfo?.Wid || null,
                battery: res.data?.status?.accountInfo?.Battery || null,
            };
        }
        catch (e) {
            return { connected: false, status: 'error', error: e.message };
        }
    }
    async sendBookingConfirmation(tenantId, phone, data) {
        const lines = [
            `✈️ *Booking tasdiqlandi!*`,
            ``,
            `Hurmatli *${data.clientName}*,`,
            `Sizning buyurtmangiz qabul qilindi.`,
            ``,
            `📋 *Booking ma'lumotlari:*`,
            `• Ref: \`${data.bookingRef}\``,
            `• Tur: ${data.tourName}`,
            data.departureDate ? `• Ketish: ${data.departureDate}` : null,
            data.totalPrice ? `• Narx: *${data.totalPrice} ${data.currency || 'USD'}*` : null,
            ``,
            `📞 Savollar uchun bog'laning!`,
        ].filter(Boolean).join('\n');
        return this.sendMessage(tenantId, phone, lines);
    }
    async sendPaymentReminder(tenantId, phone, data) {
        const msg = [
            `💰 *To'lov eslatmasi*`,
            ``,
            `Hurmatli *${data.clientName}*,`,
            ``,
            `• Booking: \`${data.bookingRef}\``,
            `• Summa: *${data.amount} ${data.currency}*`,
            data.dueDate ? `• Muddat: ${data.dueDate}` : null,
            ``,
            `Iltimos, belgilangan muddatda to'lovni amalga oshiring.`,
        ].filter(Boolean).join('\n');
        return this.sendMessage(tenantId, phone, msg);
    }
};
exports.WhatsAppService = WhatsAppService;
exports.WhatsAppService = WhatsAppService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_service_1.NotificationsService,
        clients_service_1.ClientsService,
        realtime_gateway_1.RealtimeGateway,
        round_robin_module_1.RoundRobinService])
], WhatsAppService);
let WhatsAppController = class WhatsAppController {
    constructor(svc) {
        this.svc = svc;
    }
    getConfig(u) {
        return this.svc.getConfigMasked(u.tenantId);
    }
    saveConfig(body, u) {
        if (!body.instanceId?.trim() || !body.token?.trim()) {
            throw new common_1.BadRequestException('instanceId va token majburiy');
        }
        return this.svc.saveConfig(u.tenantId, body);
    }
    status(u) {
        return this.svc.getStatus(u.tenantId);
    }
    send(body, u) {
        if (!body.to?.trim())
            throw new common_1.BadRequestException('to majburiy');
        if (!body.message?.trim())
            throw new common_1.BadRequestException('message majburiy');
        return this.svc.sendMessage(u.tenantId, body.to, body.message, body.mediaUrl);
    }
    sendBooking(body, u) {
        return this.svc.sendBookingConfirmation(u.tenantId, body.phone, body);
    }
    sendPayment(body, u) {
        return this.svc.sendPaymentReminder(u.tenantId, body.phone, body);
    }
};
exports.WhatsAppController = WhatsAppController;
__decorate([
    (0, common_1.Get)('config'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], WhatsAppController.prototype, "getConfig", null);
__decorate([
    (0, common_1.Patch)('config'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], WhatsAppController.prototype, "saveConfig", null);
__decorate([
    (0, common_1.Get)('status'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], WhatsAppController.prototype, "status", null);
__decorate([
    (0, common_1.Post)('send'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], WhatsAppController.prototype, "send", null);
__decorate([
    (0, common_1.Post)('send/booking-confirmation'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], WhatsAppController.prototype, "sendBooking", null);
__decorate([
    (0, common_1.Post)('send/payment-reminder'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], WhatsAppController.prototype, "sendPayment", null);
exports.WhatsAppController = WhatsAppController = __decorate([
    (0, common_1.Controller)('whatsapp'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [WhatsAppService])
], WhatsAppController);
let WhatsAppWebhookController = class WhatsAppWebhookController {
    constructor(svc) {
        this.svc = svc;
    }
    webhook(tenantId, body) {
        return this.svc.handleWebhook(tenantId, body);
    }
    verify() {
        return { status: 'ok', service: 'Omon CRM WhatsApp Webhook' };
    }
};
exports.WhatsAppWebhookController = WhatsAppWebhookController;
__decorate([
    (0, common_1.Post)('webhook/:tenantId'),
    (0, decorators_1.Public)(),
    __param(0, (0, common_1.Param)('tenantId')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], WhatsAppWebhookController.prototype, "webhook", null);
__decorate([
    (0, common_1.Get)('webhook/:tenantId'),
    (0, decorators_1.Public)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], WhatsAppWebhookController.prototype, "verify", null);
exports.WhatsAppWebhookController = WhatsAppWebhookController = __decorate([
    (0, common_1.Controller)('public/whatsapp'),
    __metadata("design:paramtypes", [WhatsAppService])
], WhatsAppWebhookController);
let WhatsAppModule = class WhatsAppModule {
};
exports.WhatsAppModule = WhatsAppModule;
exports.WhatsAppModule = WhatsAppModule = __decorate([
    (0, common_1.Module)({
        controllers: [WhatsAppController, WhatsAppWebhookController],
        imports: [round_robin_module_1.RoundRobinModule],
        providers: [WhatsAppService],
        exports: [WhatsAppService],
    })
], WhatsAppModule);
//# sourceMappingURL=whatsapp.module.js.map