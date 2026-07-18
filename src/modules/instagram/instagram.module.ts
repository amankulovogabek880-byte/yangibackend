import { RoundRobinService, RoundRobinModule } from '../v9/round-robin.module';
import {
  Module, Injectable, Controller,
  Get, Post, Body, Query, Req,
  UseGuards, Logger, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, Public } from '../../common/decorators';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';

// Meta Graph API versiyasi — bitta joyda turadi.
// Eskirsa (masalan v23 -> v25) faqat shu qatorni o'zgartiring.
const GRAPH_API_VERSION = 'v23.0';

/**
 * Suhbat "jonli operator" rejimiga o'tganini belgilovchi teg.
 * Bu teg qo'yilgach BOT SUSAYADI — barcha xabarlarga faqat agent javob beradi.
 *
 * Meta App Review talabi: foydalanuvchi avtomatikadan chiqib jonli odam
 * bilan gaplasha olishi SHART. Shu teg aynan shuni ta'minlaydi.
 */
const HUMAN_TAG = 'ig:human';

/** Foydalanuvchi shu so'zlarni yozsa — darhol jonli operatorga o'tadi */
const HANDOVER_KEYWORDS = [
  'operator', 'operatorga', 'menejer', 'menejerga', 'jonli', 'odam',
  'оператор', 'менеджер', 'человек', 'help', 'support',
];

/**
 * Instagram javob berish oynasi — mijoz yozganidan keyin 24 soat.
 * Bu Meta cheklovi, chetlab o'tib bo'lmaydi.
 */
const REPLY_WINDOW_HOURS = 24;

type BotStep = 'ASK_NAME' | 'ASK_DESTINATION' | 'ASK_PHONE' | 'ASK_DATE' | 'DONE';

interface BotSession {
  step: BotStep;
  stepIndex?: number;
  name?: string;
  destination?: string;
  phone?: string;
  date?: string;
  instagramUserId: string;
  tenantId: string;
  startedAt: Date;
  [key: string]: any;
}

// DB-backed session storage (survives restarts)
// Sessions stored in Tenant.settings as instagramSessions JSON
const botSessionsCache = new Map<string, BotSession>(); // local cache for speed

@Injectable()
export class InstagramService {
  private readonly logger = new Logger('Instagram');

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private roundRobin: RoundRobinService,
    private notifications: NotificationsService,
  ) {}

  async getConfig(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const s: any = tenant?.settings || {};
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

  async saveConfig(tenantId: string, data: {
    accessToken?: string;
    pageId?: string;
    verifyToken?: string;
    botName?: string;
    greetingMessage?: string;
    assignToAgentId?: string;
  }) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const cur: any = tenant?.settings || {};
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
          instagramFarewell: (data as any).farewell ?? cur.instagramFarewell,
          instagramBotSteps: (data as any).botSteps ?? cur.instagramBotSteps,
          instagramAssignAgentId: data.assignToAgentId ?? cur.instagramAssignAgentId,
        },
      },
    });

    // MUHIM: faqat Access Token/Page ID saqlash yetarli emas — Meta shu
    // Page/Instagram akkauntini ilovamizga obuna qilishimizni talab qiladi.
    // Shu chaqiruvsiz webhook hech qachon kelmaydi, token to'g'ri bo'lsa ham.
    const accessToken = data.accessToken ?? cur.instagramAccessToken;
    const pageId = data.pageId ?? cur.instagramPageId;
    if (accessToken && pageId) {
      await this.subscribeAppToPage(pageId, accessToken);
    }

    return this.getConfig(tenantId);
  }

  /** Page/Instagram akkauntini shu Meta ilovamizga webhook uchun obuna qiladi. */
  private async subscribeAppToPage(pageId: string, accessToken: string) {
    try {
      const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/subscribed_apps` +
        `?subscribed_fields=messages,messaging_postbacks` +
        `&access_token=${encodeURIComponent(accessToken)}`;
      const res = await fetch(url, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        this.logger.error('Instagram subscribe_apps xato: ' + JSON.stringify(json));
      } else {
        this.logger.log('Instagram: Page ' + pageId + ' ilovaga obuna qilindi');
      }
    } catch (e: any) {
      this.logger.error('Instagram subscribe_apps error: ' + e.message);
    }
  }

  /**
   * MUHIM: Meta bitta App uchun faqat BITTA webhook callback URL qabul qiladi.
   * Shuning uchun manzil tenantId bilan emas — global bo'lishi kerak, va har bir
   * kelgan xabar ichidagi Page/Instagram ID orqali tegishli tenant topiladi.
   */
  verifyWebhook(mode: string, token: string, challenge: string) {
    const expected = process.env.INSTAGRAM_VERIFY_TOKEN || 'omoncrm_verify';
    if (mode === 'subscribe' && token === expected) {
      return challenge;
    }
    throw new BadRequestException('Webhook verification failed');
  }

  /** entry.id (Page/Instagram Business Account ID) bo'yicha tenantni topadi. */
  private async findTenantByPageId(pageId: string): Promise<string | null> {
    if (!pageId) return null;
    const tenants = await this.prisma.tenant.findMany({ select: { id: true, settings: true } });
    for (const t of tenants) {
      const s: any = t.settings || {};
      if (s.instagramPageId === pageId) return t.id;
    }
    return null;
  }

  async processWebhook(body: any, signature?: string, rawBody?: Buffer) {
    if (body?.object !== 'instagram' && body?.object !== 'page') return { ok: true };
    // Meta signature verification (X-Hub-Signature-256 header).
    // Meta imzoni App Secret bilan hisoblaydi (Page Access Token emas!).
    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    if (signature && appSecret && rawBody) {
      try {
        const crypto = await import('crypto');
        const expected = 'sha256=' + crypto.createHmac('sha256', appSecret)
          .update(rawBody).digest('hex');
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
        if (!valid) {
          this.logger.warn('Instagram webhook: invalid signature');
          return { ok: false };
        }
      } catch (e: any) {
        this.logger.warn('Instagram webhook signature check error: ' + e.message);
      }
    } else if (process.env.NODE_ENV === 'production' && !appSecret) {
      this.logger.warn('Instagram webhook: INSTAGRAM_APP_SECRET env sozlanmagan — imzo tekshirilmayapti!');
    }
    this.logger.log('Instagram webhook received: ' + JSON.stringify(body).slice(0, 300));
    const entries: any[] = body?.entry || [];
    for (const entry of entries) {
      // entry.id — shu xabarni qabul qilgan Page/Instagram Business Account ID.
      const pageId: string = entry?.id;
      const tenantId = await this.findTenantByPageId(pageId);
      if (!tenantId) {
        this.logger.warn('Instagram webhook: pageId=' + pageId + ' uchun tenant topilmadi (Sozlamalarda Page ID ni tekshiring)');
        continue;
      }
      for (const event of (entry?.messaging || [])) {
        if (event?.message && !event.message.is_echo) {
          await this.handleMessage(tenantId, event).catch((e: any) =>
            this.logger.error('Instagram msg error: ' + e.message)
          );
        }
      }
    }
    return { ok: true };
  }

  private async handleMessage(tenantId: string, event: any) {
    const senderId: string = event.sender?.id;
    const text: string = (event.message?.text || '').trim();
    if (!senderId || !text) return;

    // Echo (o'zimiz yuborgan xabar qaytib kelishi) — e'tiborsiz qoldiramiz
    if (event.message?.is_echo) return;

    const config = await this.getConfig(tenantId);
    if (!config.isEnabled) return;

    // ── 1) Suhbatni topamiz/yaratamiz va xabarni Chat'ga yozamiz ──
    const { conv } = await this.getOrCreateConversation(tenantId, senderId, config);
    await this.saveInbound(conv, text, event.message?.mid);

    // ── 2) Jonli operator rejimi: bot jim turadi ──
    // (Agent Chat'dan javob beradi — Telegram bilan bir xil tajriba)
    if (this.isHumanMode(conv)) return;

    // ── 3) Foydalanuvchi "operator" so'rasa — darhol topshiramiz ──
    const lower = text.toLowerCase();
    if (HANDOVER_KEYWORDS.some((k) => lower === k || lower.includes(k))) {
      await this.switchToHuman(conv);
      await this.deleteSession(tenantId, senderId);
      const note = 'Menejerimiz tez orada javob beradi. Iltimos, biroz kuting.';
      await this.sendRaw(config.accessToken!, senderId, note);
      await this.saveOutbound(conv, note, null);
      if (conv.assignedAgentId) {
        await this.notifications.create({
          tenantId,
          userId: conv.assignedAgentId,
          type: 'LEAD_NEW',
          title: '🙋 Instagram: operator so\'ralmoqda',
          body: conv.firstName || 'Instagram foydalanuvchi',
          link: `/inbox?conv=${conv.id}`,
          metadata: { conversationId: conv.id },
        }).catch(() => {});
      }
      return;
    }

    const key = senderId + ':' + tenantId;
    let session = botSessionsCache.get(key);
    if (!session) {
      session = await this.getSession(tenantId, senderId);
      if (session) botSessionsCache.set(key, session);
    }

    if (!session) {
      session = { step: 'ASK_NAME', instagramUserId: senderId, tenantId, startedAt: new Date() };
      botSessionsCache.set(key, session);
      await this.saveSession(tenantId, senderId, session);
      const steps = config.botSteps || [];
      const firstQ = steps.length > 0 ? String.fromCharCode(10) + steps[0].question : '';
      const greet = config.greetingMessage + firstQ;
      await this.reply(config.accessToken!, senderId, greet);
      await this.saveOutbound(conv, greet, null);
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
    } else if (session.step === 'ASK_DESTINATION') {
      session.destination = text;
      session.step = 'ASK_PHONE';
      await this.saveSession(tenantId, senderId, session);
      next = 'Ajoyib! Telefon raqamingizni yuboring (+998XXXXXXXXX)';
    } else if (session.step === 'ASK_PHONE') {
      session.phone = text;
      session.step = 'ASK_DATE';
      await this.saveSession(tenantId, senderId, session);
      next = 'Qachon ketmoqchisiz? (oy yoki aniq sana kiriting)';
    } else if (session.step === 'ASK_DATE') {
      session.date = text;
      session.step = 'DONE';
      next = 'Rahmat ' + (session.name || '') + '! Menejerimiz tez orada siz bilan boglanadi. Yaxshi kun!';
      const lead = await this.createLead(tenantId, { ...session }, config);
      // Suhbatni mijozga bog'laymiz — Chat'da kartochka ko'rinadi
      if (lead?.id) {
        await this.prisma.conversation.update({
          where: { id: conv.id },
          data: {
            clientId: lead.id,
            assignedAgentId: conv.assignedAgentId || (lead as any).assignedAgentId || null,
            firstName: session.name || conv.firstName,
          },
        }).catch(() => {});
      }
      botSessionsCache.delete(key);
      await this.deleteSession(tenantId, senderId);
    } else {
      botSessionsCache.delete(key);
      await this.deleteSession(tenantId, senderId);
      const fresh: BotSession = { step: 'ASK_NAME', instagramUserId: senderId, tenantId, startedAt: new Date() };
      botSessionsCache.set(key, fresh);
      next = config.greetingMessage;
    }

    if (next) {
      await this.reply(config.accessToken!, senderId, next);
      await this.saveOutbound(conv, next, null);
    }

    // Bot savollari tugadi → suhbat jonli operatorga o'tadi.
    // Shundan keyin mijoz yozgan har bir xabar Chat'da agentni kutadi.
    if (session.step === 'DONE') {
      await this.switchToHuman(conv);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CHAT: Conversation + Message (Telegram bilan bir xil uslub)
  // ═══════════════════════════════════════════════════════════

  /** Instagram foydalanuvchi profilini oladi (ism, rasm). Xato bo'lsa — jim. */
  private async fetchIgProfile(accessToken: string, igsid: string) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${igsid}` +
        `?fields=name,username,profile_pic&access_token=${encodeURIComponent(accessToken)}`,
      );
      if (!res.ok) return null;
      const j: any = await res.json();
      return {
        firstName: j?.name || j?.username || null,
        username: j?.username || null,
        avatarUrl: j?.profile_pic || null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Instagram DM uchun suhbat topadi yoki yaratadi.
   * externalChatId = Instagram-scoped user ID (IGSID).
   */
  private async getOrCreateConversation(tenantId: string, igsid: string, config: any) {
    let conv = await this.prisma.conversation.findFirst({
      where: { tenantId, channel: 'INSTAGRAM', externalChatId: igsid },
    });
    if (conv) return { conv, isNew: false };

    // Profil ma'lumoti (ism/rasm) — bo'lmasa ham suhbat yaratiladi
    const profile = config.accessToken
      ? await this.fetchIgProfile(config.accessToken, igsid)
      : null;

    // Agar shu IGSID bilan mijoz allaqachon bor bo'lsa — o'sha agentga
    // yo'naltiramiz (mijoz "kimniki" ekani chalkashmasin).
    const existingClient = await this.prisma.client.findFirst({
      where: {
        tenantId,
        preferences: { path: ['instagramUserId'], equals: igsid } as any,
      },
      select: { id: true, assignedAgentId: true },
    }).catch(() => null);

    const assignedAgentId =
      existingClient?.assignedAgentId ||
      config.assignToAgentId ||
      (await this.roundRobin.getNextAgent(tenantId).catch(() => null));

    conv = await this.prisma.conversation.create({
      data: {
        tenantId,
        channel: 'INSTAGRAM',
        externalChatId: igsid,
        externalUserId: igsid,
        firstName: profile?.firstName || 'Instagram foydalanuvchi',
        username: profile?.username || null,
        avatarUrl: profile?.avatarUrl || null,
        clientId: existingClient?.id || null,
        assignedAgentId: assignedAgentId || null,
        chatType: 'private',
      } as any,
    });

    if (assignedAgentId) {
      await this.notifications.create({
        tenantId,
        userId: assignedAgentId,
        type: 'LEAD_NEW',
        title: '📷 Yangi Instagram suhbat',
        body: profile?.firstName || 'Instagram foydalanuvchi',
        link: `/inbox?conv=${conv.id}`,
        metadata: { conversationId: conv.id, channel: 'INSTAGRAM' },
      }).catch(() => {});
    }

    return { conv, isNew: true };
  }

  /** Kiruvchi xabarni bazaga yozadi va Chat'ni real-time yangilaydi. */
  private async saveInbound(conv: any, text: string, externalMsgId?: string) {
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'INBOUND',
        messageType: 'TEXT',
        text,
        externalMsgId: externalMsgId || null,
        isRead: false,
      },
    });

    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: new Date(),
        lastMessageText: text.slice(0, 200),
        lastMessageType: 'TEXT',
        unreadCount: { increment: 1 },
        isResolved: false,
      },
    });

    this.realtime.emitToTenant(conv.tenantId, 'message:new', msg);
    if (conv.assignedAgentId) {
      this.realtime.emitToUser(conv.assignedAgentId, 'message:new', msg);
    }
    return msg;
  }

  /** Chiquvchi xabarni (bot yoki agent) bazaga yozadi. */
  private async saveOutbound(conv: any, text: string, agentId?: string | null) {
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        agentId: agentId || null,
        direction: 'OUTBOUND',
        messageType: 'TEXT',
        text,
        isRead: true,
        isDelivered: true,
      },
    });

    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: new Date(),
        lastMessageText: text.slice(0, 200),
        lastMessageType: 'TEXT',
      },
    });

    this.realtime.emitToTenant(conv.tenantId, 'message:new', msg);
    return msg;
  }

  /** Suhbatni jonli operator rejimiga o'tkazadi (bot to'xtaydi). */
  private async switchToHuman(conv: any) {
    const tags: string[] = Array.isArray(conv.tags) ? conv.tags : [];
    if (tags.includes(HUMAN_TAG)) return;
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: { tags: [...tags, HUMAN_TAG] },
    }).catch(() => {});
  }

  private isHumanMode(conv: any): boolean {
    return Array.isArray(conv?.tags) && conv.tags.includes(HUMAN_TAG);
  }

  // ═══════════════════════════════════════════════════════════
  // AGENT JAVOBI (Chat'dan yuboriladi — telegram moduli chaqiradi)
  // ═══════════════════════════════════════════════════════════

  /**
   * Agent Chat'dan yozganda Instagram'ga yuboradi.
   *
   * MUHIM — Meta 24 soat qoidasi: mijoz oxirgi yozganidan 24 soat
   * o'tgan bo'lsa, oddiy xabar yuborib bo'lmaydi. Bunda aniq
   * tushunarli xato qaytaramiz (Meta'ning xom xatosi emas).
   *
   * Agent yozgani = suhbat jonli operatorga o'tdi → bot to'xtaydi.
   */
  async sendAgentMessage(tenantId: string, conversationId: string, text: string, agentId?: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId, channel: 'INSTAGRAM' },
    });
    if (!conv) throw new BadRequestException('Instagram suhbati topilmadi');

    const config = await this.getConfig(tenantId);
    if (!config.accessToken) {
      throw new BadRequestException('Instagram ulanmagan. Sozlamalar → Instagram');
    }

    // ── 24 soatlik oynani tekshirish ──
    const lastInbound = await this.prisma.message.findFirst({
      where: { conversationId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (lastInbound) {
      const hours = (Date.now() - new Date(lastInbound.createdAt).getTime()) / 3600000;
      if (hours > REPLY_WINDOW_HOURS) {
        throw new BadRequestException(
          `Instagram 24 soatlik javob oynasi yopilgan (${Math.floor(hours)} soat o'tdi). ` +
          `Mijoz qayta yozmaguncha xabar yuborib bo'lmaydi — telefon yoki boshqa kanaldan bog'laning.`,
        );
      }
    }

    // Agent yozdi → bot to'xtaydi
    await this.switchToHuman(conv);
    await this.deleteSession(tenantId, conv.externalChatId);

    const ok = await this.sendRaw(config.accessToken, conv.externalChatId, text);
    if (!ok.success) {
      throw new BadRequestException(`Instagram'ga yuborilmadi: ${ok.error}`);
    }

    return this.saveOutbound(conv, text, agentId);
  }

  /** Xom yuborish — natijani qaytaradi (xatoni yutmaydi). */
  private async sendRaw(accessToken: string, recipientId: string, text: string) {
    try {
      const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text },
          messaging_type: 'RESPONSE',
        }),
      });
      if (!res.ok) {
        const err: any = await res.json().catch(() => ({}));
        const m = err?.error?.message || JSON.stringify(err).slice(0, 200);
        this.logger.error('Instagram send failed: ' + m);
        return { success: false, error: m };
      }
      return { success: true, error: null };
    } catch (e: any) {
      this.logger.error('Instagram send error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  private async createLead(tenantId: string, s: BotSession, config: any) {
    let agentId = config.assignToAgentId;
    if (!agentId) {
      // Round-Robin: strategiya tekshirib navbat bilan tayinlash
      agentId = await this.roundRobin.getNextAgent(tenantId);
    }

    // Check duplicate
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
      } as any,
    });

    await this.prisma.clientTimeline.create({
      data: {
        clientId: client.id,
        type: 'created',
        title: 'Instagram bot orqali yangi lead',
        description: 'Yonalish: ' + s.destination + ' | Tel: ' + s.phone + ' | Sana: ' + s.date,
        metadata: { source: 'instagram_bot', instagramUserId: s.instagramUserId },
      } as any,
    }).catch(() => {});

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

  private async reply(accessToken: string, recipientId: string, text: string) {
    if (!accessToken) { this.logger.warn('Instagram: no accessToken'); return; }
    try {
      const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.logger.error('Instagram send failed: ' + JSON.stringify(err));
      }
    } catch (e: any) {
      this.logger.error('Instagram send error: ' + e.message);
    }
  }

  // ── DB session helpers ─────────────────────────────────────────────────────
  private async getSession(tenantId: string, senderId: string): Promise<BotSession | null> {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const sessions: any = (tenant?.settings as any)?.instagramSessions || {};
      return sessions[senderId] || null;
    } catch { return null; }
  }

  private async saveSession(tenantId: string, senderId: string, session: BotSession) {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const cur: any = tenant?.settings || {};
      const sessions: any = cur.instagramSessions || {};
      sessions[senderId] = { ...session, savedAt: new Date().toISOString() };
      // Keep max 200 sessions
      const keys = Object.keys(sessions);
      if (keys.length > 200) {
        const oldest = keys.sort((a, b) => (sessions[a].savedAt || '') < (sessions[b].savedAt || '') ? -1 : 1).slice(0, keys.length - 200);
        oldest.forEach(k => delete sessions[k]);
      }
      await this.prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...cur, instagramSessions: sessions } } });
    } catch (e: any) { this.logger.warn('saveSession error: ' + e.message); }
  }

  private async deleteSession(tenantId: string, senderId: string) {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const cur: any = tenant?.settings || {};
      const sessions: any = cur.instagramSessions || {};
      delete sessions[senderId];
      await this.prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...cur, instagramSessions: sessions } } });
      botSessionsCache.delete(senderId + ':' + tenantId);
    } catch (e: any) { this.logger.warn('deleteSession error: ' + e.message); }
  }

  async getStats(tenantId: string) {
    const [total, thisMonth] = await Promise.all([
      this.prisma.client.count({ where: { tenantId, source: 'INSTAGRAM' } }),
      this.prisma.client.count({
        where: { tenantId, source: 'INSTAGRAM', createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
      }),
    ]);
    return { total, thisMonth, activeSessions: botSessionsCache.size };
  }
}

@ApiTags('Instagram Lead Bot')
@Controller('instagram')
export class InstagramController {
  constructor(private svc: InstagramService) {}

  // ── YANGI: global webhook (BARCHA tenantlar uchun bitta manzil) ──────────
  // Meta App darajasida faqat bitta callback URL bo'lishi mumkin, shuning
  // uchun tenant POST body ichidagi Page ID orqali avtomatik aniqlanadi.
  @Get('webhook')
  @Public()
  verifyWebhookGlobal(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    return this.svc.verifyWebhook(mode, token, challenge);
  }

  @Post('webhook')
  @Public()
  webhookGlobal(@Body() body: any, @Req() req: any) {
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody: Buffer | undefined = req.rawBody;
    return this.svc.processWebhook(body, sig, rawBody);
  }

  // ── ESKI manzil (moslik uchun qoldirilgan) ────────────────────────────────
  // Eski `/instagram/webhook/:tenantId` manzilini Meta'ga kiritgan bo'lsangiz
  // ham ishlashda davom etadi — lekin :tenantId e'tiborga olinmaydi, tenant
  // baribir Page ID orqali topiladi. Yangi o'rnatishlar uchun yuqoridagi
  // global `/instagram/webhook` manzilidan foydalaning.
  @Get('webhook/:tenantId')
  @Public()
  verifyWebhookLegacy(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    return this.svc.verifyWebhook(mode, token, challenge);
  }

  @Post('webhook/:tenantId')
  @Public()
  webhookLegacy(@Body() body: any, @Req() req: any) {
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody: Buffer | undefined = req.rawBody;
    return this.svc.processWebhook(body, sig, rawBody);
  }

  @ApiOperation({ summary: 'Instagram bot sozlamalarini olish' })
  @ApiBearerAuth('JWT')
  @Get('config')
  @UseGuards(JwtAuthGuard)
  getConfig(@CurrentUser() u: any) {
    return this.svc.getConfig(u.tenantId);
  }

  @ApiOperation({ summary: 'Instagram bot sozlamalarini saqlash' })
  @ApiBearerAuth('JWT')
  @Post('config')
  @UseGuards(JwtAuthGuard)
  saveConfig(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.saveConfig(u.tenantId, body);
  }

  @ApiOperation({ summary: 'Instagram statistikasi' })
  @ApiBearerAuth('JWT')
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  stats(@CurrentUser() u: any) {
    return this.svc.getStats(u.tenantId);
  }
}

@Module({
  controllers: [InstagramController],
  imports: [RoundRobinModule],
  providers: [InstagramService],
  exports: [InstagramService],
})
export class InstagramModule {}