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
exports.TelegramPersonalModule = exports.TelegramPersonalController = exports.TelegramPersonalService = void 0;
const common_1 = require("@nestjs/common");
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
const events_1 = require("telegram/events");
const tl_1 = require("telegram/tl");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const realtime_gateway_1 = require("../realtime/realtime.gateway");
const encryption_service_1 = require("../../common/encryption/encryption.service");
const activeSessions = new Map();
const pendingAuth = new Map();
let TelegramPersonalService = class TelegramPersonalService {
    constructor(prisma, realtime, encryption) {
        this.prisma = prisma;
        this.realtime = realtime;
        this.encryption = encryption;
        this.logger = new common_1.Logger('TelegramPersonal');
    }
    async getClient(userId, tenantId) {
        if (activeSessions.has(userId)) {
            const c = activeSessions.get(userId);
            if (c.connected)
                return c;
        }
        const acct = await this.prisma.telegramAccount.findFirst({
            where: { userId, tenantId, isPersonal: true, isActive: true },
        });
        if (!acct)
            throw new common_1.NotFoundException('Telegram akkaunt ulanmagan');
        const apiId = parseInt(acct.apiId || process.env.TELEGRAM_API_ID || '0');
        const apiHash = acct.apiHash
            ? this.encryption.decrypt(acct.apiHash)
            : (process.env.TELEGRAM_API_HASH || '');
        const session = acct.sessionData
            ? this.encryption.decrypt(acct.sessionData)
            : '';
        const client = new telegram_1.TelegramClient(new sessions_1.StringSession(session), apiId, apiHash, { connectionRetries: 5, useWSS: false });
        await client.connect();
        activeSessions.set(userId, client);
        client.addEventHandler(async (event) => {
            await this.handleIncoming(event, userId, tenantId);
        }, new events_1.NewMessage({}));
        return client;
    }
    async sendCode(userId, tenantId, phone, apiId, apiHash) {
        const client = new telegram_1.TelegramClient(new sessions_1.StringSession(''), apiId, apiHash, { connectionRetries: 3, useWSS: false });
        await client.connect();
        const result = await client.sendCode({ apiId, apiHash }, phone);
        pendingAuth.set(userId, { client, phone, phoneCodeHash: result.phoneCodeHash });
        return { sent: true, phoneCodeHash: result.phoneCodeHash };
    }
    async verifyCode(userId, tenantId, code, password) {
        const pending = pendingAuth.get(userId);
        if (!pending)
            throw new common_1.BadRequestException('Avval telefon raqam kiriting');
        const { client, phone, phoneCodeHash } = pending;
        try {
            await client.invoke(new tl_1.Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash,
                phoneCode: code,
            }));
        }
        catch (e) {
            if (e.message?.includes('SESSION_PASSWORD_NEEDED')) {
                if (!password)
                    return { need2fa: true };
                const hint = await client.invoke(new tl_1.Api.account.GetPassword());
                const { computeCheck } = await Promise.resolve().then(() => __importStar(require('telegram/Password')));
                const passwordCheck = await computeCheck(hint, password);
                await client.invoke(new tl_1.Api.auth.CheckPassword({ password: passwordCheck }));
            }
            else
                throw e;
        }
        const session = client.session.save();
        pendingAuth.delete(userId);
        const encSession = this.encryption.encrypt(session);
        const encHash = this.encryption.encrypt(pending.client['apiHash'] || '');
        const existing = await this.prisma.telegramAccount.findFirst({
            where: { userId, tenantId, isPersonal: true },
        });
        if (existing) {
            await this.prisma.telegramAccount.update({
                where: { id: existing.id },
                data: { sessionData: encSession, isActive: true, phoneNumber: phone },
            });
        }
        else {
            await this.prisma.telegramAccount.create({
                data: {
                    tenantId, userId,
                    name: `Personal: ${phone}`,
                    channel: 'TELEGRAM',
                    isPersonal: true,
                    isActive: true,
                    phoneNumber: phone,
                    sessionData: encSession,
                    apiHash: encHash,
                },
            });
        }
        activeSessions.set(userId, client);
        client.addEventHandler(async (event) => {
            await this.handleIncoming(event, userId, tenantId);
        }, new events_1.NewMessage({}));
        return { connected: true };
    }
    async getDialogs(userId, tenantId) {
        const client = await this.getClient(userId, tenantId);
        const dialogs = await client.getDialogs({ limit: 100 });
        const results = [];
        for (const d of dialogs) {
            if (!d.isUser)
                continue;
            const entity = d.entity;
            const chatId = String(entity?.id || d.id);
            let conv = await this.prisma.conversation.findFirst({
                where: { tenantId, channel: 'TELEGRAM', externalChatId: chatId },
            });
            const convData = {
                tenantId,
                channel: 'TELEGRAM',
                externalChatId: chatId,
                externalUserId: chatId,
                firstName: entity?.firstName || '',
                lastName: entity?.lastName || '',
                username: entity?.username || '',
                assignedAgentId: userId,
                unreadCount: d.unreadCount || 0,
                lastMessageText: d.message?.message || '',
                lastMessageAt: d.message?.date ? new Date(d.message.date * 1000) : new Date(),
            };
            if (!conv) {
                conv = await this.prisma.conversation.create({ data: convData });
            }
            else {
                conv = await this.prisma.conversation.update({
                    where: { id: conv.id },
                    data: { unreadCount: convData.unreadCount, lastMessageText: convData.lastMessageText, lastMessageAt: convData.lastMessageAt },
                });
            }
            results.push(conv);
        }
        return results;
    }
    async getMessages(userId, tenantId, conversationId) {
        const conv = await this.prisma.conversation.findFirst({
            where: { id: conversationId, tenantId },
        });
        if (!conv)
            throw new common_1.NotFoundException('Conversation topilmadi');
        const client = await this.getClient(userId, tenantId);
        const entity = await client.getEntity(conv.externalChatId);
        const msgs = await client.getMessages(entity, { limit: 50 });
        for (const m of msgs) {
            const existing = await this.prisma.message.findFirst({
                where: { conversationId, externalMsgId: String(m.id) },
            });
            if (existing)
                continue;
            let fileUrl;
            let fileName;
            if (m.media) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const uploadDir = process.env.UPLOAD_DIR || './uploads';
                    if (!fs.existsSync(uploadDir))
                        fs.mkdirSync(uploadDir, { recursive: true });
                    const ext = m.media.photo ? 'jpg' :
                        (m.media.document?.mimeType || 'bin').split('/')[1] || 'bin';
                    fileName = `tg_${Date.now()}_${m.id}.${ext}`;
                    const filePath = path.join(uploadDir, fileName);
                    const buf = await client.downloadMedia(m);
                    if (buf && buf.length > 0) {
                        fs.writeFileSync(filePath, buf);
                        const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
                        fileUrl = `${baseUrl}/uploads/${fileName}`;
                    }
                }
                catch { }
            }
            const senderId = String(m.fromId?.userId || m.peerId?.userId || '');
            const myId = String((await client.getMe())?.id || '');
            const direction = senderId === myId ? 'OUTBOUND' : 'INBOUND';
            const msgType = m.media
                ? (m.media.photo ? 'PHOTO' : 'DOCUMENT')
                : 'TEXT';
            await this.prisma.message.create({
                data: {
                    conversationId,
                    agentId: direction === 'OUTBOUND' ? userId : null,
                    externalMsgId: String(m.id),
                    direction,
                    messageType: msgType,
                    text: m.message || '',
                    fileUrl,
                    isRead: true,
                    createdAt: new Date(m.date * 1000),
                },
            });
        }
        return this.prisma.message.findMany({
            where: { conversationId },
            orderBy: { createdAt: 'asc' },
            take: 100,
        });
    }
    async sendMessage(userId, tenantId, conversationId, text, fileBase64, fileName) {
        const conv = await this.prisma.conversation.findFirst({
            where: { id: conversationId, tenantId },
        });
        if (!conv)
            throw new common_1.NotFoundException('Conversation topilmadi');
        const client = await this.getClient(userId, tenantId);
        const entity = await client.getEntity(conv.externalChatId);
        let sentMsg;
        if (fileBase64 && fileName) {
            const buf = Buffer.from(fileBase64.includes(',') ? fileBase64.split(',')[1] : fileBase64, 'base64');
            const isImage = !!fileName.match(/\.(jpg|jpeg|png|gif|webp)$/i);
            sentMsg = await client.sendFile(entity, {
                file: buf,
                caption: text || '',
                forceDocument: !isImage,
                workers: 1,
                attributes: [{ className: 'DocumentAttributeFilename', fileName }],
            });
        }
        else {
            sentMsg = await client.sendMessage(entity, { message: text });
        }
        const saved = await this.prisma.message.create({
            data: {
                conversationId,
                agentId: userId,
                externalMsgId: String(sentMsg.id),
                direction: 'OUTBOUND',
                messageType: fileBase64 ? 'DOCUMENT' : 'TEXT',
                text,
                isDelivered: true,
                isRead: false,
                createdAt: new Date(),
            },
        });
        await this.prisma.conversation.update({
            where: { id: conversationId },
            data: { lastMessageText: text, lastMessageAt: new Date() },
        });
        this.realtime.emitToTenant(tenantId, 'message:new', { conversationId, message: saved });
        return saved;
    }
    async searchUser(userId, tenantId, query) {
        const client = await this.getClient(userId, tenantId);
        try {
            const username = query.replace('@', '');
            const result = await client.invoke(new tl_1.Api.contacts.ResolveUsername({ username }));
            const user = result.users?.[0];
            if (!user)
                return null;
            return {
                id: String(user.id),
                firstName: user.firstName || '',
                lastName: user.lastName || '',
                username: user.username || '',
                phone: user.phone || '',
            };
        }
        catch {
            return null;
        }
    }
    async startChat(userId, tenantId, externalUserId, firstMessage) {
        const client = await this.getClient(userId, tenantId);
        const entity = await client.getEntity(externalUserId);
        const u = entity;
        let conv = await this.prisma.conversation.findFirst({
            where: { tenantId, channel: 'TELEGRAM', externalChatId: String(u.id) },
        });
        if (!conv) {
            conv = await this.prisma.conversation.create({
                data: {
                    tenantId,
                    channel: 'TELEGRAM',
                    externalChatId: String(u.id),
                    externalUserId: String(u.id),
                    firstName: u.firstName || '',
                    lastName: u.lastName || '',
                    username: u.username || '',
                    assignedAgentId: userId,
                    unreadCount: 0,
                    lastMessageAt: new Date(),
                },
            });
        }
        if (firstMessage) {
            await this.sendMessage(userId, tenantId, conv.id, firstMessage);
        }
        return conv;
    }
    async handleIncoming(event, userId, tenantId) {
        try {
            const m = event.message;
            if (!m)
                return;
            const chatId = String(m.chatId || m.peerId?.userId || '');
            if (!chatId)
                return;
            let conv = await this.prisma.conversation.findFirst({
                where: { tenantId, channel: 'TELEGRAM', externalChatId: chatId },
            });
            if (!conv) {
                conv = await this.prisma.conversation.create({
                    data: {
                        tenantId, channel: 'TELEGRAM',
                        externalChatId: chatId,
                        externalUserId: chatId,
                        assignedAgentId: userId,
                        unreadCount: 1,
                        lastMessageText: m.message || '',
                        lastMessageAt: new Date(),
                    },
                });
            }
            else {
                await this.prisma.conversation.update({
                    where: { id: conv.id },
                    data: {
                        unreadCount: { increment: 1 },
                        lastMessageText: m.message || '',
                        lastMessageAt: new Date(),
                    },
                });
            }
            const msg = await this.prisma.message.create({
                data: {
                    conversationId: conv.id,
                    direction: 'INBOUND',
                    messageType: m.media ? 'DOCUMENT' : 'TEXT',
                    text: m.message || '',
                    externalMsgId: String(m.id),
                    isRead: false,
                    createdAt: new Date(m.date * 1000),
                },
            });
            this.realtime.emitToUser(userId, 'message:new', { conversationId: conv.id, message: msg });
            this.realtime.emitToTenant(tenantId, 'conversation:update', conv);
        }
        catch (e) {
            this.logger.warn('handleIncoming error: ' + e?.message);
        }
    }
    async getStatus(userId, tenantId) {
        const acct = await this.prisma.telegramAccount.findFirst({
            where: { userId, tenantId, isPersonal: true },
            select: { isActive: true, phoneNumber: true, createdAt: true },
        });
        if (!acct)
            return { connected: false };
        const client = activeSessions.get(userId);
        return {
            connected: !!acct.isActive,
            online: !!(client?.connected),
            phone: acct.phoneNumber,
            since: acct.createdAt,
        };
    }
    async disconnect(userId, tenantId) {
        const client = activeSessions.get(userId);
        if (client) {
            try {
                await client.disconnect();
            }
            catch { }
            activeSessions.delete(userId);
        }
        await this.prisma.telegramAccount.updateMany({
            where: { userId, tenantId, isPersonal: true },
            data: { sessionData: null, isActive: false },
        });
        return { disconnected: true };
    }
    async restoreAllSessions() {
        try {
            const accounts = await this.prisma.telegramAccount.findMany({
                where: { isPersonal: true, isActive: true, sessionData: { not: null } },
            });
            for (const acct of accounts) {
                try {
                    const apiId = parseInt(acct.apiId || process.env.TELEGRAM_API_ID || '0');
                    const apiHash = acct.apiHash ? this.encryption.decrypt(acct.apiHash) : (process.env.TELEGRAM_API_HASH || '');
                    const session = this.encryption.decrypt(acct.sessionData);
                    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(session), apiId, apiHash, { connectionRetries: 3, useWSS: false });
                    await client.connect();
                    activeSessions.set(acct.userId, client);
                    client.addEventHandler(async (event) => {
                        await this.handleIncoming(event, acct.userId, acct.tenantId);
                    }, new events_1.NewMessage({}));
                    this.logger.log(`Session restored: ${acct.phoneNumber}`);
                }
                catch (e) {
                    this.logger.warn(`Session restore failed for ${acct.phoneNumber}: ${e?.message}`);
                }
            }
        }
        catch { }
    }
};
exports.TelegramPersonalService = TelegramPersonalService;
exports.TelegramPersonalService = TelegramPersonalService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        realtime_gateway_1.RealtimeGateway,
        encryption_service_1.EncryptionService])
], TelegramPersonalService);
let TelegramPersonalController = class TelegramPersonalController {
    constructor(svc) {
        this.svc = svc;
    }
    status(u) {
        return this.svc.getStatus(u.sub, u.tenantId);
    }
    connect(u, body) {
        return this.svc.sendCode(u.sub, u.tenantId, body.phone, body.apiId, body.apiHash);
    }
    verifyCode(u, body) {
        return this.svc.verifyCode(u.sub, u.tenantId, body.code, body.password);
    }
    disconnect(u) {
        return this.svc.disconnect(u.sub, u.tenantId);
    }
    dialogs(u) {
        return this.svc.getDialogs(u.sub, u.tenantId);
    }
    messages(u, id) {
        return this.svc.getMessages(u.sub, u.tenantId, id);
    }
    send(u, body) {
        return this.svc.sendMessage(u.sub, u.tenantId, body.conversationId, body.text, body.fileBase64, body.fileName);
    }
    search(u, body) {
        return this.svc.searchUser(u.sub, u.tenantId, body.query);
    }
    startChat(u, body) {
        return this.svc.startChat(u.sub, u.tenantId, body.externalUserId, body.firstMessage);
    }
};
exports.TelegramPersonalController = TelegramPersonalController;
__decorate([
    (0, common_1.Get)('status'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TelegramPersonalController.prototype, "status", null);
__decorate([
    (0, common_1.Post)('connect'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramPersonalController.prototype, "connect", null);
__decorate([
    (0, common_1.Post)('verify-code'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramPersonalController.prototype, "verifyCode", null);
__decorate([
    (0, common_1.Post)('disconnect'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TelegramPersonalController.prototype, "disconnect", null);
__decorate([
    (0, common_1.Get)('dialogs'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TelegramPersonalController.prototype, "dialogs", null);
__decorate([
    (0, common_1.Get)('messages/:conversationId'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('conversationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], TelegramPersonalController.prototype, "messages", null);
__decorate([
    (0, common_1.Post)('send'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramPersonalController.prototype, "send", null);
__decorate([
    (0, common_1.Post)('search'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramPersonalController.prototype, "search", null);
__decorate([
    (0, common_1.Post)('start-chat'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramPersonalController.prototype, "startChat", null);
exports.TelegramPersonalController = TelegramPersonalController = __decorate([
    (0, common_1.Controller)('telegram/personal'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [TelegramPersonalService])
], TelegramPersonalController);
let TelegramPersonalModule = class TelegramPersonalModule {
};
exports.TelegramPersonalModule = TelegramPersonalModule;
exports.TelegramPersonalModule = TelegramPersonalModule = __decorate([
    (0, common_1.Module)({
        controllers: [TelegramPersonalController],
        providers: [TelegramPersonalService],
        exports: [TelegramPersonalService],
    })
], TelegramPersonalModule);
//# sourceMappingURL=telegram-personal.module.js.map