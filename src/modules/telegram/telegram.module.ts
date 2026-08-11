import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Param, Body, Query,
  UseGuards, NotFoundException, BadRequestException, ForbiddenException, Logger, OnModuleInit, OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { ClientsService } from '../clients/clients.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { InstagramService, InstagramModule } from '../instagram/instagram.module';
import TelegramBot from 'node-telegram-bot-api';
import { paginate, meta } from '../../common/utils/helpers';
import { Prisma } from '@prisma/client';
import { MessageType, Language } from '../../prisma-types';;
import { normalizeChatId } from './chat-id.util';
import { uploadBufferToStorage } from '../../common/utils/media-storage';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { UserTelegramModule, UserTelegramService } from './user-telegram.module';
import { PollLockService } from '../../common/utils/poll-lock.service';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Telegram');
  private bots = new Map<string, TelegramBot>();
  // v18: qulf band bo'lgani haqidagi ogohlantirishni throttle qilamiz
  // (aks holda har 20s'da bir marta log to'lib ketardi)
  private lockWaitWarned = new Map<string, number>();
  // v17 FIX: ilgari `lastErrorTime`/`retryCount` startBot() ICHIDA `let`
  // sifatida e'lon qilingandi — har safar 409 tufayli qayta ishga
  // tushirilganda YANGI yopiq o'zgaruvchilar (closure) yaratilib, HAR DOIM
  // 0'dan boshlanardi. Natijada:
  //   1) "bir xil xatoni 60s'da bir marta log qilish" himoyasi ishlamasdi
  //      (har yangi closure'da lastErrorTime yana 0),
  //   2) backoff (15s → 30s → ... → 120s) HECH QACHON o'smasdi — har doim
  //      qayta 15s'dan boshlanardi.
  // Bu ikkalasi birgalikda, agar konflikt haqiqatan davom etsa (masalan
  // Render'da eski/yangi deploy jarayoni bir vaqtda ishlab qolsa), botni
  // deyarli uzluksiz — soniyada bir necha marta — qayta ishga tushirib,
  // CPU/RAM sarflardi (aynan loglarda ko'rilgan holat). Endi bu holat
  // klass darajasida, accountId bo'yicha SAQLANADI — restart bo'lsa ham
  // yo'qolmaydi, shu bilan backoff haqiqatan ishlaydi.
  private conflictState = new Map<string, { count: number; lastAt: number }>();

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private clients: ClientsService,
    private realtime: RealtimeGateway,
    // v14 XAVFSIZLIK: session shifrini ochish uchun
    private enc: EncryptionService,
    // v14: shaxsiy (MTProto) suhbatларга invoice/booking/xabar yuborish uchun
    private userTelegram: UserTelegramService,
    // v12.2: Instagram suhbatiga Chat'dan javob yuborish uchun
    private instagram: InstagramService,
    // v18: bir nechta instans bir xil tokenni pollamasin (409 loop fix)
    private pollLock: PollLockService,
  ) {}

  async onModuleInit() {
    try {
      const accounts = await this.prisma.telegramAccount.findMany({
        where: { isActive: true, botToken: { not: null } },
      });
      for (const acc of accounts) {
        if (!acc.botToken) continue;
        await this.startBot(acc.id, acc.tenantId, acc.botToken).catch((e) =>
          this.logger.error(`Bot start failed [${acc.id}]: ${e.message}`),
        );
      }
      this.logger.log(`${accounts.length} bot(s) started`);
    } catch (e: any) {
      this.logger.error(`Init failed: ${e.message}`);
    }
  }

  async onModuleDestroy() {
    for (const [id, bot] of this.bots.entries()) {
      try {
        await bot.stopPolling();
        this.logger.log(`Bot stopped on shutdown: ${id}`);
      } catch {}
      await this.pollLock.release(`telegram-bot:${id}`).catch(() => {});
    }
    this.bots.clear();
  }

  private async startBot(accountId: string, tenantId: string, token: string) {
    const existing = this.bots.get(accountId);
    if (existing) {
      try { await existing.stopPolling(); } catch {}
      this.bots.delete(accountId);
    }

    // v18 FIX: bir nechta instans/replika bir xil tokenni bir vaqtda
    // pollashi 409 Conflict'ga va cheksiz restart tsikliga olib kelardi
    // (loglarda ko'rilgan holat — 27, 28, 29... urinish). Endi FAQAT
    // qulfni ushlab turgan instans haqiqiy pollingni boshlaydi; qolganlari
    // hech qanday TelegramBot yaratmasdan, qulf bo'shashini kutadi.
    const lockName = `telegram-bot:${accountId}`;
    const gotLock = await this.pollLock.acquire(lockName, 30);
    if (!gotLock) {
      const now = Date.now();
      const lastWarned = this.lockWaitWarned.get(accountId) || 0;
      if (now - lastWarned > 5 * 60 * 1000) {
        this.lockWaitWarned.set(accountId, now);
        this.logger.log(`Bot ${accountId}: boshqa instansda allaqachon ishlamoqda — kutilmoqda`);
      }
      setTimeout(() => {
        this.startBot(accountId, tenantId, token).catch((e) =>
          this.logger.error(`Bot start (qulf kutish) xato [${accountId}]: ${e.message}`),
        );
      }, 20000);
      return;
    }

    // Webhookni o'chirish — polling bilan conflict bo'lmasin
    try {
      const tempBot = new TelegramBot(token, { polling: false });
      await tempBot.deleteWebhook({ drop_pending_updates: true });
    } catch {}
    const bot = new TelegramBot(token, {
      polling: {
        params: {
          // v16 FIX: Telegram Bot API 7.0'dan buyon "message_reaction"
          // (xabarga bosilgan ❤️/👍 kabi reaksiya) yangilanishlari FAQAT
          // shu yerda ANIQ so'ralsa yuboriladi — shu sabab reaksiyalar
          // ilgari botga umuman yetib kelmasdi. Qolgan turlar Telegramning
          // standart to'plamini takrorlaydi, shu bilan avvalgi xatti-harakat
          // buzilmaydi.
          allowed_updates: [
            'message', 'edited_message', 'channel_post', 'edited_channel_post',
            'inline_query', 'chosen_inline_result', 'callback_query',
            'shipping_query', 'pre_checkout_query', 'poll', 'poll_answer',
            'my_chat_member', 'chat_join_request',
            'message_reaction', 'message_reaction_count',
          ],
        },
      },
    });
    bot.on('message', (msg) =>
      this.handleIncoming(msg, accountId, tenantId, bot).catch((e) =>
        this.logger.error(`handle: ${e.message}`),
      ),
    );
    // v16: mijoz (yoki agent) Telegramda biror xabarga reaksiya (emoji/stiker)
    // bossa — buni ham inboxda ko'rsatamiz.
    bot.on('message_reaction', (reaction: any) =>
      this.handleReaction(reaction, tenantId).catch((e) =>
        this.logger.error(`reaction: ${e.message}`),
      ),
    );
    let lastErrorTime = 0;

    bot.on('polling_error', (e: any) => {
      const msg = e?.message || String(e);
      const now = Date.now();

      // Bir xil xatoni har 60 soniyada bir marta log qilamiz
      if (now - lastErrorTime < 60000) return;
      lastErrorTime = now;

      if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
        // Internet yo'q — 60 soniya kutib qayta urinish
        this.logger.warn(`Bot ${accountId}: internet yo'q, 60s dan keyin urinish`);
        setTimeout(async () => {
          try { await this.startBot(accountId, tenantId, token); } catch {}
        }, 60000);
      } else if (msg.includes('409') || msg.includes('Conflict')) {
        // v17 FIX: holat (count/lastAt) endi accountId bo'yicha klassda
        // saqlanadi — startBot() qayta chaqirilganda YO'QOLMAYDI, shu
        // bilan backoff haqiqatan 15s → 30s → ... → 120s bo'lib o'sadi.
        // Agar oxirgi konfliktdan beri 5 daqiqadan ko'proq vaqt o'tgan
        // bo'lsa — bu YANGI muammo deb hisoblanadi va hisoblagich 1'dan
        // qayta boshlanadi (eski, allaqachon tuzalgan muammo tufayli
        // keyingi urinish keraksiz uzoq kutmasin uchun).
        const prev = this.conflictState.get(accountId);
        const count = prev && now - prev.lastAt < 5 * 60 * 1000 ? prev.count + 1 : 1;
        this.conflictState.set(accountId, { count, lastAt: now });
        const delay = Math.min(15000 * count, 120000); // max 2 daqiqa
        this.logger.warn(`Bot ${accountId}: 409 Conflict (${count}-urinish) — ${delay/1000}s dan keyin restart`);
        setTimeout(async () => {
          try {
            await bot.stopPolling();
            await new Promise(r => setTimeout(r, 3000));
            await this.startBot(accountId, tenantId, token);
          } catch {}
        }, delay);
      } else {
        this.logger.error(`Bot ${accountId}: ${msg}`);
      }
    });
    this.bots.set(accountId, bot);
  }

  /**
   * Round-robin: navbat bo'yicha agent tanlash.
   *
   * v16 FIX: ilgari "eng kam FAOL (isResolved=false) suhbatga ega agent"
   * mezoni ishlatilardi. Bu quyidagi og'ir xatoga olib kelardi: agar bir
   * necha agentda bir vaqtning o'zida FAOL suhbatlar soni TENG bo'lsa
   * (masalan barchasi 0 — kun boshida yoki barcha suhbatlar yopilgan
   * bo'lsa), `sort()` barqaror (stable) bo'lgani uchun tenglik HAR DOIM
   * ro'yxatdagi BIRINCHI agent foydasiga hal qilinardi. Natijada yangi
   * Telegram leadlar deyarli doim faqat BITTA (birinchi) agentga tushardi.
   * Endi `/modules/v9/round-robin.module.ts`dagi bilan BIR XIL, isbotlangan
   * "lastAssignedAt eng eski (yoki hali umuman olmagan) — navbat shunga"
   * mezonidan foydalanamiz: har safar tanlangan agentning lastAssignedAt
   * darhol yangilanadi, shu sabab tenglik holati deyarli yuzaga kelmaydi va
   * leadlar barcha agentlar orasida haqiqiy aylanma (round-robin) tarzda
   * taqsimlanadi.
   */
  private async pickAgent(tenantId: string): Promise<string | null> {
    let agents = await this.prisma.user.findMany({
      where: {
        tenantId, role: { in: ['AGENT', 'MANAGER', 'TENANT_ADMIN'] }, status: 'ACTIVE',
        // v14: pauza qilingan agent (ta'til/kasal) lead OLMAYDI
        isPausedFromAssignment: false,
      },
      select: { id: true, lastAssignedAt: true },
    });
    // v10 MUAMMO 5 BONUS FIX: agar tenant'da hali AGENT/MANAGER rolidagi
    // hech kim bo'lmasa (masalan kichik/yangi agentlik — faqat egasi
    // TENANT_ADMIN sifatida ishlayotgan bo'lsa), oldin bu funksiya har doim
    // `null` qaytarardi va HAR BIR yangi suhbat abadiy "biriktirilmagan"
    // holda qolib ketardi. Endi shunday holatda faol TENANT_ADMIN'larga
    // zaxira sifatida tayinlaymiz — hech kimga umuman tegmasdan qolishdan
    // ko'ra shu ma'qulroq.
    if (!agents.length) {
      agents = await this.prisma.user.findMany({
        where: { tenantId, role: 'TENANT_ADMIN', status: 'ACTIVE' },
        select: { id: true, lastAssignedAt: true },
      });
    }
    if (!agents.length) return null;

    agents.sort((a, b) => {
      const at = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
      const bt = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
      return at - bt;
    });
    const chosen = agents[0];

    // Tanlangandan so'ng darhol navbatni yangilaymiz — aks holda ketma-ket
    // ikkita yangi lead kelsa, ikkalasi ham hali eskirmagan bir xil agentga
    // tushib qolishi mumkin edi.
    await this.prisma.user.update({
      where: { id: chosen.id },
      data: { lastAssignedAt: new Date() },
    }).catch((e: any) => {
      this.logger.warn(`pickAgent: lastAssignedAt yangilanmadi (agent=${chosen.id}): ${e?.message || e}`);
    });

    return chosen.id;
  }

  // ─── Telegram bot orqali profil rasmini yuklab olish ──────────────────────
  private async saveAvatarFromBot(bot: TelegramBot, tgUserId: string, key: string): Promise<string | undefined> {
    try {
      const photos = await bot.getUserProfilePhotos(Number(tgUserId), { limit: 1 });
      const fileId = photos?.photos?.[0]?.[0]?.file_id;
      if (!fileId) return undefined;

      const fileLink = await bot.getFileLink(fileId);
      const axios = require('axios');
      const resp = await axios.get(fileLink, { responseType: 'arraybuffer' });

      const fs = require('fs');
      const path = require('path');
      const uploadDir = process.env.UPLOAD_DIR || './uploads';
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

      const fileName = `tg_avatar_bot_${key}.jpg`;
      fs.writeFileSync(path.join(uploadDir, fileName), Buffer.from(resp.data));
      const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
      return `${baseUrl}/uploads/${fileName}?v=${Date.now()}`;
    } catch (e: any) {
      // MUAMMO 6 FIX: avval xato sababi sirli yutilar edi (`catch { return undefined }`),
      // keyingi safar nega rasm saqlanmaganini debug qilib bo'lmasdi.
      this.logger.warn(`saveAvatarFromBot xato (tgUserId=${tgUserId}): ${e?.message || e}`);
      return undefined;
    }
  }

  // v13 FIX: mijoz yuborgan ovozli xabar/rasm/video/fayl — ilgari BUTUNLAY
  // saqlanmasdi (faqat matn/caption yozilardi, fileUrl hech qachon
  // to'ldirilmasdi). Shu sabab agent mijoz yuborgan ovozli xabarni HECH
  // QACHON eshita olmasdi. Endi mos fayl Telegramdan yuklab olinib, xuddi
  // bot orqali chiquvchi fayllar kabi /uploads ichiga saqlanadi.
  private async saveIncomingFile(bot: TelegramBot, fileId: string, ext: string, key: string): Promise<string | undefined> {
    try {
      const fileLink = await bot.getFileLink(fileId);
      const axios = require('axios');
      const resp = await axios.get(fileLink, { responseType: 'arraybuffer' });

      // v14 FIX: mahalliy disk o'rniga Supabase (doimiy, yetib boradigan URL) —
      // aks holda kiruvchi ovoz/rasm Render restartida yo'qolar yoki umuman ochilmasdi.
      const contentType =
        ext === 'ogg' ? 'audio/ogg'
        : ext === 'jpg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
        : ext === 'mp4' ? 'video/mp4'
        : 'application/octet-stream';
      return await uploadBufferToStorage(Buffer.from(resp.data), `tg_in_${key}_${Date.now()}.${ext}`, contentType);
    } catch (e: any) {
      this.logger.warn(`saveIncomingFile xato (fileId=${fileId}): ${e?.message || e}`);
      return undefined;
    }
  }

  // v16: suhbatlar ro'yxatida oxirgi xabar matn bo'lmasa (rasm/stiker/fayl...),
  // ilgari xom `[STICKER]`, `[PHOTO]` kabi texnik kod ko'rsatilardi. Endi
  // odam o'qiy oladigan, emoji bilan qisqa yorliq chiqadi.
  private previewLabel(messageType: MessageType): string {
    const map: Partial<Record<MessageType, string>> = {
      PHOTO: '📷 Rasm',
      VIDEO: '🎥 Video',
      VOICE: '🎤 Ovozli xabar',
      DOCUMENT: '📎 Fayl',
      STICKER: '🌟 Stiker',
      LOCATION: '📍 Joylashuv',
      CONTACT: '👤 Kontakt',
      FORWARD: '↪️ Uzatilgan xabar',
    };
    return map[messageType] || `[${messageType}]`;
  }

  private inferType(msg: TelegramBot.Message): MessageType {
    if (msg.photo) return 'PHOTO';
    if (msg.document) return 'DOCUMENT';
    if (msg.voice) return 'VOICE';
    if (msg.video) return 'VIDEO';
    if (msg.sticker) return 'STICKER';
    if (msg.location) return 'LOCATION';
    if (msg.contact) return 'CONTACT';
    if (msg.forward_from || msg.forward_from_chat) return 'FORWARD';
    return 'TEXT';
  }

  /**
   * v16: Telegramda mijoz (yoki agent) biror xabarga reaksiya (❤️, 👍, 🔥...)
   * bossa/olib tashlasa keladigan yangilanishni qayta ishlaydi. Telegram har
   * safar shu foydalanuvchining O'SHA xabar uchun JORIY (to'liq) reaksiyalar
   * ro'yxatini yuboradi — "bittasini qo'sh/o'chir" emas — shu sabab avval
   * saqlangan ro'yxatdan shu foydalanuvchining eski yozuvi olib tashlanib,
   * o'rniga yangisi qo'yiladi (bo'sh bo'lsa — reaksiya olib tashlangan degani).
   */
  private async handleReaction(reaction: any, tenantId: string) {
    const chatId = reaction?.chat?.id !== undefined ? String(reaction.chat.id) : '';
    const externalMsgId = reaction?.message_id !== undefined ? String(reaction.message_id) : '';
    if (!chatId || !externalMsgId) return;

    const conv = await this.prisma.conversation.findFirst({
      where: { tenantId, channel: 'TELEGRAM', externalChatId: chatId },
    });
    if (!conv) return;

    const msg = await this.prisma.message.findFirst({
      where: { conversationId: conv.id, externalMsgId },
    });
    if (!msg) return;

    const actorId = reaction?.user?.id !== undefined
      ? String(reaction.user.id)
      : reaction?.actor_chat?.id !== undefined ? String(reaction.actor_chat.id) : undefined;

    const toEmoji = (r: any): string => {
      if (r?.type === 'emoji') return r.emoji;
      if (r?.type === 'paid') return '⭐';
      return '🎨'; // custom_emoji — brauzerda render qila olmaymiz, o'rnini bosuvchi belgi
    };

    const newReaction = Array.isArray(reaction?.new_reaction) ? reaction.new_reaction : [];
    const existing: any[] = Array.isArray((msg as any).reactions) ? (msg as any).reactions : [];
    const filtered = actorId ? existing.filter((r: any) => r.userId !== actorId) : existing;
    const added = newReaction.map((r: any) => ({
      emoji: toEmoji(r),
      userId: actorId,
      date: new Date().toISOString(),
    }));
    const updatedReactions = [...filtered, ...added];

    await this.prisma.message.update({
      where: { id: msg.id },
      data: { reactions: updatedReactions } as any,
    });

    try {
      this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId, 'message:reaction', {
        conversationId: conv.id, messageId: msg.id, reactions: updatedReactions,
      });
      this.realtime.emitToConversation(conv.id, 'message:reaction', {
        conversationId: conv.id, messageId: msg.id, reactions: updatedReactions,
      });
    } catch {}
  }

  private async handleIncoming(
    msg: TelegramBot.Message,
    accountId: string,
    tenantId: string,
    bot: TelegramBot,
  ) {
    // MUAMMO 1 FIX: normalizatsiya qilingan chatId — GramJS (shaxsiy akkaunt)
    // orqali kelgan bir xil guruh/kanal bilan bir xil formatga tushishi uchun.
    const chatId = normalizeChatId(msg.chat.id, 'bot', msg.chat.type !== 'private');
    // MUAMMO 2 FIX: suhbat turi (private/group/supergroup/channel) endi saqlanadi.
    const chatType = msg.chat.type;
    const tgUserId = msg.from?.id ? String(msg.from.id) : undefined;
    const text = msg.text || msg.caption || '';

    let startPayload: string | undefined;
    if (text.startsWith('/start')) {
      const parts = text.split(/\s+/);
      if (parts.length > 1) startPayload = parts.slice(1).join(' ').slice(0, 80);
    }

    let conv = await this.prisma.conversation.findFirst({
      where: { tenantId, channel: 'TELEGRAM', externalChatId: chatId },
    });
    let isNew = false;

    // Telegramdan profil rasmini olib qo'yamiz (faqat hali yo'q bo'lsa) —
    // shu orqali "rasm ko'rinmayapti" muammosi hal bo'ladi
    let avatarUrl: string | undefined;
    if (tgUserId && (!conv || !conv.avatarUrl)) {
      avatarUrl = await this.saveAvatarFromBot(bot, tgUserId, chatId);
    }

    if (!conv) {
      isNew = true;
      const client = tgUserId
        ? await this.prisma.client.findFirst({
            where: { tenantId, telegramId: tgUserId },
          })
        : null;
      // v13 FIX: agar bu Telegram foydalanuvchi CRM'da allaqachon biror
      // agentga biriktirilgan klient/lid bo'lsa — round-robin o'rniga
      // TO'G'RIDAN-TO'G'RI o'sha agentga yo'naltiramiz. Ilgari bu yerda
      // har doim pickAgent() (round-robin) ishlatilardi, shu sabab bitta
      // umumiy kompaniya raqami orqali yozgan klientlar tasodifiy boshqa
      // agentlarga tushib, "kimniki-kimniki" bo'lib chalkashib ketardi.
      const assignedAgentId = client?.assignedAgentId || await this.pickAgent(tenantId);

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
          avatarUrl,
          startPayload,
          clientId: client?.id,
          assignedAgentId,
          chatType,
        } as any,
      });

      if (assignedAgentId) {
        await this.notifications.create({
          tenantId, userId: assignedAgentId,
          type: 'LEAD_NEW',
          title: '🔥 Yangi Telegram lead',
          body: (msg.from?.first_name || 'Noma\'lum') + (startPayload ? ` — ${startPayload}` : ''),
          link: `/inbox?conv=${conv.id}`,
          metadata: { conversationId: conv.id },
        }).catch(() => {});
      }
    } else {
      // v13 FIX: mavjud suhbat bo'lsa ham, agar bog'langan (yoki
      // telegramId bo'yicha topilgan) klient CRM'da boshqa agentga
      // biriktirilgan/qayta biriktirilgan bo'lsa — suhbatni ham o'sha
      // agentga sinxronlaymiz. Aks holda agent CRM'da klientni o'ziga
      // biriktirsa ham, eski suhbat hamon boshqa agentda (yoki
      // "umumiy"da) qolib, klientlar chalkashib ketaverardi.
      let linkedClient: { id: string; assignedAgentId: string | null } | null = null;
      if (conv.clientId) {
        linkedClient = await this.prisma.client.findFirst({
          where: { id: conv.clientId, tenantId },
          select: { id: true, assignedAgentId: true },
        });
      } else if (tgUserId) {
        linkedClient = await this.prisma.client.findFirst({
          where: { tenantId, telegramId: tgUserId },
          select: { id: true, assignedAgentId: true },
        });
      }

      const needsAvatarOrMeta = avatarUrl || !conv.firstName || !(conv as any).chatType;
      const needsAgentSync = !!(linkedClient?.assignedAgentId && linkedClient.assignedAgentId !== conv.assignedAgentId);

      if (needsAvatarOrMeta || needsAgentSync) {
        conv = await this.prisma.conversation.update({
          where: { id: conv.id },
          data: {
            ...(avatarUrl ? { avatarUrl } : {}),
            firstName: conv.firstName || msg.from?.first_name,
            lastName: conv.lastName || msg.from?.last_name,
            username: conv.username || msg.from?.username,
            chatType: (conv as any).chatType || chatType,
            ...(needsAgentSync ? { assignedAgentId: linkedClient!.assignedAgentId, clientId: linkedClient!.id } : {}),
          } as any,
        });
      }
    }

    const messageType = this.inferType(msg);

    // v13 FIX: media fayllarni (ovozli xabar, rasm, video, hujjat) haqiqatan
    // yuklab olib saqlaymiz — aks holda agent mijoz yuborgan ovozli xabar
    // yoki rasmni ko'ra/eshita olmasdi.
    let fileUrl: string | undefined;
    let duration: number | undefined;
    try {
      if (messageType === 'VOICE' && msg.voice) {
        fileUrl = await this.saveIncomingFile(bot, msg.voice.file_id, 'ogg', chatId);
        duration = msg.voice.duration;
      } else if (messageType === 'PHOTO' && msg.photo?.length) {
        const largest = msg.photo[msg.photo.length - 1];
        fileUrl = await this.saveIncomingFile(bot, largest.file_id, 'jpg', chatId);
      } else if (messageType === 'VIDEO' && msg.video) {
        fileUrl = await this.saveIncomingFile(bot, msg.video.file_id, 'mp4', chatId);
        duration = msg.video.duration;
      } else if (messageType === 'DOCUMENT' && msg.document) {
        const ext = msg.document.file_name?.split('.').pop() || 'bin';
        fileUrl = await this.saveIncomingFile(bot, msg.document.file_id, ext, chatId);
      } else if (messageType === 'STICKER' && msg.sticker) {
        // v16 FIX: sticker turi aniqlanardi (STICKER), lekin fayl HECH QACHON
        // yuklab olinmasdi — shu sabab agent inboxda stikerni umuman ko'ra
        // olmasdi (bo'sh xabar bo'lib ko'rinardi). Statik stikerlar (.webp)
        // to'g'ridan-to'g'ri yuklanadi. Animatsion (.tgs/Lottie) yoki video
        // (.webm) stikerlar oddiy <img>/<video>da to'g'ri ochilmagani uchun,
        // ular uchun Telegram taqdim etadigan JPG preview (thumb) olinadi —
        // shunda agent hech bo'lmasa qaysi stiker yuborilganini ko'radi.
        if (!msg.sticker.is_animated && !msg.sticker.is_video) {
          fileUrl = await this.saveIncomingFile(bot, msg.sticker.file_id, 'webp', chatId);
        } else if (msg.sticker.thumb?.file_id) {
          fileUrl = await this.saveIncomingFile(bot, msg.sticker.thumb.file_id, 'jpg', chatId);
        }
      }
    } catch (e: any) {
      this.logger.warn(`Inbound media yuklashda xato: ${e?.message || e}`);
    }

    const newMsg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        externalMsgId: String(msg.message_id),
        direction: 'INBOUND',
        messageType,
        text: msg.text || msg.caption || null,
        fileUrl,
        duration,
      },
    });

    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: new Date(),
        lastMessageText: (msg.text || msg.caption || this.previewLabel(messageType)).slice(0, 200),
        lastMessageType: messageType,
        unreadCount: { increment: 1 },
        isResolved: false,
      },
    });

    // Real-time emit (WebSocket) — v10 MUAMMO 4 FIX: butun tenant o'rniga
    // faqat biriktirilgan agent + admin/manager'larga (yoki agent
    // biriktirilmagan bo'lsa — barcha agentlarga "umumiy" sifatida)
    try {
      this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId, 'message:new', newMsg);
      this.realtime.emitToConversation(conv.id, 'message:new', newMsg);
      this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId, 'conversation:updated', {
        conversationId: conv.id,
        lastMessageText: (msg.text || msg.caption || this.previewLabel(messageType)).slice(0, 200),
        lastMessageAt: new Date(),
      });
    } catch {}

    if (!isNew && conv.assignedAgentId) {
      const recent = await this.prisma.notification.findFirst({
        where: {
          userId: conv.assignedAgentId,
          type: 'NEW_MESSAGE',
          createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
          metadata: { path: ['conversationId'], equals: conv.id } as any,
        },
      });
      if (!recent) {
        await this.notifications.create({
          tenantId, userId: conv.assignedAgentId,
          type: 'NEW_MESSAGE',
          title: '💬 Yangi xabar',
          body: (msg.text || msg.caption || this.previewLabel(messageType)).slice(0, 100),
          link: `/inbox?conv=${conv.id}`,
          metadata: { conversationId: conv.id },
        }).catch(() => {});
      }
    }

    if (conv.clientId) {
      await this.prisma.client.update({
        where: { id: conv.clientId },
        data: { lastContactAt: new Date() },
      }).catch(() => {});
    }
  }

  /**
   * 🩹 MUHIM TUZATISH: avval bot xotiradagi `this.bots` xaritasida topilmasa
   * (masalan server hozirgina qayta ishga tushgan, deploy paytida bot hali
   * to'liq ulanmagan, yoki 409 Conflict tufayli vaqtincha o'chib qolgan
   * bo'lsa) — kod DARHOL "Bot aktiv emas" deb xato qaytarardi, HATTO klient
   * /start bosgan va bot to'liq sozlangan bo'lsa ham. Endi shu holatda DB'dagi
   * saqlangan tokendan foydalanib botni QAYTA ISHGA TUSHIRISHGA urinamiz —
   * shundan keyingina, agar chindan ham muvaffaqiyatsiz bo'lsa, aniq xato
   * qaytaramiz.
   */
  private async getOrStartBot(accountId: string, tenantId: string): Promise<TelegramBot> {
    const cached = this.bots.get(accountId);
    if (cached) return cached;

    const acc = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, tenantId, isActive: true, botToken: { not: null } },
    });
    if (!acc?.botToken) {
      throw new BadRequestException(
        "Bot ulanmagan yoki o'chirilgan. Settings → Telegram bo'limida bot tokenini tekshiring.",
      );
    }

    this.logger.warn(`Bot ${accountId} xotirada topilmadi — DB tokenidan qayta ishga tushirilmoqda...`);
    try {
      await this.startBot(acc.id, tenantId, acc.botToken);
    } catch (e: any) {
      throw new BadRequestException(`Botni ishga tushirib bo'lmadi: ${e?.message || e}`);
    }

    const started = this.bots.get(accountId);
    if (!started) {
      throw new BadRequestException(
        "Bot aktiv emas (qayta ishga tushirishga urinildi, lekin muvaffaqiyatsiz bo'ldi). " +
          "Bot tokeni to'g'riligini (Settings → Telegram) tekshiring.",
      );
    }
    return started;
  }

  async sendMessage(
    tenantId: string, conversationId: string, text: string,
    agentId: string, agentRole: string, isInternal = false,
  ) {
    if (!text?.trim()) throw new BadRequestException("Xabar bo'sh");
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { account: true },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');

    // ── v5: AGENT faqat o'ziga tayinlangan suhbatga javob bera oladi ──
    // (TENANT_ADMIN, MANAGER barchasiga javob bera oladi)
    if (agentRole === 'AGENT') {
      if (conv.assignedAgentId && conv.assignedAgentId !== agentId) {
        throw new ForbiddenException(
          'Bu suhbat boshqa agentga tayinlangan. Avval admin sizga tayinlashi kerak.',
        );
      }
      // Agar tayinlanmagan bo'lsa, avtomatik o'ziga tayinlaymiz
      if (!conv.assignedAgentId) {
        await this.prisma.conversation.update({
          where: { id: conversationId },
          data: { assignedAgentId: agentId },
        });
      }
    }

    // ── v12.2: INSTAGRAM suhbati ──
    // Instagram'da Telegram bot yo'q — xabar Graph API orqali ketadi.
    // Xabarni bazaga InstagramService o'zi yozadi (24 soatlik oynani
    // tekshirgach), shuning uchun bu yerda erta return qilamiz.
    if (!isInternal && conv.channel === 'INSTAGRAM') {
      const igMsg = await this.instagram.sendAgentMessage(
        tenantId, conversationId, text, agentId,
      );
      this.realtime.emitToUser(agentId, 'message:new', igMsg);
      return igMsg;
    }

    // v14 FIX: shaxsiy (MTProto) account orqali kelgan suhbatда BOT ishlamaydi
    // ("Bot aktiv emas"). Bunday suhbatда (invoice/booking "Mijozga yuborish" ham)
    // to'liq userTelegram (MTProto) orqali — mijoz qaysi accountда yozayotgan
    // bo'lsa, o'sha (umumiy shaxsiy) account orqali javob ketadi.
    if (!isInternal && conv.channel === 'TELEGRAM' && (conv as any).account?.isPersonal) {
      return this.userTelegram.sendPersonalMessage(tenantId, agentId, {
        conversationId,
        text,
        clientId: conv.clientId || undefined,
      });
    }

    // v14.1 TUZATISH: bot instansini xabar bazaga yozilishidan OLDIN
    // aniqlaymiz (kerak bo'lsa lazy-restart qilib) — aks holda bot
    // topilmasa, xabar allaqachon "yuborilgan" sifatida saqlanib qolar,
    // lekin hech qanday xato/failed belgisi bo'lmasdi.
    let bot: TelegramBot | undefined;
    if (!isInternal && conv.channel === 'TELEGRAM' && conv.accountId) {
      bot = await this.getOrStartBot(conv.accountId, tenantId);
    }

    const msg = await this.prisma.message.create({
      data: {
        conversationId, agentId,
        direction: 'OUTBOUND',
        messageType: 'TEXT',
        // v15 FIX: avval bu yerda HAR DOIM `isRead: true` yozilardi — ya'ni
        // bot orqali yuborilgan xabar bazaga yozilgan ONDA "o'qildi" (✓✓)
        // belgisi darhol chiqardi, garchi Telegram Bot API'da mijoz xabarni
        // haqiqatan o'qiganini bilishning HECH QANDAY yo'li yo'q. Bu
        // frontendda ko'rsatilayotgan "o'qildi/o'qilmadi" belgisini butunlay
        // yolg'on qilib qo'yardi. Endi faqat ICHKI (isInternal) izohlar
        // "o'qilgan" deb belgilanadi (ular mijozga ko'rinmaydi, bu yerda
        // ahamiyatsiz) — mijozga ketgan xabar esa haqiqiy o'qilgan-o'qilmagan
        // holatini bilmagunimizcha `false` bo'lib qoladi. Shaxsiy (MTProto)
        // akkaunt orqali ketgan xabarlar uchun bu holat keyinchalik haqiqiy
        // Telegram "o'qildi" signalidan (UpdateReadHistoryOutbox) kelib
        // avtomatik yangilanadi — pastdagi `startListening()`ga qarang.
        text, isInternal, isRead: isInternal,
      },
      include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
    });

    if (!isInternal && conv.channel === 'TELEGRAM' && conv.accountId && bot) {
      try {
        const sent = await bot.sendMessage(conv.externalChatId, text);
        // v13 DUBLIKAT FIX: avval bu natija bazaga yozilar edi-yu, lekin
        // pastdagi socket emit'da ESKI `msg` obyekti (externalMsgId=null)
        // ishlatilardi. Ikkita alohida socket xonasiga ('user:X' va
        // 'conv:Y') bir xil xabar externalMsgId=null bilan ikki marta
        // yuborilardi — frontend buni "ikkita boshqa xabar" deb hisoblab
        // ro'yxatga IKKALASINI HAM qo'shardi (shuning uchun agent yuborgan
        // har bir xabar ekranda ikki marta ko'rinardi). Endi yangilangan
        // qiymatni xotiradagi `msg` obyektiga ham yozamiz — shu orqali emit
        // qilinadigan ikkala nusxa ham BIR XIL externalMsgId'ga ega bo'ladi
        // va frontend ularni to'g'ri dublikat deb tanib, bittasini ko'rsatadi.
        (msg as any).externalMsgId = String(sent.message_id);
        (msg as any).isDelivered = true;
        await this.prisma.message.update({
          where: { id: msg.id },
          data: { externalMsgId: String(sent.message_id), isDelivered: true },
        });
      } catch (e: any) {
        await this.prisma.message.update({
          where: { id: msg.id },
          data: { isFailed: true, errorMessage: e.message },
        });
        throw new BadRequestException(`Yuborilmadi: ${e.message}`);
      }
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date(), lastMessageText: text.slice(0, 200), lastMessageType: 'TEXT' },
      });
    }

    // Realtime emit — v10 MUAMMO 4 FIX: tenant-keng emas, faqat tegishlilarga
    try {
      const targetAgentId = conv.assignedAgentId || agentId;
      this.realtime.emitConversationEvent(tenantId, targetAgentId, 'message:new', msg);
      this.realtime.emitToConversation(conversationId, 'message:new', msg);
      this.realtime.emitConversationEvent(tenantId, targetAgentId, 'conversation:updated', {
        conversationId,
        lastMessageText: text.slice(0, 200),
        lastMessageAt: new Date(),
      });
    } catch {}

    return msg;
  }

  /**
   * Tizim tomonidan avtomatik yuboriladigan xabarlar uchun (masalan:
   * booking uchish sanasidan 2 kun oldin yuboriladigan eslatma). Hech qanday
   * agent/AI aralashuvisiz, faqat kod orqali ishlaydi — shuning uchun
   * agentId/agentRole talab qilmaydi va "tayinlangan agent"ga tegishli
   * ruxsat tekshiruvlarini o'tkazib yubormaydi (chunki bu tekshiruv
   * odam-agent xabar yozganda kerak, tizim xabarida emas).
   * Suhbat turiga qarab (bot yoki shaxsiy/MTProto akkaunt) mos yo'l bilan
   * yuboradi va xabarni suhbat tarixiga (Message) yozadi.
   */
  async sendSystemMessage(tenantId: string, conversationId: string, text: string) {
    if (!text?.trim()) throw new BadRequestException("Xabar bo'sh");
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { account: true },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');
    if (conv.channel !== 'TELEGRAM') {
      throw new BadRequestException('Avtomatik eslatma faqat Telegram suhbatlariga yuboriladi');
    }

    // Shaxsiy (MTProto) akkaunt orqali ulangan suhbat — UserTelegramService orqali
    if ((conv as any).account?.isPersonal) {
      return this.userTelegram.sendSystemMessage(tenantId, conversationId, text);
    }

    if (!conv.accountId) {
      throw new BadRequestException("Suhbat hech qanday Telegram akkauntga bog'lanmagan");
    }
    const bot = await this.getOrStartBot(conv.accountId, tenantId);

    const msg = await this.prisma.message.create({
      data: {
        conversationId, agentId: null,
        direction: 'OUTBOUND', messageType: 'TEXT',
        text, isInternal: false, isRead: false,
      },
    });

    try {
      const sent = await bot.sendMessage(conv.externalChatId, text);
      await this.prisma.message.update({
        where: { id: msg.id },
        data: { externalMsgId: String(sent.message_id), isDelivered: true },
      });
    } catch (e: any) {
      await this.prisma.message.update({
        where: { id: msg.id },
        data: { isFailed: true, errorMessage: e.message },
      });
      throw new BadRequestException(`Yuborilmadi: ${e.message}`);
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), lastMessageText: text.slice(0, 200), lastMessageType: 'TEXT' },
    });

    try {
      this.realtime.emitToConversation(conversationId, 'message:new', msg);
      this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId, 'conversation:updated', {
        conversationId,
        lastMessageText: text.slice(0, 200),
        lastMessageAt: new Date(),
      });
    } catch {}

    return msg;
  }

  /**
   * v6: Rasm/fayl yuborish
   * Agentlar mehmonxona rasmlarini va boshqa fayllarni klientga yuboradi.
   */
  async sendMedia(
    tenantId: string, conversationId: string,
    agentId: string, agentRole: string,
    data: { fileUrl: string; mimeType?: string; caption?: string; mediaType?: 'photo' | 'document' | 'video' | 'voice' }
  ) {
    if (!data.fileUrl) throw new BadRequestException('Fayl URL bo\'sh');

    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { account: true },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');

    // Role check
    if (agentRole === 'AGENT') {
      if (conv.assignedAgentId && conv.assignedAgentId !== agentId) {
        throw new ForbiddenException('Bu suhbat boshqa agentga tayinlangan');
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
    // v13: ovozli xabar (voice) qo'llab-quvvatlash — agent mijozga ovozli
    // xabar yubora oladigan bo'ldi.
    const isVoice = data.mediaType === 'voice' ||
      (data.mimeType?.startsWith('audio/') ?? false);
    const msgType: any = isVoice ? 'VOICE' : isImage ? 'PHOTO' : isVideo ? 'VIDEO' : 'DOCUMENT';

    // v14.1 TUZATISH: sendMessage'dagi bilan bir xil — bot instansini
    // xabar bazaga yozilishidan OLDIN aniqlaymiz (lazy-restart bilan).
    let bot: TelegramBot | undefined;
    if (conv.channel === 'TELEGRAM' && conv.accountId) {
      bot = await this.getOrStartBot(conv.accountId, tenantId);
    }

    const msg = await this.prisma.message.create({
      data: {
        conversationId, agentId,
        direction: 'OUTBOUND',
        messageType: msgType,
        fileUrl: data.fileUrl,
        fileMimeType: data.mimeType,
        caption: data.caption,
        // v15 FIX: bot orqali "o'qildi" holatini bilib bo'lmaydi — xatoan
        // darhol `true` qo'yilmasin (yuqoridagi sendMessage'dagi izohga qarang).
        isRead: false,
      },
      include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
    });

    // Telegramga yuborish
    if (conv.channel === 'TELEGRAM' && conv.accountId && bot) {

      // v9-FINAL: Localhost URL — Telegram tashqaridan yuklay olmaydi
      // Fayl tizimidan stream sifatida o'qib yuboramiz
      const fs = require('fs');
      const path = require('path');
      let fileToSend: any = data.fileUrl;
      try {
        if (data.fileUrl.includes('/uploads/')) {
          const filename = data.fileUrl.split('/uploads/').pop();
          const filePath = path.join(process.cwd(), 'uploads', filename);
          if (fs.existsSync(filePath)) {
            fileToSend = fs.createReadStream(filePath);
          }
        }
      } catch (fsErr) {
        // Agar fs yo'q bo'lsa - URL bilan urinib ko'ramiz
      }

      try {
        let sent: any;
        if (isVoice) {
          sent = await bot.sendVoice(conv.externalChatId, fileToSend);
        } else if (isImage) {
          sent = await bot.sendPhoto(conv.externalChatId, fileToSend, {
            caption: data.caption,
          });
        } else if (isVideo) {
          sent = await bot.sendVideo(conv.externalChatId, fileToSend, {
            caption: data.caption,
          });
        } else {
          sent = await bot.sendDocument(conv.externalChatId, fileToSend, {
            caption: data.caption,
          });
        }
        // v13 DUBLIKAT FIX: xuddi sendMessage'dagidek — emit qilinadigan
        // `msg` obyektini ham yangilangan externalMsgId bilan sinxronlaymiz,
        // aks holda rasm/fayl/ovozli xabarlar ham ikki marta ko'rinardi.
        (msg as any).externalMsgId = String(sent.message_id);
        (msg as any).isDelivered = true;
        await this.prisma.message.update({
          where: { id: msg.id },
          data: { externalMsgId: String(sent.message_id), isDelivered: true },
        });
      } catch (e: any) {
        await this.prisma.message.update({
          where: { id: msg.id },
          data: { isFailed: true, errorMessage: e.message },
        });
        throw new BadRequestException(`Yuborilmadi: ${e.message}`);
      }

      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          lastMessageText: data.caption?.slice(0, 200) || (isVoice ? '🎤 Ovozli xabar' : isImage ? '📷 Rasm' : '📎 Fayl'),
          lastMessageType: msgType,
        },
      });
    }

    try {
      this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId || agentId, 'message:new', msg);
      this.realtime.emitToConversation(conversationId, 'message:new', msg);
    } catch {}

    return msg;
  }

  /**
   * v6: Shablon yuborish (matn + barcha media bilan)
   * Mehmonxona shablonlari: tariflash matni + bir nechta rasm
   */
  async sendTemplate(
    tenantId: string, conversationId: string,
    agentId: string, agentRole: string,
    templateId: string,
  ) {
    const [template, conv] = await Promise.all([
      this.prisma.messageTemplate.findFirst({
        where: { id: templateId, tenantId, isActive: true },
      }),
      this.prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        include: {
          account: true,
          client: {
            include: {
              bookings: {
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            } as any,
          },
        } as any,
      }),
    ]);
    if (!template) throw new NotFoundException('Shablon topilmadi');
    if (!conv) throw new NotFoundException('Suhbat topilmadi');

    // ── Shablon o'zgaruvchilarini avtomatik to'ldirish ──────────────────────
    const client: any = (conv as any).client;
    const booking: any = (client?.bookings?.[0]) || null;

    const fmt = (d: any) => d ? new Date(d).toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
    const vars: Record<string, string> = {
      // v12 FIX: mijoz CRM kartasiga bog'lanmagan bo'lsa (ko'p shaxsiy suhbatlar
      // shunday) — Telegram kontakt ismini ishlatamiz, "Mijoz" emas.
      client_name:    client?.fullName
        || [ (conv as any).firstName, (conv as any).lastName ].filter(Boolean).join(' ').trim()
        || (conv as any).username
        || 'Mijoz',
      tour_name:      booking?.tourName || '—',
      booking_ref:    booking?.bookingRef || '—',
      destination:    booking?.destination || '—',
      departure_date: fmt(booking?.departureDate),
      return_date:    fmt(booking?.returnDate),
      total_price:    booking?.totalPrice ? `$${Number(booking.totalPrice).toFixed(0)}` : '—',
      paid_amount:    booking?.paidAmount ? `$${Number(booking.paidAmount).toFixed(0)}` : '$0',
      agent_name:     '',  // quyida to'ldirilamiz
    };

    // Agent ismini ham qo'shamiz
    try {
      const agent = await this.prisma.user.findFirst({ where: { id: agentId }, select: { name: true } });
      vars.agent_name = agent?.name || '';
    } catch {}

    const varRe = new RegExp('\\{([^}]+)\\}', 'g');
    const fill = (str: string) =>
      str.replace(varRe, (_, k: string) => vars[k.trim()] ?? ('{' + k + '}'));

    const filledText = fill(template.text || '');

    // useCount oshirish
    await this.prisma.messageTemplate.update({
      where: { id: templateId },
      data: { useCount: { increment: 1 } },
    });

    const sentMessages: any[] = [];

    // ── Shaxsiy (isPersonal) suhbat — MTProto client orqali yuborish ────────
    // Bot mavjud bo'lmasa ham ishlaydi
    const isPersonalConv = (conv as any).account?.isPersonal || !conv.accountId;

    if (isPersonalConv) {
      // v17 FIX: ilgari bu yerda HAR SAFAR o'zining alohida TelegramClient'i
      // (activeSessions cache'idan mustaqil) ochilib, hech qachon to'g'ri
      // yopilmasdan (yoki bir xil session bilan PARALLEL ikkinchi ulanish
      // hosil qilib) yuborilardi — bundan tashqari account HAM noto'g'ri
      // (`userId: agentId` — hozir gapirayotgan agentning O'ZI ulagan
      // accounti, suhbat aslida qaysi accountga tegishli bo'lishidan
      // qat'iy nazar) tanlanardi. Endi userTelegram.sendPersonalMessage()
      // orqali — u aynan shu suhbatning conv.accountId'siga tegishli,
      // xotirada keshlangan (activeSessions) sessiyani ishlatadi.
      if (filledText.trim()) {
        const r = await this.userTelegram.sendPersonalMessage(tenantId, agentId, {
          conversationId,
          text: filledText,
        });
        if (r?.message) sentMessages.push(r.message);
      }
    } else {
      // Bot suhbati — standart sendMessage orqali yuboramiz
      if (filledText.trim()) {
        const msg = await this.sendMessage(tenantId, conversationId, filledText, agentId, agentRole, false);
        sentMessages.push(msg);
      }

      // Media
      if (template.mediaUrl) {
        try {
          const mediaMsg = await this.sendMedia(tenantId, conversationId, agentId, agentRole, {
            fileUrl: template.mediaUrl,
            mediaType: (template.mediaType as any) || 'photo',
            caption: fill(template.mediaCaption || ''),
          });
          sentMessages.push(mediaMsg);
        } catch {}
      }

      // Attachments
      if (Array.isArray(template.attachments)) {
        for (const att of template.attachments as any[]) {
          if (!att?.url) continue;
          try {
            const m = await this.sendMedia(tenantId, conversationId, agentId, agentRole, {
              fileUrl: att.url, mimeType: att.mimeType,
              mediaType: att.type || 'photo', caption: fill(att.caption || ''),
            });
            sentMessages.push(m);
          } catch {}
        }
      }
    }

    return { sent: sentMessages.length, messages: sentMessages };
  }

  /**
   * v6: Invoice'ni inbox suhbati orqali yuborish
   * Asosiy use case: agent klient bilan yozishyapti, lekin to'lov uchun invoice kerak
   */
  async sendInvoiceFromInbox(
    tenantId: string, conversationId: string,
    agentId: string, agentRole: string,
    data: {
      bookingId: string;
      salePrice: number;
      providerCost?: number;
      discount?: number;
      notes?: string;
      currency?: string;
      dueDate?: string;
    }
  ) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { client: true },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');
    if (!conv.clientId) throw new BadRequestException('Suhbatga klient bog\'lanmagan');

    // Booking tekshirish (services bilan birga - invoice'da ko'rinishi uchun)
    // v9: include cast - Prisma generate qilingach to'g'ridan-to'g'ri ishlaydi
    const booking = await this.prisma.booking.findFirst({
      where: { id: data.bookingId, tenantId, clientId: conv.clientId },
      include: {
        services: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: { createdAt: 'asc' },
        },
      } as any,
    }) as any;
    if (!booking) throw new NotFoundException('Booking topilmadi');

    // Invoice raqami: INV-YYYY-NNNN
    const year = new Date().getFullYear();
    const lastInv = await this.prisma.invoice.findFirst({
      where: { tenantId, invoiceNumber: { startsWith: `INV-${year}-` } },
      orderBy: { invoiceNumber: 'desc' },
    });
    let seq = 1;
    if (lastInv) {
      const lastSeq = parseInt(lastInv.invoiceNumber.split('-')[2], 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    const invoiceNumber = `INV-${year}-${String(seq).padStart(4, '0')}`;

    const salePrice = Number(data.salePrice) || booking.totalPrice;
    const providerCost = agentRole === 'AGENT' ? 0 : (Number(data.providerCost) || 0);
    const discount = Number(data.discount) || 0;
    const profit = Math.max(0, salePrice - providerCost - discount);
    const totalAmount = salePrice - discount;

    // Invoice yaratish
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
        currency: (data.currency || booking.currency) as any,
        status: 'SENT',
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        notes: data.notes,
        issuedAt: new Date(),
        sentAt: new Date(),
        sentViaTelegram: true,
      },
    });

    // Invoice matnini chiroyli format qilib yuborish
    const invoiceText = this.formatInvoiceMessage(invoice, booking, conv.client);

    const msg = await this.sendMessage(
      tenantId, conversationId, invoiceText, agentId, agentRole, false,
    );

    return { invoice, message: msg };
  }

  /**
   * Invoice'ni chiroyli matn formatga aylantirish (Telegramga yuborish uchun)
   */
  private formatInvoiceMessage(invoice: any, booking: any, client: any): string {
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

    // 🏨 Mehmonxona
    if (booking.hotelName) {
      lines.push(``, `🏨 *MEHMONXONA*`);
      lines.push(`• ${booking.hotelName}${booking.hotelStars ? ` ${'⭐'.repeat(booking.hotelStars)}` : ''}`);
      if (booking.hotelCity) lines.push(`• Shahar: ${booking.hotelCity}`);
      if (booking.hotelAddress) lines.push(`• Manzil: ${booking.hotelAddress}`);
      if (booking.hotelCheckIn) lines.push(`• Check-in: ${new Date(booking.hotelCheckIn).toLocaleDateString('uz-UZ')}`);
      if (booking.hotelCheckOut) lines.push(`• Check-out: ${new Date(booking.hotelCheckOut).toLocaleDateString('uz-UZ')}`);
    }

    // ✈️ Reys
    if (booking.flightNumber || booking.flightDeparture) {
      lines.push(``, `✈️ *REYS*`);
      if (booking.flightNumber) lines.push(`• Reys: ${booking.flightNumber}`);
      if (booking.flightDeparture) lines.push(`• Ketish: ${booking.flightDeparture}`);
      if (booking.flightArrival) lines.push(`• Borish: ${booking.flightArrival}`);
      if (booking.flightClass) lines.push(`• Klass: ${booking.flightClass}`);
    }

    // 🚕 Taxi/Transfer
    if (booking.taxiPickupAddress || booking.taxiCompany) {
      lines.push(``, `🚕 *TRANSFER*`);
      if (booking.taxiPickupAddress) lines.push(`• Olib ketish: ${booking.taxiPickupAddress}`);
      if (booking.taxiDropoffAddress) lines.push(`• Olib boorish: ${booking.taxiDropoffAddress}`);
      if (booking.taxiPickupTime) lines.push(`• Vaqt: ${new Date(booking.taxiPickupTime).toLocaleString('uz-UZ')}`);
      if (booking.taxiCompany) lines.push(`• Kompaniya: ${booking.taxiCompany}`);
      if (booking.taxiDriverName) lines.push(`• Haydovchi: ${booking.taxiDriverName} ${booking.taxiDriverPhone ? `(${booking.taxiDriverPhone})` : ''}`);
    }

    // 🛡 Sug'urta
    if (booking.insuranceCompany) {
      lines.push(``, `🛡 *SUG'URTA*`);
      lines.push(`• Kompaniya: ${booking.insuranceCompany}`);
      if (booking.insurancePolicyNo) lines.push(`• Polisa №: ${booking.insurancePolicyNo}`);
      if (booking.insuranceCoverage) lines.push(`• Qoplama: ${booking.insuranceCoverage}`);
    }

    // 🛂 Viza
    if (booking.visaStatus && booking.visaStatus !== 'not_required') {
      lines.push(``, `🛂 *VIZA*`);
      lines.push(`• Holat: ${booking.visaStatus}`);
      if (booking.visaType) lines.push(`• Turi: ${booking.visaType}`);
      if (booking.visaExpiryDate) lines.push(`• Amal qiladi: ${new Date(booking.visaExpiryDate).toLocaleDateString('uz-UZ')}`);
    }

    // 🛎 Qo'shimcha xizmatlar (v9)
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
        if (s.notes) lines.push(`   📝 ${s.notes}`);
      }
    }

    // 💰 Moliyaviy
    lines.push(``, `💰 *NARX TAFSILOTI*`);
    lines.push(`• Jami narx: ${invoice.currency} ${invoice.salePrice.toFixed(2)}`);
    if (invoice.discount > 0) {
      lines.push(`• Chegirma: -${invoice.currency} ${invoice.discount.toFixed(2)}`);
    }
    lines.push(`• ✅ *To'lash kerak: ${invoice.currency} ${invoice.totalAmount.toFixed(2)}*`);

    // Booking.paidAmount bo'lsa
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

  async claim(tenantId: string, conversationId: string, userId: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');
    if (conv.assignedAgentId && conv.assignedAgentId !== userId) {
      throw new BadRequestException('Bu suhbatni boshqa agent olgan');
    }
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedAgentId: userId },
    });
  }

  /**
   * Bot ulash. userId berilsa - agent shaxsiy boti.
   * Aks holda - tenant-wide (admin uchun).
   */
  async connectBot(tenantId: string, token: string, name: string, userId?: string) {
    if (!token?.trim()) throw new BadRequestException('Token kerak');
    const tempBot = new TelegramBot(token);
    const info = await tempBot.getMe().catch(() => {
      throw new BadRequestException('Token noto\'g\'ri');
    });
    const dup = await this.prisma.telegramAccount.findFirst({
      where: { tenantId, botToken: token },
    });
    if (dup) throw new BadRequestException('Bu bot allaqachon ulangan');

    const acc = await this.prisma.telegramAccount.create({
      data: {
        tenantId, name: name?.trim() || info.first_name,
        botToken: token, botUsername: info.username,
        channel: 'TELEGRAM', isActive: true,
        userId: userId || null, // v8: agent shaxsiy boti bo'lsa userId saqlanadi
      },
    });
    await this.startBot(acc.id, tenantId, token);
    return { ...acc, botToken: undefined };
  }

  /**
   * AI Marketing (TurMaker-uslubidagi reklama) uchun: tayyor banner +
   * matnni tenant'ning Telegram BOT'i orqali istalgan kanalga (yoki
   * chatga) yuboradi. Suhbat (Conversation) bilan bog'liq EMAS — bu
   * mijoz bilan yozishmalar emas, ommaviy reklama e'loni.
   *
   * MUHIM: bot kanalga xabar yuborishi uchun kanalning
   * ADMINISTRATORI bo'lishi shart (Telegram cheklovi — buni
   * boshqacha qilib bo'lmaydi). `chatId` — kanal username'i
   * (masalan "@mening_kanalim") yoki raqamli chat ID.
   */
  async sendAdToChannel(
    tenantId: string,
    chatId: string,
    photoUrl: string,
    caption: string,
    accountId?: string,
  ): Promise<{ messageId: number }> {
    if (!chatId?.trim()) throw new BadRequestException('Kanal ID/username kerak');
    if (!photoUrl?.trim()) throw new BadRequestException("Rasm URL'i kerak");

    const account = await this.prisma.telegramAccount.findFirst({
      where: accountId
        ? { id: accountId, tenantId }
        : { tenantId, isActive: true, botToken: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (!account) {
      throw new BadRequestException(
        "Telegram bot ulanmagan. Sozlamalar → Telegram bo'limidan bot tokeningizni qo'shing",
      );
    }

    const bot = await this.getOrStartBot(account.id, tenantId);

    try {
      // Telegram caption cheklovi — 1024 belgi
      const safeCaption = String(caption || '').slice(0, 1024);
      const sent = await bot.sendPhoto(chatId.trim(), photoUrl, { caption: safeCaption });
      return { messageId: sent.message_id };
    } catch (e: any) {
      const raw = String(e?.message || e);
      // Telegram'ning eng ko'p uchraydigan xatosi — bot kanalga admin
      // qilib qo'yilmagan bo'lsa, tushunarli xabar beramiz
      if (/chat not found|not enough rights|CHAT_ADMIN_REQUIRED/i.test(raw)) {
        throw new BadRequestException(
          `Kanalga yuborib bo'lmadi: bot "${chatId}" kanalining administratori emas, ` +
            'yoki kanal ID noto\'g\'ri. Botni kanalga admin sifatida qo\'shing.',
        );
      }
      throw new BadRequestException(`Telegram'ga yuborishda xato: ${raw}`);
    }
  }

  /**
   * v8: Yangi suhbat boshlash (agent o'zi yozadi).
   * Telegram bot chat_id orqali xabar yuborish — chat_id avval bot bilan
   * gaplashgan bo'lishi kerak (Telegram cheklovi).
   *
   * Variant 1: Agent klientga "/start <bot>" yozish iltimosi
   * Variant 2: chat_id ma'lum bo'lsa - to'g'ridan-to'g'ri yuborish
   */
  async startNewConversation(
    tenantId: string,
    userId: string,
    data: { chatId?: string; username?: string; text: string; clientId?: string; accountId?: string }
  ) {
    if (!data.text?.trim()) throw new BadRequestException('Xabar matni kerak');

    // Bot accountni topish (admin tomonidan ulangan yoki agent shaxsiy)
    let accountWhere: any = { tenantId, isActive: true, botToken: { not: null } };
    if (data.accountId) accountWhere.id = data.accountId;
    else accountWhere.OR = [{ userId }, { userId: null }]; // agent o'ziniki yoki tenant-wide

    const account = await this.prisma.telegramAccount.findFirst({
      where: accountWhere,
      orderBy: { createdAt: 'asc' },
    });
    if (!account) {
      throw new BadRequestException(
        'Bot ulanmagan. Settings → Telegram bo\'limidan bot tokeningizni qo\'shing'
      );
    }

    if (!data.chatId && !data.username) {
      throw new BadRequestException(
        "Chat ID yoki username kerak. Eslatma: Telegram bot username orqali xabar yubora olmaydi - " +
        "klient avval botingiz bilan /start yozishi kerak."
      );
    }

    const bot = await this.getOrStartBot(account.id, tenantId);

    try {
      const targetChat = data.chatId || data.username!;
      const sent = await bot.sendMessage(targetChat, data.text);

      // Conversation yaratish
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
      } else {
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

      // Message saqlash
      // Eslatma: Message modelida tenantId va accountId yo'q (faqat conversationId orqali)
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
    } catch (e: any) {
      throw new BadRequestException(
        e.message?.includes('chat not found')
          ? "Klient bot bilan /start yozmagan. Klient avval botingizga yozishi kerak."
          : `Telegram xato: ${e.message}`
      );
    }
  }

  async disconnectBot(tenantId: string, accountId: string) {
    const acc = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, tenantId },
    });
    if (!acc) throw new NotFoundException('Topilmadi');
    const bot = this.bots.get(accountId);
    if (bot) {
      try { await bot.stopPolling(); } catch {}
      this.bots.delete(accountId);
    }
    // v18: bot uzilganda qulfni ham bo'shatamiz — aks holda shu accountId
    // uchun qulf 30s TTL tugagunga qadar band bo'lib turadi.
    await this.pollLock.release(`telegram-bot:${accountId}`).catch(() => {});
    return this.prisma.telegramAccount.update({
      where: { id: accountId },
      data: { isActive: false },
    });
  }

  async getConversations(
    tenantId: string, userId: string, role: string,
    params: any,
  ) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where: any = { tenantId };
    if (params.resolved !== undefined) where.isResolved = params.resolved === 'true';
    if (params.channel) where.channel = params.channel;
    if (params.unassigned === 'true') where.assignedAgentId = null;
    else if (role === 'AGENT') {
      // v14 QAT'IY IZOLYATSIYA: agent FAQAT o'ziga biriktirilgan suhbatlarni
      // ko'radi. Boshqa agentniki (biriktirilmagan "umumiy" bo'lsa ham) ko'rinmaydi.
      // Yangi lead round-robin orqali darhol biriktiriladi, admin esa hammasini
      // ko'radi va kerak bo'lsa qayta biriktiradi.
      where.assignedAgentId = userId;
    } else if (params.agentId) {
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
    // Add isPersonal flag from account to each conversation
    const enriched = data.map((conv: any) => ({
      ...conv,
      isPersonal: conv.account?.isPersonal ?? false,
    }));
    return { data: enriched, meta: meta(total, page, limit) };
  }

  async getMessages(
    tenantId: string, userId: string, role: string,
    conversationId: string,
  ) {
    const where: any = { id: conversationId, tenantId };
    if (role === 'AGENT') {
      // v14 QAT'IY IZOLYATSIYA: agent faqat O'ZIGA biriktirilgan suhbatni ocha oladi.
      where.assignedAgentId = userId;
    }
    const conv = await this.prisma.conversation.findFirst({ where });
    if (!conv) throw new NotFoundException('Topilmadi');

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
      include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return { messages, conversation: conv };
  }

  // v13: "o'qildi / o'qilmadi" qo'lda belgilash. getMessages() faqat
  // konversatsiyani OCHGANDA avtomatik o'qilgan qiladi — bu yerda esa
  // agent ro'yxatdan turib xohlagan suhbatni o'qilgan/o'qilmagan deb
  // belgilay oladi (email-client'lardagi kabi).
  async setReadStatus(
    tenantId: string, conversationId: string, userId: string, role: string, read: boolean,
  ) {
    const where: any = { id: conversationId, tenantId };
    if (role === 'AGENT') {
      // v14 QAT'IY IZOLYATSIYA
      where.assignedAgentId = userId;
    }
    const conv = await this.prisma.conversation.findFirst({ where });
    if (!conv) throw new NotFoundException('Topilmadi');

    if (read) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { unreadCount: 0 },
      });
      await this.prisma.message.updateMany({
        where: { conversationId, direction: 'INBOUND', isRead: false },
        data: { isRead: true },
      });
    } else {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { unreadCount: conv.unreadCount > 0 ? conv.unreadCount : 1 },
      });
    }
    return { ok: true };
  }

  async assignAgent(tenantId: string, conversationId: string, agentId: string | null) {
    if (agentId) {
      const agent = await this.prisma.user.findFirst({
        where: { id: agentId, tenantId, status: 'ACTIVE' },
      });
      if (!agent) throw new NotFoundException('Agent topilmadi');
    }
    const res = await this.prisma.conversation.updateMany({
      where: { id: conversationId, tenantId },
      data: { assignedAgentId: agentId },
    });
    if (!res.count) throw new NotFoundException('Suhbat topilmadi');
    return { ok: true };
  }

  async resolve(tenantId: string, conversationId: string) {
    const res = await this.prisma.conversation.updateMany({
      where: { id: conversationId, tenantId },
      data: { isResolved: true, unreadCount: 0 },
    });
    if (!res.count) throw new NotFoundException('Suhbat topilmadi');
    return { ok: true };
  }

  // v12 FIX: suhbatni o'chirish — agent inboxdan keraksiz/xato suhbatlarni
  // (masalan spam yoki eski test yozishmalarni) o'chira olishi kerak edi,
  // lekin bunday funksiya umuman yo'q edi.
  async deleteConversation(tenantId: string, conversationId: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');
    // Message'lar `onDelete: Cascade` orqali avtomatik o'chadi
    await this.prisma.conversation.delete({ where: { id: conversationId } });
    return { ok: true };
  }

  async linkClient(tenantId: string, conversationId: string, clientId: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
    });
    if (!client) throw new NotFoundException('Klient topilmadi');
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        clientId,
        // v13 FIX: klient CRM'da allaqachon biror agentga biriktirilgan
        // bo'lsa, suhbatni ham darhol o'sha agentga o'tkazamiz — shu orqali
        // boshqa agentlarga bu suhbat ko'rinmay qoladi.
        ...(client.assignedAgentId ? { assignedAgentId: client.assignedAgentId } : {}),
      },
    });
    if (conv.externalUserId && conv.channel === 'TELEGRAM') {
      await this.prisma.client.update({
        where: { id: clientId },
        data: { telegramId: conv.externalUserId, telegramUsername: conv.username },
      });
    }
    return { ok: true };
  }

  async getAccounts(tenantId: string) {
    return this.prisma.telegramAccount.findMany({
      where: { tenantId },
      select: { id: true, name: true, botUsername: true, channel: true, isActive: true, createdAt: true },
    });
  }

  async getTemplates(tenantId: string, userId: string, role: string, filters?: { category?: string; language?: string }) {
    const where: any = {
      tenantId, isActive: true,
      ...(role === 'AGENT' ? { OR: [{ userId }, { userId: null }] } : {}),
    };
    if (filters?.category) where.category = filters.category;
    if (filters?.language && ['UZ', 'RU', 'EN'].includes(filters.language)) {
      where.language = filters.language;
    }
    return this.prisma.messageTemplate.findMany({
      where,
      orderBy: [{ category: 'asc' }, { useCount: 'desc' }],
    });
  }

  async createTemplate(tenantId: string, userId: string, role: string, data: any) {
    if (!data.name?.trim() || !data.text?.trim()) {
      throw new BadRequestException('name va text majburiy');
    }
    const lang = ['UZ', 'RU', 'EN'].includes(data.language) ? data.language : 'UZ';
    const ownerId = role === 'AGENT' || data.isPersonal ? userId : null;

    // v6: Media va attachments
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];

    return this.prisma.messageTemplate.create({
      data: {
        tenantId, userId: ownerId,
        name: data.name.trim(), text: data.text.trim(),
        language: lang as Language, category: data.category,
        // v6: Mehmonxona rasmlari va boshqa media
        mediaUrl: data.mediaUrl || null,
        mediaType: data.mediaType || null,
        mediaCaption: data.mediaCaption || null,
        attachments,
      },
    });
  }

  /**
   * v6: Shablonni tahrirlash (rasm qo'shish/o'zgartirish)
   */
  async updateTemplate(tenantId: string, userId: string, role: string, id: string, data: any) {
    const tpl = await this.prisma.messageTemplate.findFirst({ where: { id, tenantId } });
    if (!tpl) throw new NotFoundException('Topilmadi');
    if (role === 'AGENT' && tpl.userId !== userId) {
      throw new BadRequestException('Bu shablon sizga tegishli emas');
    }

    const safe: any = {};
    if (data.name?.trim()) safe.name = data.name.trim();
    if (data.text?.trim()) safe.text = data.text.trim();
    if (data.category !== undefined) safe.category = data.category;
    if (data.mediaUrl !== undefined) safe.mediaUrl = data.mediaUrl;
    if (data.mediaType !== undefined) safe.mediaType = data.mediaType;
    if (data.mediaCaption !== undefined) safe.mediaCaption = data.mediaCaption;
    if (Array.isArray(data.attachments)) safe.attachments = data.attachments;
    if (data.language && ['UZ', 'RU', 'EN'].includes(data.language)) safe.language = data.language;
    if (typeof data.isActive === 'boolean') safe.isActive = data.isActive;

    return this.prisma.messageTemplate.update({ where: { id }, data: safe });
  }

  async deleteTemplate(tenantId: string, userId: string, role: string, id: string) {
    const tpl = await this.prisma.messageTemplate.findFirst({ where: { id, tenantId } });
    if (!tpl) throw new NotFoundException('Topilmadi');
    if (role === 'AGENT' && tpl.userId !== userId) {
      throw new BadRequestException('Bu shablon sizga tegishli emas');
    }
    await this.prisma.messageTemplate.update({
      where: { id }, data: { isActive: false },
    });
    return { ok: true };
  }
}

@Controller('telegram')
@UseGuards(JwtAuthGuard)
export class TelegramController {
  constructor(private svc: TelegramService) {}

  @Get('accounts')
  accounts(@CurrentUser() u: any) {
    return this.svc.getAccounts(u.tenantId);
  }

  @Post('accounts')
  @UseGuards(RolesGuard) @Roles('TENANT_ADMIN')
  connect(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.connectBot(u.tenantId, body.token, body.name);
  }

  /**
   * v8: Agentning shaxsiy boti ulash.
   * Agent o'zining bot tokeniga ega bo'lsa, kompaniya bot'iga teng bo'lmagan
   * holda alohida ulanadi.
   */
  @Post('accounts/personal')
  @UseGuards(RolesGuard) @Roles('TENANT_ADMIN')
  connectPersonal(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.connectBot(u.tenantId, body.token, body.name, u.sub);
  }

  @Delete('accounts/:id')
  @UseGuards(RolesGuard) @Roles('TENANT_ADMIN')
  disconnect(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.disconnectBot(u.tenantId, id);
  }

  /**
   * v8: Yangi suhbat boshlash (agent xohlagan odamga yozadi).
   * MUHIM: Telegram bot oldindan /start yozmagan odamga xabar yubora olmaydi.
   * Klient avval botingiz bilan /start qilishi kerak.
   */
  @Post('conversations/new')
  startNew(
    @Body() body: { chatId?: string; username?: string; text: string; clientId?: string; accountId?: string },
    @CurrentUser() u: any,
  ) {
    return this.svc.startNewConversation(u.tenantId, u.sub, body);
  }

  @Get('conversations')
  async conversations(
    @CurrentUser() u: any,
    @Query('resolved') resolved?: string,
    @Query('channel') channel?: string,
    @Query('agentId') agentId?: string,
    @Query('unassigned') unassigned?: string,
    @Query('page') page?: any,
    @Query('limit') limit?: any,
  ) {
    const res = await this.svc.getConversations(u.tenantId, u.sub, u.role, {
      resolved, channel, agentId, unassigned,
      page: page || 1, limit: limit || 100,
    });
    // Frontend uchun array qaytarish (inbox list)
    return res.data;
  }

  @Get('conversations/:id/messages')
  messages(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.getMessages(u.tenantId, u.sub, u.role, id);
  }

  @Post('conversations/:id/messages')
  send(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.sendMessage(u.tenantId, id, body.text, u.sub, u.role, !!body.isInternal);
  }

  /** v6: Rasm/fayl yuborish (mehmonxona rasmlari) */
  @Post('conversations/:id/media')
  sendMedia(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.sendMedia(u.tenantId, id, u.sub, u.role, body);
  }

  /** v6: Shablon yuborish (matn + barcha media) */
  @Post('conversations/:id/template/:templateId')
  sendTemplate(
    @Param('id') id: string,
    @Param('templateId') templateId: string,
    @CurrentUser() u: any,
  ) {
    return this.svc.sendTemplate(u.tenantId, id, u.sub, u.role, templateId);
  }

  /** v6: Inboxdan invoice yuborish */
  @Post('conversations/:id/send-invoice')
  sendInvoice(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.sendInvoiceFromInbox(u.tenantId, id, u.sub, u.role, body);
  }

  @Patch('conversations/:id/assign')
  assign(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.assignAgent(u.tenantId, id, body.agentId || null);
  }

  /** v13: suhbatni qo'lda "o'qildi/o'qilmadi" deb belgilash */
  @Patch('conversations/:id/read')
  setRead(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.setReadStatus(u.tenantId, id, u.sub, u.role, body.read !== false);
  }

  @Patch('conversations/:id/claim')
  claim(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.claim(u.tenantId, id, u.sub);
  }

  @Patch('conversations/:id/resolve')
  resolve(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.resolve(u.tenantId, id);
  }

  // v12 FIX: suhbatni o'chirish
  @Delete('conversations/:id')
  deleteConversation(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.deleteConversation(u.tenantId, id);
  }

  @Patch('conversations/:id/link-client')
  link(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.linkClient(u.tenantId, id, body.clientId);
  }

  @Get('templates')
  templates(@CurrentUser() u: any, @Query('category') category?: string, @Query('language') language?: string) {
    return this.svc.getTemplates(u.tenantId, u.sub, u.role, { category, language });
  }

  @Post('templates')
  createTemplate(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.createTemplate(u.tenantId, u.sub, u.role, body);
  }

  @Patch('templates/:id')
  updateTemplate(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.updateTemplate(u.tenantId, u.sub, u.role, id, body);
  }

  @Delete('templates/:id')
  deleteTemplate(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.deleteTemplate(u.tenantId, u.sub, u.role, id);
  }
}

@Module({
  // v12.2: Instagram suhbatlariga Chat'dan javob berish uchun
  imports: [UserTelegramModule, InstagramModule],
  controllers: [TelegramController],
  providers: [TelegramService, ClientsService],
  exports: [TelegramService],
})
export class TelegramModule {}