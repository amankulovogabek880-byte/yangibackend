import { RoundRobinService, RoundRobinModule } from '../v9/round-robin.module';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators';
import { verifyMetaSignature, canSkipSignature } from '../../common/utils/meta-signature';
import {
  Module, Injectable, Controller,
  Get, Post, Delete, Body, Query, Req, Res,
  UseGuards, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, Public } from '../../common/decorators';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { normalizePhone, phoneVariants } from '../../common/utils/helpers';
import { swallow } from '../../common/utils/swallow';

/**
 * Instagram webhook imzosi uchun App Secret.
 *
 * TUZATILDI: bu joyda ilgari to'g'ridan-to'g'ri `process.env.INSTAGRAM_APP_SECRET`
 * ishlatilardi. Lekin bu CRM'da Instagram uchun ALOHIDA OAuth oqimi yo'q —
 * ulanish faqat FACEBOOK_APP_ID/SECRET orqali ("Facebook orqali ulash"
 * tugmasi) amalga oshadi, ya'ni aksariyat foydalanuvchilarda Facebook va
 * Instagram BITTA Meta App'da. `env.validation.ts` xuddi shu holat uchun
 * `META_SINGLE_APP=true` bo'lsa FACEBOOK_APP_SECRET fallback sifatida
 * ishlashini ogohlantirishida nazarda tutgan, lekin haqiqiy webhook
 * tekshiruv kodi bu fallbackni amalga OSHIRMAGAN edi. Natijada
 * INSTAGRAM_APP_SECRET sozlanmagan (yoki bo'sh) bo'lsa, `verifyMetaSignature`
 * har doim "APP_SECRET sozlanmagan" deb JIMGINA 403 qaytarardi — Meta buni
 * qayta-qayta urinib, oxiri tashlab yuborardi, va Instagram "ulangan" deb
 * ko'rinsa ham DM'lar hech qachon Chat bo'limiga tushmasdi.
 */
/**
 * v13.2 TUZATILDI: ilgari bu funksiya faqat BITTA secretni qaytarardi,
 * ustuvorlik bilan (INSTAGRAM_APP_SECRET → FACEBOOK_APP_SECRET →
 * INSTAGRAM_LOGIN_APP_SECRET). Bu quyidagi holatda muammo edi:
 *
 *   Agar Render'da INSTAGRAM_APP_SECRET ham sozlangan bo'lsa (masalan,
 *   eski/Facebook-Page oqimidan qolgan qiymat), lekin haqiqiy ulanish
 *   "Instagram orqali to'g'ridan-to'g'ri" (Instagram Login) usulida
 *   bo'lsa — Meta webhook'ni INSTAGRAM_LOGIN_APP_SECRET tegishli bo'lgan
 *   App bilan imzolaydi. Funksiya esa har doim birinchi topilgan
 *   INSTAGRAM_APP_SECRET'ni qaytargani uchun HMAC solishtiruvi HECH QACHON
 *   mos kelmasdi → webhook "imzo noto'g'ri" deb DOIMIY rad etilardi →
 *   Instagram "ulangan" ko'rinsa ham DM'lar Chat bo'limiga tushmasdi.
 *
 * ENDI: barcha sozlangan (va bir-biridan farqli) secretlar nomzod
 * sifatida qaytariladi; `processWebhook` ularning HAR BIRI bilan
 * tekshiradi va birortasi mos kelsa qabul qiladi (fail-closed —
 * birortasi ham mos kelmasa hamon 403). Bu qaysi Meta App webhook'ni
 * imzolayotganini bilmasdan ham to'g'ri ishlashni kafolatlaydi.
 */
function getInstagramAppSecretCandidates(): string[] {
  const candidates = [
    process.env.INSTAGRAM_APP_SECRET,
    process.env.INSTAGRAM_LOGIN_APP_SECRET,
    process.env.META_SINGLE_APP === 'true' ? process.env.FACEBOOK_APP_SECRET : undefined,
  ].filter((v): v is string => !!v);
  // Takrorlanuvchi qiymatlarni olib tashlaymiz (ko'p hollarda ular baribir bir xil).
  return Array.from(new Set(candidates));
}

// Meta Graph API versiyasi — bitta joyda turadi.
// Eskirsa (masalan v23 -> v25) faqat shu qatorni o'zgartiring.
const GRAPH_API_VERSION = 'v23.0';

/**
 * ═══════════════════════════════════════════════════════════════════
 * INSTAGRAM ORQALI TO'G'RIDAN-TO'G'RI ULANISH ("Instagram Login for
 * Business" / "Instagram API with Instagram Login").
 * ═══════════════════════════════════════════════════════════════════
 *
 * Bu — Facebook Page talab qilmaydigan, Meta'ning rasmiy OAuth oqimi.
 * Admin "Instagram orqali ulash" tugmasini bossa, instagram.com'ning
 * O'ZIGA (Facebook'ga emas) yo'naltiriladi, u yerda Instagram login/parol
 * bilan kiradi — login/parol HECH QACHON bizning serverimizga tushmaydi,
 * faqat Meta bir martalik "code" qaytaradi (standart, xavfsiz OAuth2
 * Authorization Code oqimi — xuddi "Google orqali kirish" kabi).
 *
 * Meta App Dashboard'da: App → Instagram → "API setup with Instagram
 * login" bo'limida ko'rsatilgan "Instagram app ID" / "Instagram app
 * secret" AYNAN shular ishlatiladi (Facebook App ID/Secret'dan farqli).
 * Agar alohida sozlanmagan bo'lsa — quyidagi funksiyalar mavjud
 * INSTAGRAM_APP_SECRET'ga tushadi (bir xil Meta App ichida ko'p hollarda
 * ular baribir bir xil bo'ladi).
 */
function getInstagramLoginAppId(): string | undefined {
  return process.env.INSTAGRAM_LOGIN_APP_ID || process.env.INSTAGRAM_APP_ID;
}
function getInstagramLoginAppSecret(): string | undefined {
  return process.env.INSTAGRAM_LOGIN_APP_SECRET || process.env.INSTAGRAM_APP_SECRET;
}

/**
 * Qaysi usul bilan ulanganiga qarab Graph API manzili farq qiladi:
 *  - 'facebook'        → Facebook Page orqali ulangan (eski oqim), token
 *                         Page Access Token, so'rovlar graph.facebook.com'ga.
 *  - 'instagram_login' → Instagram orqali to'g'ridan-to'g'ri ulangan
 *                         (yangi oqim), token IG User Access Token,
 *                         so'rovlar graph.instagram.com'ga boradi — Meta
 *                         talabi shunday, aks holda token "invalid" bo'ladi.
 */
function igApiHost(authMode?: string | null): string {
  return authMode === 'instagram_login' ? 'graph.instagram.com' : 'graph.facebook.com';
}

const IG_OAUTH_STATE_SECRET =
  process.env.JWT_ACCESS_SECRET || 'dev-only-change-in-production';
const IG_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

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

/**
 * ═══════════════════════════════════════════════════════════════
 * AI REJIM (erkin suhbat) — Claude orqali mijoz savollariga javob
 * ═══════════════════════════════════════════════════════════════
 *
 * G'OYA: eski rejim (ASK_NAME → ASK_DESTINATION → ...) faqat qattiq
 * belgilangan savollarni beradi. AI rejimida esa mijoz istalgan
 * savolni yozishi mumkin ("Antalyaga necha kunlik tur bor?",
 * "Narxi qancha?") — Claude Sozlamalar'da kiritilgan "Bilim bazasi"
 * (firma haqida ma'lumot, turlar, narxlar) asosida javob beradi.
 * Agar javob bera olmasa yoki mijoz operator so'rasa — jonli
 * operator raqamini beradi va suhbat "ig:human" rejimiga o'tadi
 * (xuddi eski rejimdagi kabi).
 *
 * XARAJATNI NAZORAT QILISH: calls/ai-marketing modullaridagi kabi
 * shu funksiyaga XOS ANTHROPIC_MODEL_INSTAGRAM o'zgaruvchisi
 * o'qiladi (standart — arzon Haiku). Har bir tenant uchun kunlik
 * so'rov limiti bor (standart 300; INSTAGRAM_AI_DAILY_LIMIT bilan
 * sozlanadi) — API xarajati nazoratdan chiqib ketmasligi uchun.
 */
const AI_CONTEXT_MESSAGE_LIMIT = 12; // Claude'ga yuboriladigan oxirgi xabarlar soni
const AI_DAILY_QUOTA = parseInt(process.env.INSTAGRAM_AI_DAILY_LIMIT || '300', 10);

/** Kunlik AI kvota hisoblagichi (jarayon xotirasida — botSessionsCache uslubida) */
const aiQuotaCache = new Map<string, { count: number; day: string }>();

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

// v17: "pageId uchun tenant topilmadi" ogohlantirishini throttle qilamiz.
// Ilgari HAR bir webhook uchun alohida log yozilardi — agar noma'lum
// pageId'ga (masalan boshqa firmaning shu umumiy Meta App orqali ulangan,
// lekin bu CRM'da ro'yxatdan o'tmagan akkaunti) tez-tez xabar kelsa, log
// soniyasiga bir necha marta o'sha bir xil qatorni takrorlab, disk/log
// hajmini keraksiz to'ldirardi. Endi har bir pageId uchun 10 daqiqada
// FAQAT bir marta yoziladi — xatti-harakat o'zgarmaydi (baribir `continue`
// qilinadi), faqat log shovqini kamayadi.
const unknownPageIdWarned = new Map<string, number>();
const UNKNOWN_PAGE_WARN_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class InstagramService {
  private readonly logger = new Logger('Instagram');

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private roundRobin: RoundRobinService,
    private notifications: NotificationsService,
    // v12.3 XAVFSIZLIK: Access Token shifrlangan holda saqlanadi
    private encryption: EncryptionService,
  ) {}

  /**
   * ICHKI foydalanish uchun — ochiq token bilan.
   *
   * FAQAT modul ichida chaqiriladi (xabar yuborish, profil olish va h.k.).
   * Hech qachon controller orqali tashqariga chiqarilmasin.
   */
  private async getInternalConfig(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const s: any = tenant?.settings || {};
    return {
      accessToken: this.decryptToken(s.instagramAccessToken),
      pageId: s.instagramPageId || null,
      // 'facebook' (Page orqali) | 'instagram_login' (to'g'ridan-to'g'ri)
      authMode: s.instagramAuthMode || 'facebook',
      username: s.instagramUsername || null,
      verifyToken: s.instagramVerifyToken || 'omoncrm_verify',
      botName: s.instagramBotName || 'Travel Bot',
      greetingMessage: s.instagramGreeting || 'Salom! Sizga yordam berishdan mamnunman.',
      farewell: s.instagramFarewell || 'Rahmat! Tez orada siz bilan boglanamiz.',
      assignToAgentId: s.instagramAssignAgentId || null,
      isEnabled: !!s.instagramAccessToken,
      botSteps: s.instagramBotSteps || [],
      // ── AI rejim ──
      aiEnabled: !!s.instagramAiEnabled,
      operatorPhone: s.instagramOperatorPhone || '',
      knowledgeBase: s.instagramKnowledgeBase || '',
    };
  }

  /** TASHQI (controller) uchun — token MASKALANGAN */
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
    // XAVFSIZLIK (v13.0): ilgari bu yerda `accessToken` OCHIQ MATNDA
    // qaytarilardi. Controller'da esa @Roles yo'q edi — ya'ni oddiy
    // AGENT `GET /instagram/config` chaqirib, butun kompaniyaning Meta
    // Page Access Token'ini olardi. U bilan kompaniya nomidan DM
    // yuborish va barcha yozishmalarni o'qish mumkin edi.
    //
    // Endi tashqariga faqat MASKALANGAN qiymat chiqadi. Modul ichida
    // ochiq token kerak bo'lsa — getInternalConfig() ishlatiladi.
    // (Bu naqsh facebook-leads modulida allaqachon to'g'ri qilingan edi.)
    const plain = this.decryptToken(s.instagramAccessToken);

    return {
      hasAccessToken: !!plain,
      maskedAccessToken: plain ? this.encryption.mask(plain, 6, 4) : null,
      pageId: s.instagramPageId || null,
      // 'facebook' (Page orqali) | 'instagram_login' (to'g'ridan-to'g'ri Instagram)
      authMode: s.instagramAuthMode || 'facebook',
      username: s.instagramUsername || null,
      verifyToken: s.instagramVerifyToken || 'omoncrm_verify',
      botName: s.instagramBotName || 'Travel Bot',
      greetingMessage: s.instagramGreeting || 'Salom! Sizga yordam berishdan mamnunman.',
      farewell: s.instagramFarewell || 'Rahmat! Tez orada siz bilan boglanamiz.',
      assignToAgentId: s.instagramAssignAgentId || null,
      isEnabled: !!s.instagramAccessToken,
      botSteps: s.instagramBotSteps || defaultSteps,
      // ── AI rejim ──
      aiEnabled: !!s.instagramAiEnabled,
      operatorPhone: s.instagramOperatorPhone || '',
      knowledgeBase: s.instagramKnowledgeBase || '',
    };
  }

  /**
   * Saqlangan tokenni ochadi.
   *
   * ORQAGA MOSLIK: eski o'rnatmalarda token OCHIQ MATNDA saqlangan.
   * Shifrni ochib bo'lmasa — qiymatning o'zini qaytaramiz, shunda
   * mavjud mijozlarning ulanishi buzilmaydi. Keyingi saqlashda u
   * avtomatik shifrlanadi.
   */
  private decryptToken(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const plain = this.encryption.decrypt(value);
      return plain || value;
    } catch {
      return value; // eski, shifrlanmagan qiymat
    }
  }

  async saveConfig(tenantId: string, data: {
    accessToken?: string;
    pageId?: string;
    authMode?: 'facebook' | 'instagram_login';
    instagramUsername?: string;
    verifyToken?: string;
    botName?: string;
    greetingMessage?: string;
    assignToAgentId?: string;
    aiEnabled?: boolean;
    operatorPhone?: string;
    knowledgeBase?: string;
  }) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const cur: any = tenant?.settings || {};

    // ── v13.0: Page ID to'qnashuvini OLDINDAN tekshiramiz ──
    //
    // Baza darajasida @unique cheklov bor, lekin u tushunarsiz
    // "duplicate key" xatosi beradi. Bu yerda oldindan tekshirib,
    // adminга aniq xabar ko'rsatamiz.
    const newPageId = data.pageId ? String(data.pageId).trim() : null;
    if (newPageId) {
      const taken = await this.prisma.tenant.findFirst({
        where: { instagramPageId: newPageId, NOT: { id: tenantId } },
        select: { id: true },
      });
      if (taken) {
        throw new BadRequestException(
          `Bu Instagram Page ID (${newPageId}) boshqa hisobga allaqachon ulangan. ` +
          `O'z Page ID'ingizni tekshiring yoki platforma administratoriga murojaat qiling.`,
        );
      }
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        // v13.0: alohida indekslangan ustun (webhook shu bo'yicha topadi)
        instagramPageId: newPageId ?? cur.instagramPageId ?? null,
        settings: {
          ...cur,
          // Yangi token kelsa SHIFRLAB saqlaymiz; kelmasa eskisi qoladi
          instagramAccessToken: data.accessToken
            ? this.encryption.encrypt(String(data.accessToken).trim())
            : cur.instagramAccessToken,
          instagramPageId: data.pageId ?? cur.instagramPageId,
          instagramAuthMode: data.authMode ?? cur.instagramAuthMode ?? 'facebook',
          instagramUsername: data.instagramUsername ?? cur.instagramUsername ?? null,
          instagramVerifyToken: data.verifyToken ?? cur.instagramVerifyToken,
          instagramBotName: data.botName ?? cur.instagramBotName,
          instagramGreeting: data.greetingMessage ?? cur.instagramGreeting,
          instagramFarewell: (data as any).farewell ?? cur.instagramFarewell,
          instagramBotSteps: (data as any).botSteps ?? cur.instagramBotSteps,
          instagramAssignAgentId: data.assignToAgentId ?? cur.instagramAssignAgentId,
          // ── AI rejim ──
          instagramAiEnabled: data.aiEnabled ?? cur.instagramAiEnabled ?? false,
          instagramOperatorPhone: data.operatorPhone ?? cur.instagramOperatorPhone ?? '',
          instagramKnowledgeBase: data.knowledgeBase ?? cur.instagramKnowledgeBase ?? '',
        },
      },
    });

    // MUHIM: faqat Access Token/Page ID saqlash yetarli emas — Meta shu
    // Page/Instagram akkauntini ilovamizga obuna qilishimizni talab qiladi.
    // Shu chaqiruvsiz webhook hech qachon kelmaydi, token to'g'ri bo'lsa ham.
    // Obuna uchun OCHIQ token kerak (yangi kelgan yoki eskisini ochamiz)
    const accessToken = data.accessToken ?? this.decryptToken(cur.instagramAccessToken);
    const pageId = data.pageId ?? cur.instagramPageId;
    const authMode = data.authMode ?? cur.instagramAuthMode ?? 'facebook';
    if (accessToken && pageId) {
      await this.subscribeAppToPage(pageId, accessToken, authMode);
    }

    return this.getConfig(tenantId);
  }

  /**
   * Page/Instagram akkauntini shu Meta ilovamizga webhook uchun obuna qiladi.
   *
   * `authMode` ga qarab to'g'ri Graph API host'i tanlanadi:
   *  - 'facebook'-da bo'lganidek graph.facebook.com (Page Access Token)
   *  - 'instagram_login'-da graph.instagram.com (IG User Access Token) —
   *    Meta talabi shunday, aks holda "Invalid OAuth access token" xatosi
   *    qaytadi, chunki bu token Facebook Graph'da tanilmaydi.
   */
  /**
   * "Instagram uzish" tugmasi — ulangan akkauntni to'liq uzadi.
   *
   * 1) Iloji bo'lsa, Meta'dagi obunani ham bekor qilishga harakat qilamiz
   *    (subscribed_apps DELETE) — token/pageId eskirgan yoki bekor qilingan
   *    bo'lsa xato chiqishi mumkin, lekin bu holatda ham lokal tozalashni
   *    to'xtatmaymiz (foydalanuvchi baribir "uzilgan" ko'rishi kerak).
   * 2) tenant.instagramPageId ustunini va settings ichidagi barcha
   *    Instagram bilan bog'liq maydonlarni tozalaymiz — shunda Page ID
   *    boshqa hisobga qayta ulanishi ham mumkin bo'ladi (unique cheklov
   *    tufayli avval bo'shatilishi shart edi).
   */
  async disconnect(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const cur: any = tenant?.settings || {};
    const accessToken = this.decryptToken(cur.instagramAccessToken);
    const pageId = cur.instagramPageId;
    const authMode = cur.instagramAuthMode || 'facebook';

    if (accessToken && pageId) {
      try {
        const host = igApiHost(authMode);
        const url = `https://${host}/${GRAPH_API_VERSION}/${pageId}/subscribed_apps` +
          `?access_token=${encodeURIComponent(accessToken)}`;
        await fetch(url, { method: 'DELETE' });
      } catch (e: any) {
        this.logger.warn('Instagram disconnect: Meta obunasini bekor qilishda xato (e\'tibor berilmaydi): ' + e.message);
      }
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        instagramPageId: null,
        settings: {
          ...cur,
          instagramAccessToken: null,
          instagramPageId: null,
          instagramAuthMode: null,
          instagramUsername: null,
        },
      },
    });

    this.logger.log(`Instagram uzildi: tenant=${tenantId}`);
    return this.getConfig(tenantId);
  }

  private async subscribeAppToPage(pageId: string, accessToken: string, authMode?: string) {
    try {
      const host = igApiHost(authMode);
      const url = `https://${host}/${GRAPH_API_VERSION}/${pageId}/subscribed_apps` +
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

  // ─────────────────────────────────────────────────────────────────
  // OAuth — "Instagram orqali to'g'ridan-to'g'ri ulash"
  // (Instagram Login for Business — Facebook Page shart emas)
  // ─────────────────────────────────────────────────────────────────

  /** facebook-leads modulidagi bilan bir xil "sozlamalarni yamash" naqshi. */
  private async patchSettings(tenantId: string, patch: Record<string, any>) {
    await this.prisma.$transaction(async (tx: any) => {
      const t = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const cur: any = t?.settings || {};
      await tx.tenant.update({
        where: { id: tenantId },
        data: { settings: { ...cur, ...patch } },
      });
    });
  }

  private signIgState(payload: Record<string, any>): string {
    const json = JSON.stringify(payload);
    const b64 = Buffer.from(json).toString('base64url');
    const sig = crypto.createHmac('sha256', IG_OAUTH_STATE_SECRET).update(b64).digest('base64url');
    return `${b64}.${sig}`;
  }

  private verifyIgState(state: string | undefined): any | null {
    if (!state) return null;
    const [b64, sig] = state.split('.');
    if (!b64 || !sig) return null;
    const expected = crypto
      .createHmac('sha256', IG_OAUTH_STATE_SECRET)
      .update(b64)
      .digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    try {
      const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
      if (!payload?.tenantId || !payload?.ts) return null;
      if (Date.now() - payload.ts > IG_OAUTH_STATE_TTL_MS) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * "Instagram orqali ulash" tugmasi bosilganda chaqiriladi. Foydalanuvchini
   * instagram.com'ning O'ZIGA yo'naltiradigan URL yasaydi — Facebook Login
   * oynasi UMUMAN ko'rinmaydi, login/parol to'g'ridan-to'g'ri Instagram
   * sahifasida kiritiladi (bizning serverimiz uni hech qachon ko'rmaydi).
   */
  async getOAuthStartUrl(tenantId: string, userId?: string) {
    const appId = getInstagramLoginAppId();
    const redirectUri = process.env.INSTAGRAM_LOGIN_REDIRECT_URI;
    if (!appId || !redirectUri) {
      throw new BadRequestException(
        "Serverda INSTAGRAM_LOGIN_APP_ID va INSTAGRAM_LOGIN_REDIRECT_URI env sozlanmagan. " +
          "Administratorga murojaat qiling.",
      );
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    await this.patchSettings(tenantId, {
      instagramOAuthNonce: {
        value: nonce,
        userId: userId || null,
        expiresAt: Date.now() + IG_OAUTH_STATE_TTL_MS,
      },
    });

    const state = this.signIgState({ tenantId, userId, nonce, ts: Date.now() });

    // Instagram Login for Business uchun talab qilinadigan ruxsatlar:
    // profil, DM o'qish/yozish va (keyinchalik kerak bo'lsa) izohlarni
    // boshqarish. `instagram_business_content_publish` shart emas — biz
    // post joylamaymiz, shuning uchun so'ramaymiz (kamroq ruxsat = admin
    // uchun oddiyroq tasdiqlash oynasi).
    const scope = [
      'instagram_business_basic',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments',
    ].join(',');

    const url =
      `https://www.instagram.com/oauth/authorize` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent(scope)}` +
      `&response_type=code`;

    return { nonce, url };
  }

  async handleOAuthCallback(
    code: string | undefined,
    state: string | undefined,
    oauthError?: string,
    cookieNonce?: string,
  ): Promise<string> {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const redirectBase = `${frontendUrl}/settings?tab=instagram`;

    if (oauthError) {
      this.logger.warn(`Instagram OAuth: admin rad etdi yoki xato qaytdi: ${oauthError}`);
      return `${redirectBase}&igLogin=denied`;
    }

    const payload = this.verifyIgState(state);
    if (!payload?.tenantId) {
      this.logger.warn("Instagram OAuth: 'state' yaroqsiz yoki muddati o'tgan");
      return `${redirectBase}&igLogin=error`;
    }
    if (!code) return `${redirectBase}&igLogin=error`;

    // ── CSRF: bir martalik nonce ──
    {
      const row = await this.prisma.tenant.findUnique({
        where: { id: payload.tenantId },
        select: { settings: true },
      });
      const st: any = row?.settings || {};
      const saved = st.instagramOAuthNonce;

      const baseOk =
        saved &&
        typeof saved.value === 'string' &&
        typeof payload.nonce === 'string' &&
        saved.value === payload.nonce &&
        Date.now() <= Number(saved.expiresAt || 0) &&
        (saved.userId ?? null) === (payload.userId ?? null);

      // Cookie qo'shimcha himoya — majburiy emas (facebook-leads
      // modulidagi bilan bir xil sabab: turli domenda third-party
      // cookie bloklanishi mumkin, asosiy himoya imzolangan state).
      const cookieOk = !cookieNonce || cookieNonce === saved?.value;
      const nonceOk = baseOk && cookieOk;

      if (saved) {
        await this.patchSettings(payload.tenantId, { instagramOAuthNonce: null }).catch(
          swallow('nonce tozalash'),
        );
      }

      if (!nonceOk) {
        this.logger.warn(
          `Instagram OAuth RAD ETILDI: nonce mos kelmadi yoki allaqachon ishlatilgan (tenant=${payload.tenantId})`,
        );
        return `${redirectBase}&igLogin=error`;
      }
    }

    const appId = getInstagramLoginAppId();
    const appSecret = getInstagramLoginAppSecret();
    const redirectUri = process.env.INSTAGRAM_LOGIN_REDIRECT_URI;
    if (!appId || !appSecret || !redirectUri) {
      this.logger.error(
        'Instagram OAuth: INSTAGRAM_LOGIN_APP_ID/SECRET/REDIRECT_URI env sozlanmagan',
      );
      return `${redirectBase}&igLogin=error`;
    }

    try {
      // 1) Kod → qisqa muddatli token (Meta talabi: form-urlencoded POST)
      const form = new URLSearchParams();
      form.set('client_id', appId);
      form.set('client_secret', appSecret);
      form.set('grant_type', 'authorization_code');
      form.set('redirect_uri', redirectUri);
      form.set('code', code);

      const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const tokenJson: any = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenJson?.access_token) {
        this.logger.error('Instagram OAuth token xato: ' + JSON.stringify(tokenJson));
        return `${redirectBase}&igLogin=token_exchange_failed`;
      }
      const shortToken: string = tokenJson.access_token;
      // ESKI (legacy) ID — /oauth/access_token javobidagi `user_id`.
      // v13.3 TUZATILDI: bu ID FAQAT zaxira (fallback) sifatida saqlanadi —
      // pastga qarang, nega bu bilan pageId sifatida ISHLATIB BO'LMASLIGI
      // tushuntirilgan.
      const legacyIgUserId: string = String(tokenJson.user_id || '');

      // 2) Qisqa (≈1 soat) → uzoq muddatli (60 kunlik) tokenga almashtirish
      const longUrl =
        `https://graph.instagram.com/access_token` +
        `?grant_type=ig_exchange_token` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&access_token=${encodeURIComponent(shortToken)}`;
      const longRes = await fetch(longUrl);
      const longJson: any = await longRes.json().catch(() => ({}));
      if (!longRes.ok || !longJson?.access_token) {
        this.logger.error(
          "Instagram OAuth: uzoq muddatli tokenga almashtirish MUVAFFAQIYATSIZ: " +
            JSON.stringify(longJson),
        );
        return `${redirectBase}&igLogin=token_exchange_failed`;
      }
      const longToken: string = longJson.access_token;

      /**
       * v13.3 MUHIM TUZATISH — "Instagram ulangan, lekin DM'lar
       * Chat'ga tushmayapti" muammosining ILDIZI shu yerda edi.
       *
       * Meta'da Instagram Business akkaunt uchun IKKITA turli ID bor:
       *   - `user_id` (tokenJson/meJson) — ESKI, deprecated raqamli ID
       *     (ig_id). Faqat eski/legacy migratsiya uchun qoldirilgan,
       *     boshqa hech qayerda ishlatilmaydi.
       *   - `id` (meJson.id) — HAQIQIY Instagram-scoped ID. Meta
       *     messaging webhook'da (`entry.id` va `recipient.id`)
       *     ANIQ shu ID'ni yuboradi.
       *
       * Ilgari bu yerda `tokenJson.user_id` (legacy) pageId sifatida
       * saqlanardi. Natijada: Instagram sozlamalarda "ulangan" deb
       * ko'rinardi, webhook ham muntazam kelardi (Meta uni to'g'ri
       * qabul qilardi — imzo/token to'g'ri edi), LEKIN har bir kelgan
       * webhook'dagi `entry.id` saqlangan (legacy) pageId'ga HECH QACHON
       * mos kelmasdi → `findTenantByPageId` doim `null` qaytarardi →
       * xabar "notanish pageId" sifatida jimgina tashlab yuborilardi
       * (bu ogohlantirish ham 10 daqiqada bir marta throttle qilingani
       * uchun Render loglarida deyarli ko'rinmasdi).
       *
       * Bu — Meta'ning o'zining developer forumida ham keng tarqalgan,
       * tan olingan muammosi (google: "Mismatch Between IDs in Instagram
       * Business Webhooks and Graph API").
       *
       * ENDI: `/me` so'roviga `id` maydonini ham qo'shamiz va ANIQ shuni
       * pageId sifatida saqlaymiz. `user_id` faqat `id` negadir
       * qaytmagan taqdirdagi zaxira (fallback) sifatida qoladi.
       */
      let username: string | null = null;
      let correctIgId: string = legacyIgUserId; // zaxira, pastda meJson.id bilan almashtiriladi
      try {
        const meRes = await fetch(
          `https://graph.instagram.com/${GRAPH_API_VERSION}/me` +
          `?fields=id,user_id,username,account_type` +
          `&access_token=${encodeURIComponent(longToken)}`,
        );
        const meJson: any = await meRes.json().catch(() => ({}));
        if (meRes.ok) {
          username = meJson?.username || null;
          if (meJson?.id) {
            correctIgId = String(meJson.id);
          } else {
            // `id` maydoni negadir qaytmasa — hech bo'lmasa shuni logga yozamiz,
            // chunki bu holda webhook baribir mos kelmasligi mumkin.
            this.logger.warn(
              'Instagram OAuth: /me javobida "id" maydoni yo\'q, legacy user_id bilan davom etilmoqda (webhook mos kelmasligi mumkin)',
            );
          }
        }
      } catch {
        /* profil ixtiyoriy — bo'lmasa ham ulanish davom etadi, legacy ID bilan */
      }

      if (!correctIgId) {
        this.logger.error('Instagram OAuth: Instagram akkaunt ID topilmadi');
        return `${redirectBase}&igLogin=error`;
      }

      // Bu Instagram akkaunt boshqa tenant'ga ulanmaganini tekshirish
      // saveConfig ichida (instagramPageId @unique) allaqachon bajariladi.
      await this.saveConfig(payload.tenantId, {
        accessToken: longToken,
        pageId: correctIgId,
        authMode: 'instagram_login',
        instagramUsername: username || undefined,
      });

      this.logger.log(
        `Instagram OAuth: tenant ${payload.tenantId} to'g'ridan-to'g'ri ulandi (@${username || igUserId})`,
      );

      return `${redirectBase}&igLogin=success${username ? `&igLoginUser=${encodeURIComponent(username)}` : ''}`;
    } catch (e: any) {
      if (e instanceof BadRequestException) {
        // Masalan: shu Instagram akkaunt allaqachon boshqa hisobga ulangan
        this.logger.warn('Instagram OAuth: ' + e.message);
        return `${redirectBase}&igLogin=already_connected&igLoginMsg=${encodeURIComponent(e.message)}`;
      }
      this.logger.error('Instagram OAuth callback xatosi: ' + e.message);
      return `${redirectBase}&igLogin=error`;
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
  /**
   * Page ID bo'yicha tenantni topadi.
   *
   * v13.0: ilgari BARCHA tenantlar o'qib chiqilib, JSON ichidan
   * qidirilardi — bu ham sekin edi, ham Page ID'ni o'zlashtirib olish
   * imkonini berardi. Endi indekslangan, @unique ustun bo'yicha
   * bitta so'rov.
   */
  private async findTenantByPageId(pageId: string): Promise<string | null> {
    if (!pageId) return null;
    const t = await this.prisma.tenant.findUnique({
      where: { instagramPageId: String(pageId).trim() },
      select: { id: true },
    });
    return t?.id ?? null;
  }

  async processWebhook(body: any, signature?: string, rawBody?: Buffer) {
    if (body?.object !== 'instagram' && body?.object !== 'page') return { ok: true };
    // Meta signature verification (X-Hub-Signature-256 header).
    // Meta imzoni App Secret bilan hisoblaydi (Page Access Token emas!).
    // ── IMZO TEKSHIRUVI (v13.2) — FAIL-CLOSED, KO'P-SECRET ──
    //
    // ILGARI: `if (signature && appSecret && rawBody)` shartida edi.
    // Ya'ni imzo sarlavhasi YUBORILMASA, tekshiruv butunlay o'tkazib
    // yuborilardi va istalgan odam soxta xabar/lead yarata olardi.
    // Keyinroq (v13.0-13.1) bitta secret bilan fail-closed qilindi, lekin
    // noto'g'ri secret ustuvor bo'lib qolsa, HAR BIR haqiqiy webhook ham
    // rad etilaverardi (pastdagi izohga qarang).
    //
    // ENDI: sozlangan barcha (INSTAGRAM_APP_SECRET / INSTAGRAM_LOGIN_APP_SECRET
    // / kerak bo'lsa FACEBOOK_APP_SECRET) secretlar navbat bilan tekshiriladi;
    // birortasi mos kelsa — qabul qilinadi. Hech biri mos kelmasa yoki
    // umuman sozlanmagan bo'lsa — 403 (chekinish yo'li yo'q; development'dagi
    // META_WEBHOOK_SKIP_SIGNATURE production'da ishlamaydi — canSkipSignature()
    // ichida qattiq shart bor).
    if (!canSkipSignature()) {
      const candidates = getInstagramAppSecretCandidates();
      let matched = false;
      let lastReason = 'APP_SECRET sozlanmagan';
      for (const secret of candidates) {
        const sig = verifyMetaSignature(rawBody, signature, secret);
        if (sig.ok) { matched = true; break; }
        lastReason = sig.reason || lastReason;
      }
      if (!matched) {
        this.logger.warn(`Instagram webhook RAD ETILDI: ${lastReason} (${candidates.length} secret tekshirildi)`);
        throw new ForbiddenException();
      }
    }

    // PII himoyasi (v13.0): ilgari butun body log'ga yozilardi —
    // mijoz ismlari va xabar matnlari log fayllarida qolardi.
    // Endi production'da faqat metama'lumot yoziladi.
    if (process.env.NODE_ENV === 'production') {
      this.logger.log(
        `Instagram webhook: object=${body?.object} entries=${(body?.entry || []).length}`,
      );
    } else {
      this.logger.log('Instagram webhook received: ' + JSON.stringify(body).slice(0, 300));
    }
    const entries: any[] = body?.entry || [];
    for (const entry of entries) {
      // entry.id — shu xabarni qabul qilgan Page/Instagram Business Account ID.
      const pageId: string = entry?.id;
      const tenantId = await this.findTenantByPageId(pageId);
      if (!tenantId) {
        const now = Date.now();
        const lastWarned = unknownPageIdWarned.get(pageId) || 0;
        if (now - lastWarned > UNKNOWN_PAGE_WARN_TTL_MS) {
          unknownPageIdWarned.set(pageId, now);
          this.logger.warn('Instagram webhook: pageId=' + pageId + ' uchun tenant topilmadi (Sozlamalarda Page ID ni tekshiring)');
          // Xotira sizmasin uchun eskirgan yozuvlarni vaqti-vaqti bilan tozalaymiz.
          if (unknownPageIdWarned.size > 500) {
            for (const [k, t] of unknownPageIdWarned) {
              if (now - t > UNKNOWN_PAGE_WARN_TTL_MS) unknownPageIdWarned.delete(k);
            }
          }
        }
        continue;
      }
      // v18: mos tenant TOPILGANDA ham bir marta LOG qoldiramiz. Ilgari
      // faqat "topilmadi" holati log qilinardi — shuning uchun Render
      // loglarida "pageId=X uchun tenant topilmadi" ko'p uchrasa ham,
      // bu X o'zining sozlangan Page ID'siga TEGISHLI ekanini yoki
      // umuman BOSHQA (tekshirilmagan/eski) Page'ga tegishli ekanini
      // ajratib bo'lmasdi. Endi muvaffaqiyatli moslashuv ham ko'rinadi —
      // shu bilan "webhook umuman kelmayaptimi" va "kelyapti-yu, lekin
      // pageId mos kelmayaptimi" ikkalasini loglardan aniq ajratish mumkin.
      const messagingEvents = entry?.messaging || [];
      this.logger.log(
        `Instagram webhook: pageId=${pageId} → tenant=${tenantId} topildi (${messagingEvents.length} ta hodisa)`,
      );
      for (const event of messagingEvents) {
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

    const config = await this.getInternalConfig(tenantId);
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
      await this.sendRaw(config.accessToken!, senderId, note, config.authMode);
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
        }).catch(swallow('bildirishnoma'));
      }
      return;
    }

    // ── AI rejim: erkin suhbat (skript emas) ──
    // Sozlamalar → Instagram → "AI bilan javob berish" yoqilgan bo'lsa,
    // pastdagi qattiq ASK_NAME/ASK_DESTINATION skripti ISHLAMAYDI —
    // buning o'rniga Claude mijoz bilan erkin suhbatlashadi va kerak
    // bo'lsa operator raqamini beradi.
    if (config.aiEnabled) {
      await this.handleAiMessage(tenantId, conv, config, senderId, text);
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
      await this.reply(config.accessToken!, senderId, greet, config.authMode);
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
        }).catch(swallow('yozuvni yangilash'));
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
      await this.reply(config.accessToken!, senderId, next, config.authMode);
      await this.saveOutbound(conv, next, null);
    }

    // Bot savollari tugadi → suhbat jonli operatorga o'tadi.
    // Shundan keyin mijoz yozgan har bir xabar Chat'da agentni kutadi.
    if (session.step === 'DONE') {
      await this.switchToHuman(conv);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // AI REJIM: Claude bilan erkin suhbat
  // ═══════════════════════════════════════════════════════════

  private get anthropicKey() {
    return (process.env.ANTHROPIC_API_KEY || '').trim();
  }

  /** ai-marketing/calls modullaridagi kabi — shu funksiyaga XOS model o'zgaruvchisi. */
  private get anthropicModel() {
    return (process.env.ANTHROPIC_MODEL_INSTAGRAM || 'claude-haiku-4-5-20251001').trim();
  }

  /** Kunlik AI kvotasini tekshiradi va sarflaydi. Limitdan oshsa false qaytaradi. */
  private consumeAiQuota(tenantId: string): boolean {
    const today = new Date().toISOString().slice(0, 10);
    const cur = aiQuotaCache.get(tenantId);
    if (!cur || cur.day !== today) {
      aiQuotaCache.set(tenantId, { count: 1, day: today });
      return true;
    }
    if (cur.count >= AI_DAILY_QUOTA) return false;
    cur.count += 1;
    return true;
  }

  /**
   * Mijozga jonli operatorga o'tkazilgani haqida xabar yozadi (operator
   * raqami bilan, agar Sozlamalarda kiritilgan bo'lsa) va suhbatni
   * "ig:human" rejimiga o'tkazadi.
   */
  private async handoffToOperator(tenantId: string, conv: any, config: any, senderId: string, aiReplyText?: string) {
    const phoneLine = config.operatorPhone
      ? `\n\nMenejerimiz raqami: ${config.operatorPhone} — bevosita bog'lanishingiz mumkin, yoki shu yerda kuting, tez orada javob beramiz.`
      : '\n\nMenejerimiz tez orada siz bilan bog\'lanadi.';
    const text = (aiReplyText ? aiReplyText.trim() : 'Kechirasiz, bu savolga aniq javob bera olmayapman.') + phoneLine;

    await this.sendRaw(config.accessToken!, senderId, text, config.authMode);
    await this.saveOutbound(conv, text, null);
    await this.switchToHuman(conv);
    await this.deleteSession(tenantId, senderId);

    if (conv.assignedAgentId) {
      await this.notifications.create({
        tenantId,
        userId: conv.assignedAgentId,
        type: 'LEAD_NEW',
        title: '🤖 Instagram AI: operatorga topshirildi',
        body: conv.firstName || 'Instagram foydalanuvchi',
        link: `/inbox?conv=${conv.id}`,
        metadata: { conversationId: conv.id },
      }).catch(swallow('bildirishnoma'));
    }
  }

  /**
   * AI rejimida kelgan mijoz xabariga Claude orqali javob yozadi.
   *
   * - Bilim bazasi (config.knowledgeBase) — firma/turlar/narxlar haqida
   *   admin Sozlamalarda kiritgan matn. Claude FAQAT shu matndagi
   *   faktlarga tayanadi, narx/sana to'qib chiqarmaydi.
   * - Claude javobni QAT'IY JSON ko'rinishida qaytaradi:
   *   {"reply": "mijozga yuboriladigan matn", "handoff": true|false}
   *   `handoff: true` — Claude aniq javob bera olmadi YOKI mijoz
   *   jonli odam so'radi (bu holat asosan yuqoridagi HANDOVER_KEYWORDS
   *   orqali ushlanadi, lekin Claude ham mustaqil aniqlashi mumkin).
   */
  private async handleAiMessage(tenantId: string, conv: any, config: any, senderId: string, text: string) {
    if (!config.accessToken) return;

    if (!this.anthropicKey) {
      this.logger.warn('Instagram AI: ANTHROPIC_API_KEY sozlanmagan — operatorga topshirilmoqda');
      await this.handoffToOperator(tenantId, conv, config, senderId);
      return;
    }

    if (!this.consumeAiQuota(tenantId)) {
      this.logger.warn(`Instagram AI: tenant ${tenantId} kunlik kvota (${AI_DAILY_QUOTA}) tugadi`);
      await this.handoffToOperator(tenantId, conv, config, senderId,
        'Hozircha AI yordamchimiz band — kechirasiz.');
      return;
    }

    // Suhbat tarixi — oxirgi bir nechta xabar (Claude'ga kontekst uchun)
    const history = await this.prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'desc' },
      take: AI_CONTEXT_MESSAGE_LIMIT,
      select: { direction: true, text: true },
    });
    const messages = history
      .reverse()
      .filter((m) => (m.text || '').trim())
      .map((m) => ({
        role: m.direction === 'OUTBOUND' ? 'assistant' : 'user',
        content: m.text as string,
      }));
    // Oxirgi xabar aynan shu kiruvchi xabar bo'lishi kerak (saveInbound
    // handleAiMessage'dan OLDIN chaqiriladi, shu sabab tarixda allaqachon bor)
    if (messages.length === 0 || messages[messages.length - 1].content !== text) {
      messages.push({ role: 'user', content: text });
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    const kb = (config.knowledgeBase || '').trim();

    const system = `Sen "${tenant?.name || 'Sayohat agentligi'}" turizm agentligining Instagram Direct orqali mijozlarga javob beruvchi yordamchisisan.

QOIDALAR:
1. Faqat pastdagi "BILIM BAZASI" bo'limidagi faktlardan foydalan — narx, sana, tur yo'nalishi yoki xizmatlarni hech qachon o'zingdan to'qib chiqarma.
2. Agar savolga aniq javob berish uchun bilim bazasida yetarli ma'lumot bo'lmasa, yoki mijoz aniq operator/menejer bilan gaplashishni so'rasa — "handoff": true qaytar va reply'da mijozga hozircha nima bilishing (agar bo'lsa) qisqa yoz.
3. Javoblaring QISQA (2-4 gap), samimiy, o'zbek tilida (agar mijoz rus tilida yozsa — rus tilida javob ber).
4. Hech qachon narxni, sanani yoki mavjudlikni "taxminan" deb o'ylab topma — bilmasang shundayligini yoz va handoff qil.
5. Salomlashish, xayrlashish kabi oddiy xabarlarga o'zing tabiiy javob ber (handoff kerak emas).

BILIM BAZASI (agentlik haqida, turlar, narxlar, shartlar):
${kb || '(Admin hali bilim bazasini to\'ldirmagan — faqat umumiy, ehtiyotkor javob ber va aniq savollarda handoff qil.)'}

Javobni FAQAT quyidagi JSON formatida qaytar, boshqa hech narsa yozma (izoh, markdown belgisi ham kerak emas):
{"reply": "...", "handoff": false}`;

    let raw = '';
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.anthropicModel,
          max_tokens: 500,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Anthropic API xato (HTTP ${res.status}): ${errText.slice(0, 200)}`);
      }

      const j: any = await res.json();
      const textBlock = (j?.content || []).find((c: any) => c.type === 'text');
      raw = textBlock?.text || '';
    } catch (e: any) {
      this.logger.error('Instagram AI xato: ' + e.message);
      await this.handoffToOperator(tenantId, conv, config, senderId);
      return;
    }

    let parsed: { reply?: string; handoff?: boolean } = {};
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { reply: raw };
    } catch {
      parsed = { reply: raw };
    }

    const replyText = (parsed.reply || '').trim();
    if (parsed.handoff) {
      await this.handoffToOperator(tenantId, conv, config, senderId, replyText);
      return;
    }

    if (!replyText) return;
    await this.sendRaw(config.accessToken, senderId, replyText, config.authMode);
    await this.saveOutbound(conv, replyText, null);
  }

  // ═══════════════════════════════════════════════════════════
  // CHAT: Conversation + Message (Telegram bilan bir xil uslub)
  // ═══════════════════════════════════════════════════════════

  /** Instagram foydalanuvchi profilini oladi (ism, rasm). Xato bo'lsa — jim. */
  private async fetchIgProfile(accessToken: string, igsid: string, authMode?: string) {
    try {
      const res = await fetch(
        `https://${igApiHost(authMode)}/${GRAPH_API_VERSION}/${igsid}` +
        `?fields=name,profile_pic&access_token=${encodeURIComponent(accessToken)}`,
      );
      if (!res.ok) return null;
      const j: any = await res.json();
      return {
        // DIQQAT: bu endpoint `username` ni QO'LLAB-QUVVATLAMAYDI.
        // So'ralsa Meta butun so'rovni rad etadi:
        // "(#100) Tried accessing nonexisting field (username)"
        firstName: j?.name || null,
        username: null,
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
      ? await this.fetchIgProfile(config.accessToken, igsid, config.authMode)
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
      }).catch(swallow('bildirishnoma'));
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
    }).catch(swallow('yangilash'));
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

    const config = await this.getInternalConfig(tenantId);
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

    const ok = await this.sendRaw(config.accessToken, conv.externalChatId, text, config.authMode);
    if (!ok.success) {
      throw new BadRequestException(`Instagram'ga yuborilmadi: ${ok.error}`);
    }

    return this.saveOutbound(conv, text, agentId);
  }

  /** Xom yuborish — natijani qaytaradi (xatoni yutmaydi). */
  private async sendRaw(accessToken: string, recipientId: string, text: string, authMode?: string) {
    try {
      const res = await fetch(`https://${igApiHost(authMode)}/${GRAPH_API_VERSION}/me/messages`, {
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
    // Raqamni yagona formatga keltiramiz va barcha ko'rinishlari
    // bo'yicha dublikat qidiramiz (Facebook bilan bir xil mantiq)
    const normalizedPhone = normalizePhone(s.phone);
    if (s.phone) {
      const dup = await this.prisma.client.findFirst({
        where: { tenantId, phone: { in: phoneVariants(s.phone) } },
      });
      if (dup) {
        this.logger.log('Instagram duplicate phone: ' + s.phone);
        return dup;
      }
    }

    const client = await this.prisma.client.create({
      data: {
        tenantId,
        fullName: s.name || 'Instagram foydalanuvchi',
        phone: normalizedPhone || s.phone || '',
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
    }).catch(swallow('mijoz tarixi'));

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

  private async reply(accessToken: string, recipientId: string, text: string, authMode?: string) {
    if (!accessToken) { this.logger.warn('Instagram: no accessToken'); return; }
    try {
      const res = await fetch(`https://${igApiHost(authMode)}/${GRAPH_API_VERSION}/me/messages`, {
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
  // XAVFSIZLIK (v13.0): ilgari faqat JwtAuthGuard bor edi — oddiy AGENT
  // ham integratsiya sozlamalarini o'qiy/yoza olardi. Endi faqat admin.
  @Get('config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('TENANT_ADMIN')
  getConfig(@CurrentUser() u: any) {
    return this.svc.getConfig(u.tenantId);
  }

  @ApiOperation({ summary: 'Instagram bot sozlamalarini saqlash' })
  @ApiBearerAuth('JWT')
  @Post('config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('TENANT_ADMIN')
  saveConfig(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.saveConfig(u.tenantId, body);
  }

  @ApiOperation({ summary: 'Instagram akkauntini uzish' })
  @ApiBearerAuth('JWT')
  @Delete('config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('TENANT_ADMIN')
  disconnect(@CurrentUser() u: any) {
    return this.svc.disconnect(u.tenantId);
  }

  @ApiOperation({ summary: 'Instagram statistikasi' })
  @ApiBearerAuth('JWT')
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  stats(@CurrentUser() u: any) {
    return this.svc.getStats(u.tenantId);
  }

  // ── OAuth: "Instagram orqali to'g'ridan-to'g'ri ulash" ──────────────
  // Facebook Page shart emas — Meta'ning "Instagram Login for Business"
  // oqimi. Login/parol faqat instagram.com'ning o'zida kiritiladi.

  @ApiOperation({ summary: 'Instagram Login URL olish (to\'g\'ridan-to\'g\'ri ulanish)' })
  @ApiBearerAuth('JWT')
  @Get('oauth/start-url')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('TENANT_ADMIN')
  async getOAuthStartUrl(
    @CurrentUser() u: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result: any = await this.svc.getOAuthStartUrl(u.tenantId, u.sub);

    // Cookie qo'shimcha himoya sifatida — brauzer bloklasa ham (Safari
    // ITP / third-party cookie) oqim baribir ishlaydi, asosiy himoya
    // imzolangan `state` + serverdagi bir martalik nonce.
    if (result?.nonce) {
      res.cookie('ig_oauth_nonce', result.nonce, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 10 * 60 * 1000,
        path: '/api/v1/instagram',
      });
      delete result.nonce;
    }
    return result;
  }

  @Get('oauth/callback')
  @Public()
  @SkipThrottle()
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const cookieNonce = req.cookies?.ig_oauth_nonce;
    res.clearCookie('ig_oauth_nonce', { path: '/api/v1/instagram' });
    const redirectTo = await this.svc.handleOAuthCallback(code, state, error, cookieNonce);
    return res.redirect(redirectTo);
  }
}

@Module({
  controllers: [InstagramController],
  imports: [RoundRobinModule],
  providers: [InstagramService],
  exports: [InstagramService],
})
export class InstagramModule {}