import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType } from '../../prisma-types';;
import { EmailService } from '../email/email.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import TelegramBot from 'node-telegram-bot-api';

interface CreateNotificationDto {
  tenantId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  metadata?: any;
}

/**
 * Notifications Service
 *
 * Har bildirishnoma 3 kanalda yuborilishi mumkin:
 * 1. In-app (database + websocket realtime)
 * 2. Email (SendGrid)
 * 3. Telegram (user telegramId bo'lsa)
 *
 * Foydalanuvchi sozlamalariga qarab kanallar tanlanadi.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    private prisma: PrismaService,
    private email: EmailService,
    private realtime: RealtimeGateway,
  ) {}

  async create(data: CreateNotificationDto) {
    // 1. Database'ga yozish (in-app)
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

    // 2. WebSocket orqali real-time yuborish
    try {
      this.realtime.emitToUser(data.userId, 'notification:new', notification);
    } catch (e: any) {
      this.logger.warn(`WebSocket xatosi: ${e.message}`);
    }

    // 3. User sozlamalari va kanallarini olish
    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
      select: {
        name: true, email: true, telegramId: true,
        notifyEmail: true, notifyTelegram: true,
      },
    });
    if (!user) return notification;

    // 4. Email yuborish (parallel — javob kutmaymiz)
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

    // 5. Telegram yuborish (parallel)
    if (user.notifyTelegram && user.telegramId) {
      this.sendTelegramAlert(user.telegramId, data).catch((e) =>
        this.logger.error(`Telegram yuborilmadi: ${e.message}`),
      );
    }

    return notification;
  }

  /** Qaysi turdagi xabarlar email bilan yuborilsin (spam bo'lmasin) */
  private shouldSendEmail(type: NotificationType): boolean {
    const emailWorthy: NotificationType[] = [
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

  private buildEmailHtml(data: CreateNotificationDto, name: string): string {
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

  /** Telegram orqali xabar yuborish (botToken kerak) */
  private async sendTelegramAlert(chatId: string, data: CreateNotificationDto) {
    const token = process.env.TELEGRAM_NOTIFY_BOT_TOKEN;
    if (!token) return; // bot ulanmagan
    try {
      const bot = new TelegramBot(token);
      const link = data.link ? `\n\n${process.env.FRONTEND_URL}${data.link}` : '';
      await bot.sendMessage(chatId, `*${data.title}*\n${data.body || ''}${link}`, {
        parse_mode: 'Markdown',
      });
    } catch (e: any) {
      // Foydalanuvchi botni bloklagan bo'lishi mumkin — log faqat
      this.logger.warn(`Telegram ${chatId}: ${e.message}`);
    }
  }

  async createBulk(notifications: CreateNotificationDto[]) {
    return Promise.all(notifications.map((n) => this.create(n)));
  }

  async list(userId: string, unreadOnly = false, limit = 50) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { isRead: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, isRead: false },
    });
    return { count };
  }

  // v9-SECURITY: Proper error handling + tenantId verification
  async markRead(userId: string, id: string, tenantId: string) {
    // SECURITY: Validate ID format first (prevent injection)
    if (!id || !id.match(/^[a-zA-Z0-9_-]+$/)) {
      throw new Error('Invalid notification ID format');
    }

    // SECURITY: Verify notification exists AND belongs to this user + tenant
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId, tenantId },
      select: { id: true },
    });

    if (!notification) {
      throw new Error('Notification not found or access denied');
    }

    // UPDATE with double-verified WHERE clause
    const updated = await this.prisma.notification.updateMany({
      where: { id, userId, tenantId }, // ✅ SECURITY: Include tenantId
      data: { isRead: true, readAt: new Date() },
    });

    if (updated.count === 0) {
      throw new Error('Failed to update notification');
    }

    this.realtime.emitToUser(userId, 'notification:read', { id });
    return { ok: true };
  }

  async markAllRead(userId: string, tenantId: string) {
    // SECURITY: Include tenantId in query
    const result = await this.prisma.notification.updateMany({
      where: { userId, tenantId, isRead: false }, // ✅ SECURITY: Include tenantId
      data: { isRead: true, readAt: new Date() },
    });
    this.realtime.emitToUser(userId, 'notification:readAll', {});
    return { ok: true, updated: result.count };
  }

  // v9-SECURITY: Proper deletion with authorization
  async delete(userId: string, id: string, tenantId: string) {
    // SECURITY: Validate ID format
    if (!id || !id.match(/^[a-zA-Z0-9_-]+$/)) {
      throw new Error('Invalid notification ID format');
    }

    // SECURITY: Verify existence first
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId, tenantId },
      select: { id: true },
    });

    if (!notification) {
      throw new Error('Notification not found or access denied');
    }

    // DELETE with verified WHERE
    const deleted = await this.prisma.notification.deleteMany({
      where: { id, userId, tenantId }, // ✅ SECURITY: Include tenantId
    });

    if (deleted.count === 0) {
      throw new Error('Failed to delete notification');
    }

    this.realtime.emitToUser(userId, 'notification:deleted', { id });
    return { ok: true };
  }

  // v9-SECURITY: Delete all with proper logging
  async deleteAll(userId: string, tenantId: string) {
    // SECURITY: Include tenantId in query
    const result = await this.prisma.notification.deleteMany({
      where: { userId, tenantId }, // ✅ SECURITY: Include tenantId
    });
    this.logger.log(`User ${userId} deleted ${result.count} notifications`);
    this.realtime.emitToUser(userId, 'notification:deletedAll', { count: result.count });
    return { ok: true, deleted: result.count };
  }
}
