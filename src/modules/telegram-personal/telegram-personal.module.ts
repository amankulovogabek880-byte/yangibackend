import {
  Module, Injectable, Controller, Logger,
  Post, Get, Body, Param, UseGuards,
  BadRequestException, NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { Api } from 'telegram/tl';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EncryptionService } from '../../common/encryption/encryption.service';

// ─── SESSION STORE (memory — faqat aktiv ulanganlar uchun) ──
// Bu Map restart bo'lsa yo'qoladi, lekin bu OK —
// chunki session DB da saqlangan, getClient() qayta ulanadi
const activeSessions = new Map<string, TelegramClient>();

// ─── SERVICE ───────────────────────────────────────────────────
@Injectable()
export class TelegramPersonalService {
  private readonly logger = new Logger('TelegramPersonal');

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private encryption: EncryptionService,
  ) {}

  // ── getOrCreateClient ──────────────────────────────────────
  private async getClient(userId: string, tenantId: string): Promise<TelegramClient> {
    if (activeSessions.has(userId)) {
      const c = activeSessions.get(userId)!;
      if (c.connected) return c;
    }

    const acct = await (this.prisma as any).telegramAccount.findFirst({
      where: { userId, tenantId, isPersonal: true, isActive: true },
    });
    if (!acct) throw new NotFoundException('Telegram akkaunt ulanmagan');

    const apiId   = parseInt(acct.apiId || process.env.TELEGRAM_API_ID || '0');
    const apiHash = acct.apiHash
      ? this.encryption.decrypt(acct.apiHash)
      : (process.env.TELEGRAM_API_HASH || '');
    const session = acct.sessionData
      ? this.encryption.decrypt(acct.sessionData)
      : '';

    const client = new TelegramClient(
      new StringSession(session),
      apiId, apiHash,
      { connectionRetries: 5, useWSS: false },
    );
    await client.connect();
    activeSessions.set(userId, client);

    client.addEventHandler(async (event: any) => {
      await this.handleIncoming(event, userId, tenantId);
    }, new NewMessage({}));

    return client;
  }

  // ── STEP 1: Send code — endi DB ga saqlanadi ──────────────
  async sendCode(userId: string, tenantId: string, phone: string, apiId: number, apiHash: string) {
    const client = new TelegramClient(
      new StringSession(''),
      apiId, apiHash,
      { connectionRetries: 3, useWSS: false },
    );
    await client.connect();

    const result = await client.sendCode({ apiId, apiHash }, phone);

    // Eski pending ni o'chirib, yangisini DB ga yoz
    await (this.prisma as any).telegramPendingAuth.deleteMany({ where: { userId } });

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 daqiqa
    await (this.prisma as any).telegramPendingAuth.create({
      data: {
        userId,
        phone,
        phoneCodeHash: result.phoneCodeHash,
        apiId,
        apiHash: this.encryption.encrypt(apiHash),
        expiresAt,
      },
    });

    // Client ni RAM da saqlaylik (bir xil process ichida ishlaydi)
    // Agar restart bo'lsa verifyCode yangi client yaratadi
    activeSessions.set(`pending_${userId}`, client);

    return { sent: true, phoneCodeHash: result.phoneCodeHash };
  }

  // ── STEP 2: Verify code — DB dan o'qiydi ──────────────────
  async verifyCode(userId: string, tenantId: string, code: string, password?: string) {
    // DB dan pending ma'lumotni olish
    const pending = await (this.prisma as any).telegramPendingAuth.findUnique({
      where: { userId },
    });

    if (!pending) {
      throw new BadRequestException('Avval telefon raqam kiriting (kod muddati tugagan bo\'lishi mumkin)');
    }

    // Muddati o'tganmi tekshir
    if (new Date() > new Date(pending.expiresAt)) {
      await (this.prisma as any).telegramPendingAuth.deleteMany({ where: { userId } });
      throw new BadRequestException('Kod muddati tugadi. Qaytadan telefon raqam kiriting.');
    }

    const apiId   = pending.apiId;
    const apiHash = this.encryption.decrypt(pending.apiHash);
    const phone   = pending.phone;
    const phoneCodeHash = pending.phoneCodeHash;

    // RAM da client bor bo'lsa ishlatamiz, yo'q bo'lsa yangi yaratamiz
    let client = activeSessions.get(`pending_${userId}`);
    if (!client || !client.connected) {
      client = new TelegramClient(
        new StringSession(''),
        apiId, apiHash,
        { connectionRetries: 3, useWSS: false },
      );
      await client.connect();
    }

    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      }));
    } catch (e: any) {
      if (e.message?.includes('SESSION_PASSWORD_NEEDED')) {
        if (!password) return { need2fa: true };
        const hint = await client.invoke(new Api.account.GetPassword());
        const { computeCheck } = await import('telegram/Password');
        const passwordCheck = await computeCheck(hint as any, password);
        await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
      } else throw e;
    }

    const session    = (client.session as StringSession).save();
    const encSession = this.encryption.encrypt(session);
    const encHash    = this.encryption.encrypt(apiHash);

    // Pending ni DB dan o'chir
    await (this.prisma as any).telegramPendingAuth.deleteMany({ where: { userId } });
    activeSessions.delete(`pending_${userId}`);

    // Session ni DB ga saqlash
    const existing = await (this.prisma as any).telegramAccount.findFirst({
      where: { userId, tenantId, isPersonal: true },
    });

    if (existing) {
      await (this.prisma as any).telegramAccount.update({
        where: { id: existing.id },
        data: { sessionData: encSession, isActive: true, phoneNumber: phone },
      });
    } else {
      await (this.prisma as any).telegramAccount.create({
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
    client.addEventHandler(async (event: any) => {
      await this.handleIncoming(event, userId, tenantId);
    }, new NewMessage({}));

    return { connected: true };
  }

  // ── Load dialogs ───────────────────────────────────────────
  async getDialogs(userId: string, tenantId: string) {
    const client = await this.getClient(userId, tenantId);
    const dialogs = await client.getDialogs({ limit: 100 });

    const results = [];
    for (const d of dialogs) {
      if (!d.isUser) continue;
      const entity = d.entity as any;
      const chatId = String(entity?.id || d.id);

      let conv = await (this.prisma as any).conversation.findFirst({
        where: { tenantId, channel: 'TELEGRAM', externalChatId: chatId },
      });

      const convData = {
        tenantId,
        channel: 'TELEGRAM',
        externalChatId: chatId,
        externalUserId: chatId,
        firstName: entity?.firstName || '',
        lastName:  entity?.lastName || '',
        username:  entity?.username || '',
        assignedAgentId: userId,
        unreadCount: d.unreadCount || 0,
        lastMessageText: d.message?.message || '',
        lastMessageAt: d.message?.date ? new Date((d.message.date as number) * 1000) : new Date(),
      };

      if (!conv) {
        conv = await (this.prisma as any).conversation.create({ data: convData });
      } else {
        conv = await (this.prisma as any).conversation.update({
          where: { id: conv.id },
          data: { unreadCount: convData.unreadCount, lastMessageText: convData.lastMessageText, lastMessageAt: convData.lastMessageAt },
        });
      }
      results.push(conv);
    }
    return results;
  }

  // ── Get messages ───────────────────────────────────────────
  async getMessages(userId: string, tenantId: string, conversationId: string) {
    const conv = await (this.prisma as any).conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conv) throw new NotFoundException('Conversation topilmadi');

    const client = await this.getClient(userId, tenantId);
    const entity = await client.getEntity(conv.externalChatId);
    const msgs = await client.getMessages(entity, { limit: 50 });

    for (const m of msgs) {
      const existing = await (this.prisma as any).message.findFirst({
        where: { conversationId, externalMsgId: String(m.id) },
      });
      if (existing) continue;

      let fileUrl: string | undefined;
      let fileName: string | undefined;
      if (m.media) {
        try {
          const fs = require('fs');
          const path = require('path');
          const uploadDir = process.env.UPLOAD_DIR || './uploads';
          if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
          
          const ext = (m.media as any).photo ? 'jpg' : 
                      ((m.media as any).document?.mimeType || 'bin').split('/')[1] || 'bin';
          fileName = `tg_${Date.now()}_${m.id}.${ext}`;
          const filePath = path.join(uploadDir, fileName);
          
          const buf = await client.downloadMedia(m as any, { workers: 1 }) as Buffer;
          if (buf && buf.length > 0) {
            fs.writeFileSync(filePath, buf);
            const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
            fileUrl = `${baseUrl}/uploads/${fileName}`;
          }
        } catch {}
      }

      const senderId = String((m as any).fromId?.userId || (m as any).peerId?.userId || '');
      const myId     = String((await client.getMe())?.id || '');
      const direction = senderId === myId ? 'OUTBOUND' : 'INBOUND';

      const msgType = m.media
        ? ((m.media as any).photo ? 'PHOTO' : 'DOCUMENT')
        : 'TEXT';

      await (this.prisma as any).message.create({
        data: {
          conversationId,
          agentId: direction === 'OUTBOUND' ? userId : null,
          externalMsgId: String(m.id),
          direction,
          messageType: msgType as any,
          text: m.message || '',
          fileUrl,
          isRead: true,
          createdAt: new Date((m.date as number) * 1000),
        },
      });
    }

    return (this.prisma as any).message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  }

  // ── Send message ───────────────────────────────────────────
  async sendMessage(userId: string, tenantId: string, conversationId: string, text: string, fileBase64?: string, fileName?: string) {
    const conv = await (this.prisma as any).conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conv) throw new NotFoundException('Conversation topilmadi');

    const client = await this.getClient(userId, tenantId);
    const entity = await client.getEntity(conv.externalChatId);

    let sentMsg: any;
    if (fileBase64 && fileName) {
      const buf = Buffer.from(fileBase64.includes(',') ? fileBase64.split(',')[1] : fileBase64, 'base64');
      const isImage = !!fileName.match(/\.(jpg|jpeg|png|gif|webp)$/i);
      sentMsg = await client.sendFile(entity, {
        file: buf,
        caption: text || '',
        forceDocument: !isImage,
        workers: 1,
        attributes: [{ className: 'DocumentAttributeFilename', fileName }] as any,
      } as any);
    } else {
      sentMsg = await client.sendMessage(entity, { message: text });
    }

    const saved = await (this.prisma as any).message.create({
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

    await (this.prisma as any).conversation.update({
      where: { id: conversationId },
      data: { lastMessageText: text, lastMessageAt: new Date() },
    });

    this.realtime.emitToTenant(tenantId, 'message:new', { conversationId, message: saved });
    return saved;
  }

  // ── Search username ────────────────────────────────────────
  async searchUser(userId: string, tenantId: string, query: string) {
    const client = await this.getClient(userId, tenantId);
    try {
      const username = query.replace('@', '');
      const result = await client.invoke(new Api.contacts.ResolveUsername({ username })) as any;
      const user = result.users?.[0];
      if (!user) return null;
      return {
        id: String(user.id),
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        username: user.username || '',
        phone: user.phone || '',
      };
    } catch { return null; }
  }

  // ── Start new chat ─────────────────────────────────────────
  async startChat(userId: string, tenantId: string, externalUserId: string, firstMessage?: string) {
    const client = await this.getClient(userId, tenantId);
    const entity = await client.getEntity(externalUserId);
    const u = entity as any;

    let conv = await (this.prisma as any).conversation.findFirst({
      where: { tenantId, channel: 'TELEGRAM', externalChatId: String(u.id) },
    });

    if (!conv) {
      conv = await (this.prisma as any).conversation.create({
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

  // ── Handle incoming ────────────────────────────────────────
  private async handleIncoming(event: any, userId: string, tenantId: string) {
    try {
      const m = event.message;
      if (!m) return;
      const chatId = String(m.chatId || m.peerId?.userId || '');
      if (!chatId) return;

      let conv = await (this.prisma as any).conversation.findFirst({
        where: { tenantId, channel: 'TELEGRAM', externalChatId: chatId },
      });
      if (!conv) {
        conv = await (this.prisma as any).conversation.create({
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
      } else {
        await (this.prisma as any).conversation.update({
          where: { id: conv.id },
          data: {
            unreadCount: { increment: 1 },
            lastMessageText: m.message || '',
            lastMessageAt: new Date(),
          },
        });
      }

      const msg = await (this.prisma as any).message.create({
        data: {
          conversationId: conv.id,
          direction: 'INBOUND',
          messageType: m.media ? 'DOCUMENT' : 'TEXT',
          text: m.message || '',
          externalMsgId: String(m.id),
          isRead: false,
          createdAt: new Date((m.date as number) * 1000),
        },
      });

      this.realtime.emitToUser(userId, 'message:new', { conversationId: conv.id, message: msg });
      this.realtime.emitToTenant(tenantId, 'conversation:update', conv);
    } catch (e: any) {
      this.logger.warn('handleIncoming error: ' + e?.message);
    }
  }

  // ── Status ─────────────────────────────────────────────────
  async getStatus(userId: string, tenantId: string) {
    const acct = await (this.prisma as any).telegramAccount.findFirst({
      where: { userId, tenantId, isPersonal: true },
      select: { isActive: true, phoneNumber: true, createdAt: true },
    });
    if (!acct) return { connected: false };
    const client = activeSessions.get(userId);
    return {
      connected: !!acct.isActive,
      online: !!(client?.connected),
      phone: acct.phoneNumber,
      since: acct.createdAt,
    };
  }

  // ── Disconnect ─────────────────────────────────────────────
  async disconnect(userId: string, tenantId: string) {
    const client = activeSessions.get(userId);
    if (client) { try { await client.disconnect(); } catch {} activeSessions.delete(userId); }
    await (this.prisma as any).telegramAccount.updateMany({
      where: { userId, tenantId, isPersonal: true },
      data: { sessionData: null, isActive: false },
    });
    return { disconnected: true };
  }

  // ── Restore sessions on boot ───────────────────────────────
  async restoreAllSessions() {
    try {
      const accounts = await (this.prisma as any).telegramAccount.findMany({
        where: { isPersonal: true, isActive: true, sessionData: { not: null } },
      });
      for (const acct of accounts) {
        try {
          const apiId   = parseInt(acct.apiId || process.env.TELEGRAM_API_ID || '0');
          const apiHash = acct.apiHash ? this.encryption.decrypt(acct.apiHash) : (process.env.TELEGRAM_API_HASH || '');
          const session = this.encryption.decrypt(acct.sessionData);
          const client  = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3, useWSS: false });
          await client.connect();
          activeSessions.set(acct.userId, client);
          client.addEventHandler(async (event: any) => {
            await this.handleIncoming(event, acct.userId, acct.tenantId);
          }, new NewMessage({}));
          this.logger.log(`Session restored: ${acct.phoneNumber}`);
        } catch (e: any) {
          this.logger.warn(`Session restore failed for ${acct.phoneNumber}: ${e?.message}`);
        }
      }
    } catch {}
  }
}

// ─── CONTROLLER ────────────────────────────────────────────────
@Controller('telegram/personal')
@UseGuards(JwtAuthGuard)
export class TelegramPersonalController {
  constructor(private svc: TelegramPersonalService) {}

  @Get('status')
  status(@CurrentUser() u: any) {
    return this.svc.getStatus(u.sub, u.tenantId);
  }

  @Post('connect')
  connect(@CurrentUser() u: any, @Body() body: { phone: string; apiId: number; apiHash: string }) {
    return this.svc.sendCode(u.sub, u.tenantId, body.phone, body.apiId, body.apiHash);
  }

  @Post('verify-code')
  verifyCode(@CurrentUser() u: any, @Body() body: { code: string; password?: string }) {
    return this.svc.verifyCode(u.sub, u.tenantId, body.code, body.password);
  }

  @Post('disconnect')
  disconnect(@CurrentUser() u: any) {
    return this.svc.disconnect(u.sub, u.tenantId);
  }

  @Get('dialogs')
  dialogs(@CurrentUser() u: any) {
    return this.svc.getDialogs(u.sub, u.tenantId);
  }

  @Get('messages/:conversationId')
  messages(@CurrentUser() u: any, @Param('conversationId') id: string) {
    return this.svc.getMessages(u.sub, u.tenantId, id);
  }

  @Post('send')
  send(@CurrentUser() u: any, @Body() body: { conversationId: string; text: string; fileBase64?: string; fileName?: string }) {
    return this.svc.sendMessage(u.sub, u.tenantId, body.conversationId, body.text, body.fileBase64, body.fileName);
  }

  @Post('search')
  search(@CurrentUser() u: any, @Body() body: { query: string }) {
    return this.svc.searchUser(u.sub, u.tenantId, body.query);
  }

  @Post('start-chat')
  startChat(@CurrentUser() u: any, @Body() body: { externalUserId: string; firstMessage?: string }) {
    return this.svc.startChat(u.sub, u.tenantId, body.externalUserId, body.firstMessage);
  }
}

// ─── MODULE ────────────────────────────────────────────────────
@Module({
  controllers: [TelegramPersonalController],
  providers: [TelegramPersonalService],
  exports: [TelegramPersonalService],
})
export class TelegramPersonalModule {}