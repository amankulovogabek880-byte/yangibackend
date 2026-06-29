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
exports.TelegramModule = exports.TelegramController = exports.TelegramService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
const notifications_service_1 = require("../notifications/notifications.service");
const clients_service_1 = require("../clients/clients.service");
const realtime_gateway_1 = require("../realtime/realtime.gateway");
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const helpers_1 = require("../../common/utils/helpers");
;
let TelegramService = class TelegramService {
    constructor(prisma, notifications, clients, realtime) {
        this.prisma = prisma;
        this.notifications = notifications;
        this.clients = clients;
        this.realtime = realtime;
        this.logger = new common_1.Logger('Telegram');
        this.bots = new Map();
    }
    async onModuleInit() {
        try {
            const accounts = await this.prisma.telegramAccount.findMany({
                where: { isActive: true, botToken: { not: null } },
            });
            for (const acc of accounts) {
                if (!acc.botToken)
                    continue;
                await this.startBot(acc.id, acc.tenantId, acc.botToken).catch((e) => this.logger.error(`Bot start failed [${acc.id}]: ${e.message}`));
            }
            this.logger.log(`${accounts.length} bot(s) started`);
        }
        catch (e) {
            this.logger.error(`Init failed: ${e.message}`);
        }
    }
    async onModuleDestroy() {
        for (const [id, bot] of this.bots.entries()) {
            try {
                await bot.stopPolling();
                this.logger.log(`Bot stopped on shutdown: ${id}`);
            }
            catch { }
        }
        this.bots.clear();
    }
    async startBot(accountId, tenantId, token) {
        const existing = this.bots.get(accountId);
        if (existing) {
            try {
                await existing.stopPolling();
            }
            catch { }
            this.bots.delete(accountId);
        }
        try {
            const tempBot = new node_telegram_bot_api_1.default(token, { polling: false });
            await tempBot.deleteWebhook({ drop_pending_updates: true });
        }
        catch { }
        const bot = new node_telegram_bot_api_1.default(token, { polling: true });
        bot.on('message', (msg) => this.handleIncoming(msg, accountId, tenantId).catch((e) => this.logger.error(`handle: ${e.message}`)));
        let lastErrorTime = 0;
        let retryCount = 0;
        bot.on('polling_error', (e) => {
            const msg = e?.message || String(e);
            const now = Date.now();
            if (now - lastErrorTime < 60000)
                return;
            lastErrorTime = now;
            if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
                this.logger.warn(`Bot ${accountId}: internet yo'q, 60s dan keyin urinish`);
                setTimeout(async () => {
                    try {
                        await this.startBot(accountId, tenantId, token);
                    }
                    catch { }
                }, 60000);
            }
            else if (msg.includes('409') || msg.includes('Conflict')) {
                retryCount++;
                const delay = Math.min(15000 * retryCount, 120000);
                this.logger.warn(`Bot ${accountId}: 409 Conflict — ${delay / 1000}s dan keyin restart`);
                setTimeout(async () => {
                    try {
                        await bot.stopPolling();
                        await new Promise(r => setTimeout(r, 3000));
                        await this.startBot(accountId, tenantId, token);
                        retryCount = 0;
                    }
                    catch { }
                }, delay);
            }
            else {
                this.logger.error(`Bot ${accountId}: ${msg}`);
            }
        });
        this.bots.set(accountId, bot);
    }
    async pickAgent(tenantId) {
        const agents = await this.prisma.user.findMany({
            where: { tenantId, role: { in: ['AGENT', 'MANAGER'] }, status: 'ACTIVE' },
            select: { id: true },
        });
        if (!agents.length)
            return null;
        const counts = await Promise.all(agents.map(async (a) => ({
            id: a.id,
            cnt: await this.prisma.conversation.count({
                where: { tenantId, assignedAgentId: a.id, isResolved: false },
            }),
        })));
        counts.sort((a, b) => a.cnt - b.cnt);
        return counts[0].id;
    }
    inferType(msg) {
        if (msg.photo)
            return 'PHOTO';
        if (msg.document)
            return 'DOCUMENT';
        if (msg.voice)
            return 'VOICE';
        if (msg.video)
            return 'VIDEO';
        if (msg.sticker)
            return 'STICKER';
        if (msg.location)
            return 'LOCATION';
        if (msg.contact)
            return 'CONTACT';
        if (msg.forward_from || msg.forward_from_chat)
            return 'FORWARD';
        return 'TEXT';
    }
    async handleIncoming(msg, accountId, tenantId) {
        const chatId = String(msg.chat.id);
        const tgUserId = msg.from?.id ? String(msg.from.id) : undefined;
        const text = msg.text || msg.caption || '';
        let startPayload;
        if (text.startsWith('/start')) {
            const parts = text.split(/\s+/);
            if (parts.length > 1)
                startPayload = parts.slice(1).join(' ').slice(0, 80);
        }
        let conv = await this.prisma.conversation.findFirst({
            where: { tenantId, channel: 'TELEGRAM', externalChatId: chatId },
        });
        let isNew = false;
        if (!conv) {
            isNew = true;
            const client = tgUserId
                ? await this.prisma.client.findFirst({
                    where: { tenantId, telegramId: tgUserId },
                })
                : null;
            const assignedAgentId = await this.pickAgent(tenantId);
            conv = await this.prisma.conversation.create({
                data: {
                    tenantId,
                    accountId,
                    channel: 'TELEGRAM',
                    externalChatId: chatId,
                    externalUserId: tgUserId,
                    firstName: msg.from?.first_name,
                    lastName: msg.from?.last_name,
                    username: msg.from?.username,
                    startPayload,
                    clientId: client?.id,
                    assignedAgentId,
                },
            });
            if (assignedAgentId) {
                await this.notifications.create({
                    tenantId, userId: assignedAgentId,
                    type: 'LEAD_NEW',
                    title: '🔥 Yangi Telegram lead',
                    body: (msg.from?.first_name || 'Noma\'lum') + (startPayload ? ` — ${startPayload}` : ''),
                    link: `/inbox?conv=${conv.id}`,
                    metadata: { conversationId: conv.id },
                }).catch(() => { });
            }
        }
        const messageType = this.inferType(msg);
        const newMsg = await this.prisma.message.create({
            data: {
                conversationId: conv.id,
                externalMsgId: String(msg.message_id),
                direction: 'INBOUND',
                messageType,
                text: msg.text || msg.caption || null,
            },
        });
        await this.prisma.conversation.update({
            where: { id: conv.id },
            data: {
                lastMessageAt: new Date(),
                lastMessageText: (msg.text || msg.caption || `[${messageType}]`).slice(0, 200),
                lastMessageType: messageType,
                unreadCount: { increment: 1 },
                isResolved: false,
            },
        });
        try {
            this.realtime.emitToConversation(conv.id, 'message:new', newMsg);
            this.realtime.emitToTenant(tenantId, 'conversation:updated', {
                conversationId: conv.id,
                lastMessageText: (msg.text || msg.caption || `[${messageType}]`).slice(0, 200),
                lastMessageAt: new Date(),
            });
        }
        catch { }
        if (!isNew && conv.assignedAgentId) {
            const recent = await this.prisma.notification.findFirst({
                where: {
                    userId: conv.assignedAgentId,
                    type: 'NEW_MESSAGE',
                    createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
                    metadata: { path: ['conversationId'], equals: conv.id },
                },
            });
            if (!recent) {
                await this.notifications.create({
                    tenantId, userId: conv.assignedAgentId,
                    type: 'NEW_MESSAGE',
                    title: '💬 Yangi xabar',
                    body: (msg.text || msg.caption || `[${messageType}]`).slice(0, 100),
                    link: `/inbox?conv=${conv.id}`,
                    metadata: { conversationId: conv.id },
                }).catch(() => { });
            }
        }
        if (conv.clientId) {
            await this.prisma.client.update({
                where: { id: conv.clientId },
                data: { lastContactAt: new Date() },
            }).catch(() => { });
        }
    }
    async sendMessage(tenantId, conversationId, text, agentId, agentRole, isInternal = false) {
        if (!text?.trim())
            throw new common_1.BadRequestException("Xabar bo'sh");
        const conv = await this.prisma.conversation.findFirst({
            where: { id: conversationId, tenantId },
            include: { account: true },
        });
        if (!conv)
            throw new common_1.NotFoundException('Suhbat topilmadi');
        if (agentRole === 'AGENT') {
            if (conv.assignedAgentId && conv.assignedAgentId !== agentId) {
                throw new common_1.ForbiddenException('Bu suhbat boshqa agentga tayinlangan. Avval admin sizga tayinlashi kerak.');
            }
            if (!conv.assignedAgentId) {
                await this.prisma.conversation.update({
                    where: { id: conversationId },
                    data: { assignedAgentId: agentId },
                });
            }
        }
        const msg = await this.prisma.message.create({
            data: {
                conversationId, agentId,
                direction: 'OUTBOUND',
                messageType: 'TEXT',
                text, isInternal, isRead: true,
            },
            include: { agent: { select: { id: true, name: true } } },
        });
        if (!isInternal && conv.channel === 'TELEGRAM' && conv.accountId) {
            const bot = this.bots.get(conv.accountId);
            if (!bot)
                throw new common_1.BadRequestException('Bot aktiv emas');
            try {
                const sent = await bot.sendMessage(conv.externalChatId, text);
                await this.prisma.message.update({
                    where: { id: msg.id },
                    data: { externalMsgId: String(sent.message_id), isDelivered: true },
                });
            }
            catch (e) {
                await this.prisma.message.update({
                    where: { id: msg.id },
                    data: { isFailed: true, errorMessage: e.message },
                });
                throw new common_1.BadRequestException(`Yuborilmadi: ${e.message}`);
            }
            await this.prisma.conversation.update({
                where: { id: conversationId },
                data: { lastMessageAt: new Date(), lastMessageText: text.slice(0, 200), lastMessageType: 'TEXT' },
            });
        }
        try {
            this.realtime.emitToConversation(conversationId, 'message:new', msg);
            this.realtime.emitToTenant(tenantId, 'conversation:updated', {
                conversationId,
                lastMessageText: text.slice(0, 200),
                lastMessageAt: new Date(),
            });
        }
        catch { }
        return msg;
    }
    async sendMedia(tenantId, conversationId, agentId, agentRole, data) {
        if (!data.fileUrl)
            throw new common_1.BadRequestException('Fayl URL bo\'sh');
        const conv = await this.prisma.conversation.findFirst({
            where: { id: conversationId, tenantId },
            include: { account: true },
        });
        if (!conv)
            throw new common_1.NotFoundException('Suhbat topilmadi');
        if (agentRole === 'AGENT') {
            if (conv.assignedAgentId && conv.assignedAgentId !== agentId) {
                throw new common_1.ForbiddenException('Bu suhbat boshqa agentga tayinlangan');
            }
            if (!conv.assignedAgentId) {
                await this.prisma.conversation.update({
                    where: { id: conversationId },
                    data: { assignedAgentId: agentId },
                });
            }
        }
        const isImage = data.mediaType === 'photo' ||
            (data.mimeType?.startsWith('image/') ?? false);
        const isVideo = data.mediaType === 'video' ||
            (data.mimeType?.startsWith('video/') ?? false);
        const msgType = isImage ? 'PHOTO' : isVideo ? 'VIDEO' : 'DOCUMENT';
        const msg = await this.prisma.message.create({
            data: {
                conversationId, agentId,
                direction: 'OUTBOUND',
                messageType: msgType,
                fileUrl: data.fileUrl,
                fileMimeType: data.mimeType,
                caption: data.caption,
                isRead: true,
            },
            include: { agent: { select: { id: true, name: true } } },
        });
        if (conv.channel === 'TELEGRAM' && conv.accountId) {
            const bot = this.bots.get(conv.accountId);
            if (!bot)
                throw new common_1.BadRequestException('Bot aktiv emas');
            const fs = require('fs');
            const path = require('path');
            let fileToSend = data.fileUrl;
            try {
                if (data.fileUrl.includes('/uploads/')) {
                    const filename = data.fileUrl.split('/uploads/').pop();
                    const filePath = path.join(process.cwd(), 'uploads', filename);
                    if (fs.existsSync(filePath)) {
                        fileToSend = fs.createReadStream(filePath);
                    }
                }
            }
            catch (fsErr) {
            }
            try {
                let sent;
                if (isImage) {
                    sent = await bot.sendPhoto(conv.externalChatId, fileToSend, {
                        caption: data.caption,
                    });
                }
                else if (isVideo) {
                    sent = await bot.sendVideo(conv.externalChatId, fileToSend, {
                        caption: data.caption,
                    });
                }
                else {
                    sent = await bot.sendDocument(conv.externalChatId, fileToSend, {
                        caption: data.caption,
                    });
                }
                await this.prisma.message.update({
                    where: { id: msg.id },
                    data: { externalMsgId: String(sent.message_id), isDelivered: true },
                });
            }
            catch (e) {
                await this.prisma.message.update({
                    where: { id: msg.id },
                    data: { isFailed: true, errorMessage: e.message },
                });
                throw new common_1.BadRequestException(`Yuborilmadi: ${e.message}`);
            }
            await this.prisma.conversation.update({
                where: { id: conversationId },
                data: {
                    lastMessageAt: new Date(),
                    lastMessageText: data.caption?.slice(0, 200) || (isImage ? '📷 Rasm' : '📎 Fayl'),
                    lastMessageType: msgType,
                },
            });
        }
        try {
            this.realtime.emitToConversation(conversationId, 'message:new', msg);
        }
        catch { }
        return msg;
    }
    async sendTemplate(tenantId, conversationId, agentId, agentRole, templateId) {
        const template = await this.prisma.messageTemplate.findFirst({
            where: { id: templateId, tenantId, isActive: true },
        });
        if (!template)
            throw new common_1.NotFoundException('Shablon topilmadi');
        await this.prisma.messageTemplate.update({
            where: { id: templateId },
            data: { useCount: { increment: 1 } },
        });
        const sentMessages = [];
        if (template.text?.trim()) {
            const msg = await this.sendMessage(tenantId, conversationId, template.text, agentId, agentRole, false);
            sentMessages.push(msg);
        }
        if (template.mediaUrl) {
            const mediaMsg = await this.sendMedia(tenantId, conversationId, agentId, agentRole, {
                fileUrl: template.mediaUrl,
                mediaType: template.mediaType || 'photo',
                caption: template.mediaCaption || undefined,
            });
            sentMessages.push(mediaMsg);
        }
        if (Array.isArray(template.attachments)) {
            for (const att of template.attachments) {
                if (!att?.url)
                    continue;
                try {
                    const m = await this.sendMedia(tenantId, conversationId, agentId, agentRole, {
                        fileUrl: att.url,
                        mimeType: att.mimeType,
                        mediaType: att.type || 'photo',
                        caption: att.caption,
                    });
                    sentMessages.push(m);
                }
                catch (e) {
                }
            }
        }
        return { sent: sentMessages.length, messages: sentMessages };
    }
    async sendInvoiceFromInbox(tenantId, conversationId, agentId, agentRole, data) {
        const conv = await this.prisma.conversation.findFirst({
            where: { id: conversationId, tenantId },
            include: { client: true },
        });
        if (!conv)
            throw new common_1.NotFoundException('Suhbat topilmadi');
        if (!conv.clientId)
            throw new common_1.BadRequestException('Suhbatga klient bog\'lanmagan');
        const booking = await this.prisma.booking.findFirst({
            where: { id: data.bookingId, tenantId, clientId: conv.clientId },
            include: {
                services: {
                    where: { status: { not: 'CANCELLED' } },
                    orderBy: { createdAt: 'asc' },
                },
            },
        });
        if (!booking)
            throw new common_1.NotFoundException('Booking topilmadi');
        const year = new Date().getFullYear();
        const lastInv = await this.prisma.invoice.findFirst({
            where: { tenantId, invoiceNumber: { startsWith: `INV-${year}-` } },
            orderBy: { invoiceNumber: 'desc' },
        });
        let seq = 1;
        if (lastInv) {
            const lastSeq = parseInt(lastInv.invoiceNumber.split('-')[2], 10);
            if (!isNaN(lastSeq))
                seq = lastSeq + 1;
        }
        const invoiceNumber = `INV-${year}-${String(seq).padStart(4, '0')}`;
        const salePrice = Number(data.salePrice) || booking.totalPrice;
        const providerCost = agentRole === 'AGENT' ? 0 : (Number(data.providerCost) || 0);
        const discount = Number(data.discount) || 0;
        const profit = Math.max(0, salePrice - providerCost - discount);
        const totalAmount = salePrice - discount;
        const invoice = await this.prisma.invoice.create({
            data: {
                tenantId,
                invoiceNumber,
                bookingId: booking.id,
                clientId: conv.clientId,
                agentId,
                salePrice,
                providerCost,
                discount,
                profit,
                totalAmount,
                paidAmount: 0,
                currency: (data.currency || booking.currency),
                status: 'SENT',
                dueDate: data.dueDate ? new Date(data.dueDate) : null,
                notes: data.notes,
                issuedAt: new Date(),
                sentAt: new Date(),
                sentViaTelegram: true,
            },
        });
        const invoiceText = this.formatInvoiceMessage(invoice, booking, conv.client);
        const msg = await this.sendMessage(tenantId, conversationId, invoiceText, agentId, agentRole, false);
        return { invoice, message: msg };
    }
    formatInvoiceMessage(invoice, booking, client) {
        const lines = [
            `🧾 *HISOB-FAKTURA*`,
            `📋 № ${invoice.invoiceNumber}`,
            ``,
            `👤 *Mijoz:* ${client?.fullName || '—'}`,
            `✈️ *Tour:* ${booking.tourName}`,
            `📍 *Yo'nalish:* ${booking.destination}`,
        ];
        if (booking.departureDate) {
            const d = new Date(booking.departureDate);
            lines.push(`📅 *Ketish:* ${d.toLocaleDateString('uz-UZ')}`);
        }
        if (booking.returnDate) {
            const d = new Date(booking.returnDate);
            lines.push(`🔙 *Qaytish:* ${d.toLocaleDateString('uz-UZ')}`);
        }
        if (booking.adults || booking.children) {
            lines.push(`👥 *Sayohatchilar:* ${booking.adults || 0} kattalar + ${booking.children || 0} bolalar`);
        }
        if (booking.hotelName) {
            lines.push(``, `🏨 *MEHMONXONA*`);
            lines.push(`• ${booking.hotelName}${booking.hotelStars ? ` ${'⭐'.repeat(booking.hotelStars)}` : ''}`);
            if (booking.hotelCity)
                lines.push(`• Shahar: ${booking.hotelCity}`);
            if (booking.hotelAddress)
                lines.push(`• Manzil: ${booking.hotelAddress}`);
            if (booking.hotelCheckIn)
                lines.push(`• Check-in: ${new Date(booking.hotelCheckIn).toLocaleDateString('uz-UZ')}`);
            if (booking.hotelCheckOut)
                lines.push(`• Check-out: ${new Date(booking.hotelCheckOut).toLocaleDateString('uz-UZ')}`);
        }
        if (booking.flightNumber || booking.flightDeparture) {
            lines.push(``, `✈️ *REYS*`);
            if (booking.flightNumber)
                lines.push(`• Reys: ${booking.flightNumber}`);
            if (booking.flightDeparture)
                lines.push(`• Ketish: ${booking.flightDeparture}`);
            if (booking.flightArrival)
                lines.push(`• Borish: ${booking.flightArrival}`);
            if (booking.flightClass)
                lines.push(`• Klass: ${booking.flightClass}`);
        }
        if (booking.taxiPickupAddress || booking.taxiCompany) {
            lines.push(``, `🚕 *TRANSFER*`);
            if (booking.taxiPickupAddress)
                lines.push(`• Olib ketish: ${booking.taxiPickupAddress}`);
            if (booking.taxiDropoffAddress)
                lines.push(`• Olib boorish: ${booking.taxiDropoffAddress}`);
            if (booking.taxiPickupTime)
                lines.push(`• Vaqt: ${new Date(booking.taxiPickupTime).toLocaleString('uz-UZ')}`);
            if (booking.taxiCompany)
                lines.push(`• Kompaniya: ${booking.taxiCompany}`);
            if (booking.taxiDriverName)
                lines.push(`• Haydovchi: ${booking.taxiDriverName} ${booking.taxiDriverPhone ? `(${booking.taxiDriverPhone})` : ''}`);
        }
        if (booking.insuranceCompany) {
            lines.push(``, `🛡 *SUG'URTA*`);
            lines.push(`• Kompaniya: ${booking.insuranceCompany}`);
            if (booking.insurancePolicyNo)
                lines.push(`• Polisa №: ${booking.insurancePolicyNo}`);
            if (booking.insuranceCoverage)
                lines.push(`• Qoplama: ${booking.insuranceCoverage}`);
        }
        if (booking.visaStatus && booking.visaStatus !== 'not_required') {
            lines.push(``, `🛂 *VIZA*`);
            lines.push(`• Holat: ${booking.visaStatus}`);
            if (booking.visaType)
                lines.push(`• Turi: ${booking.visaType}`);
            if (booking.visaExpiryDate)
                lines.push(`• Amal qiladi: ${new Date(booking.visaExpiryDate).toLocaleDateString('uz-UZ')}`);
        }
        if (booking.services && booking.services.length > 0) {
            lines.push(``, `🛎 *QO'SHIMCHA XIZMATLAR*`);
            for (const s of booking.services) {
                const qty = s.quantity > 1 ? ` × ${s.quantity}` : '';
                lines.push(`• ${s.name}${qty} — ${invoice.currency} ${s.totalAmount.toFixed(2)}`);
                if (s.fromLocation && s.toLocation) {
                    lines.push(`   📍 ${s.fromLocation} → ${s.toLocation}`);
                }
                if (s.date) {
                    const d = new Date(s.date).toLocaleDateString('uz-UZ');
                    lines.push(`   📅 ${d}${s.time ? ' ' + s.time : ''}`);
                }
                if (s.providerName) {
                    lines.push(`   🏢 ${s.providerName}${s.providerPhone ? ` (${s.providerPhone})` : ''}`);
                }
                if (s.notes)
                    lines.push(`   📝 ${s.notes}`);
            }
        }
        lines.push(``, `💰 *NARX TAFSILOTI*`);
        lines.push(`• Jami narx: ${invoice.currency} ${invoice.salePrice.toFixed(2)}`);
        if (invoice.discount > 0) {
            lines.push(`• Chegirma: -${invoice.currency} ${invoice.discount.toFixed(2)}`);
        }
        lines.push(`• ✅ *To'lash kerak: ${invoice.currency} ${invoice.totalAmount.toFixed(2)}*`);
        if (booking.paidAmount > 0) {
            lines.push(`• To'langan: ${invoice.currency} ${booking.paidAmount.toFixed(2)}`);
            const remaining = invoice.totalAmount - booking.paidAmount;
            if (remaining > 0) {
                lines.push(`• ⏳ *Qoldiq: ${invoice.currency} ${remaining.toFixed(2)}*`);
            }
        }
        if (invoice.dueDate) {
            const due = new Date(invoice.dueDate);
            lines.push(``, `⏰ *To'lov muddati:* ${due.toLocaleDateString('uz-UZ')}`);
        }
        if (invoice.notes) {
            lines.push(``, `📝 ${invoice.notes}`);
        }
        lines.push(``, `💳 *To'lov qabul qilamiz:*`);
        lines.push(`• Naqd pul`);
        lines.push(`• Bank kartasi`);
        lines.push(`• Payme / Click / Uzum`);
        return lines.join('\n');
    }
    async claim(tenantId, conversationId, userId) {
        const conv = await this.prisma.conversation.findFirst({
            where: { id: conversationId, tenantId },
        });
        if (!conv)
            throw new common_1.NotFoundException('Suhbat topilmadi');
        if (conv.assignedAgentId && conv.assignedAgentId !== userId) {
            throw new common_1.BadRequestException('Bu suhbatni boshqa agent olgan');
        }
        return this.prisma.conversation.update({
            where: { id: conversationId },
            data: { assignedAgentId: userId },
        });
    }
    async connectBot(tenantId, token, name, userId) {
        if (!token?.trim())
            throw new common_1.BadRequestException('Token kerak');
        const tempBot = new node_telegram_bot_api_1.default(token);
        const info = await tempBot.getMe().catch(() => {
            throw new common_1.BadRequestException('Token noto\'g\'ri');
        });
        const dup = await this.prisma.telegramAccount.findFirst({
            where: { tenantId, botToken: token },
        });
        if (dup)
            throw new common_1.BadRequestException('Bu bot allaqachon ulangan');
        const acc = await this.prisma.telegramAccount.create({
            data: {
                tenantId, name: name?.trim() || info.first_name,
                botToken: token, botUsername: info.username,
                channel: 'TELEGRAM', isActive: true,
                userId: userId || null,
            },
        });
        await this.startBot(acc.id, tenantId, token);
        return { ...acc, botToken: undefined };
    }
    async startNewConversation(tenantId, userId, data) {
        if (!data.text?.trim())
            throw new common_1.BadRequestException('Xabar matni kerak');
        let accountWhere = { tenantId, isActive: true, botToken: { not: null } };
        if (data.accountId)
            accountWhere.id = data.accountId;
        else
            accountWhere.OR = [{ userId }, { userId: null }];
        const account = await this.prisma.telegramAccount.findFirst({
            where: accountWhere,
            orderBy: { createdAt: 'asc' },
        });
        if (!account) {
            throw new common_1.BadRequestException('Bot ulanmagan. Settings → Telegram bo\'limidan bot tokeningizni qo\'shing');
        }
        if (!data.chatId && !data.username) {
            throw new common_1.BadRequestException("Chat ID yoki username kerak. Eslatma: Telegram bot username orqali xabar yubora olmaydi - " +
                "klient avval botingiz bilan /start yozishi kerak.");
        }
        const bot = this.bots.get(account.id);
        if (!bot)
            throw new common_1.BadRequestException('Bot ishlamayapti');
        try {
            const targetChat = data.chatId || data.username;
            const sent = await bot.sendMessage(targetChat, data.text);
            const externalChatId = String(sent.chat.id);
            let conv = await this.prisma.conversation.findFirst({
                where: { tenantId, channel: 'TELEGRAM', externalChatId },
            });
            if (!conv) {
                conv = await this.prisma.conversation.create({
                    data: {
                        tenantId,
                        accountId: account.id,
                        clientId: data.clientId,
                        assignedAgentId: userId,
                        channel: 'TELEGRAM',
                        externalChatId,
                        firstName: sent.chat.first_name,
                        lastName: sent.chat.last_name,
                        username: sent.chat.username,
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
                        assignedAgentId: conv.assignedAgentId || userId,
                        clientId: conv.clientId || data.clientId,
                    },
                });
            }
            await this.prisma.message.create({
                data: {
                    conversationId: conv.id,
                    agentId: userId,
                    direction: 'OUTBOUND',
                    messageType: 'TEXT',
                    text: data.text,
                    externalMsgId: String(sent.message_id),
                    isDelivered: true,
                },
            });
            return { conversationId: conv.id, ok: true };
        }
        catch (e) {
            throw new common_1.BadRequestException(e.message?.includes('chat not found')
                ? "Klient bot bilan /start yozmagan. Klient avval botingizga yozishi kerak."
                : `Telegram xato: ${e.message}`);
        }
    }
    async disconnectBot(tenantId, accountId) {
        const acc = await this.prisma.telegramAccount.findFirst({
            where: { id: accountId, tenantId },
        });
        if (!acc)
            throw new common_1.NotFoundException('Topilmadi');
        const bot = this.bots.get(accountId);
        if (bot) {
            try {
                await bot.stopPolling();
            }
            catch { }
            this.bots.delete(accountId);
        }
        return this.prisma.telegramAccount.update({
            where: { id: accountId },
            data: { isActive: false },
        });
    }
    async getConversations(tenantId, userId, role, params) {
        const { skip, take, page, limit } = (0, helpers_1.paginate)(params.page, params.limit);
        const where = { tenantId };
        if (params.resolved !== undefined)
            where.isResolved = params.resolved === 'true';
        if (params.channel)
            where.channel = params.channel;
        if (params.unassigned === 'true')
            where.assignedAgentId = null;
        else if (role === 'AGENT') {
            where.OR = [{ assignedAgentId: userId }, { assignedAgentId: null }];
        }
        else if (params.agentId) {
            where.assignedAgentId = params.agentId;
        }
        const [data, total] = await Promise.all([
            this.prisma.conversation.findMany({
                where, skip, take,
                include: {
                    client: { select: { id: true, fullName: true, tier: true } },
                    account: { select: { id: true, name: true, botUsername: true, channel: true, isPersonal: true } },
                },
                orderBy: [
                    { isPinned: 'desc' },
                    { lastMessageAt: { sort: 'desc', nulls: 'last' } },
                ],
            }),
            this.prisma.conversation.count({ where }),
        ]);
        const enriched = data.map((conv) => ({
            ...conv,
            isPersonal: conv.account?.isPersonal ?? false,
        }));
        return { data: enriched, meta: (0, helpers_1.meta)(total, page, limit) };
    }
    async getMessages(tenantId, userId, role, conversationId) {
        const where = { id: conversationId, tenantId };
        if (role === 'AGENT') {
            where.OR = [{ assignedAgentId: userId }, { assignedAgentId: null }];
        }
        const conv = await this.prisma.conversation.findFirst({ where });
        if (!conv)
            throw new common_1.NotFoundException('Topilmadi');
        await this.prisma.conversation.update({
            where: { id: conversationId },
            data: { unreadCount: 0 },
        });
        await this.prisma.message.updateMany({
            where: { conversationId, direction: 'INBOUND', isRead: false },
            data: { isRead: true },
        });
        const messages = await this.prisma.message.findMany({
            where: { conversationId },
            include: { agent: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'asc' },
            take: 200,
        });
        return { messages, conversation: conv };
    }
    async assignAgent(tenantId, conversationId, agentId) {
        if (agentId) {
            const agent = await this.prisma.user.findFirst({
                where: { id: agentId, tenantId, status: 'ACTIVE' },
            });
            if (!agent)
                throw new common_1.NotFoundException('Agent topilmadi');
        }
        const res = await this.prisma.conversation.updateMany({
            where: { id: conversationId, tenantId },
            data: { assignedAgentId: agentId },
        });
        if (!res.count)
            throw new common_1.NotFoundException('Suhbat topilmadi');
        return { ok: true };
    }
    async resolve(tenantId, conversationId) {
        const res = await this.prisma.conversation.updateMany({
            where: { id: conversationId, tenantId },
            data: { isResolved: true, unreadCount: 0 },
        });
        if (!res.count)
            throw new common_1.NotFoundException('Suhbat topilmadi');
        return { ok: true };
    }
    async linkClient(tenantId, conversationId, clientId) {
        const conv = await this.prisma.conversation.findFirst({
            where: { id: conversationId, tenantId },
        });
        if (!conv)
            throw new common_1.NotFoundException('Suhbat topilmadi');
        const client = await this.prisma.client.findFirst({
            where: { id: clientId, tenantId },
        });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        await this.prisma.conversation.update({
            where: { id: conversationId },
            data: { clientId },
        });
        if (conv.externalUserId && conv.channel === 'TELEGRAM') {
            await this.prisma.client.update({
                where: { id: clientId },
                data: { telegramId: conv.externalUserId, telegramUsername: conv.username },
            });
        }
        return { ok: true };
    }
    async getAccounts(tenantId) {
        return this.prisma.telegramAccount.findMany({
            where: { tenantId },
            select: { id: true, name: true, botUsername: true, channel: true, isActive: true, createdAt: true },
        });
    }
    async getTemplates(tenantId, userId, role, filters) {
        const where = {
            tenantId, isActive: true,
            ...(role === 'AGENT' ? { OR: [{ userId }, { userId: null }] } : {}),
        };
        if (filters?.category)
            where.category = filters.category;
        if (filters?.language && ['UZ', 'RU', 'EN'].includes(filters.language)) {
            where.language = filters.language;
        }
        return this.prisma.messageTemplate.findMany({
            where,
            orderBy: [{ category: 'asc' }, { useCount: 'desc' }],
        });
    }
    async createTemplate(tenantId, userId, role, data) {
        if (!data.name?.trim() || !data.text?.trim()) {
            throw new common_1.BadRequestException('name va text majburiy');
        }
        const lang = ['UZ', 'RU', 'EN'].includes(data.language) ? data.language : 'UZ';
        const ownerId = role === 'AGENT' || data.isPersonal ? userId : null;
        const attachments = Array.isArray(data.attachments) ? data.attachments : [];
        return this.prisma.messageTemplate.create({
            data: {
                tenantId, userId: ownerId,
                name: data.name.trim(), text: data.text.trim(),
                language: lang, category: data.category,
                mediaUrl: data.mediaUrl || null,
                mediaType: data.mediaType || null,
                mediaCaption: data.mediaCaption || null,
                attachments,
            },
        });
    }
    async updateTemplate(tenantId, userId, role, id, data) {
        const tpl = await this.prisma.messageTemplate.findFirst({ where: { id, tenantId } });
        if (!tpl)
            throw new common_1.NotFoundException('Topilmadi');
        if (role === 'AGENT' && tpl.userId !== userId) {
            throw new common_1.BadRequestException('Bu shablon sizga tegishli emas');
        }
        const safe = {};
        if (data.name?.trim())
            safe.name = data.name.trim();
        if (data.text?.trim())
            safe.text = data.text.trim();
        if (data.category !== undefined)
            safe.category = data.category;
        if (data.mediaUrl !== undefined)
            safe.mediaUrl = data.mediaUrl;
        if (data.mediaType !== undefined)
            safe.mediaType = data.mediaType;
        if (data.mediaCaption !== undefined)
            safe.mediaCaption = data.mediaCaption;
        if (Array.isArray(data.attachments))
            safe.attachments = data.attachments;
        if (data.language && ['UZ', 'RU', 'EN'].includes(data.language))
            safe.language = data.language;
        if (typeof data.isActive === 'boolean')
            safe.isActive = data.isActive;
        return this.prisma.messageTemplate.update({ where: { id }, data: safe });
    }
    async deleteTemplate(tenantId, userId, role, id) {
        const tpl = await this.prisma.messageTemplate.findFirst({ where: { id, tenantId } });
        if (!tpl)
            throw new common_1.NotFoundException('Topilmadi');
        if (role === 'AGENT' && tpl.userId !== userId) {
            throw new common_1.BadRequestException('Bu shablon sizga tegishli emas');
        }
        await this.prisma.messageTemplate.update({
            where: { id }, data: { isActive: false },
        });
        return { ok: true };
    }
};
exports.TelegramService = TelegramService;
exports.TelegramService = TelegramService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_service_1.NotificationsService,
        clients_service_1.ClientsService,
        realtime_gateway_1.RealtimeGateway])
], TelegramService);
let TelegramController = class TelegramController {
    constructor(svc) {
        this.svc = svc;
    }
    accounts(u) {
        return this.svc.getAccounts(u.tenantId);
    }
    connect(body, u) {
        return this.svc.connectBot(u.tenantId, body.token, body.name);
    }
    connectPersonal(body, u) {
        return this.svc.connectBot(u.tenantId, body.token, body.name, u.sub);
    }
    disconnect(id, u) {
        return this.svc.disconnectBot(u.tenantId, id);
    }
    startNew(body, u) {
        return this.svc.startNewConversation(u.tenantId, u.sub, body);
    }
    async conversations(u, resolved, channel, agentId, unassigned, page, limit) {
        const res = await this.svc.getConversations(u.tenantId, u.sub, u.role, {
            resolved, channel, agentId, unassigned,
            page: page || 1, limit: limit || 100,
        });
        return res.data;
    }
    messages(id, u) {
        return this.svc.getMessages(u.tenantId, u.sub, u.role, id);
    }
    send(id, body, u) {
        return this.svc.sendMessage(u.tenantId, id, body.text, u.sub, u.role, !!body.isInternal);
    }
    sendMedia(id, body, u) {
        return this.svc.sendMedia(u.tenantId, id, u.sub, u.role, body);
    }
    sendTemplate(id, templateId, u) {
        return this.svc.sendTemplate(u.tenantId, id, u.sub, u.role, templateId);
    }
    sendInvoice(id, body, u) {
        return this.svc.sendInvoiceFromInbox(u.tenantId, id, u.sub, u.role, body);
    }
    assign(id, body, u) {
        return this.svc.assignAgent(u.tenantId, id, body.agentId || null);
    }
    claim(id, u) {
        return this.svc.claim(u.tenantId, id, u.sub);
    }
    resolve(id, u) {
        return this.svc.resolve(u.tenantId, id);
    }
    link(id, body, u) {
        return this.svc.linkClient(u.tenantId, id, body.clientId);
    }
    templates(u, category, language) {
        return this.svc.getTemplates(u.tenantId, u.sub, u.role, { category, language });
    }
    createTemplate(body, u) {
        return this.svc.createTemplate(u.tenantId, u.sub, u.role, body);
    }
    updateTemplate(id, body, u) {
        return this.svc.updateTemplate(u.tenantId, u.sub, u.role, id, body);
    }
    deleteTemplate(id, u) {
        return this.svc.deleteTemplate(u.tenantId, u.sub, u.role, id);
    }
};
exports.TelegramController = TelegramController;
__decorate([
    (0, common_1.Get)('accounts'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "accounts", null);
__decorate([
    (0, common_1.Post)('accounts'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "connect", null);
__decorate([
    (0, common_1.Post)('accounts/personal'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "connectPersonal", null);
__decorate([
    (0, common_1.Delete)('accounts/:id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "disconnect", null);
__decorate([
    (0, common_1.Post)('conversations/new'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "startNew", null);
__decorate([
    (0, common_1.Get)('conversations'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('resolved')),
    __param(2, (0, common_1.Query)('channel')),
    __param(3, (0, common_1.Query)('agentId')),
    __param(4, (0, common_1.Query)('unassigned')),
    __param(5, (0, common_1.Query)('page')),
    __param(6, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], TelegramController.prototype, "conversations", null);
__decorate([
    (0, common_1.Get)('conversations/:id/messages'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "messages", null);
__decorate([
    (0, common_1.Post)('conversations/:id/messages'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "send", null);
__decorate([
    (0, common_1.Post)('conversations/:id/media'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "sendMedia", null);
__decorate([
    (0, common_1.Post)('conversations/:id/template/:templateId'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Param)('templateId')),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "sendTemplate", null);
__decorate([
    (0, common_1.Post)('conversations/:id/send-invoice'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "sendInvoice", null);
__decorate([
    (0, common_1.Patch)('conversations/:id/assign'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "assign", null);
__decorate([
    (0, common_1.Patch)('conversations/:id/claim'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "claim", null);
__decorate([
    (0, common_1.Patch)('conversations/:id/resolve'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "resolve", null);
__decorate([
    (0, common_1.Patch)('conversations/:id/link-client'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "link", null);
__decorate([
    (0, common_1.Get)('templates'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('category')),
    __param(2, (0, common_1.Query)('language')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "templates", null);
__decorate([
    (0, common_1.Post)('templates'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "createTemplate", null);
__decorate([
    (0, common_1.Patch)('templates/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "updateTemplate", null);
__decorate([
    (0, common_1.Delete)('templates/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], TelegramController.prototype, "deleteTemplate", null);
exports.TelegramController = TelegramController = __decorate([
    (0, common_1.Controller)('telegram'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [TelegramService])
], TelegramController);
let TelegramModule = class TelegramModule {
};
exports.TelegramModule = TelegramModule;
exports.TelegramModule = TelegramModule = __decorate([
    (0, common_1.Module)({
        controllers: [TelegramController],
        providers: [TelegramService, clients_service_1.ClientsService],
        exports: [TelegramService],
    })
], TelegramModule);
//# sourceMappingURL=telegram.module.js.map