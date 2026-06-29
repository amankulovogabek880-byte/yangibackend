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
exports.UserTelegramModule = exports.UserTelegramController = exports.UserTelegramService = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
const tl_1 = require("telegram/tl");
const events_1 = require("telegram/events");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const realtime_gateway_1 = require("../realtime/realtime.gateway");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const DEFAULT_API_ID = parseInt(process.env.TELEGRAM_API_ID || '2040');
const DEFAULT_API_HASH = process.env.TELEGRAM_API_HASH || 'b18441a1ff607e10a989891a5462e627';
const activeSessions = new Map();
const pendingAuth = new Map();
let UserTelegramService = class UserTelegramService {
    constructor(prisma, realtime) {
        this.prisma = prisma;
        this.realtime = realtime;
        this.logger = new common_1.Logger('UserTelegramService');
    }
    async onModuleInit() {
        try {
            const accounts = await this.prisma.telegramAccount.findMany({
                where: { isPersonal: true, sessionData: { not: null }, isActive: true },
            });
            this.logger.log(`Restoring ${accounts.length} personal Telegram sessions...`);
            for (const acc of accounts) {
                await this.restoreSession(acc).catch(e => this.logger.warn(`Session restore failed for ${acc.id}: ${e.message}`));
            }
        }
        catch (e) {
            this.logger.warn('Could not restore sessions on init');
        }
    }
    async restoreSession(acc) {
        if (!acc.sessionData)
            return null;
        try {
            const apiId = parseInt(acc.apiId || String(DEFAULT_API_ID));
            const apiHash = acc.apiHash || DEFAULT_API_HASH;
            const session = new sessions_1.StringSession(acc.sessionData);
            const client = new telegram_1.TelegramClient(session, apiId, apiHash, {
                connectionRetries: 3,
                useWSS: false,
            });
            await client.connect();
            if (await client.isUserAuthorized()) {
                activeSessions.set(acc.id, client);
                this.startListening(client, acc);
                this.logger.log(`Session restored: ${acc.name || acc.phoneNumber}`);
                return client;
            }
        }
        catch { }
        return null;
    }
    async sendCode(tenantId, userId, data) {
        const phone = data.phone.replace(/\s+/g, '').trim();
        if (!phone.startsWith('+'))
            throw new common_1.BadRequestException('Telefon raqami + bilan boshlanishi kerak. Masalan: +998901234567');
        const apiId = data.apiId || DEFAULT_API_ID;
        const apiHash = data.apiHash || DEFAULT_API_HASH;
        const existing = await this.prisma.telegramAccount.findFirst({
            where: { tenantId, userId, isPersonal: true, isActive: true, phoneNumber: phone },
        });
        if (existing?.sessionData) {
            const client = await this.restoreSession(existing);
            if (client)
                return { status: 'already_connected', accountId: existing.id };
        }
        const session = new sessions_1.StringSession('');
        const client = new telegram_1.TelegramClient(session, apiId, apiHash, {
            connectionRetries: 3,
            useWSS: false,
        });
        try {
            await client.connect();
            const result = await client.sendCode({ apiId, apiHash }, phone);
            const phoneCodeHash = result.phoneCodeHash;
            const key = `${userId}:${phone}`;
            pendingAuth.set(key, { phoneCodeHash, client, phone });
            return { status: 'code_sent', phone, message: `SMS kodi ${phone} raqamiga yuborildi` };
        }
        catch (e) {
            await client.disconnect();
            if (e.message?.includes('PHONE_NUMBER_INVALID'))
                throw new common_1.BadRequestException('Noto\'g\'ri telefon raqami');
            if (e.message?.includes('API_ID_INVALID'))
                throw new common_1.BadRequestException('Telegram API ID noto\'g\'ri. Settings\'dan API ID/Hash ni tekshiring');
            if (e.message?.includes('FLOOD_WAIT'))
                throw new common_1.BadRequestException('Juda ko\'p urinish. Biroz kuting');
            throw new common_1.BadRequestException(`Xato: ${e.message}`);
        }
    }
    async verifyCode(tenantId, userId, data) {
        const phone = data.phone.replace(/\s+/g, '').trim();
        const key = `${userId}:${phone}`;
        const pending = pendingAuth.get(key);
        if (!pending)
            throw new common_1.BadRequestException('Avval kod so\'rang yoki kod muddati o\'tdi');
        const apiId = data.apiId || DEFAULT_API_ID;
        const apiHash = data.apiHash || DEFAULT_API_HASH;
        try {
            const { client, phoneCodeHash } = pending;
            await client.invoke(new tl_1.Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash,
                phoneCode: data.code.trim(),
            }));
            const sessionString = client.session.save();
            const me = await client.getMe();
            const account = await this.prisma.telegramAccount.upsert({
                where: { id: `personal-${tenantId}-${userId}` },
                create: {
                    id: `personal-${tenantId}-${userId}`,
                    tenantId, userId,
                    name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || phone,
                    isPersonal: true,
                    isActive: true,
                    phoneNumber: phone,
                    sessionData: sessionString,
                    apiId: String(apiId),
                    apiHash,
                    channel: 'TELEGRAM',
                    config: {
                        username: me.username,
                        firstName: me.firstName,
                        lastName: me.lastName,
                        telegramId: String(me.id),
                    },
                },
                update: {
                    name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || phone,
                    isActive: true,
                    sessionData: sessionString,
                    apiId: String(apiId),
                    apiHash,
                    config: {
                        username: me.username,
                        firstName: me.firstName,
                        telegramId: String(me.id),
                    },
                },
            });
            activeSessions.set(account.id, client);
            this.startListening(client, account);
            pendingAuth.delete(key);
            return {
                status: 'connected',
                accountId: account.id,
                name: account.name,
                username: me.username,
                message: '✅ Shaxsiy Telegram accountingiz muvaffaqiyatli ulandi!',
            };
        }
        catch (e) {
            if (e.message?.includes('SESSION_PASSWORD_NEEDED') || e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                return { status: 'need_2fa', message: '2FA parol kerak' };
            }
            if (e.message?.includes('PHONE_CODE_INVALID'))
                throw new common_1.BadRequestException('Noto\'g\'ri kod. Qayta tekshiring');
            if (e.message?.includes('PHONE_CODE_EXPIRED'))
                throw new common_1.BadRequestException('Kod muddati o\'tdi. Qayta so\'rang');
            throw new common_1.BadRequestException(`Xato: ${e.message}`);
        }
    }
    async verify2FA(tenantId, userId, data) {
        const phone = data.phone.replace(/\s+/g, '').trim();
        const key = `${userId}:${phone}`;
        const pending = pendingAuth.get(key);
        if (!pending)
            throw new common_1.BadRequestException('Avval kod so\'rang');
        const apiId = data.apiId || DEFAULT_API_ID;
        const apiHash = data.apiHash || DEFAULT_API_HASH;
        try {
            const { client } = pending;
            await client.invoke(new tl_1.Api.account.GetPassword()).then(async (pwd) => {
                const { computeCheck } = await Promise.resolve().then(() => __importStar(require('telegram/Password')));
                const inputCheck = await computeCheck(pwd, data.password);
                return client.invoke(new tl_1.Api.auth.CheckPassword({ password: inputCheck }));
            });
            const sessionString = client.session.save();
            const me = await client.getMe();
            const account = await this.prisma.telegramAccount.upsert({
                where: { id: `personal-${tenantId}-${userId}` },
                create: {
                    id: `personal-${tenantId}-${userId}`,
                    tenantId, userId,
                    name: [me.firstName, me.lastName].filter(Boolean).join(' ') || phone,
                    isPersonal: true, isActive: true, phoneNumber: phone,
                    sessionData: sessionString, apiId: String(apiId), apiHash,
                    channel: 'TELEGRAM',
                    config: { username: me.username, telegramId: String(me.id) },
                },
                update: {
                    isActive: true, sessionData: sessionString,
                    name: [me.firstName, me.lastName].filter(Boolean).join(' ') || phone,
                    config: { username: me.username, telegramId: String(me.id) },
                },
            });
            activeSessions.set(account.id, client);
            this.startListening(client, account);
            pendingAuth.delete(key);
            return { status: 'connected', accountId: account.id, name: account.name };
        }
        catch (e) {
            if (e.message?.includes('PASSWORD_HASH_INVALID'))
                throw new common_1.BadRequestException('Parol noto\'g\'ri');
            throw new common_1.BadRequestException(`Xato: ${e.message}`);
        }
    }
    startListening(client, acc) {
        try {
            client.addEventHandler(async (event) => {
                try {
                    const msg = event.message;
                    if (!msg || msg.out)
                        return;
                    const senderId = msg.senderId?.toString();
                    if (!senderId)
                        return;
                    const text = msg.message || '';
                    const date = new Date((msg.date || 0) * 1000);
                    this.logger.log(`Personal incoming: ${senderId} → "${text.slice(0, 50)}"`);
                    let firstName = '';
                    let lastName = '';
                    let username = '';
                    try {
                        const sender = await msg.getSender();
                        firstName = sender?.firstName || sender?.title || '';
                        lastName = sender?.lastName || '';
                        username = sender?.username || '';
                    }
                    catch { }
                    const tenantId = acc.tenantId;
                    const agentId = acc.userId;
                    const externalChatId = senderId;
                    let conv = await this.prisma.conversation.findFirst({
                        where: { tenantId, channel: 'TELEGRAM', externalChatId },
                    });
                    if (!conv) {
                        let clientId = null;
                        if (username) {
                            const cl = await this.prisma.client.findFirst({
                                where: { tenantId, telegramUsername: username },
                            }).catch(() => null);
                            if (cl)
                                clientId = cl.id;
                        }
                        conv = await this.prisma.conversation.create({
                            data: {
                                tenantId,
                                accountId: acc.id,
                                clientId,
                                assignedAgentId: agentId,
                                channel: 'TELEGRAM',
                                externalChatId,
                                firstName,
                                lastName,
                                username,
                                lastMessageAt: date,
                                lastMessageText: text.slice(0, 200),
                            },
                        });
                    }
                    else {
                        await this.prisma.conversation.update({
                            where: { id: conv.id },
                            data: {
                                lastMessageAt: date,
                                lastMessageText: text.slice(0, 200),
                            },
                        });
                    }
                    await this.prisma.message.create({
                        data: {
                            conversationId: conv.id,
                            direction: 'INBOUND',
                            messageType: 'TEXT',
                            text,
                            externalMsgId: String(msg.id || Date.now()),
                            isDelivered: true,
                        },
                    });
                    if (agentId) {
                        this.realtime.emitToUser(agentId, 'message:new', {
                            conversationId: conv.id,
                            text,
                            from: { firstName, lastName, username },
                            source: 'personal_telegram',
                        });
                    }
                }
                catch (e) {
                    this.logger.warn('Personal incoming handler error: ' + e.message);
                }
            }, new events_1.NewMessage({ incoming: true }));
        }
        catch (e) {
            this.logger.warn('startListening error: ' + e.message);
        }
    }
    async sendPersonalMessage(tenantId, agentId, data) {
        if (!data.text?.trim())
            throw new common_1.BadRequestException('Xabar matni kerak');
        if (!data.phone && !data.username && !data.userId) {
            throw new common_1.BadRequestException('Telefon raqami, username yoki Telegram ID kerak');
        }
        const account = await this.prisma.telegramAccount.findFirst({
            where: { tenantId, userId: agentId, isPersonal: true, isActive: true },
        });
        if (!account) {
            throw new common_1.BadRequestException('Shaxsiy Telegram account ulanmagan. Settings → Telegram → Shaxsiy account ulang');
        }
        let client = activeSessions.get(account.id);
        if (!client || !(await client.isUserAuthorized().catch(() => false))) {
            client = await this.restoreSession(account) || undefined;
            if (!client) {
                throw new common_1.BadRequestException('Session yaroqsiz. Settings → Telegram dan qayta ulaning');
            }
        }
        try {
            let peer;
            if (data.username) {
                peer = await client.getInputEntity(data.username.startsWith('@') ? data.username : `@${data.username}`);
            }
            else if (data.phone) {
                const phone = data.phone.replace(/\s+/g, '');
                try {
                    await client.invoke(new tl_1.Api.contacts.ImportContacts({
                        contacts: [new tl_1.Api.InputPhoneContact({
                                clientId: BigInt(Date.now()),
                                phone,
                                firstName: 'Client',
                                lastName: '',
                            })],
                    }));
                    peer = await client.getInputEntity(phone);
                }
                catch {
                    peer = phone;
                }
            }
            else if (data.userId) {
                peer = await client.getInputEntity(data.userId);
            }
            const sent = await client.sendMessage(peer, { message: data.text });
            let chat = null;
            let externalChatId;
            try {
                chat = await client.getEntity(peer);
                externalChatId = String(chat.id);
            }
            catch {
                const peerId = sent.peerId;
                externalChatId = String(peerId?.userId || peerId?.chatId || peerId?.channelId || Date.now());
            }
            let conv = await this.prisma.conversation.findFirst({
                where: { tenantId, channel: 'TELEGRAM', externalChatId },
            });
            if (!conv) {
                conv = await this.prisma.conversation.create({
                    data: {
                        tenantId,
                        accountId: account.id,
                        clientId: data.clientId || null,
                        assignedAgentId: agentId,
                        channel: 'TELEGRAM',
                        externalChatId,
                        firstName: chat?.firstName || chat?.username || data.username || data.phone || '',
                        lastName: chat?.lastName || '',
                        username: chat?.username || (data.username ? data.username.replace('@', '') : ''),
                        lastMessageAt: new Date(),
                        lastMessageText: data.text.slice(0, 200),
                    },
                });
            }
            else {
                await this.prisma.conversation.update({
                    where: { id: conv.id },
                    data: {
                        lastMessageAt: new Date(),
                        lastMessageText: data.text.slice(0, 200),
                        clientId: conv.clientId || data.clientId || null,
                        assignedAgentId: conv.assignedAgentId || agentId,
                    },
                });
            }
            await this.prisma.message.create({
                data: {
                    conversationId: conv.id,
                    agentId,
                    direction: 'OUTBOUND',
                    messageType: 'TEXT',
                    text: data.text,
                    externalMsgId: String(sent.id || Date.now()),
                    isDelivered: true,
                },
            });
            return { ok: true, conversationId: conv.id, message: '✅ Xabar yuborildi' };
        }
        catch (e) {
            if (e.message?.includes('USERNAME_NOT_OCCUPIED'))
                throw new common_1.BadRequestException('Bu username topilmadi');
            if (e.message?.includes('PEER_ID_INVALID'))
                throw new common_1.BadRequestException('Foydalanuvchi topilmadi');
            if (e.message?.includes('USER_PRIVACY_RESTRICTED')) {
                throw new common_1.BadRequestException('Foydalanuvchi maxfiylik sozlamasi tufayli siz bilan bog\'lana olmaydi. ' +
                    'Ular avval sizga yozishi kerak yoki umumiy guruhda bo\'lishlari kerak.');
            }
            throw new common_1.BadRequestException(`Xato: ${e.message}`);
        }
    }
    async getMyAccount(tenantId, userId) {
        const account = await this.prisma.telegramAccount.findFirst({
            where: { tenantId, userId, isPersonal: true },
            select: {
                id: true, name: true, phoneNumber: true, isActive: true, config: true,
                createdAt: true,
            },
        });
        if (!account)
            return null;
        const isOnline = activeSessions.has(account.id);
        return { ...account, isOnline };
    }
    async disconnect(tenantId, userId) {
        const account = await this.prisma.telegramAccount.findFirst({
            where: { tenantId, userId, isPersonal: true },
        });
        if (!account)
            throw new common_1.NotFoundException('Account topilmadi');
        const client = activeSessions.get(account.id);
        if (client) {
            await client.disconnect().catch(() => { });
            activeSessions.delete(account.id);
        }
        await this.prisma.telegramAccount.update({
            where: { id: account.id },
            data: { isActive: false, sessionData: null },
        });
        return { ok: true };
    }
};
exports.UserTelegramService = UserTelegramService;
exports.UserTelegramService = UserTelegramService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        realtime_gateway_1.RealtimeGateway])
], UserTelegramService);
let UserTelegramController = class UserTelegramController {
    constructor(svc) {
        this.svc = svc;
    }
    sendCode(u, body) {
        return this.svc.sendCode(u.tenantId, u.id || u.sub, body);
    }
    verifyCode(u, body) {
        return this.svc.verifyCode(u.tenantId, u.id || u.sub, body);
    }
    verify2FA(u, body) {
        return this.svc.verify2FA(u.tenantId, u.id || u.sub, body);
    }
    sendMessage(u, body) {
        return this.svc.sendPersonalMessage(u.tenantId, u.id || u.sub, body);
    }
    getMyAccount(u) {
        return this.svc.getMyAccount(u.tenantId, u.id || u.sub);
    }
    disconnect(u) {
        return this.svc.disconnect(u.tenantId, u.id || u.sub);
    }
};
exports.UserTelegramController = UserTelegramController;
__decorate([
    (0, swagger_1.ApiOperation)({ summary: '1-qadam: Telefon raqamga kod yuborish', description: 'Telegram SMS/App orqali 5 xonali kod yuboradi.' }),
    (0, swagger_1.ApiBody)({ schema: { example: { phone: '+998901234567' } } }),
    (0, common_1.Post)('auth/send-code'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], UserTelegramController.prototype, "sendCode", null);
__decorate([
    (0, swagger_1.ApiOperation)({ summary: '2-qadam: Kodni tasdiqlash', description: 'Telegramdan kelgan kodni kiriting.' }),
    (0, swagger_1.ApiBody)({ schema: { example: { phone: '+998901234567', code: '12345' } } }),
    (0, common_1.Post)('auth/verify-code'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], UserTelegramController.prototype, "verifyCode", null);
__decorate([
    (0, common_1.Post)('auth/2fa'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], UserTelegramController.prototype, "verify2FA", null);
__decorate([
    (0, swagger_1.ApiOperation)({
        summary: 'Birinchi xabar yuborish (klient /start yozmasdan ham)',
        description: 'Shaxsiy Telegram accountingiz orqali. Klient hech narsa yozmagan bolsa ham ishlaydi!',
    }),
    (0, swagger_1.ApiBody)({
        schema: {
            example: {
                phone: '+998901234567',
                text: 'Salom! Sizga tur haqida malumot bermoqchi edim.',
            },
        },
    }),
    (0, common_1.Post)('send'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], UserTelegramController.prototype, "sendMessage", null);
__decorate([
    (0, common_1.Get)('me'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], UserTelegramController.prototype, "getMyAccount", null);
__decorate([
    (0, common_1.Delete)('me'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], UserTelegramController.prototype, "disconnect", null);
exports.UserTelegramController = UserTelegramController = __decorate([
    (0, swagger_1.ApiTags)('Telegram Shaxsiy Account (MTProto)'),
    (0, swagger_1.ApiBearerAuth)('JWT'),
    (0, common_1.Controller)('user-telegram'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [UserTelegramService])
], UserTelegramController);
let UserTelegramModule = class UserTelegramModule {
};
exports.UserTelegramModule = UserTelegramModule;
exports.UserTelegramModule = UserTelegramModule = __decorate([
    (0, common_1.Module)({
        imports: [
            jwt_1.JwtModule.registerAsync({
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                useFactory: (cfg) => ({
                    secret: cfg.get('JWT_ACCESS_SECRET', 'dev-only-change-in-production'),
                    signOptions: { expiresIn: cfg.get('JWT_ACCESS_EXPIRES', '15m') },
                }),
            }),
        ],
        controllers: [UserTelegramController],
        providers: [UserTelegramService, realtime_gateway_1.RealtimeGateway],
        exports: [UserTelegramService],
    })
], UserTelegramModule);
//# sourceMappingURL=user-telegram.module.js.map