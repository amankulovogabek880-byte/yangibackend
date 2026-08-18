import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Cron } from '@nestjs/schedule';
import { verifyMetaSignature, canSkipSignature } from '../../common/utils/meta-signature';
import type { Response } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { CronLockService } from '../../common/utils/cron-lock.service';
import { normalizePhone, phoneVariants } from '../../common/utils/helpers';
import { RoundRobinService, RoundRobinModule } from '../v9/round-robin.module';
import { InstagramService, InstagramModule } from '../instagram/instagram.module';
import { LeadScoringService, LeadScoringModule } from '../v9/lead-scoring.module';
import { AutoReplyService, AutoReplyModule } from '../v9/auto-reply.module';
import { swallow } from '../../common/utils/swallow';

const GRAPH_API_VERSION = 'v23.0';

/** Bitta hodisa uchun eng ko'p necha marta qayta uriniladi */
const MAX_ATTEMPTS = 6;
/** Bir siklda navbatdan nechta hodisa olinadi */
const QUEUE_BATCH = 25;
/** SLA: lead tayinlangandan keyin necha daqiqada javob kutamiz */
const SLA_MINUTES = Number(process.env.LEAD_SLA_MINUTES || 15);

// ── FACEBOOK XATOLARINI TASNIFLASH ──────────────────────────────────
// Graph API turli holatlarda turlicha xato qaytaradi (ruxsat yetishmasligi,
// Page topilmasligi, token yaroqsizligi...). Bu funksiya xom javobni
// frontend uchun tushunarli, harakatga undovchi "errorType" ga aylantiradi.
export type FacebookErrorType =
  | 'NO_ADMIN_ACCESS'
  | 'MISSING_PERMISSIONS'
  | 'INVALID_TOKEN'
  | 'NO_PAGES'
  | 'RATE_LIMIT'
  | 'UNKNOWN';

function classifyFacebookError(json: any): { type: FacebookErrorType; message: string } {
  const err = json?.error || {};
  const code = err.code;
  const subcode = err.error_subcode;
  const message: string = String(err.message || '');
  const lower = message.toLowerCase();

  // 4 / 17 / 32 / 613 — Meta'ning limit kodlari. Bularni "noma'lum" deb
  // belgilash xato edi: qayta urinish kerak, sozlamani o'zgartirish emas.
  if ([4, 17, 32, 613].includes(Number(code)) || lower.includes('rate limit')) {
    return { type: 'RATE_LIMIT', message };
  }
  if (code === 100 && subcode === 33) {
    return { type: 'NO_ADMIN_ACCESS', message };
  }
  if (code === 190 || lower.includes('impersonating')) {
    return { type: 'MISSING_PERMISSIONS', message };
  }
  if (code === 200 || (lower.includes('requires') && lower.includes('permission'))) {
    return { type: 'MISSING_PERMISSIONS', message };
  }
  if (
    lower.includes('admin') ||
    lower.includes('must have a role') ||
    lower.includes('does not have sufficient')
  ) {
    return { type: 'NO_ADMIN_ACCESS', message };
  }
  if (
    lower.includes('expired') ||
    lower.includes('invalid oauth access token') ||
    lower.includes('session has been invalidated')
  ) {
    return { type: 'INVALID_TOKEN', message };
  }
  if (!message) return { type: 'UNKNOWN', message: '' };
  return { type: 'UNKNOWN', message };
}

const OAUTH_STATE_SECRET =
  process.env.JWT_ACCESS_SECRET || 'dev-only-change-in-production';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Webhook verify token — FAQAT server env'idan.
 *
 * TUZATILDI: ilgari `getConfig()` tenant sozlamalaridagi
 * `facebookVerifyToken` ni qaytarardi va UI shuni ko'rsatardi, lekin
 * `verifyWebhook()` env qiymatini tekshirardi. Admin UI'dagi qiymatni
 * Meta Dashboard'ga kiritsa — webhook verifikatsiyasi YIQILARDI va
 * obuna umuman o'rnatilmasdi.
 *
 * Webhook manzili butun platforma uchun BITTA, demak verify token ham
 * bitta bo'lishi kerak. Tenantga bog'lash mantiqan noto'g'ri edi.
 */
function getVerifyToken(): string {
  return process.env.FACEBOOK_VERIFY_TOKEN || 'omoncrm_fb_verify';
}

/**
 * Webhook imzosi uchun App Secret.
 *
 * TUZATILDI: ilgari `FACEBOOK_APP_SECRET || INSTAGRAM_APP_SECRET` edi.
 * Agar Facebook va Instagram TURLI Meta App'da bo'lsa, Instagram siri
 * bilan hisoblangan imzo hech qachon mos kelmaydi va HAR BIR lead
 * jimgina 403 bilan rad etiladi.
 *
 * Endi fallback FAQAT `META_SINGLE_APP=true` bo'lganda ishlaydi —
 * ya'ni admin ataylab "bitta App ishlatyapman" deb tasdiqlaganda.
 */
function getAppSecret(): string | undefined {
  const fb = process.env.FACEBOOK_APP_SECRET;
  if (fb) return fb;
  if (process.env.META_SINGLE_APP === 'true') return process.env.INSTAGRAM_APP_SECRET;
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════
// FACEBOOK LEAD ADS SERVICE
//
// OQIM (v14):
//   1. Admin "Facebook orqali ulash" bosadi → OAuth → Page Access Token
//      shifrlanib saqlanadi va Page "leadgen" hodisasiga obuna qilinadi.
//   2. Formani to'ldirgan odam bo'lsa, Meta bizning global webhookka
//      POST yuboradi.
//   3. Webhook hodisani `FacebookLeadEvent` jadvaliga yozadi va Meta'ga
//      DARHOL 200 qaytaradi (≈20ms).
//   4. Fon navbat (`drainQueue`) hodisani qayta ishlaydi: Graph API'dan
//      to'liq lead → client → scoring → auto-reply → tayinlash.
//      Xato bo'lsa qayta uriniladi, hech narsa yo'qolmaydi.
//   5. Har soatda "backfill" cron Meta'dan o'tkazib yuborilgan leadlarni
//      qidirib topadi va navbatga qo'shadi.
//
// XAVFSIZLIK:
//   - Page Access Token AES-256-GCM bilan shifrlanadi
//   - Webhook imzosi FAIL-CLOSED tekshiriladi
//   - OAuth `state` imzolangan + bir martalik nonce
// ═══════════════════════════════════════════════════════════════════

@Injectable()
export class FacebookLeadsService {
  private readonly logger = new Logger('FacebookLeads');

  /** Navbat bir vaqtda faqat bitta oqimda ishlashi uchun (shu instans ichida) */
  private draining = false;

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private encryption: EncryptionService,
    private roundRobin: RoundRobinService,
    private scoring: LeadScoringService,
    private autoReply: AutoReplyService,
    private instagram: InstagramService,
    private notifications: NotificationsService,
    private cronLock: CronLockService,
  ) {}

  /**
   * Prisma cast — `FacebookLeadEvent` modeli `prisma generate` dan keyin
   * paydo bo'ladi. Shu sababli `any`: kod generate'gacha ham kompilyatsiya
   * bo'lsin (loyihada `marketplace` moduli ham shu usulni ishlatadi).
   */
  private get db(): any {
    return this.prisma;
  }

  // ─────────────────────────────────────────────────────────────────
  // SOZLAMALAR
  // ─────────────────────────────────────────────────────────────────

  async getConfig(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const s: any = tenant?.settings || {};
    const decrypted = s.facebookPageAccessToken
      ? this.encryption.decrypt(s.facebookPageAccessToken)
      : null;

    return {
      pageId: s.facebookPageId || null,
      pageName: s.facebookPageName || null,
      hasAccessToken: !!decrypted,
      maskedAccessToken: decrypted ? this.encryption.mask(decrypted, 6, 4) : null,
      // MUHIM: bu env qiymati — Meta Dashboard'ga AYNAN shuni kiritish kerak
      verifyToken: getVerifyToken(),
      assignToAgentId: s.facebookAssignAgentId || null,
      isEnabled: !!decrypted && !!s.facebookPageId,
      connectedAt: s.facebookConnectedAt || null,
      lastBackfillAt: s.facebookLastBackfillAt || null,
      // Server tomonida imzo siri bormi — yo'q bo'lsa HECH QANDAY lead kelmaydi
      appSecretConfigured: !!getAppSecret(),
    };
  }

  async saveConfig(
    tenantId: string,
    data: {
      accessToken?: string;
      pageId?: string;
      pageName?: string;
      assignToAgentId?: string;
    },
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const cur: any = tenant?.settings || {};

    const newEncToken = data.accessToken?.trim()
      ? this.encryption.encrypt(data.accessToken.trim())
      : cur.facebookPageAccessToken || null;

    const newPageId = data.pageId?.trim() || cur.facebookPageId || null;

    if (newPageId) {
      const taken = await this.prisma.tenant.findFirst({
        where: { facebookPageId: newPageId, NOT: { id: tenantId } },
        select: { id: true },
      });
      if (taken) {
        throw new BadRequestException(
          `Bu Facebook Page ID (${newPageId}) boshqa hisobga allaqachon ulangan. ` +
            `O'z Page'ingizni tanlang yoki platforma administratoriga murojaat qiling.`,
        );
      }
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        facebookPageId: newPageId,
        settings: {
          ...cur,
          facebookPageAccessToken: newEncToken,
          facebookPageId: newPageId,
          facebookPageName: data.pageName?.trim() ?? cur.facebookPageName ?? null,
          facebookAssignAgentId:
            data.assignToAgentId !== undefined
              ? data.assignToAgentId || null
              : cur.facebookAssignAgentId ?? null,
          facebookConnectedAt:
            newEncToken && newPageId
              ? new Date().toISOString()
              : cur.facebookConnectedAt ?? null,
          // Token yaroqsizligi haqidagi eski bayroqni tozalaymiz
          facebookTokenInvalidAt: null,
        },
      },
    });

    let subscribeResult: {
      ok: boolean;
      errorType?: FacebookErrorType;
      rawMessage?: string;
    } | null = null;
    if (newEncToken && newPageId) {
      const plainToken = this.encryption.decrypt(newEncToken);
      if (plainToken) subscribeResult = await this.subscribeAppToPage(newPageId, plainToken);
    }

    const config = await this.getConfig(tenantId);
    if (subscribeResult && !subscribeResult.ok) {
      return {
        ...config,
        subscribeWarning: {
          errorType: subscribeResult.errorType || 'UNKNOWN',
          message: subscribeResult.rawMessage || '',
        },
      };
    }
    return config;
  }

  /** Page'ni Meta ilovamizga "leadgen" hodisasi uchun obuna qiladi. */
  private async subscribeAppToPage(
    pageId: string,
    accessToken: string,
  ): Promise<{ ok: boolean; errorType?: FacebookErrorType; rawMessage?: string }> {
    try {
      const url =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/subscribed_apps` +
        `?subscribed_fields=leadgen` +
        `&access_token=${encodeURIComponent(accessToken)}`;
      const res = await fetch(url, { method: 'POST' });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        const { type, message } = classifyFacebookError(json);
        this.logger.error(`Facebook subscribe_apps xato [${type}]: ` + JSON.stringify(json));
        return { ok: false, errorType: type, rawMessage: message };
      }
      this.logger.log(`Facebook: Page ${pageId} "leadgen" hodisasiga obuna qilindi`);
      return { ok: true };
    } catch (e: any) {
      this.logger.error('Facebook subscribe_apps error: ' + e.message);
      return { ok: false, errorType: 'UNKNOWN', rawMessage: e.message };
    }
  }

  /**
   * 🩹 TUZATISH: Facebook Page'ga bog'langan Instagram professional
   * (Business/Creator) akkaunt ID'sini topadi.
   *
   * Ilgari bu yerda TEKSHIRUVSIZ to'g'ridan-to'g'ri Facebook Page ID'ning
   * o'zi `instagram.saveConfig`ga `pageId` sifatida yuborilardi. Bu ikki
   * jihatdan noto'g'ri edi:
   *   1) Agar Page'ga Instagram akkaunt umuman bog'lanmagan bo'lsa —
   *      baribir "Instagram ulandi" deb ko'rsatilardi (soxta muvaffaqiyat),
   *      chunki hech qanday tekshiruv yo'q edi.
   *   2) Instagram Messaging webhook'lari (object=instagram) `entry.id`
   *      sifatida Facebook Page ID'ni EMAS — aynan shu Instagram akkaunt
   *      ID'sini yuboradi. Demak FB Page ID saqlansa, `findTenantByPageId`
   *      hech qachon mos tenant topa olmasdi va DM'lar Chat bo'limiga
   *      HECH QACHON tushmasdi — garchi ulanish "muvaffaqiyatli" ko'ringan
   *      taqdirda ham.
   *
   * Endi shu funksiya Graph API orqali haqiqiy bog'langan Instagram
   * akkauntni so'raydi va topilmasa ANIQ xabar bilan rad etadi — soxta
   * "ulandi" holatiga yo'l qo'ymaydi.
   */
  private async findLinkedInstagramAccount(
    pageId: string,
    pageAccessToken: string,
  ): Promise<{ id: string; username?: string } | null> {
    try {
      const url =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}` +
        `?fields=instagram_business_account{id,username}` +
        `&access_token=${encodeURIComponent(pageAccessToken)}`;
      const res = await fetch(url);
      const json: any = await res.json().catch(() => ({}));
      const acc = json?.instagram_business_account;
      if (!res.ok) {
        this.logger.warn('Instagram business account so\'rovi xato: ' + JSON.stringify(json));
        return null;
      }
      if (!acc?.id) return null;
      return { id: acc.id, username: acc.username };
    } catch (e: any) {
      this.logger.warn(`Instagram business account qidirishda xato: ${e.message}`);
      return null;
    }
  }

  /**
   * Tanlangan Facebook Page uchun Instagram DM ulanishini sinaydi va
   * natija (ulandi/yo'q + admin ko'radigan sabab) qaytaradi. Ikkala joyda
   * (bitta Page avtomatik oqimi va qo'lda Page tanlash oqimi) ishlatiladi
   * — mantiq ikki marta yozilmasligi uchun.
   */
  private async connectInstagramForPage(
    tenantId: string,
    pageId: string,
    pageAccessToken: string,
  ): Promise<{ connected: boolean; error: string }> {
    try {
      const igAccount = await this.findLinkedInstagramAccount(pageId, pageAccessToken);
      if (!igAccount) {
        return {
          connected: false,
          error:
            "Bu Facebook Page'ga Instagram professional (Business yoki Creator) akkaunt " +
            "bog'lanmagan. Instagram ilovasida: Sozlamalar → Hisob turi → Professional " +
            "akkauntga o'ting, so'ng uni aynan shu Facebook Page'ga bog'lang va \"Facebook " +
            "orqali ulash\"ni qaytadan bosing.",
        };
      }
      await this.instagram.saveConfig(tenantId, {
        accessToken: pageAccessToken,
        pageId: igAccount.id,
      });
      return { connected: true, error: '' };
    } catch (e: any) {
      const msg = e?.message || '';
      this.logger.warn(`Instagram ulanmadi (Facebook ishlayapti): ${msg}`);
      return { connected: false, error: msg };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // WEBHOOK
  // ─────────────────────────────────────────────────────────────────

  verifyWebhook(mode: string, token: string, challenge: string): string {
    if (mode === 'subscribe' && token === getVerifyToken()) {
      this.logger.log('Facebook webhook verifikatsiyasi muvaffaqiyatli');
      return challenge;
    }
    this.logger.warn(
      "Facebook webhook verifikatsiyasi RAD ETILDI — Meta Dashboard'dagi Verify Token " +
        "server env'idagi FACEBOOK_VERIFY_TOKEN bilan mos kelmadi",
    );
    throw new BadRequestException('Webhook verification failed');
  }

  /**
   * WEBHOOK QABUL QILISH — endi FAQAT yozib qo'yadi va darhol qaytadi.
   *
   * NEGA SHUNDAY: Meta ~5 soniya kutadi. Graph API + scoring + auto-reply
   * undan uzoq davom etadi → Meta timeout deb hisoblaydi, qayta yuboradi,
   * keyin esa Page obunasini butunlay o'chiradi. Endi bu so'rov ~20ms
   * ichida tugaydi, haqiqiy ishlov fon rejimida boradi.
   */
  async processWebhook(body: any, signature?: string, rawBody?: Buffer) {
    if (body?.object !== 'page') return { ok: true };

    // ── IMZO TEKSHIRUVI — FAIL-CLOSED ──
    // Imzo yo'q, kalit yo'q yoki mos kelmasa — rad etamiz. Aks holda
    // istalgan odam soxta lead va bildirishnoma yarata olardi.
    if (!canSkipSignature()) {
      const appSecret = getAppSecret();
      if (!appSecret) {
        // Bu holat ENG XAVFLISI: hech narsa ishlamaydi, lekin sabab
        // ko'rinmaydi. Shuning uchun `error` darajasida yozamiz.
        this.logger.error(
          'FACEBOOK_APP_SECRET sozlanmagan — barcha Facebook webhooklari RAD ETILADI. ' +
            "Leadlar CRM'ga TUSHMAYDI. Serverdagi .env ni tekshiring.",
        );
        throw new ForbiddenException();
      }
      const sig = verifyMetaSignature(rawBody, signature, appSecret);
      if (!sig.ok) {
        this.logger.warn(`Facebook webhook RAD ETILDI: ${sig.reason}`);
        throw new ForbiddenException();
      }
    }

    const entries: any[] = body?.entry || [];
    let queued = 0;

    for (const entry of entries) {
      const pageId: string = String(entry?.id || '');
      const changes: any[] = entry?.changes || [];

      for (const change of changes) {
        if (change?.field !== 'leadgen') continue;
        const leadgenId: string | undefined = change?.value?.leadgen_id;
        if (!leadgenId) continue;

        const ok = await this.enqueueLead({
          leadgenId: String(leadgenId),
          pageId,
          formId: change?.value?.form_id ? String(change.value.form_id) : null,
          adId: change?.value?.ad_id ? String(change.value.ad_id) : null,
          createdTime: change?.value?.created_time
            ? String(change.value.created_time)
            : null,
          source: 'WEBHOOK',
        });
        if (ok) queued++;
      }
    }

    // Fon rejimda ishlov beramiz — javobni KUTMAYMIZ.
    if (queued > 0) {
      setImmediate(() => {
        this.drainQueue().catch((e) =>
          this.logger.error('Facebook navbatini ishlashda xato: ' + e?.message),
        );
      });
    }

    return { ok: true };
  }

  /**
   * Hodisani navbatga qo'yadi. `leadgenId` @unique bo'lgani uchun
   * takroriy webhook (Meta at-least-once kafolat beradi) dublikat
   * yaratmaydi — shunchaki `false` qaytadi.
   */
  private async enqueueLead(data: {
    leadgenId: string;
    pageId: string;
    formId?: string | null;
    adId?: string | null;
    createdTime?: string | null;
    payload?: any;
    source: 'WEBHOOK' | 'BACKFILL';
  }): Promise<boolean> {
    // Page qaysi agentlikka tegishli — hozirroq aniqlab qo'yamiz,
    // shunda "kimniki ekani noma'lum" hodisalar ham ko'rinib turadi.
    const tenantId = await this.findTenantIdByPageId(data.pageId);

    try {
      await this.db.facebookLeadEvent.create({
        data: {
          leadgenId: data.leadgenId,
          pageId: data.pageId,
          tenantId,
          formId: data.formId || null,
          adId: data.adId || null,
          createdTime: data.createdTime || null,
          payload: data.payload ?? undefined,
          source: data.source,
          status: tenantId ? 'PENDING' : 'NO_TENANT',
        },
      });
      if (!tenantId) {
        this.logger.warn(
          `Facebook webhook: pageId=${data.pageId} uchun agentlik topilmadi. ` +
            `Hodisa saqlandi (leadgenId=${data.leadgenId}) — Page ulangach qayta ishlanadi.`,
        );
      }
      return !!tenantId;
    } catch (e: any) {
      // P2002 — bu hodisa allaqachon navbatda/bajarilgan. Normal holat.
      if (e?.code === 'P2002') return false;
      this.logger.error('Facebook hodisasini navbatga qo\'yib bo\'lmadi: ' + e?.message);
      return false;
    }
  }

  /** Page ID bo'yicha faol agentlikni topadi (indekslangan, @unique ustun). */
  private async findTenantIdByPageId(pageId: string): Promise<string | null> {
    if (!pageId) return null;
    const t = await this.prisma.tenant
      .findUnique({
        where: { facebookPageId: String(pageId).trim() },
        select: { id: true, status: true },
      })
      .catch(() => null);
    if (!t || t.status !== ('ACTIVE' as any)) return null;
    return t.id;
  }

  /** Agentlikning ochilgan (deshifrlangan) Page Access Token'i. */
  private async getPageToken(tenantId: string): Promise<string | null> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const st: any = t?.settings || {};
    if (!st.facebookPageAccessToken) return null;
    return this.encryption.decrypt(st.facebookPageAccessToken) || null;
  }

  // ─────────────────────────────────────────────────────────────────
  // NAVBATNI ISHLASH
  // ─────────────────────────────────────────────────────────────────

  /**
   * Navbatdagi hodisalarni ketma-ket qayta ishlaydi.
   *
   * Bir vaqtda bitta oqim (`draining` bayrog'i) — aks holda bir xil
   * hodisa ikki marta ishlanib, dublikat mijoz paydo bo'lardi.
   */
  async drainQueue(): Promise<{ processed: number; failed: number }> {
    if (this.draining) return { processed: 0, failed: 0 };
    this.draining = true;

    let processed = 0;
    let failed = 0;

    try {
      for (let round = 0; round < 20; round++) {
        const events: any[] = await this.db.facebookLeadEvent.findMany({
          where: {
            status: { in: ['PENDING', 'FAILED'] },
            attempts: { lt: MAX_ATTEMPTS },
            tenantId: { not: null },
          },
          orderBy: { createdAt: 'asc' },
          take: QUEUE_BATCH,
        });
        if (events.length === 0) break;

        for (const ev of events) {
          // Optimistik qulf: statusni PROCESSING ga o'tkazamiz. Boshqa
          // instans shu yozuvni endi olmaydi.
          const claimed = await this.db.facebookLeadEvent.updateMany({
            where: { id: ev.id, status: ev.status },
            data: { status: 'PROCESSING', attempts: { increment: 1 } },
          });
          if (!claimed?.count) continue; // boshqa instans ulgurdi

          try {
            const { client, skipReason } = await this.handleLeadgen(ev);
            await this.db.facebookLeadEvent.update({
              where: { id: ev.id },
              data: {
                status: client === null ? 'SKIPPED' : 'DONE',
                clientId: client?.id || null,
                lastError: client === null ? skipReason || null : null,
                processedAt: new Date(),
              },
            });
            processed++;
          } catch (e: any) {
            failed++;
            const attempts = (ev.attempts || 0) + 1;
            const msg = String(e?.message || e).slice(0, 500);
            await this.db.facebookLeadEvent.update({
              where: { id: ev.id },
              data: {
                status: 'FAILED',
                lastError: msg,
                processedAt: new Date(),
              },
            });
            this.logger.error(
              `Facebook lead ${ev.leadgenId} xato (urinish ${attempts}/${MAX_ATTEMPTS}): ${msg}`,
            );

            // Urinishlar tugadi — adminga xabar beramiz, chunki bu
            // endi avtomatik tuzalmaydi va lead yo'qolib ketishi mumkin.
            if (attempts >= MAX_ATTEMPTS && ev.tenantId) {
              await this.notifyAdmins(
                ev.tenantId,
                '⚠️ Facebook lead qayta ishlanmadi',
                `Lead ID ${ev.leadgenId} — ${msg}. Sozlamalar → Facebook Ads bo'limida ko'ring.`,
                '/settings?tab=facebook',
              ).catch(swallow('bildirishnoma'));
            }
          }
        }
      }
    } finally {
      this.draining = false;
    }

    return { processed, failed };
  }

  /** Har daqiqada navbatni tekshiradi (webhook o'tkazib yuborilgan holatlar uchun). */
  @Cron('*/1 * * * *')
  async queueCron() {
    await this.cronLock.runOnce('fb-lead-queue', 55, async () => {
      const r = await this.drainQueue();
      if (r.processed || r.failed) {
        this.logger.log(`Facebook navbat: ${r.processed} bajarildi, ${r.failed} xato`);
      }
    });
  }

  /** Graph API'dan lead maydonlarini olib, tekis obyektga aylantiradi. */
  private async fetchLeadData(
    leadgenId: string,
    accessToken: string,
  ): Promise<{ fields: Record<string, string>; formName: string; rawFieldData: any[] }> {
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${leadgenId}` +
      `?fields=id,created_time,field_data,form_id,ad_id,campaign_id,campaign_name` +
      `&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const { type, message } = classifyFacebookError(json);
      throw new Error(`Graph API [${type}]: ${message || JSON.stringify(json)}`);
    }
    return this.parseLeadPayload(json);
  }

  /** Xom Graph API javobini (webhook yoki backfill) bir xil ko'rinishga keltiradi. */
  private parseLeadPayload(json: any): {
    fields: Record<string, string>;
    formName: string;
    rawFieldData: any[];
  } {
    const fields: Record<string, string> = {};
    const rawFieldData: any[] = Array.isArray(json?.field_data) ? json.field_data : [];
    for (const f of rawFieldData) {
      // Meta savol matnidan `name` chiqarganda ba'zan oxirida "?" qoldiradi
      // (masalan "ismingiz?"). Buni tozalamasak, "telefon_raqamingiz" yoki
      // "ism" kabi tanish kalitlar bilan HECH QACHON mos kelmaydi.
      const key = String(f?.name || '')
        .toLowerCase()
        .trim()
        .replace(/[?？！!:：]+$/g, '');
      const value = Array.isArray(f?.values) ? f.values.join(', ') : f?.values;
      if (key && value) fields[key] = String(value);
    }
    return { fields, formName: json?.form_name || '', rawFieldData };
  }

  /**
   * Metaning standart maydonlarini bizning schema'ga moslaydi.
   *
   * TUZATILDI: ilgari faqat qattiq belgilangan kalit so'zlar
   * (`phone_number`, `phone`, `telefon`...) bo'yicha qidirilardi. Agar
   * forma "maxsus savol" (custom question) ishlatsa — masalan
   * "Telefon raqamingizni qoldiring" — Meta bu maydonga savol matnidan
   * chiqarilgan BUTUNLAY BOSHQA `name` beradi (masalan
   * `telefon_raqamingizni_qoldiring`) va ro'yxatda topilmagani uchun
   * telefon/email HECH QACHON aniqlanmasdi — lead "SKIPPED" bo'lib,
   * mijoz umuman yaratilmasdi. Bu deyarli BARCHA custom-savolli
   * formalarni buzardi.
   *
   * Endi: avval nomga qarab aniq moslikni qidiramiz (tezroq va aniqroq),
   * topilmasa — barcha maydon qiymatlarini ko'rib chiqib, qiymat
   * o'zi telefon yoki emailga o'xshasa (raqamlar soni yoki @ belgisi
   * bo'yicha), o'shani ishlatamiz. Shu bilan maydon nomi qanday
   * bo'lishidan qat'i nazar, mijoz aloqa ma'lumoti yo'qolmaydi.
   */
  private mapFacebookFields(raw: Record<string, string>) {
    const pick = (...keys: string[]): string | null => {
      for (const k of keys) if (raw[k]) return raw[k];
      return null;
    };

    const PHONE_KEYS = [
      'phone_number', 'phone', 'mobile_phone', 'mobile', 'tel',
      'telefon', 'telefon_raqami', 'telefon_raqamingiz', 'raqam',
      'телефон', 'номер', 'номер_телефона',
    ];
    const EMAIL_KEYS = ['email', 'work_email', 'e_mail', 'pochta', 'почта'];

    const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
    const looksLikePhone = (v: string) => {
      const digits = v.replace(/[^\d]/g, '');
      return digits.length >= 7 && digits.length <= 15;
    };

    let phone = pick(...PHONE_KEYS);
    let email = pick(...EMAIL_KEYS);

    // ── Zaxira: nom bo'yicha topilmasa, qiymat naqshiga qarab qidiramiz ──
    if (!phone || !email) {
      for (const [key, value] of Object.entries(raw)) {
        if (!value) continue;
        if (PHONE_KEYS.includes(key) || EMAIL_KEYS.includes(key)) continue; // allaqachon tekshirilgan
        if (!email && looksLikeEmail(value)) {
          email = value;
          continue;
        }
        if (!phone && looksLikePhone(value)) {
          phone = value;
        }
      }
    }

    let fullName =
      pick(
        'full_name', 'fullname', 'name', 'ism', 'ismingiz', 'ismi',
        "to'liq_ism", 'toliq_ism', 'fio', 'имя', 'фио',
      ) ||
      [pick('first_name'), pick('last_name')].filter(Boolean).join(' ').trim() ||
      null;

    // ── Zaxira: forma "maxsus savol" ishlatgan bo'lsa (masalan
    // "Ismingiz?"), Meta unga tanish ro'yxatda yo'q `name` beradi.
    // Ism har xil matn bo'lishi mumkin (telefon/emaildagidek raqam/@
    // naqshi yo'q), shuning uchun qiymatga emas — maydon KALITIGA
    // qarab qidiramiz: "ism" yoki "name" so'zi bilan boshlanadigan/
    // tugaydigan har qanday maydon.
    if (!fullName) {
      for (const [key, value] of Object.entries(raw)) {
        if (!value) continue;
        if (value === phone || value === email) continue;
        if (PHONE_KEYS.includes(key) || EMAIL_KEYS.includes(key)) continue;
        const parts = key.split('_');
        const looksLikeName = parts.some(
          (p) =>
            p.startsWith('ism') ||
            p.startsWith('name') ||
            p === 'fio' ||
            p === 'имя' ||
            p === 'фио',
        );
        if (looksLikeName) {
          fullName = value;
          break;
        }
      }
    }

    return {
      fullName: fullName || 'Facebook Lead',
      phone,
      email,
      city: pick('city', 'shahar', 'город'),
    };
  }

  /**
   * "Standart bo'lmagan" savollarni ajratib beradi.
   *
   * TUZATILDI: ilgari faqat ism/telefon/email/shahar olinardi, qolgan
   * hamma javob (byudjet, yo'nalish, sana, nechta kishi) TASHLAB
   * YUBORILARDI. Bu sotuv uchun eng qimmatli ma'lumot — agent mijozga
   * qo'ng'iroq qilganda hech narsa bilmasdi.
   */
  private extractExtraAnswers(rawFieldData: any[]): { label: string; value: string }[] {
    const STANDARD = new Set([
      'full_name', 'name', 'first_name', 'last_name',
      'phone_number', 'phone', 'email', 'work_email', 'city',
    ]);
    const out: { label: string; value: string }[] = [];
    for (const f of rawFieldData || []) {
      const key = String(f?.name || '').toLowerCase();
      if (!key || STANDARD.has(key)) continue;
      const value = Array.isArray(f?.values) ? f.values.join(', ') : f?.values;
      if (!value) continue;
      out.push({
        label: String(f?.label || f?.name || key).slice(0, 200),
        value: String(value).slice(0, 500),
      });
    }
    return out;
  }

  /**
   * Bitta navbat yozuvini to'liq qayta ishlaydi.
   * @returns `{ client, skipReason }` — client `null` bo'lsa, `skipReason`
   *   nima uchun o'tkazib yuborilganini tushuntiradi (admin UI'da ko'rinadi).
   */
  private async handleLeadgen(
    ev: any,
  ): Promise<{ client: any | null; skipReason?: string }> {
    const tenantId: string = ev.tenantId;
    const leadgenId: string = ev.leadgenId;

    // Backfill'da to'liq payload allaqachon bor — qayta so'rov shart emas.
    let parsed: { fields: Record<string, string>; formName: string; rawFieldData: any[] };
    if (ev.payload && Array.isArray(ev.payload?.field_data)) {
      parsed = this.parseLeadPayload(ev.payload);
    } else {
      const accessToken = await this.getPageToken(tenantId);
      if (!accessToken) {
        throw new Error("Agentlikda Facebook Page Access Token yo'q (qayta ulang)");
      }
      parsed = await this.fetchLeadData(leadgenId, accessToken);
    }

    const { fields: raw, formName, rawFieldData } = parsed;
    const { fullName, phone, email, city } = this.mapFacebookFields(raw);
    const extraAnswers = this.extractExtraAnswers(rawFieldData);

    if (!phone && !email) {
      // Admin buni "Xato bo'lgan leadlar" bo'limida ko'radi — qaysi
      // maydon nomlari kelgani ko'rsatilsa, forma savollarini nomlash
      // muammosini tezda topish mumkin bo'ladi.
      const fieldNames = Object.keys(raw).join(', ') || '(bo\'sh)';
      const skipReason =
        `Formada telefon yoki email topilmadi. Kelgan maydonlar: ${fieldNames}. ` +
        `Agar mijoz telefon raqamini yozgan bo'lsa, forma savoli nomi ` +
        `tanish ro'yxatda yo'q — dasturchi bilan bog'laning.`;
      this.logger.warn(`Facebook lead ${leadgenId}: ${skipReason}`);
      return { client: null, skipReason };
    }

    const normalizedPhone = normalizePhone(phone);

    // ── Dublikat mijoz tekshiruvi ──
    let existing: any = null;
    if (phone) {
      existing = await this.prisma.client.findFirst({
        where: { tenantId, phone: { in: phoneVariants(phone) } },
      });
    }
    if (!existing && email) {
      existing = await this.prisma.client.findFirst({ where: { tenantId, email } });
    }

    if (existing) {
      const client = await this.handleReturningClient(tenantId, existing, {
        leadgenId,
        formName,
        formId: ev.formId,
        adId: ev.adId,
        extraAnswers,
      });
      return { client };
    }

    // ── Yangi mijoz ──
    let client: any;
    try {
      client = await this.prisma.client.create({
        data: {
          tenantId,
          fullName,
          phone: normalizedPhone || phone || null,
          email: email || null,
          city: city || null,
          source: 'FACEBOOK',
          pipelineStage: 'NEW_LEAD',
          pipelineStageAt: new Date(),
          sourceCampaign: ev.adId || ev.formId || null,
        } as any,
      });
    } catch (e: any) {
      // ── POYGA HOLATI ──
      // `@@unique([tenantId, phone])` sabab: ikki webhook bir vaqtda
      // kelsa ikkalasi ham "mavjud emas" deb topadi, ikkinchisi P2002
      // bilan yiqiladi va ILGARI lead butunlay yo'qolardi.
      // Endi mavjud mijozni topib, "qayta murojaat" oqimiga o'tamiz.
      if (e?.code === 'P2002') {
        const again = await this.prisma.client.findFirst({
          where: {
            tenantId,
            OR: [
              ...(phone ? [{ phone: { in: phoneVariants(phone) } }] : []),
              ...(email ? [{ email }] : []),
            ],
          },
        });
        if (again) {
          const client = await this.handleReturningClient(tenantId, again, {
            leadgenId,
            formName,
            formId: ev.formId,
            adId: ev.adId,
            extraAnswers,
          });
          return { client };
        }
      }
      throw e;
    }

    await this.prisma.clientTimeline
      .create({
        data: {
          clientId: client.id,
          type: 'created',
          title: '📥 Yangi lead — Facebook Ads',
          description: this.buildTimelineDescription(formName, ev.formId, extraAnswers),
          metadata: {
            source: 'FACEBOOK',
            leadgenId,
            formId: ev.formId,
            adId: ev.adId,
            formName,
            // Formadagi BARCHA javoblar — agent qo'ng'iroq oldidan ko'radi
            answers: extraAnswers,
            rawFields: raw,
          },
        },
      })
      .catch(swallow('mijoz tarixi'));

    // Fon amallar — asosiy oqimni bloklamaydi
    this.scoring
      .scoreClient(tenantId, client.id)
      .catch((e: any) => this.logger.error('Facebook scoring error: ' + e?.message));
    this.autoReply
      .triggerRules(tenantId, client.id, 'FACEBOOK')
      .catch((e: any) => this.logger.error('Facebook autoReply error: ' + e?.message));

    // ── TAYINLASH ──
    const assignedAgentId = await this.assignAgent(tenantId, client.id, fullName);

    if (assignedAgentId) {
      await this.prisma.client
        .update({
          where: { id: client.id },
          data: { assignedAgentId, assignedAt: new Date() } as any,
        })
        .catch(swallow('tayinlash vaqti'));

      this.realtime.emitToUser(assignedAgentId, 'lead:new', {
        clientId: client.id,
        source: 'FACEBOOK',
        name: fullName,
        phone: normalizedPhone || phone,
        email,
        answers: extraAnswers,
      });
    } else {
      // Hech kim tayinlanmadi — bu jimgina yo'qolmasligi kerak
      await this.notifyAdmins(
        tenantId,
        '⚠️ Yangi lead tayinlanmadi',
        `${fullName} — Facebook. Faol agent topilmadi yoki hammasi kunlik limitga yetgan.`,
        `/clients/${client.id}`,
      ).catch(swallow('bildirishnoma'));
    }

    this.realtime.emitToTenant(tenantId, 'lead:new', {
      clientId: client.id,
      source: 'FACEBOOK',
    });

    this.logger.log(`Yangi Facebook lead: ${client.id} — ${fullName}`);
    return { client };
  }

  private buildTimelineDescription(
    formName: string,
    formId: string | null,
    extra: { label: string; value: string }[],
  ): string {
    const head = `Forma: ${formName || formId || '—'}`;
    if (!extra.length) return head;
    const body = extra.map((a) => `• ${a.label}: ${a.value}`).join('\n');
    return `${head}\n\n${body}`.slice(0, 5000);
  }

  /** Mavjud mijoz qayta murojaat qilgan holat. */
  private async handleReturningClient(
    tenantId: string,
    existing: any,
    meta: {
      leadgenId: string;
      formName: string;
      formId?: string | null;
      adId?: string | null;
      extraAnswers: { label: string; value: string }[];
    },
  ) {
    await this.prisma.clientTimeline
      .create({
        data: {
          clientId: existing.id,
          type: 'message',
          title: '🔁 Facebook orqali qayta murojaat',
          description: this.buildTimelineDescription(
            meta.formName,
            meta.formId || null,
            meta.extraAnswers,
          ),
          metadata: {
            source: 'FACEBOOK',
            leadgenId: meta.leadgenId,
            formId: meta.formId,
            adId: meta.adId,
            answers: meta.extraAnswers,
            isDuplicate: true,
          },
        },
      })
      .catch(swallow('mijoz tarixi'));

    // "Yo'qotilgan" bosqichda bo'lsa qayta tiklaymiz — bu tayyor sotuv
    if (existing.pipelineStage === 'LOST') {
      await this.prisma.client
        .update({
          where: { id: existing.id },
          data: { pipelineStage: 'NEW_LEAD', pipelineStageAt: new Date() },
        })
        .catch(swallow('yangilash'));
    }

    if (existing.assignedAgentId) {
      await this.notifications
        .create({
          tenantId,
          userId: existing.assignedAgentId,
          type: 'LEAD_NEW',
          title: '🔁 Mijoz qayta murojaat qildi',
          body: `${existing.fullName} — Facebook forma${
            meta.formName ? ': ' + meta.formName : ''
          }`,
          link: `/clients/${existing.id}`,
          metadata: { clientId: existing.id, leadgenId: meta.leadgenId, isReturning: true },
        })
        .catch(swallow('bildirishnoma'));

      this.realtime.emitToUser(existing.assignedAgentId, 'lead:returning', {
        clientId: existing.id,
        fullName: existing.fullName,
        phone: existing.phone,
        source: 'FACEBOOK',
      });
    } else {
      const agentId = await this.assignAgent(tenantId, existing.id, existing.fullName);
      if (agentId) {
        await this.prisma.client
          .update({
            where: { id: existing.id },
            data: { assignedAgentId: agentId, assignedAt: new Date() } as any,
          })
          .catch(swallow('tayinlash'));
      }
      this.realtime.emitToTenant(tenantId, 'lead:returning', {
        clientId: existing.id,
        fullName: existing.fullName,
        source: 'FACEBOOK',
      });
    }

    this.logger.log(`Facebook: qayta murojaat — ${existing.fullName} (${existing.id})`);
    return existing;
  }

  /**
   * Agent tanlash — 3 bosqichli.
   *
   * TUZATILDI: ilgari `tenant.sourceRouting` (Sozlamalardagi "manba
   * bo'yicha yo'naltirish") Facebook leadlariga UMUMAN ta'sir qilmasdi —
   * u faqat `public-leads` modulida o'qilardi. Endi hisobga olinadi.
   */
  private async assignAgent(
    tenantId: string,
    clientId: string,
    clientName: string,
  ): Promise<string | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true, sourceRouting: true },
    });
    const s: any = tenant?.settings || {};
    const routing: any = tenant?.sourceRouting || {};

    // 1) Facebook bo'limidagi aniq agent
    const candidates: (string | null | undefined)[] = [s.facebookAssignAgentId];
    // 2) Manba bo'yicha yo'naltirish
    const routed = routing?.FACEBOOK;
    if (routed && routed !== 'ROUND_ROBIN') candidates.push(routed);

    for (const candidate of candidates) {
      if (!candidate) continue;
      const agent = await this.prisma.user.findFirst({
        where: {
          id: candidate,
          tenantId,
          status: 'ACTIVE' as any,
          isPausedFromAssignment: false,
        },
        select: { id: true },
      });
      if (!agent) continue;

      await this.prisma.client.update({
        where: { id: clientId },
        data: { assignedAgentId: agent.id },
      });
      await this.prisma.clientTimeline
        .create({
          data: {
            clientId,
            userId: agent.id,
            type: 'assigned',
            title: "🎯 Facebook manba bo'yicha tayinlandi",
            metadata: { autoAssigned: true, source: 'FACEBOOK' },
          },
        })
        .catch(swallow('mijoz tarixi'));
      return agent.id;
    }

    // 3) Round-robin
    return this.roundRobin.assignNewLead({
      tenantId,
      clientId,
      clientName,
      source: 'FACEBOOK',
    });
  }

  /** Agentlikning barcha adminlariga bildirishnoma. */
  private async notifyAdmins(
    tenantId: string,
    title: string,
    body: string,
    link: string,
  ) {
    const admins = await this.prisma.user.findMany({
      where: { tenantId, status: 'ACTIVE' as any, role: { in: ['TENANT_ADMIN', 'MANAGER'] as any } },
      select: { id: true },
      take: 10,
    });
    for (const a of admins) {
      await this.notifications
        .create({ tenantId, userId: a.id, type: 'SYSTEM' as any, title, body, link })
        .catch(swallow('bildirishnoma'));
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // BACKFILL — O'TKAZIB YUBORILGAN LEADLARNI TIKLASH
  // ─────────────────────────────────────────────────────────────────

  /**
   * Har soatda Meta'dan o'tkazib yuborilgan leadlarni qidiradi.
   *
   * NEGA MAJBURIY: webhook yo'qolsa (server o'chgan, deploy, 403,
   * timeout) Meta uni QAYTA YUBORMAYDI va lead butunlay yo'qoladi.
   * Mijoz reklamaga pul to'laydi, lead esa hech qayerda yo'q — bozorga
   * chiqayotgan mahsulot uchun bu qabul qilib bo'lmaydi.
   *
   * Oqim:
   *   GET /{page-id}/leadgen_forms
   *   → har bir forma uchun:
   *   GET /{form-id}/leads?filtering=[{time_created > oxirgi_tekshiruv}]
   */
  @Cron('7 * * * *')
  async backfillCron() {
    await this.cronLock.runOnce('fb-lead-backfill', 15 * 60, async () => {
      const tenants = await this.prisma.tenant.findMany({
        where: { facebookPageId: { not: null }, status: 'ACTIVE' as any },
        select: { id: true, name: true, settings: true },
      });
      if (!tenants.length) return;

      this.logger.log(`Facebook backfill: ${tenants.length} ta agentlik tekshirilmoqda`);
      let totalFound = 0;

      for (const t of tenants) {
        try {
          const found = await this.backfillTenant(t.id);
          totalFound += found;
        } catch (e: any) {
          this.logger.warn(`Facebook backfill xato [${t.name}]: ${e?.message}`);
        }
        // Meta limitiga urilmaslik uchun
        await new Promise((r) => setTimeout(r, 800));
      }

      if (totalFound > 0) {
        this.logger.log(`Facebook backfill: ${totalFound} ta o'tkazib yuborilgan lead topildi`);
        await this.drainQueue();
      }
    });
  }

  /** Bitta agentlik uchun backfill. Qaytadi: nechta yangi hodisa qo'shildi. */
  async backfillTenant(tenantId: string): Promise<number> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const s: any = tenant?.settings || {};
    const pageId: string | undefined = s.facebookPageId;
    if (!pageId) return 0;

    const token = await this.getPageToken(tenantId);
    if (!token) return 0;

    // Oxirgi tekshiruvdan beri (birinchi marta — oxirgi 7 kun)
    const since = s.facebookLastBackfillAt
      ? Math.floor(new Date(s.facebookLastBackfillAt).getTime() / 1000)
      : Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000);

    const forms = await this.fetchAllPages(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/leadgen_forms` +
        `?fields=id,name,status&limit=100&access_token=${encodeURIComponent(token)}`,
    );

    let added = 0;
    for (const form of forms) {
      const filtering = encodeURIComponent(
        JSON.stringify([
          { field: 'time_created', operator: 'GREATER_THAN', value: since },
        ]),
      );
      const leads = await this.fetchAllPages(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${form.id}/leads` +
          `?fields=id,created_time,field_data,form_id,ad_id&limit=100` +
          `&filtering=${filtering}&access_token=${encodeURIComponent(token)}`,
      );

      for (const lead of leads) {
        const ok = await this.enqueueLead({
          leadgenId: String(lead.id),
          pageId,
          formId: String(lead.form_id || form.id),
          adId: lead.ad_id ? String(lead.ad_id) : null,
          createdTime: lead.created_time || null,
          // Payload to'liq — ishlov paytida Graph API'ga qayta so'rov ketmaydi
          payload: { ...lead, form_name: form.name },
          source: 'BACKFILL',
        });
        if (ok) added++;
      }
    }

    await this.patchSettings(tenantId, { facebookLastBackfillAt: new Date().toISOString() });

    if (added > 0) {
      this.logger.warn(
        `Facebook backfill [${tenantId}]: ${added} ta lead webhook orqali kelmagan edi — tiklandi`,
      );
    }
    return added;
  }

  /** Graph API sahifalanishini (paging.next) oxirigacha o'qiydi. */
  private async fetchAllPages(startUrl: string, maxPages = 20): Promise<any[]> {
    const out: any[] = [];
    let url: string | null = startUrl;
    let page = 0;

    while (url && page < maxPages) {
      const res = await fetch(url);
      const json: any = await res.json().catch(() => ({}));
      if (json?.error) {
        const { type, message } = classifyFacebookError(json);
        throw new Error(`[${type}] ${message}`);
      }
      if (Array.isArray(json?.data)) out.push(...json.data);
      url = json?.paging?.next || null;
      page++;
    }
    return out;
  }

  /**
   * `tenant.settings` ni XAVFSIZ yangilaydi.
   *
   * TUZATILDI: ilgari har joyda "o'qi → o'zgartir → yoz" qilinardi.
   * Ikki so'rov bir vaqtda kelsa biri ikkinchisining yozganini
   * (masalan Facebook tokenini) YO'Q QILARDI. Endi barcha yozuvlar
   * shu bitta metod orqali va bitta tranzaksiyada boradi.
   */
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

  // ─────────────────────────────────────────────────────────────────
  // TOKEN SALOMATLIGI
  // ─────────────────────────────────────────────────────────────────

  /**
   * Har 6 soatda saqlangan tokenlarni tekshiradi.
   *
   * NEGA: Page Access Token bekor qilinishi mumkin (parol o'zgardi,
   * admin huquqi olindi, Meta xavfsizlik tekshiruvi). Ilgari buni
   * hech kim bilmasdi — leadlar shunchaki kelmay qo'yardi.
   */
  @Cron('0 */6 * * *')
  async tokenHealthCron() {
    await this.cronLock.runOnce('fb-token-health', 10 * 60, async () => {
      const tenants = await this.prisma.tenant.findMany({
        where: { facebookPageId: { not: null }, status: 'ACTIVE' as any },
        select: { id: true, name: true, settings: true },
      });

      for (const t of tenants) {
        const s: any = t.settings || {};
        const token = await this.getPageToken(t.id);
        if (!token) continue;

        let valid = true;
        try {
          const res = await fetch(
            `https://graph.facebook.com/${GRAPH_API_VERSION}/me?access_token=${encodeURIComponent(token)}`,
          );
          const json: any = await res.json().catch(() => ({}));
          if (json?.error) valid = false;
        } catch {
          valid = false;
        }

        if (!valid && !s.facebookTokenInvalidAt) {
          await this.patchSettings(t.id, {
            facebookTokenInvalidAt: new Date().toISOString(),
          });
          await this.notifyAdmins(
            t.id,
            '🔴 Facebook ulanishi uzildi',
            "Facebook token yaroqsiz bo'lib qoldi — yangi leadlar KELMAYAPTI. " +
              "Sozlamalar → Facebook Ads bo'limida qaytadan ulang.",
            '/settings?tab=facebook',
          ).catch(swallow('bildirishnoma'));
          this.logger.error(`Facebook token yaroqsiz [${t.name}] — admin xabardor qilindi`);
        } else if (valid && s.facebookTokenInvalidAt) {
          await this.patchSettings(t.id, { facebookTokenInvalidAt: null });
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // SPEED-TO-LEAD (SLA)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Har 5 daqiqada javobsiz qolgan leadlarni tekshiradi.
   *
   * NEGA: Facebook leadlarida 5 daqiqada javob berish konversiyani
   * bir necha barobar oshiradi. Kechasi kelgan lead ertalabgacha
   * yotib qolsa — pul bekorga sarflangan bo'ladi.
   */
  @Cron('*/5 * * * *')
  async slaCron() {
    await this.cronLock.runOnce('lead-sla', 4 * 60, async () => {
      const deadline = new Date(Date.now() - SLA_MINUTES * 60 * 1000);

      const late: any[] = await this.prisma.client.findMany({
        where: {
          source: 'FACEBOOK' as any,
          pipelineStage: 'NEW_LEAD' as any,
          assignedAt: { lte: deadline, not: null },
          firstResponseAt: null,
          slaBreachedAt: null,
        } as any,
        select: {
          id: true, tenantId: true, fullName: true, assignedAgentId: true, assignedAt: true,
        } as any,
        take: 100,
      });

      for (const c of late) {
        await this.prisma.client
          .update({ where: { id: c.id }, data: { slaBreachedAt: new Date() } as any })
          .catch(swallow('SLA belgisi'));

        // Agentga eslatma
        if (c.assignedAgentId) {
          await this.notifications
            .create({
              tenantId: c.tenantId,
              userId: c.assignedAgentId,
              type: 'LEAD_NEW' as any,
              title: `⏰ ${SLA_MINUTES} daqiqa o'tdi — javob berilmadi`,
              body: `${c.fullName} (Facebook) hali ham kutmoqda.`,
              link: `/clients/${c.id}`,
              metadata: { clientId: c.id, slaBreach: true },
            })
            .catch(swallow('bildirishnoma'));
        }

        // Rahbariyatga eskalatsiya
        await this.notifyAdmins(
          c.tenantId,
          '⏰ Lead javobsiz qoldi',
          `${c.fullName} — Facebook. ${SLA_MINUTES} daqiqada javob berilmadi.`,
          `/clients/${c.id}`,
        ).catch(swallow('bildirishnoma'));

        this.realtime.emitToTenant(c.tenantId, 'lead:sla-breach', {
          clientId: c.id,
          fullName: c.fullName,
        });
      }

      if (late.length) {
        this.logger.warn(`SLA: ${late.length} ta lead ${SLA_MINUTES} daqiqada javobsiz qoldi`);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // OAuth (Facebook Login)
  // ─────────────────────────────────────────────────────────────────

  private signState(payload: Record<string, any>): string {
    const json = JSON.stringify(payload);
    const b64 = Buffer.from(json).toString('base64url');
    const sig = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(b64).digest('base64url');
    return `${b64}.${sig}`;
  }

  private verifyState(state: string | undefined): any | null {
    if (!state) return null;
    const [b64, sig] = state.split('.');
    if (!b64 || !sig) return null;
    const expected = crypto
      .createHmac('sha256', OAUTH_STATE_SECRET)
      .update(b64)
      .digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    try {
      const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
      if (!payload?.tenantId || !payload?.ts) return null;
      if (Date.now() - payload.ts > OAUTH_STATE_TTL_MS) return null;
      return payload;
    } catch {
      return null;
    }
  }

  async getOAuthStartUrl(tenantId: string, userId?: string, origin?: string) {
    const appId = process.env.FACEBOOK_APP_ID;
    const redirectUri = process.env.FACEBOOK_OAUTH_REDIRECT_URI;
    if (!appId || !redirectUri) {
      throw new BadRequestException(
        "Serverda FACEBOOK_APP_ID va FACEBOOK_OAUTH_REDIRECT_URI env sozlanmagan. Administratorga murojaat qiling.",
      );
    }

    const nonce = crypto.randomBytes(16).toString('hex');

    // Qaysi sozlamalar tab'idan ulanish boshlangani ('facebook' | 'instagram').
    // TUZATILDI: ilgari bu umuman kuzatilmasdi va callback HAR DOIM
    // `tab=facebook`ga qaytarardi — Instagram tab'idan "Facebook orqali
    // ulash" bosilsa ham, foydalanuvchi Facebook Ads tab'ida qolib
    // qolardi va Instagram ulanish holatini o'z ko'zi bilan ko'rmasdi.
    const originTab = origin === 'instagram' ? 'instagram' : 'facebook';

    // Nonce foydalanuvchi bo'yicha saqlanadi — bir agentlikda ikki admin
    // bir vaqtda ulasa bir-birining oqimini buzmaydi.
    await this.patchSettings(tenantId, {
      facebookOAuthNonce: {
        value: nonce,
        userId: userId || null,
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      },
    });

    const state = this.signState({ tenantId, userId, nonce, ts: Date.now(), origin: originTab });
    const scope = [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_metadata',
      'pages_manage_posts',
      'leads_retrieval',
      'pages_manage_ads',
      'instagram_basic',
      'instagram_manage_messages',
      'pages_messaging',
      // TUZATILDI: Page Business Manager orqali boshqarilsa va
      // foydalanuvchiga BM ichida ("Full control") huquq berilgan bo'lsa —
      // bu ruxsat bo'lmasa `/me/accounts` bunday Page'larni UMUMAN
      // ko'rsatmaydi (creator bo'lmagan har qanday admin uchun ham).
      'business_management',
    ].join(',');

    const url =
      `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent(scope)}` +
      // MUHIM: rerequest bo'lmasa, Facebook oldin rad etilgan/olib
      // tashlangan ruxsatlarni qayta so'ramaydi — consent oynasi ochilsa
      // ham eski (to'liqsiz) ruxsatlar to'plami qaytaveradi.
      `&auth_type=rerequest` +
      `&response_type=code`;

    return { nonce, url };
  }

  /**
   * FALLBACK: Business Manager orqali Page topish.
   *
   * `/me/accounts` foydalanuvchi Page'da to'g'ridan-to'g'ri admin bo'lgan
   * hollarda ishlaydi. Lekin Page Business Manager orqali boshqarilsa va
   * foydalanuvchiga faqat BM ichida ("Full control") huquq berilgan bo'lsa —
   * u Page'ning o'ziga creator/admin sifatida qo'shilmagan, shuning uchun
   * `/me/accounts` uni ko'rsatmaydi.
   *
   * Bu funksiya foydalanuvchining barcha Business'larini (`/me/businesses`)
   * so'raydi, so'ng har bir Business uchun ham o'zi egalik qiladigan
   * (`owned_pages`), ham mijoz sifatida ulangan (`client_pages`) Page'larni
   * yig'adi — creator bo'lmagan, lekin BM orqali to'liq huquq berilgan
   * HAR QANDAY admin uchun ham ishlaydi.
   */
  private async getPagesViaBusinessManager(
    userToken: string,
  ): Promise<Array<{ id: string; name: string; access_token: string }>> {
    try {
      const bizUrl =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/me/businesses` +
        `?fields=id,name` +
        `&access_token=${encodeURIComponent(userToken)}`;
      const bizRes = await fetch(bizUrl);
      const bizJson: any = await bizRes.json().catch(() => ({}));
      if (!bizRes.ok) {
        this.logger.warn(
          "Facebook OAuth /me/businesses xato (business_management ruxsati yo'qmi?): " +
            JSON.stringify(bizJson),
        );
        return [];
      }

      const businesses: Array<{ id: string; name: string }> = bizJson?.data || [];
      if (businesses.length === 0) return [];

      // id bo'yicha dedupe — bitta Page bir nechta Business orqali
      // (masalan, owned + client) ikki marta qaytishi mumkin.
      const pagesById = new Map<string, { id: string; name: string; access_token: string }>();

      for (const biz of businesses) {
        for (const edge of ['owned_pages', 'client_pages']) {
          try {
            const pUrl =
              `https://graph.facebook.com/${GRAPH_API_VERSION}/${biz.id}/${edge}` +
              `?fields=id,name,access_token` +
              `&access_token=${encodeURIComponent(userToken)}`;
            const pRes = await fetch(pUrl);
            const pJson: any = await pRes.json().catch(() => ({}));
            if (!pRes.ok) {
              this.logger.warn(
                `Business Manager ${edge} so'rovi xato (business=${biz.id}): ` +
                  JSON.stringify(pJson),
              );
              continue;
            }
            const list: Array<{ id: string; name: string; access_token?: string }> =
              pJson?.data || [];
            for (const p of list) {
              // access_token qaytmasa (masalan, cheklangan Task huquqi) —
              // bu Page'ni hozircha ulab bo'lmaydi, ro'yxatga qo'shmaymiz.
              if (p.id && p.access_token) {
                pagesById.set(p.id, {
                  id: p.id,
                  name: p.name,
                  access_token: p.access_token,
                });
              }
            }
          } catch (e: any) {
            this.logger.warn(
              `Business Manager ${edge} so'rovida tarmoq xatosi (business=${biz.id}): ` +
                e.message,
            );
          }
        }
      }

      return Array.from(pagesById.values());
    } catch (e: any) {
      this.logger.warn('Facebook OAuth Business Manager fallback xatosi: ' + e.message);
      return [];
    }
  }

  async handleOAuthCallback(
    code: string | undefined,
    state: string | undefined,
    oauthError?: string,
    cookieNonce?: string,
  ): Promise<string> {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

    // TUZATILDI: ilgari bu yerda `tab=facebook` qattiq yozilgan edi, shuning
    // uchun Instagram tab'idan ulansa ham natija doim Facebook Ads tab'ida
    // ko'rsatilardi. Endi `getOAuthStartUrl`da saqlangan `origin` state
    // ichidan o'qib, foydalanuvchi boshlagan tab'ga aynan qaytariladi.
    const payload = this.verifyState(state);
    const originTab = payload?.origin === 'instagram' ? 'instagram' : 'facebook';
    const redirectBase = `${frontendUrl}/settings?tab=${originTab}`;

    if (oauthError) {
      this.logger.warn(`Facebook OAuth: admin rad etdi yoki xato qaytdi: ${oauthError}`);
      return `${redirectBase}&fb=denied`;
    }

    if (!payload?.tenantId) {
      this.logger.warn("Facebook OAuth: 'state' yaroqsiz yoki muddati o'tgan");
      return `${redirectBase}&fb=error`;
    }
    if (!code) return `${redirectBase}&fb=error`;

    // ── CSRF: bir martalik nonce ──
    {
      const row = await this.prisma.tenant.findUnique({
        where: { id: payload.tenantId },
        select: { settings: true },
      });
      const st: any = row?.settings || {};
      const saved = st.facebookOAuthNonce;

      const baseOk =
        saved &&
        typeof saved.value === 'string' &&
        typeof payload.nonce === 'string' &&
        saved.value === payload.nonce &&
        Date.now() <= Number(saved.expiresAt || 0) &&
        (saved.userId ?? null) === (payload.userId ?? null);

      // ── TUZATILDI: cookie endi MAJBURIY EMAS ──
      //
      // Ilgari `cookieNonce === saved.value` majburiy edi. Lekin frontend
      // (omoncrm.uz) va backend (api.render.com) turli domenda bo'lsa,
      // bu cookie THIRD-PARTY hisoblanadi va Safari (ITP) uni butunlay
      // bloklaydi, Chrome ham bloklash rejimida qabul qilmaydi.
      // Natijada "Facebook orqali ulash" tugmasi HECH QACHON ishlamasdi —
      // har doim fb=error qaytardi.
      //
      // Xavfsizlik yo'qolmaydi: `state` imzolangan + nonce bir martalik +
      // serverda saqlangan + userId ga bog'langan. Cookie bor bo'lsa
      // QO'SHIMCHA tekshiruv sifatida ishlatiladi.
      const cookieOk = !cookieNonce || cookieNonce === saved?.value;
      const nonceOk = baseOk && cookieOk;

      if (saved) {
        await this.patchSettings(payload.tenantId, { facebookOAuthNonce: null }).catch(
          swallow('nonce tozalash'),
        );
      }

      if (!nonceOk) {
        this.logger.warn(
          `Facebook OAuth RAD ETILDI: nonce mos kelmadi yoki allaqachon ishlatilgan (tenant=${payload.tenantId})`,
        );
        return `${redirectBase}&fb=error`;
      }
    }

    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const redirectUri = process.env.FACEBOOK_OAUTH_REDIRECT_URI;
    if (!appId || !appSecret || !redirectUri) {
      this.logger.error('Facebook OAuth: FACEBOOK_APP_ID/SECRET/REDIRECT_URI env sozlanmagan');
      return `${redirectBase}&fb=error`;
    }

    try {
      const tokenUrl =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token` +
        `?client_id=${encodeURIComponent(appId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&code=${encodeURIComponent(code)}`;
      const tokenRes = await fetch(tokenUrl);
      const tokenJson: any = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenJson?.access_token) {
        this.logger.error('Facebook OAuth token xato: ' + JSON.stringify(tokenJson));
        return `${redirectBase}&fb=error`;
      }
      const shortToken: string = tokenJson.access_token;

      const longUrl =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token` +
        `?grant_type=fb_exchange_token` +
        `&client_id=${encodeURIComponent(appId)}` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&fb_exchange_token=${encodeURIComponent(shortToken)}`;
      const longRes = await fetch(longUrl);
      const longJson: any = await longRes.json().catch(() => ({}));

      // TUZATILDI: ilgari bu yerda muvaffaqiyatsizlik jimgina yutilib,
      // qisqa muddatli (1-2 soatlik) tokenga qaytib ketardi. Natijada
      // Page token ham qisqa muddatli bo'lib, ulanish bir necha soatdan
      // keyin "o'zidan-o'zi" uzilib qolardi. Endi bu holat aniq xato va
      // log sifatida ko'rinadi, foydalanuvchi qayta ulanishi kerakligini
      // bilib oladi — sirli tarzda uzilib qolmaydi.
      if (!longRes.ok || !longJson?.access_token) {
        this.logger.error(
          "Facebook OAuth: uzoq muddatli (60 kunlik) tokenga almashtirish MUVAFFAQIYATSIZ. " +
            "App Secret noto'g'ri yoki App hali Live/Review holatida emas bo'lishi mumkin. " +
            JSON.stringify(longJson),
        );
        return `${redirectBase}&fb=token_exchange_failed`;
      }
      const userToken: string = longJson.access_token;

      const pagesUrl =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts` +
        `?fields=id,name,access_token` +
        `&access_token=${encodeURIComponent(userToken)}`;
      const pagesRes = await fetch(pagesUrl);
      const pagesJson: any = await pagesRes.json().catch(() => ({}));
      if (!pagesRes.ok) {
        const { type, message } = classifyFacebookError(pagesJson);
        this.logger.error(
          `Facebook OAuth /me/accounts xato [${type}]: ` + JSON.stringify(pagesJson),
        );
        const fbCode =
          type === 'NO_ADMIN_ACCESS'
            ? 'no_admin_access'
            : type === 'MISSING_PERMISSIONS'
              ? 'missing_permissions'
              : type === 'INVALID_TOKEN'
                ? 'invalid_token'
                : 'error';
        return `${redirectBase}&fb=${fbCode}&fbMsg=${encodeURIComponent(message)}`;
      }

      let pages: Array<{ id: string; name: string; access_token: string }> =
        pagesJson?.data || [];

      // ── FALLBACK: Business Manager orqali Page qidirish ──
      //
      // `/me/accounts` faqat Page'ning o'zida TO'G'RIDAN-TO'G'RI admin
      // sifatida qo'shilgan foydalanuvchilarni qaytaradi. Agar Page
      // Business Manager orqali boshqarilsa va foydalanuvchiga huquq
      // BM ichida ("Full control") berilgan bo'lsa — u Page'ga creator
      // sifatida qo'shilmagan, shuning uchun ro'yxat bo'sh qaytadi.
      //
      // Bu yerda foydalanuvchining barcha Business'larini va ularga
      // tegishli (o'zi egalik qiladigan + mijoz sifatida ulangan)
      // Page'larni so'raymiz — creator bo'lmagan, lekin BM orqali
      // to'liq huquq berilgan HAR QANDAY admin uchun ham ishlaydi.
      if (pages.length === 0) {
        this.logger.warn(
          `Facebook OAuth: /me/accounts bo'sh qaytdi (tenant=${payload.tenantId}), Business Manager orqali qidirilmoqda...`,
        );
        pages = await this.getPagesViaBusinessManager(userToken);
        if (pages.length > 0) {
          this.logger.log(
            `Facebook OAuth: Business Manager orqali ${pages.length} ta Page topildi (tenant=${payload.tenantId})`,
          );
        }
      }

      if (pages.length === 0) {
        this.logger.warn(
          `Facebook OAuth: tenant ${payload.tenantId} uchun boshqariladigan Page topilmadi`,
        );
        return `${redirectBase}&fb=nopages`;
      }

      if (pages.length === 1) {
        const saved: any = await this.saveConfig(payload.tenantId, {
          accessToken: pages[0].access_token,
          pageId: pages[0].id,
          pageName: pages[0].name,
        });
        // Instagram DM ham shu bitta tugma orqali ulanadi
        const { connected: instagramConnected, error: instagramError } =
          await this.connectInstagramForPage(payload.tenantId, pages[0].id, pages[0].access_token);
        const igParam = `&ig=${instagramConnected ? '1' : '0'}` +
          (instagramError ? `&igMsg=${encodeURIComponent(instagramError)}` : '');

        this.logger.log(
          `Facebook OAuth: tenant ${payload.tenantId} uchun Page "${pages[0].name}" ulandi`,
        );

        // Ulangach darhol backfill — oxirgi 7 kunlik leadlar tortiladi
        this.backfillTenant(payload.tenantId)
          .then(() => this.drainQueue())
          .catch(swallow('boshlang\'ich backfill'));

        if (saved?.subscribeWarning) {
          const w = saved.subscribeWarning;
          const fbCode =
            w.errorType === 'NO_ADMIN_ACCESS'
              ? 'connected_no_admin_access'
              : 'connected_subscribe_failed';
          return `${redirectBase}&fb=${fbCode}&fbMsg=${encodeURIComponent(w.message || '')}${igParam}`;
        }
        return `${redirectBase}&fb=success${igParam}`;
      }

      await this.savePendingPages(payload.tenantId, pages);
      return `${redirectBase}&fb=choose`;
    } catch (e: any) {
      this.logger.error('Facebook OAuth callback xatosi: ' + e.message);
      return `${redirectBase}&fb=error`;
    }
  }

  private async savePendingPages(
    tenantId: string,
    pages: Array<{ id: string; name: string; access_token: string }>,
  ) {
    await this.patchSettings(tenantId, {
      facebookOAuthPending: {
        expiresAt: Date.now() + OAUTH_PENDING_TTL_MS,
        pages: pages.map((p) => ({
          id: p.id,
          name: p.name,
          accessTokenEnc: this.encryption.encrypt(p.access_token),
        })),
      },
    });
  }

  async getPendingPages(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const cur: any = tenant?.settings || {};
    const pending = cur.facebookOAuthPending;
    if (!pending || Date.now() > pending.expiresAt) return { pages: [] };
    return { pages: (pending.pages || []).map((p: any) => ({ id: p.id, name: p.name })) };
  }

  async selectPage(tenantId: string, pageId: string) {
    if (!pageId) throw new BadRequestException('pageId majburiy');

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const cur: any = tenant?.settings || {};
    const pending = cur.facebookOAuthPending;
    if (!pending || Date.now() > pending.expiresAt) {
      throw new BadRequestException(
        "Tanlash muddati tugagan. Iltimos, «Facebook orqali ulash» tugmasini qaytadan bosing.",
      );
    }
    const found = (pending.pages || []).find((p: any) => p.id === pageId);
    if (!found) throw new BadRequestException("Tanlangan Page ro'yxatda topilmadi");

    const plainToken = this.encryption.decrypt(found.accessTokenEnc);
    if (!plainToken) {
      throw new BadRequestException("Tokenni ochishda xatolik, qaytadan urinib ko'ring");
    }

    const result = await this.saveConfig(tenantId, {
      accessToken: plainToken,
      pageId: found.id,
      pageName: found.name,
    });

    const { connected: instagramConnected, error: instagramError } =
      await this.connectInstagramForPage(tenantId, found.id, plainToken);

    await this.patchSettings(tenantId, { facebookOAuthPending: null });

    this.backfillTenant(tenantId)
      .then(() => this.drainQueue())
      .catch(swallow("boshlang'ich backfill"));

    return { ...(result as any), instagramConnected, instagramError };
  }

  // ─────────────────────────────────────────────────────────────────
  // TASHXIS VA STATISTIKA
  // ─────────────────────────────────────────────────────────────────

  async verifyAndListForms(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const s: any = tenant?.settings || {};
    const pageId: string | undefined = s.facebookPageId;
    const encToken: string | undefined = s.facebookPageAccessToken;
    if (!pageId || !encToken) {
      return { connected: false, leadgenSubscribed: false, forms: [] };
    }
    const token = this.encryption.decrypt(encToken);
    if (!token) return { connected: false, leadgenSubscribed: false, forms: [] };

    const subscribeResult = await this.subscribeAppToPage(pageId, token);

    let leadgenSubscribed = false;
    let subError: { errorType: FacebookErrorType; message: string } | null = null;
    try {
      const subRes = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/subscribed_apps` +
          `?access_token=${encodeURIComponent(token)}`,
      );
      const subJson: any = await subRes.json().catch(() => ({}));
      if (subJson?.error) {
        const { type, message } = classifyFacebookError(subJson);
        subError = { errorType: type, message };
      }
      const apps = subJson?.data || [];
      leadgenSubscribed = apps.some((a: any) =>
        Array.isArray(a.subscribed_fields)
          ? a.subscribed_fields.includes('leadgen')
          : (a.subscribed_fields?.data || []).some(
              (x: any) => x === 'leadgen' || x?.name === 'leadgen',
            ),
      );
    } catch {
      /* jim */
    }

    let forms: any[] = [];
    let formsError: { errorType: FacebookErrorType; message: string } | null = null;
    try {
      const formRes = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/leadgen_forms` +
          `?fields=id,name,status,leads_count&limit=100&access_token=${encodeURIComponent(token)}`,
      );
      const formJson: any = await formRes.json().catch(() => ({}));
      if (formJson?.error) {
        const { type, message } = classifyFacebookError(formJson);
        formsError = { errorType: type, message };
      }
      forms = (formJson?.data || []).map((f: any) => ({
        id: f.id,
        name: f.name,
        status: f.status,
        leadsCount: f.leads_count ?? null,
      }));
    } catch (e: any) {
      this.logger.warn('Facebook leadgen_forms error: ' + e.message);
    }

    const primaryError =
      (subscribeResult && !subscribeResult.ok
        ? {
            errorType: subscribeResult.errorType || 'UNKNOWN',
            message: subscribeResult.rawMessage || '',
          }
        : null) ||
      subError ||
      formsError ||
      null;

    return {
      connected: true,
      pageId,
      pageName: s.facebookPageName || null,
      leadgenSubscribed,
      forms,
      error: primaryError,
    };
  }

  async diagnose(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const s: any = tenant?.settings || {};
    const pageId: string | undefined = s.facebookPageId;
    const encToken: string | undefined = s.facebookPageAccessToken;

    // Navbat holati — "webhook keldimi, lekin ishlanmadimi" savoliga javob
    const [pending, failed, done] = await Promise.all([
      this.db.facebookLeadEvent.count({ where: { tenantId, status: { in: ['PENDING', 'PROCESSING'] } } }),
      this.db.facebookLeadEvent.count({ where: { tenantId, status: 'FAILED' } }),
      this.db.facebookLeadEvent.count({ where: { tenantId, status: 'DONE' } }),
    ]);
    const queue = { pending, failed, done };

    // Serverdagi sirlar — bularsiz hech narsa ishlamaydi
    const server = {
      appSecretConfigured: !!getAppSecret(),
      verifyToken: getVerifyToken(),
      appIdConfigured: !!process.env.FACEBOOK_APP_ID,
      redirectUriConfigured: !!process.env.FACEBOOK_OAUTH_REDIRECT_URI,
    };

    if (!server.appSecretConfigured) {
      return {
        tokenValid: false,
        queue,
        server,
        recommendation: 'SERVER_ENV',
        message:
          "Serverda FACEBOOK_APP_SECRET sozlanmagan — Meta'dan kelgan HAR BIR webhook rad etiladi. " +
          'Bu holatda hech qanday lead tushmaydi. Platforma administratoriga murojaat qiling.',
      };
    }

    if (!pageId || !encToken) {
      return {
        tokenValid: false,
        queue,
        server,
        pageTasks: [],
        hasRequiredTasks: false,
        missingTasks: [],
        recommendation: 'CONNECT_FIRST',
        message: "Hali hech qanday Page ulanmagan. Avval 'Tezkor ulanish'ni bajaring.",
      };
    }

    const token = this.encryption.decrypt(encToken);
    if (!token) {
      return {
        tokenValid: false,
        queue,
        server,
        recommendation: 'CONNECT_FIRST',
        message: "Saqlangan tokenni ochib bo'lmadi, qaytadan ulang.",
      };
    }

    let tokenValid = true;
    try {
      const meRes = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/me?access_token=${encodeURIComponent(token)}`,
      );
      const meJson: any = await meRes.json().catch(() => ({}));
      if (meJson?.error) tokenValid = false;
    } catch {
      tokenValid = false;
    }

    if (!tokenValid) {
      return {
        tokenValid: false,
        queue,
        server,
        recommendation: 'RECONNECT',
        message: "Token muddati tugagan yoki bekor qilingan. 'Tezkor ulanish'ni qaytadan bosing.",
      };
    }

    const REQUIRED_TASKS = ['MANAGE', 'ADVERTISE'];
    let pageTasks: string[] = [];
    try {
      const pageRes = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}` +
          `?fields=id,name,tasks&access_token=${encodeURIComponent(token)}`,
      );
      const pageJson: any = await pageRes.json().catch(() => ({}));
      if (pageJson?.error) {
        const { type, message } = classifyFacebookError(pageJson);
        return {
          tokenValid: true,
          queue,
          server,
          pageTasks: [],
          hasRequiredTasks: false,
          missingTasks: REQUIRED_TASKS,
          recommendation: type === 'NO_ADMIN_ACCESS' ? 'ASK_ADMIN' : 'SYSTEM_USER',
          errorType: type,
          message,
        };
      }
      pageTasks = pageJson?.tasks || [];
    } catch (e: any) {
      return {
        tokenValid: true,
        queue,
        server,
        pageTasks: [],
        hasRequiredTasks: false,
        missingTasks: REQUIRED_TASKS,
        recommendation: 'SYSTEM_USER',
        message: e.message,
      };
    }

    const hasRequiredTasks = REQUIRED_TASKS.some((t) => pageTasks.includes(t));
    const missingTasks = REQUIRED_TASKS.filter((t) => !pageTasks.includes(t));

    return {
      tokenValid: true,
      queue,
      server,
      pageTasks,
      hasRequiredTasks,
      missingTasks: hasRequiredTasks ? [] : missingTasks,
      recommendation: hasRequiredTasks ? 'OK' : 'ASK_ADMIN',
      message: hasRequiredTasks
        ? 'Hammasi joyida — kerakli huquqlar mavjud.'
        : `Bu akkauntda Page uchun yetarli vazifa yo'q (mavjud: ${pageTasks.join(', ') || "yo'q"}). Page egasidan Business Manager orqali "Manage Page" yoki "Advertise" vazifasini so'rang.`,
    };
  }

  async getStats(tenantId: string) {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const [total, thisMonth, queuePending, queueFailed] = await Promise.all([
      this.prisma.client.count({ where: { tenantId, source: 'FACEBOOK' as any } }),
      this.prisma.client.count({
        where: { tenantId, source: 'FACEBOOK' as any, createdAt: { gte: monthStart } },
      }),
      this.db.facebookLeadEvent.count({
        where: { tenantId, status: { in: ['PENDING', 'PROCESSING'] } },
      }),
      this.db.facebookLeadEvent.count({ where: { tenantId, status: 'FAILED' } }),
    ]);
    return { total, thisMonth, queuePending, queueFailed };
  }

  /** Xato bo'lgan hodisalar — admin UI'da ko'rish uchun. */
  async listFailedEvents(tenantId: string) {
    const items = await this.db.facebookLeadEvent.findMany({
      where: { tenantId, status: { in: ['FAILED', 'SKIPPED', 'NO_TENANT'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, leadgenId: true, formId: true, adId: true,
        status: true, attempts: true, lastError: true, createdAt: true, source: true,
      },
    });
    return { data: items };
  }

  /** Xato hodisalarni qayta navbatga qo'yadi. */
  async retryFailed(tenantId: string, eventId?: string) {
    const where: any = eventId
      ? { id: eventId, tenantId }
      : { tenantId, status: { in: ['FAILED', 'SKIPPED'] } };

    const res = await this.db.facebookLeadEvent.updateMany({
      where,
      data: { status: 'PENDING', attempts: 0, lastError: null },
    });

    setImmediate(() => this.drainQueue().catch(swallow('navbat')));
    return { success: true, requeued: res?.count || 0 };
  }

  /** Qo'lda backfill ishga tushirish (UI tugmasi). */
  async runBackfillNow(tenantId: string) {
    const found = await this.backfillTenant(tenantId);
    const r = await this.drainQueue();
    return {
      success: true,
      found,
      processed: r.processed,
      message:
        found > 0
          ? `${found} ta o'tkazib yuborilgan lead topildi va qayta ishlandi.`
          : "Yangi o'tkazib yuborilgan lead topilmadi — hammasi joyida.",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// CONTROLLER
//
// Webhook manzili butun platforma uchun BITTA:
//   https://sizning-domen.uz/api/v1/facebook-leads/webhook
// Agentlik webhook body ichidagi Page ID orqali topiladi.
// ═══════════════════════════════════════════════════════════════════

@ApiTags('Facebook Lead Ads')
@Controller('facebook-leads')
@UseGuards(JwtAuthGuard)
export class FacebookLeadsController {
  constructor(private svc: FacebookLeadsService) {}

  // ── WEBHOOK ──
  // @SkipThrottle() MAJBURIY: global ThrottlerGuard 100 so'rov/60s beradi.
  // Kampaniya kuchli ketganda yoki Meta retry burst yuborganda webhooklar
  // 429 bilan rad etilardi va leadlar YO'QOLARDI.

  @Get('webhook')
  @Public()
  @SkipThrottle()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    return this.svc.verifyWebhook(mode, token, challenge);
  }

  @Post('webhook')
  @Public()
  @SkipThrottle()
  webhook(@Body() body: any, @Req() req: any) {
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody: Buffer | undefined = req.rawBody;
    return this.svc.processWebhook(body, sig, rawBody);
  }

  // ── SOZLAMALAR ──

  @ApiOperation({ summary: 'Facebook Lead Ads sozlamalarini olish' })
  @ApiBearerAuth('JWT')
  @Get('config')
  getConfig(@CurrentUser() u: any) {
    return this.svc.getConfig(u.tenantId);
  }

  @ApiOperation({ summary: 'Facebook Lead Ads sozlamalarini saqlash (faqat admin)' })
  @ApiBearerAuth('JWT')
  @Post('config')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  saveConfig(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.saveConfig(u.tenantId, body);
  }

  @ApiOperation({ summary: 'Facebook lead statistikasi' })
  @ApiBearerAuth('JWT')
  @Get('stats')
  stats(@CurrentUser() u: any) {
    return this.svc.getStats(u.tenantId);
  }

  @ApiOperation({ summary: 'Page lead formalari + webhook obuna holati' })
  @ApiBearerAuth('JWT')
  @Get('forms')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  listForms(@CurrentUser() u: any) {
    return this.svc.verifyAndListForms(u.tenantId);
  }

  @ApiOperation({ summary: "Tashxis: 'Nega ishlamayapti?' tugmasi" })
  @ApiBearerAuth('JWT')
  @Get('diagnose')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  diagnose(@CurrentUser() u: any) {
    return this.svc.diagnose(u.tenantId);
  }

  // ── NAVBAT / TIKLASH (yangi) ──

  @ApiOperation({ summary: "Qayta ishlanmagan yoki xato bo'lgan leadlar ro'yxati" })
  @ApiBearerAuth('JWT')
  @Get('failed')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  failed(@CurrentUser() u: any) {
    return this.svc.listFailedEvents(u.tenantId);
  }

  @ApiOperation({ summary: 'Xato leadlarni qayta ishlash' })
  @ApiBearerAuth('JWT')
  @Post('retry')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  retryAll(@CurrentUser() u: any) {
    return this.svc.retryFailed(u.tenantId);
  }

  @ApiOperation({ summary: 'Bitta leadni qayta ishlash' })
  @ApiBearerAuth('JWT')
  @Post('retry/:id')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  retryOne(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.retryFailed(u.tenantId, id);
  }

  @ApiOperation({ summary: "Meta'dan o'tkazib yuborilgan leadlarni tortib olish" })
  @ApiBearerAuth('JWT')
  @Post('backfill')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  backfill(@CurrentUser() u: any) {
    return this.svc.runBackfillNow(u.tenantId);
  }

  // ── OAuth ──

  @ApiOperation({ summary: "Facebook Login URL olish" })
  @ApiBearerAuth('JWT')
  @Get('oauth/start-url')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  async getOAuthStartUrl(
    @CurrentUser() u: any,
    @Query('origin') origin: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result: any = await this.svc.getOAuthStartUrl(u.tenantId, u.sub, origin);

    // Cookie QO'SHIMCHA himoya sifatida qo'yiladi. Brauzer uni bloklasa
    // (Safari ITP / third-party cookie) oqim baribir ishlaydi — asosiy
    // himoya imzolangan `state` + serverdagi bir martalik nonce.
    if (result?.nonce) {
      res.cookie('fb_oauth_nonce', result.nonce, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 10 * 60 * 1000,
        path: '/api/v1/facebook-leads',
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
    const cookieNonce = req.cookies?.fb_oauth_nonce;
    res.clearCookie('fb_oauth_nonce', { path: '/api/v1/facebook-leads' });
    const redirectTo = await this.svc.handleOAuthCallback(code, state, error, cookieNonce);
    return res.redirect(redirectTo);
  }

  @ApiOperation({ summary: "Bir nechta Page topilganda tanlash uchun ro'yxat" })
  @ApiBearerAuth('JWT')
  @Get('oauth/pending-pages')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  getPendingPages(@CurrentUser() u: any) {
    return this.svc.getPendingPages(u.tenantId);
  }

  @ApiOperation({ summary: "Ro'yxatdan bitta Page'ni tanlab ulash" })
  @ApiBearerAuth('JWT')
  @Post('oauth/select-page')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  selectPage(@CurrentUser() u: any, @Body('pageId') pageId: string) {
    return this.svc.selectPage(u.tenantId, pageId);
  }
}

@Module({
  imports: [RoundRobinModule, LeadScoringModule, AutoReplyModule, InstagramModule],
  controllers: [FacebookLeadsController],
  providers: [FacebookLeadsService],
  exports: [FacebookLeadsService],
})
export class FacebookLeadsModule {}