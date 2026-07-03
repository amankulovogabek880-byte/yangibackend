/**
 * UserTelegram Module — MTProto orqali shaxsiy Telegram accountini boshqarish
 * 
 * Bu modul agentlarga o'z shaxsiy Telegram accountlari orqali
 * inbox'dan birinchi bo'lib xabar yuborish imkonini beradi.
 * 
 * Flow:
 * 1. Agent telefon raqamini kiritadi (POST /user-telegram/auth/send-code)
 * 2. SMS/app code keladi → agent kiritadi (POST /user-telegram/auth/verify-code)
 * 3. 2FA parol bo'lsa → (POST /user-telegram/auth/2fa)
 * 4. Session saqlandi → agent endi inbox'dan xabar yubora oladi
 */

import {
  Module, Injectable, Controller,
  Post, Get, Delete, Body, Param,
  UseGuards, BadRequestException, NotFoundException,
  OnModuleInit, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { normalizeChatId, inferChatTypeFromGramjs } from './chat-id.util';

// Telegram API credentials - admin tomonidan sozlanadi (my.telegram.org dan olinadi)
// Default: demo credentials (faqat test uchun)
const DEFAULT_API_ID = parseInt(process.env.TELEGRAM_API_ID || '2040');
const DEFAULT_API_HASH = process.env.TELEGRAM_API_HASH || 'b18441a1ff607e10a989891a5462e627';

// Active client sessions (memory cache)
const activeSessions = new Map<string, TelegramClient>();
// Pending auth state (phone → {phoneCodeHash, client})
const pendingAuth = new Map<string, { phoneCodeHash: string; client: TelegramClient; phone: string }>();

@Injectable()
export class UserTelegramService implements OnModuleInit {
  private readonly logger = new Logger('UserTelegramService');

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
  ) {}

  async onModuleInit() {
    // Restore saved sessions on startup
    try {
      const accounts = await this.prisma.telegramAccount.findMany({
        where: { isPersonal: true, sessionData: { not: null }, isActive: true },
      });
      this.logger.log(`Restoring ${accounts.length} personal Telegram sessions...`);
      for (const acc of accounts) {
        await this.restoreSession(acc).catch(e =>
          this.logger.warn(`Session restore failed for ${acc.id}: ${e.message}`)
        );
      }
    } catch (e) {
      this.logger.warn('Could not restore sessions on init');
    }
  }

  private async restoreSession(acc: any): Promise<TelegramClient | null> {
    if (!acc.sessionData) return null;
    try {
      const apiId = parseInt(acc.apiId || String(DEFAULT_API_ID));
      const apiHash = acc.apiHash || DEFAULT_API_HASH;
      const session = new StringSession(acc.sessionData);
      const client = new TelegramClient(session, apiId, apiHash, {
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
    } catch {}
    return null;
  }

  // ─── Telegramdan profil rasmini yuklab olish va saqlash ───────────────────
  private async saveAvatar(client: TelegramClient, entity: any, key: string): Promise<string | undefined> {
    try {
      const fs = require('fs');
      const path = require('path');
      const uploadDir = process.env.UPLOAD_DIR || './uploads';
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

      const buf = await client.downloadProfilePhoto(entity, {} as any) as Buffer;
      if (!buf || !buf.length) return undefined;

      const fileName = `tg_avatar_${key}.jpg`;
      fs.writeFileSync(path.join(uploadDir, fileName), buf);
      const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
      return `${baseUrl}/uploads/${fileName}?v=${Date.now()}`;
    } catch (e: any) {
      // MUAMMO 6 FIX: xato sababini log qilamiz (avval sirli yutilar edi)
      this.logger.warn(`saveAvatar xato (key=${key}): ${e?.message || e}`);
      return undefined;
    }
  }

  // ─── Step 1: Send auth code ──────────────────────────────────────────────
  async sendCode(tenantId: string, userId: string, data: {
    phone: string;
    apiId?: number;
    apiHash?: string;
  }) {
    const phone = data.phone.replace(/\s+/g, '').trim();
    if (!phone.startsWith('+')) throw new BadRequestException('Telefon raqami + bilan boshlanishi kerak. Masalan: +998901234567');

    const apiId = data.apiId || DEFAULT_API_ID;
    const apiHash = data.apiHash || DEFAULT_API_HASH;

    // Check if already connected
    const existing = await this.prisma.telegramAccount.findFirst({
      where: { tenantId, userId, isPersonal: true, isActive: true, phoneNumber: phone },
    });
    if (existing?.sessionData) {
      const client = await this.restoreSession(existing);
      if (client) return { status: 'already_connected', accountId: existing.id };
    }

    // Create MTProto client
    const session = new StringSession('');
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 3,
      useWSS: false,
    });

    try {
      await client.connect();
      const result = await client.sendCode({ apiId, apiHash }, phone) as any;
      const phoneCodeHash = result.phoneCodeHash;

      // Store pending auth
      const key = `${userId}:${phone}`;
      pendingAuth.set(key, { phoneCodeHash, client, phone });

      return { status: 'code_sent', phone, message: `SMS kodi ${phone} raqamiga yuborildi` };
    } catch (e: any) {
      await client.disconnect();
      if (e.message?.includes('PHONE_NUMBER_INVALID')) throw new BadRequestException('Noto\'g\'ri telefon raqami');
      if (e.message?.includes('API_ID_INVALID')) throw new BadRequestException('Telegram API ID noto\'g\'ri. Settings\'dan API ID/Hash ni tekshiring');
      if (e.message?.includes('FLOOD_WAIT')) throw new BadRequestException('Juda ko\'p urinish. Biroz kuting');
      throw new BadRequestException(`Xato: ${e.message}`);
    }
  }

  // ─── Step 2: Verify code ─────────────────────────────────────────────────
  async verifyCode(tenantId: string, userId: string, data: {
    phone: string;
    code: string;
    apiId?: number;
    apiHash?: string;
  }) {
    const phone = data.phone.replace(/\s+/g, '').trim();
    const key = `${userId}:${phone}`;
    const pending = pendingAuth.get(key);

    if (!pending) throw new BadRequestException('Avval kod so\'rang yoki kod muddati o\'tdi');

    const apiId = data.apiId || DEFAULT_API_ID;
    const apiHash = data.apiHash || DEFAULT_API_HASH;

    try {
      const { client, phoneCodeHash } = pending;
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash,
          phoneCode: data.code.trim(),
        })
      );

      // Save session
      const sessionString = (client.session as StringSession).save();
      const me = await client.getMe() as any;

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
        username: (me as any).username,
        message: '✅ Shaxsiy Telegram accountingiz muvaffaqiyatli ulandi!',
      };
    } catch (e: any) {
      if (e.message?.includes('SESSION_PASSWORD_NEEDED') || e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        return { status: 'need_2fa', message: '2FA parol kerak' };
      }
      if (e.message?.includes('PHONE_CODE_INVALID')) throw new BadRequestException('Noto\'g\'ri kod. Qayta tekshiring');
      if (e.message?.includes('PHONE_CODE_EXPIRED')) throw new BadRequestException('Kod muddati o\'tdi. Qayta so\'rang');
      throw new BadRequestException(`Xato: ${e.message}`);
    }
  }

  // ─── Step 3: 2FA (optional) ──────────────────────────────────────────────
  async verify2FA(tenantId: string, userId: string, data: {
    phone: string;
    password: string;
    apiId?: number;
    apiHash?: string;
  }) {
    const phone = data.phone.replace(/\s+/g, '').trim();
    const key = `${userId}:${phone}`;
    const pending = pendingAuth.get(key);
    if (!pending) throw new BadRequestException('Avval kod so\'rang');

    const apiId = data.apiId || DEFAULT_API_ID;
    const apiHash = data.apiHash || DEFAULT_API_HASH;

    try {
      const { client } = pending;
      await client.invoke(
        new Api.account.GetPassword()
      ).then(async (pwd: any) => {
        const { computeCheck } = await import('telegram/Password');
        const inputCheck = await computeCheck(pwd, data.password);
        return client.invoke(new Api.auth.CheckPassword({ password: inputCheck }));
      });

      const sessionString = (client.session as StringSession).save();
      const me = await client.getMe() as any;

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
    } catch (e: any) {
      if (e.message?.includes('PASSWORD_HASH_INVALID')) throw new BadRequestException('Parol noto\'g\'ri');
      throw new BadRequestException(`Xato: ${e.message}`);
    }
  }

  // ─── Listen incoming AND outgoing messages ──────────────────────────────
  private startListening(client: TelegramClient, acc: any) {
    try {
      client.addEventHandler(async (event: NewMessageEvent) => {
        try {
          const msg = event.message;
          if (!msg) return;

          const isOut = !!msg.out; // agent o'zi yozganmi?
          const tenantId = acc.tenantId;
          const agentId = acc.userId;
          const date = new Date((msg.date || 0) * 1000);
          const text = msg.message || '';

          // MUAMMO 1 FIX: avval INBOUND xabarlar uchun `msg.senderId` ishlatilardi —
          // bu GURUH xabarlarida XATO edi, chunki senderId xabarni YOZGAN odamning
          // ID'si, guruhning o'zi emas! Natijada guruhdagi har bir kishi bilan
          // ALOHIDA-ALOHIDA "shaxsiy suhbat" yaratilib ketardi. GramJS'ning
          // `msg.chatId` getter'i esa yo'nalishdan qat'iy nazar har doim xabar
          // tegishli bo'lgan HAQIQIY suhbatni (shaxsiy/guruh/kanal) to'g'ri beradi.
          const rawChatId = (msg as any).chatId;
          const isGroupOrChannel = !!(msg.isGroup || msg.isChannel);
          const peerId = rawChatId
            ? normalizeChatId(rawChatId.toString(), 'gramjs', isGroupOrChannel)
            : '';
          if (!peerId) return;
          // MUAMMO 2 FIX: suhbat turini ham saqlaymiz.
          const chatType = inferChatTypeFromGramjs(msg);

          if (isOut) {
            // ── Agent o'z Telegram'idan yozgan (OUTBOUND) ────────────────────
            const conv = await this.prisma.conversation.findFirst({
              where: { tenantId, channel: 'TELEGRAM', externalChatId: peerId },
            });
            if (!conv) return; // Yangi suhbat yaratmaymiz — faqat mavjudga qo'shamiz

            // Dublikat tekshirish (CRM orqali yuborilgan bo'lsa, allaqachon saqlangan)
            const dup = await this.prisma.message.findFirst({
              where: { conversationId: conv.id, externalMsgId: String(msg.id) },
            });
            if (dup) return;

            const savedOut = await this.prisma.message.create({
              data: {
                conversationId: conv.id,
                agentId,
                direction: 'OUTBOUND',
                messageType: 'TEXT',
                text,
                externalMsgId: String(msg.id),
                isDelivered: true,
                createdAt: date,
              },
              include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
            });

            await this.prisma.conversation.update({
              where: { id: conv.id },
              data: {
                lastMessageAt: date, lastMessageText: text.slice(0, 200),
                // MUAMMO FIX: avvalgi shart `conv.accountId ? {} : {...}` edi —
                // ya'ni FAQAT accountId bo'sh bo'lsagina yozardi. Lekin bu
                // suhbat allaqachon Bot accountiga bog'langan bo'lsa (masalan
                // mijoz avval botga yozgan), shart har doim "bor" deb topib,
                // hech qachon o'zgartirmasdi — shuning uchun "Bot" belgisi
                // umrbod yopishib qolardi. Endi har doim shaxsiy accountga
                // ko'chiramiz, chunki hozir shu odamga aynan shaxsiy
                // accountdan yozilyapti.
                accountId: acc.id,
              },
            });

            // Real-time: boshqa tab/qurilmada ham darhol ko'rinsin
            this.realtime.emitToUser(agentId, 'message:new', savedOut);
            this.realtime.emitConversationEvent(tenantId, agentId, 'conversation:updated', {
              conversationId: conv.id, lastMessageText: text.slice(0, 200), lastMessageAt: date,
            });
            return;
          }

          // ── Kiruvchi xabar (INBOUND) ──────────────────────────────────────
          this.logger.log(`Personal incoming: ${peerId} → "${text.slice(0, 50)}"`);

          // Get sender info
          let firstName = '';
          let lastName = '';
          let username = '';
          try {
            const sender = await msg.getSender() as any;
            firstName = sender?.firstName || sender?.title || '';
            lastName = sender?.lastName || '';
            username = sender?.username || '';
          } catch {}

          // Find or create conversation
          let conv = await this.prisma.conversation.findFirst({
            where: { tenantId, channel: 'TELEGRAM', externalChatId: peerId },
          });

          // MUAMMO 1 FIX: bu yerda avval hech qanday dublikat tekshiruvi yo'q edi
          // (faqat OUTBOUND tarmoqda bor edi) — shu sabab bitta xabar bir necha
          // marta ushlab qolinsa (masalan qayta ulanishda), har safar YANGI
          // Message yozuvi yaratilib, chatda takrorlanib chiqardi.
          if (conv) {
            const dup = await this.prisma.message.findFirst({
              where: { conversationId: conv.id, externalMsgId: String(msg.id) },
            });
            if (dup) return;
          }

          // Telegramdan profil rasmini yuklab olamiz
          let avatarUrl: string | undefined;
          if (!conv || !conv.avatarUrl) {
            try {
              const sender = await msg.getSender();
              avatarUrl = await this.saveAvatar(client, sender, peerId);
            } catch {}
          }

          {
            let clientId: string | null = null;
            if (username) {
              const cl = await this.prisma.client.findFirst({
                where: { tenantId, telegramUsername: username } as any,
              }).catch(() => null);
              if (cl) clientId = cl.id;
            }

            // MUAMMO FIX (dublikat suhbatlar): avval alohida findFirst→create/
            // update qilinardi. Agar yangi kontakt bir necha xabarni bir-biriga
            // juda yaqin (millisekundlar ichida) yuborsa, ikkala event ham
            // "suhbat yo'q" deb ko'rib, ikkalasi ham create'ga urinardi —
            // ikkinchisi unique constraint'ga urilib xato berardi va o'sha
            // xabar SIRLI YO'QOLIB QOLARDI. Endi atomik upsert ishlatamiz.
            conv = await this.prisma.conversation.upsert({
              where: {
                tenantId_channel_externalChatId: { tenantId, channel: 'TELEGRAM', externalChatId: peerId },
              },
              create: {
                tenantId, accountId: acc.id, clientId,
                assignedAgentId: agentId, channel: 'TELEGRAM',
                externalChatId: peerId, firstName, lastName, username, avatarUrl,
                lastMessageAt: date, lastMessageText: text.slice(0, 200),
                chatType,
              } as any,
              update: {
                lastMessageAt: date, lastMessageText: text.slice(0, 200),
                firstName: conv?.firstName || firstName,
                lastName: conv?.lastName || lastName,
                username: conv?.username || username,
                chatType: (conv as any)?.chatType || chatType,
                ...(avatarUrl ? { avatarUrl } : {}),
                // MUAMMO FIX: avvalgi shart `conv.accountId ? {} : {...}` edi —
                // ya'ni FAQAT accountId bo'sh bo'lsagina yozardi, shuning uchun
                // Bot-akkauntga bog'langan eski suhbatlar umrbod "Bot" deb
                // qolib ketardi. Endi har doim shaxsiy accountga ko'chiramiz.
                accountId: acc.id,
              } as any,
            });
          }

          // v12 DUBLIKAT FIX: bir xil Telegram accounti bir necha marta ulangan
          // bo'lsa (yoki listener ikki marta ishga tushsa), AYNAN bir xabar ikki
          // marta kelib, ikki marta saqlanardi. Endi (conversationId + Telegram
          // msg.id) bo'yicha allaqachon saqlangan bo'lsa — o'tkazib yuboramiz.
          const tgMsgId = String(msg.id || '');
          if (tgMsgId) {
            const already = await this.prisma.message.findFirst({
              where: { conversationId: conv.id, externalMsgId: tgMsgId, direction: 'INBOUND' },
              select: { id: true },
            });
            if (already) return;
          }

          const savedMsg = await this.prisma.message.create({
            data: {
              conversationId: conv.id,
              direction: 'INBOUND', messageType: 'TEXT', text,
              externalMsgId: tgMsgId || String(Date.now()),
              isDelivered: true, createdAt: date,
            },
          });

          // Real-time notify — v10 MUAMMO 4 FIX: tenant-keng emas
          if (agentId) {
            this.realtime.emitToUser(agentId, 'message:new', savedMsg);
          }
          this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId || agentId, 'conversation:updated', {
            conversationId: conv.id,
            lastMessageText: text.slice(0, 200),
            lastMessageAt: date,
          });
        } catch (e: any) {
          this.logger.warn('Personal incoming handler error: ' + e.message);
        }
        // MUAMMO FIX: avval `{ incoming: true }` berilgan edi. GramJS buni
        // ichkarida `outgoing = false` deb talqin qiladi (events/NewMessage.js
        // manbasida ko'rish mumkin), shu sabab agent shu Telegram accountidan
        // TO'G'RIDAN-TO'G'RI (CRM'siz) yozgan xabarlari BU HANDLER'GA UMUMAN
        // YETIB KELMASDI — yuqoridagi "isOut" bo'limi yozilgan bo'lsa ham hech
        // qachon ishlamasdi. Natijada bunday xabarlar CRM'da ko'rinmasdi yoki
        // (agar boshqa yo'l bilan sinxronlansa) xuddi mijoz yozganday bir xil
        // (kulrang) rangda chiqardi. Filtrni olib tashlab, ikkala yo'nalishni
        // ham ushlaymiz — pastdagi isOut tekshiruvi endi ishga tushadi.
      }, new NewMessage({}));
    } catch (e: any) {
      this.logger.warn('startListening error: ' + e.message);
    }
  }

  // ─── Send message via personal account ───────────────────────────────────
  async sendPersonalMessage(tenantId: string, agentId: string, data: {
    phone?: string;
    username?: string;
    userId?: string; // Telegram user ID
    conversationId?: string; // Mavjud suhbatga yozayotgan bo'lsak — shu orqali yangi dublikat suhbat yaratilmaydi
    text: string;
    clientId?: string;
  }) {
    if (!data.text?.trim()) throw new BadRequestException('Xabar matni kerak');
    if (!data.phone && !data.username && !data.userId && !data.conversationId) {
      throw new BadRequestException('Telefon raqami, username, Telegram ID yoki suhbat kerak');
    }

    // Get agent's personal account
    const account = await this.prisma.telegramAccount.findFirst({
      where: { tenantId, userId: agentId, isPersonal: true, isActive: true },
    });
    if (!account) {
      throw new BadRequestException(
        'Shaxsiy Telegram account ulanmagan. Settings → Telegram → Shaxsiy account ulang'
      );
    }

    // Get or restore client session
    let client = activeSessions.get(account.id);
    if (!client || !(await client.isUserAuthorized().catch(() => false))) {
      client = await this.restoreSession(account) || undefined;
      if (!client) {
        throw new BadRequestException(
          'Session yaroqsiz. Settings → Telegram dan qayta ulaning'
        );
      }
    }

    try {
      let peer: any;
      let existingConv: any = null;

      // Agar mavjud suhbatga yozayotgan bo'lsak — peer'ni o'sha suhbatning
      // saqlangan externalChatId'sidan olamiz. Bu yangi/dublikat suhbat
      // yaratilib, agentning yozgan xabari "yo'qolib qolish" muammosining oldini oladi.
      if (data.conversationId) {
        existingConv = await this.prisma.conversation.findFirst({
          where: { id: data.conversationId, tenantId },
        });
        if (!existingConv) throw new NotFoundException('Suhbat topilmadi');
        peer = await client.getInputEntity(existingConv.externalChatId);
      } else if (data.username) {
        peer = await client.getInputEntity(data.username.startsWith('@') ? data.username : `@${data.username}`);
      } else if (data.phone) {
        // Import contact first to be able to send
        const phone = data.phone.replace(/\s+/g, '');
        try {
          await client.invoke(new Api.contacts.ImportContacts({
            contacts: [new Api.InputPhoneContact({
              clientId: BigInt(Date.now()) as any,
              phone,
              firstName: 'Client',
              lastName: '',
            })],
          }));
          peer = await client.getInputEntity(phone);
        } catch {
          // Try direct phone lookup
          peer = phone;
        }
      } else if (data.userId) {
        peer = await client.getInputEntity(data.userId);
      }

      // Send message
      const sent = await client.sendMessage(peer, { message: data.text });

      let conv = existingConv;
      if (!conv) {
        let chat: any = null;
        let externalChatId: string;
        try {
          chat = await client.getEntity(peer) as any;
          // For user chats: use the user's Telegram ID
          externalChatId = String(chat.id);
        } catch {
          // Fallback: extract from sent message
          const peerId = (sent as any).peerId;
          externalChatId = String(peerId?.userId || peerId?.chatId || peerId?.channelId || Date.now());
        }

        // Save to DB as conversation — lekin avval shu externalChatId bilan
        // mavjud suhbat bormi tekshiramiz (qayta dublikat yaratmaslik uchun)
        conv = await this.prisma.conversation.findFirst({
          where: { tenantId, channel: 'TELEGRAM', externalChatId },
        });

        let avatarUrl: string | undefined;
        if (!conv || !conv.avatarUrl) {
          avatarUrl = await this.saveAvatar(client, chat || peer, externalChatId);
        }

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
              username: chat?.username || (data.username ? data.username.replace('@','') : ''),
              avatarUrl,
              lastMessageAt: new Date(),
              lastMessageText: data.text.slice(0, 200),
            },
          });
        } else {
          conv = await this.prisma.conversation.update({
            where: { id: conv.id },
            data: {
              lastMessageAt: new Date(),
              lastMessageText: data.text.slice(0, 200),
              clientId: conv.clientId || data.clientId || null,
              assignedAgentId: conv.assignedAgentId || agentId,
              ...(avatarUrl ? { avatarUrl } : {}),
              // MUAMMO FIX: avvalgi shart `conv.accountId ? {} : {...}` faqat
              // accountId bo'sh bo'lsagina yozardi — Bot-akkauntga bog'langan
              // eski suhbat bo'lsa hech qachon o'zgarmasdi. Endi har doim
              // shaxsiy accountga ko'chiramiz, chunki hozir CRM orqali shu
              // odamga aynan shaxsiy accountdan yozilyapti.
              accountId: account.id,
            },
          });
        }
      } else {
        conv = await this.prisma.conversation.update({
          where: { id: conv.id },
          data: {
            lastMessageAt: new Date(),
            lastMessageText: data.text.slice(0, 200),
            clientId: conv.clientId || data.clientId || null,
            // MUAMMO FIX: xuddi yuqoridagidek — endi har doim yangilanadi.
            accountId: account.id,
          },
        });
      }

      // Save message
      const savedMsg = await this.prisma.message.create({
        data: {
          conversationId: conv.id,
          agentId,
          direction: 'OUTBOUND',
          messageType: 'TEXT',
          text: data.text,
          externalMsgId: String((sent as any).id || Date.now()),
          isDelivered: true,
        },
        include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
      });

      // Refresh qilmasdan darhol ko'rinishi uchun — barcha ulangan
      // sessiyalarga (boshqa tab/qurilma) ham real xabarni yuboramiz.
      // v10 MUAMMO 4 FIX: tenant-keng emas, faqat tegishlilarga.
      this.realtime.emitToUser(agentId, 'message:new', savedMsg);
      this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId || agentId, 'conversation:updated', {
        conversationId: conv.id,
        lastMessageText: data.text.slice(0, 200),
        lastMessageAt: new Date(),
      });

      return { ok: true, conversationId: conv.id, message: savedMsg };
    } catch (e: any) {
      if (e.message?.includes('USERNAME_NOT_OCCUPIED')) throw new BadRequestException('Bu username topilmadi');
      if (e.message?.includes('PEER_ID_INVALID')) throw new BadRequestException('Foydalanuvchi topilmadi');
      if (e.message?.includes('USER_PRIVACY_RESTRICTED')) {
        throw new BadRequestException(
          'Foydalanuvchi maxfiylik sozlamasi tufayli siz bilan bog\'lana olmaydi. ' +
          'Ular avval sizga yozishi kerak yoki umumiy guruhda bo\'lishlari kerak.'
        );
      }
      throw new BadRequestException(`Xato: ${e.message}`);
    }
  }

  // ─── v11 FIX (davomi): Media/fayl yuborish (shaxsiy akkaunt orqali) ──────
  // Shablonga biriktirilgan rasm/fayl endi faqat caption-matn sifatida emas,
  // HAQIQIY fayl sifatida (MTProto orqali) yuboriladi — xuddi bot orqali
  // yuborilgandagidek.
  private async sendPersonalMedia(
    tenantId: string, agentId: string, conversationId: string,
    fileUrl: string, caption?: string,
  ) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');

    const account = await this.prisma.telegramAccount.findFirst({
      where: { tenantId, userId: agentId, isPersonal: true, isActive: true },
    });
    if (!account) throw new BadRequestException('Shaxsiy Telegram account ulanmagan');

    let client = activeSessions.get(account.id);
    if (!client || !(await client.isUserAuthorized().catch(() => false))) {
      client = await this.restoreSession(account) || undefined;
      if (!client) throw new BadRequestException('Session yaroqsiz. Settings → Telegram dan qayta ulaning');
    }

    const peer = await client.getInputEntity(conv.externalChatId);

    // Faylni URL'dan yuklab olamiz, so'ng Telegramga o'zimiz jo'natamiz
    const axios = require('axios');
    const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const buf = Buffer.from(resp.data);
    const fileName = fileUrl.split('/').pop()?.split('?')[0] || `file_${Date.now()}`;
    const isImage = !!fileName.match(/\.(jpg|jpeg|png|gif|webp)$/i);

    const sent = await client.sendFile(peer, {
      file: buf,
      caption: caption || '',
      forceDocument: !isImage,
      workers: 1,
      attributes: [{ className: 'DocumentAttributeFilename', fileName }] as any,
    } as any);

    const savedMsg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        agentId,
        direction: 'OUTBOUND',
        messageType: isImage ? 'PHOTO' : 'DOCUMENT',
        text: caption || '',
        fileUrl,
        externalMsgId: String((sent as any).id || Date.now()),
        isDelivered: true,
      } as any,
      include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
    });

    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: new Date(),
        lastMessageText: caption?.slice(0, 200) || '📎 Fayl',
        // MUAMMO FIX: xuddi yuqoridagi joylardagidek — endi har doim yangilanadi.
        accountId: account.id,
      },
    });

    this.realtime.emitToUser(agentId, 'message:new', savedMsg);
    this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId || agentId, 'conversation:updated', {
      conversationId: conv.id,
      lastMessageText: caption?.slice(0, 200) || '📎 Fayl',
      lastMessageAt: new Date(),
    });

    return savedMsg;
  }

  // Public wrapper — controller orqali chaqiriladi (masalan "Rasm" tugmasi)
  async sendMedia(tenantId: string, agentId: string, conversationId: string, fileUrl: string, caption?: string) {
    return this.sendPersonalMedia(tenantId, agentId, conversationId, fileUrl, caption);
  }

  // ─── v11 FIX: Shablon yuborish (shaxsiy akkaunt orqali) ──────────────────
  // Ilgari "Shablon" tugmasi shaxsiy (isPersonal) suhbatlarda ham har doim
  // BOT endpointiga (`/telegram/conversations/:id/template/:id`) yuborardi —
  // bu shaxsiy akkauntga tegishli emas edi, shu sabab xabar hech qachon
  // to'g'ri yetkazilmas yoki socket orqali darhol ko'rinmas edi (faqat
  // sahifani qayta yuklaganda — "restart" qilinganda — bazadan tasodifan
  // ko'rinib qolishi mumkin edi). Endi shaxsiy suhbatlar uchun MTProto
  // orqali to'g'ridan-to'g'ri shu yerdan yuboriladi.
  async sendTemplate(tenantId: string, agentId: string, conversationId: string, templateId: string) {
    const template = await this.prisma.messageTemplate.findFirst({
      where: { id: templateId, tenantId, isActive: true } as any,
    });
    if (!template) throw new NotFoundException('Shablon topilmadi');

    await this.prisma.messageTemplate.update({
      where: { id: templateId },
      data: { useCount: { increment: 1 } } as any,
    }).catch(() => {});

    const sent: any[] = [];

    if ((template as any).text?.trim()) {
      const r = await this.sendPersonalMessage(tenantId, agentId, {
        conversationId,
        text: (template as any).text,
      });
      if (r?.message) sent.push(r.message);
    }

    const mediaItems = [
      ...((template as any).mediaUrl ? [{ url: (template as any).mediaUrl, caption: (template as any).mediaCaption || '' }] : []),
      ...((Array.isArray((template as any).attachments) ? (template as any).attachments : []) as any[])
        .filter((a: any) => a?.url)
        .map((a: any) => ({ url: a.url, caption: a.caption || '' })),
    ];

    for (const item of mediaItems) {
      try {
        const savedMsg = await this.sendPersonalMedia(tenantId, agentId, conversationId, item.url, item.caption);
        sent.push(savedMsg);
      } catch (e: any) {
        this.logger.warn('Shaxsiy shablon media yuborilmadi: ' + e?.message);
      }
    }

    return { sent: sent.length, messages: sent };
  }

  // ─── Get my personal account status ──────────────────────────────────────
  async getMyAccount(tenantId: string, userId: string) {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { tenantId, userId, isPersonal: true },
      select: {
        id: true, name: true, phoneNumber: true, isActive: true, config: true,
        createdAt: true,
      },
    });
    if (!account) return null;

    const isOnline = activeSessions.has(account.id);
    return { ...account, isOnline };
  }

  // ─── Disconnect ───────────────────────────────────────────────────────────
  async disconnect(tenantId: string, userId: string) {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { tenantId, userId, isPersonal: true },
    });
    if (!account) throw new NotFoundException('Account topilmadi');

    const client = activeSessions.get(account.id);
    if (client) {
      await client.disconnect().catch(() => {});
      activeSessions.delete(account.id);
    }

    await this.prisma.telegramAccount.update({
      where: { id: account.id },
      data: { isActive: false, sessionData: null },
    });

    return { ok: true };
  }
}

// ─── Controller ───────────────────────────────────────────────────────────────
@ApiTags('Telegram Shaxsiy Account (MTProto)')
@ApiBearerAuth('JWT')
@Controller('user-telegram')
@UseGuards(JwtAuthGuard)
export class UserTelegramController {
  constructor(private svc: UserTelegramService) {}

  // Auth flow
  @ApiOperation({ summary: '1-qadam: Telefon raqamga kod yuborish', description: 'Telegram SMS/App orqali 5 xonali kod yuboradi.' })
  @ApiBody({ schema: { example: { phone: '+998901234567' } } })
  @Post('auth/send-code')
  sendCode(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.sendCode(u.tenantId, u.id || u.sub, body);
  }

  @ApiOperation({ summary: '2-qadam: Kodni tasdiqlash', description: 'Telegramdan kelgan kodni kiriting.' })
  @ApiBody({ schema: { example: { phone: '+998901234567', code: '12345' } } })
  @Post('auth/verify-code')
  verifyCode(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.verifyCode(u.tenantId, u.id || u.sub, body);
  }

  @Post('auth/2fa')
  verify2FA(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.verify2FA(u.tenantId, u.id || u.sub, body);
  }

  // Send message via personal account
  @ApiOperation({
    summary: 'Birinchi xabar yuborish (klient /start yozmasdan ham)',
    description: 'Shaxsiy Telegram accountingiz orqali. Klient hech narsa yozmagan bolsa ham ishlaydi!',
  })
  @ApiBody({
    schema: {
      example: {
        phone: '+998901234567',
        text: 'Salom! Sizga tur haqida malumot bermoqchi edim.',
      },
    },
  })
  @Post('send')
  sendMessage(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.sendPersonalMessage(u.tenantId, u.id || u.sub, body);
  }

  // v11 FIX: shaxsiy akkaunt orqali shablon yuborish
  @ApiOperation({ summary: 'Shablon yuborish (shaxsiy akkaunt orqali)' })
  @Post('send-template')
  sendTemplate(@CurrentUser() u: any, @Body() body: { conversationId: string; templateId: string }) {
    return this.svc.sendTemplate(u.tenantId, u.id || u.sub, body.conversationId, body.templateId);
  }

  // v11 FIX: shaxsiy akkaunt orqali rasm/fayl yuborish
  @ApiOperation({ summary: 'Rasm/fayl yuborish (shaxsiy akkaunt orqali)' })
  @Post('send-media')
  sendMedia(@CurrentUser() u: any, @Body() body: { conversationId: string; fileUrl: string; caption?: string }) {
    return this.svc.sendMedia(u.tenantId, u.id || u.sub, body.conversationId, body.fileUrl, body.caption);
  }

  // Status
  @Get('me')
  getMyAccount(@CurrentUser() u: any) {
    return this.svc.getMyAccount(u.tenantId, u.id || u.sub);
  }

  @Delete('me')
  disconnect(@CurrentUser() u: any) {
    return this.svc.disconnect(u.tenantId, u.id || u.sub);
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get('JWT_ACCESS_SECRET', 'dev-only-change-in-production'),
        signOptions: { expiresIn: cfg.get('JWT_ACCESS_EXPIRES', '15m') },
      }),
    }),
  ],
  controllers: [UserTelegramController],
  providers: [UserTelegramService, RealtimeGateway],
  exports: [UserTelegramService],
})
export class UserTelegramModule {}