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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
;
const email_service_1 = require("../email/email.service");
const realtime_gateway_1 = require("../realtime/realtime.gateway");
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
let NotificationsService = class NotificationsService {
    constructor(prisma, email, realtime) {
        this.prisma = prisma;
        this.email = email;
        this.realtime = realtime;
        this.logger = new common_1.Logger('Notifications');
    }
    async create(data) {
        const notification = await this.prisma.notification.create({
            data: {
                tenantId: data.tenantId,
                userId: data.userId,
                type: data.type,
                title: data.title,
                body: data.body,
                link: data.link,
                metadata: data.metadata || {},
            },
        });
        try {
            this.realtime.emitToUser(data.userId, 'notification:new', notification);
        }
        catch (e) {
            this.logger.warn(`WebSocket xatosi: ${e.message}`);
        }
        const user = await this.prisma.user.findUnique({
            where: { id: data.userId },
            select: {
                name: true, email: true, telegramId: true,
                notifyEmail: true, notifyTelegram: true,
            },
        });
        if (!user)
            return notification;
        if (user.notifyEmail && user.email && this.shouldSendEmail(data.type)) {
            this.email
                .send({
                to: user.email,
                toName: user.name,
                tenantId: data.tenantId,
                subject: data.title,
                html: this.buildEmailHtml(data, user.name),
            })
                .catch((e) => this.logger.error(`Email yuborilmadi: ${e.message}`));
        }
        if (user.notifyTelegram && user.telegramId) {
            this.sendTelegramAlert(user.telegramId, data).catch((e) => this.logger.error(`Telegram yuborilmadi: ${e.message}`));
        }
        return notification;
    }
    shouldSendEmail(type) {
        const emailWorthy = [
            'LEAD_NEW', 'LEAD_ASSIGNED',
            'BOOKING_CREATED', 'PAYMENT_RECEIVED',
            'TASK_ASSIGNED', 'FOLLOWUP_DUE',
            'SECURITY_NEW_LOGIN', 'SECURITY_FAILED_LOGIN',
            'SECURITY_2FA_ENABLED', 'SECURITY_PASSWORD_CHANGED',
            'SECURITY_SUSPICIOUS_ACTIVITY',
            'MENTION',
        ];
        return emailWorthy.includes(type);
    }
    buildEmailHtml(data, name) {
        const linkBtn = data.link
            ? `<p style="text-align:center;margin:20px 0;">
          <a href="${process.env.FRONTEND_URL}${data.link}" 
             style="background:#3d7eff;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
            CRM'da ko'rish →
          </a>
        </p>`
            : '';
        return `
<!DOCTYPE html><html><body style="margin:0;background:#f4f6fb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="600" style="background:#fff;border-radius:12px;overflow:hidden;">
<tr><td style="padding:24px 30px;background:linear-gradient(135deg,#3d7eff,#a855f7);color:#fff;">
<h1 style="margin:0;font-size:20px;">Omon CRM</h1>
</td></tr>
<tr><td style="padding:30px;color:#1a1f2e;line-height:1.6;">
<h2 style="margin:0 0 12px;font-size:18px;">${data.title}</h2>
<p>Salom, <b>${name}</b>!</p>
${data.body ? `<p style="background:#f4f6fb;padding:14px;border-radius:8px;">${data.body}</p>` : ''}
${linkBtn}
</td></tr>
<tr><td style="padding:16px 30px;background:#f8fafc;color:#94a3b8;font-size:11px;">
© ${new Date().getFullYear()} Omon CRM
</td></tr></table>
</td></tr></table>
</body></html>`;
    }
    async sendTelegramAlert(chatId, data) {
        const token = process.env.TELEGRAM_NOTIFY_BOT_TOKEN;
        if (!token)
            return;
        try {
            const bot = new node_telegram_bot_api_1.default(token);
            const link = data.link ? `\n\n${process.env.FRONTEND_URL}${data.link}` : '';
            await bot.sendMessage(chatId, `*${data.title}*\n${data.body || ''}${link}`, {
                parse_mode: 'Markdown',
            });
        }
        catch (e) {
            this.logger.warn(`Telegram ${chatId}: ${e.message}`);
        }
    }
    async createBulk(notifications) {
        return Promise.all(notifications.map((n) => this.create(n)));
    }
    async list(userId, unreadOnly = false, limit = 50) {
        return this.prisma.notification.findMany({
            where: { userId, ...(unreadOnly ? { isRead: false } : {}) },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
    async unreadCount(userId) {
        const count = await this.prisma.notification.count({
            where: { userId, isRead: false },
        });
        return { count };
    }
    async markRead(userId, id, tenantId) {
        if (!id || !id.match(/^[a-zA-Z0-9_-]+$/)) {
            throw new Error('Invalid notification ID format');
        }
        const notification = await this.prisma.notification.findFirst({
            where: { id, userId, tenantId },
            select: { id: true },
        });
        if (!notification) {
            throw new Error('Notification not found or access denied');
        }
        const updated = await this.prisma.notification.updateMany({
            where: { id, userId, tenantId },
            data: { isRead: true, readAt: new Date() },
        });
        if (updated.count === 0) {
            throw new Error('Failed to update notification');
        }
        this.realtime.emitToUser(userId, 'notification:read', { id });
        return { ok: true };
    }
    async markAllRead(userId, tenantId) {
        const result = await this.prisma.notification.updateMany({
            where: { userId, tenantId, isRead: false },
            data: { isRead: true, readAt: new Date() },
        });
        this.realtime.emitToUser(userId, 'notification:readAll', {});
        return { ok: true, updated: result.count };
    }
    async delete(userId, id, tenantId) {
        if (!id || !id.match(/^[a-zA-Z0-9_-]+$/)) {
            throw new Error('Invalid notification ID format');
        }
        const notification = await this.prisma.notification.findFirst({
            where: { id, userId, tenantId },
            select: { id: true },
        });
        if (!notification) {
            throw new Error('Notification not found or access denied');
        }
        const deleted = await this.prisma.notification.deleteMany({
            where: { id, userId, tenantId },
        });
        if (deleted.count === 0) {
            throw new Error('Failed to delete notification');
        }
        this.realtime.emitToUser(userId, 'notification:deleted', { id });
        return { ok: true };
    }
    async deleteAll(userId, tenantId) {
        const result = await this.prisma.notification.deleteMany({
            where: { userId, tenantId },
        });
        this.logger.log(`User ${userId} deleted ${result.count} notifications`);
        this.realtime.emitToUser(userId, 'notification:deletedAll', { count: result.count });
        return { ok: true, deleted: result.count };
    }
};
exports.NotificationsService = NotificationsService;
exports.NotificationsService = NotificationsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        email_service_1.EmailService,
        realtime_gateway_1.RealtimeGateway])
], NotificationsService);
//# sourceMappingURL=notifications.service.js.map