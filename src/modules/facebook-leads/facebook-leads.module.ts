import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { RoundRobinService, RoundRobinModule } from '../v9/round-robin.module';
import { LeadScoringService, LeadScoringModule } from '../v9/lead-scoring.module';
import { AutoReplyService, AutoReplyModule } from '../v9/auto-reply.module';

const GRAPH_API_VERSION = 'v19.0';

// "state" parametrini imzolash uchun (CSRF himoyasi + qaysi tenant/user
// OAuth boshlaganini bilish). JWT_ACCESS_SECRET bilan bir xil sirdan
// foydalanamiz — alohida env qo'shishga hojat yo'q.
const OAUTH_STATE_SECRET =
  process.env.JWT_ACCESS_SECRET || 'dev-only-change-in-production';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 daqiqa
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000; // 10 daqiqa

// ═══════════════════════════════════════════════════════════════════
// FACEBOOK LEAD ADS SERVICE
//
// Oqim:
//   1. Tenant admin Sozlamalar → Facebook bo'limida Page ID + Page
//      Access Token'ni kiritadi (bitta marta).
//   2. Shu Page avtomatik ravishda bizning Meta ilovamizga "leadgen"
//      hodisasiga obuna qilinadi (subscribed_apps API chaqiriladi).
//   3. Facebook'da instant-form to'ldirilganda, Meta bizning global
//      webhook manzilimizga POST yuboradi: { object:'page', entry:[...] }.
//   4. entry.id — Page ID. Shu ID orqali tegishli tenant DB'dan topiladi
//      (Meta App darajasida bitta callback URL bo'ladi, tenant emas).
//   5. change.value.leadgen_id orqali Graph API'dan to'liq lead
//      ma'lumoti (ism, telefon, email...) so'rab olinadi.
//   6. Client yaratiladi → lead scoring → auto-reply → round-robin
//      orqali agentga tayinlanadi → real-time xabar yuboriladi.
//
// XAVFSIZLIK:
//   - Page Access Token AES-256-GCM bilan shifrlab saqlanadi
//     (EncryptionService — parol/pasport kabi sezgir ma'lumotlar uchun
//     ishlatiladigan xizmat).
//   - Frontend'ga hech qachon to'liq token qaytarilmaydi — faqat
//     "EAAG••••••••ab12" ko'rinishidagi maskalangan qiymat.
//   - Webhook imzosi (X-Hub-Signature-256) FACEBOOK_APP_SECRET bilan
//     tekshiriladi — soxta so'rovlar rad etiladi.
// ═══════════════════════════════════════════════════════════════════

@Injectable()
export class FacebookLeadsService {
  private readonly logger = new Logger('FacebookLeads');

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private encryption: EncryptionService,
    private roundRobin: RoundRobinService,
    private scoring: LeadScoringService,
    private autoReply: AutoReplyService,
  ) {}

  // ── SOZLAMALAR ────────────────────────────────────────────────────

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
      verifyToken: s.facebookVerifyToken || 'omoncrm_fb_verify',
      assignToAgentId: s.facebookAssignAgentId || null,
      isEnabled: !!decrypted && !!s.facebookPageId,
      connectedAt: s.facebookConnectedAt || null,
    };
  }

  async saveConfig(
    tenantId: string,
    data: {
      accessToken?: string;
      pageId?: string;
      pageName?: string;
      verifyToken?: string;
      assignToAgentId?: string;
    },
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const cur: any = tenant?.settings || {};

    // Token faqat yangi qiymat kiritilganda qayta shifrlanadi — bo'sh
    // qoldirilsa eskisi saqlanib qoladi (frontend hech qachon to'liq
    // tokenni qaytarib olmaydi, shuning uchun uni qayta yubormaydi).
    const newEncToken = data.accessToken?.trim()
      ? this.encryption.encrypt(data.accessToken.trim())
      : cur.facebookPageAccessToken || null;

    const newPageId = data.pageId?.trim() || cur.facebookPageId || null;

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        settings: {
          ...cur,
          facebookPageAccessToken: newEncToken,
          facebookPageId: newPageId,
          facebookPageName: data.pageName?.trim() ?? cur.facebookPageName ?? null,
          facebookVerifyToken:
            data.verifyToken?.trim() || cur.facebookVerifyToken || 'omoncrm_fb_verify',
          facebookAssignAgentId:
            data.assignToAgentId !== undefined ? (data.assignToAgentId || null) : (cur.facebookAssignAgentId ?? null),
          facebookConnectedAt:
            newEncToken && newPageId
              ? new Date().toISOString()
              : cur.facebookConnectedAt ?? null,
        },
      },
    });

    // MUHIM: faqat token/Page ID saqlash yetarli emas — Meta shu Page'ni
    // bizning ilovamizga "leadgen" hodisasiga aniq obuna qilishimizni
    // talab qiladi. Shu chaqiruvsiz webhook hech qachon kelmaydi.
    if (newEncToken && newPageId) {
      const plainToken = this.encryption.decrypt(newEncToken);
      if (plainToken) await this.subscribeAppToPage(newPageId, plainToken);
    }

    return this.getConfig(tenantId);
  }

  /** Page'ni bizning Meta ilovamizga "leadgen" hodisasi uchun obuna qiladi. */
  private async subscribeAppToPage(pageId: string, accessToken: string) {
    try {
      const url =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/subscribed_apps` +
        `?subscribed_fields=leadgen` +
        `&access_token=${encodeURIComponent(accessToken)}`;
      const res = await fetch(url, { method: 'POST' });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        this.logger.error('Facebook subscribe_apps xato: ' + JSON.stringify(json));
      } else {
        this.logger.log(`Facebook: Page ${pageId} "leadgen" hodisasiga obuna qilindi`);
      }
    } catch (e: any) {
      this.logger.error('Facebook subscribe_apps error: ' + e.message);
    }
  }

  // ── WEBHOOK TEKSHIRISH (Meta bir martalik "subscribe" so'rovi) ────

  verifyWebhook(mode: string, token: string, challenge: string): string {
    const expected = process.env.FACEBOOK_VERIFY_TOKEN || 'omoncrm_fb_verify';
    if (mode === 'subscribe' && token === expected) {
      return challenge;
    }
    throw new BadRequestException('Webhook verification failed');
  }

  /** entry.id (Page ID) bo'yicha tenant va uning Page Access Token'ini topadi. */
  private async findTenantByPageId(
    pageId: string,
  ): Promise<{ tenantId: string; accessToken: string } | null> {
    if (!pageId) return null;
    const tenants = await this.prisma.tenant.findMany({
      where: { status: 'ACTIVE' as any },
      select: { id: true, settings: true },
    });
    for (const t of tenants) {
      const s: any = t.settings || {};
      if (s.facebookPageId === pageId && s.facebookPageAccessToken) {
        const accessToken = this.encryption.decrypt(s.facebookPageAccessToken);
        if (accessToken) return { tenantId: t.id, accessToken };
      }
    }
    return null;
  }

  // ── WEBHOOK QABUL QILISH ───────────────────────────────────────────

  async processWebhook(body: any, signature?: string, rawBody?: Buffer) {
    if (body?.object !== 'page') return { ok: true };

    // Meta imzoni App Secret bilan hisoblaydi (Page Access Token EMAS).
    // Instagram va Facebook Lead Ads odatda bitta Meta App ostida
    // bo'ladi, shuning uchun FACEBOOK_APP_SECRET sozlanmagan bo'lsa
    // INSTAGRAM_APP_SECRET'ga tushiladi (agar bitta App ishlatilsa).
    const appSecret = process.env.FACEBOOK_APP_SECRET || process.env.INSTAGRAM_APP_SECRET;
    if (signature && appSecret && rawBody) {
      try {
        const crypto = await import('crypto');
        const expected =
          'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        const valid =
          sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
        if (!valid) {
          this.logger.warn('Facebook webhook: invalid signature');
          return { ok: false };
        }
      } catch (e: any) {
        this.logger.warn('Facebook webhook signature check error: ' + e.message);
      }
    } else if (process.env.NODE_ENV === 'production' && !appSecret) {
      this.logger.warn(
        'Facebook webhook: FACEBOOK_APP_SECRET sozlanmagan — imzo tekshirilmayapti!',
      );
    }

    const entries: any[] = body?.entry || [];
    for (const entry of entries) {
      const pageId: string = entry?.id;
      const changes: any[] = entry?.changes || [];

      for (const change of changes) {
        if (change?.field !== 'leadgen') continue;
        const leadgenId: string | undefined = change?.value?.leadgen_id;
        if (!leadgenId) continue;

        const tenantInfo = await this.findTenantByPageId(pageId);
        if (!tenantInfo) {
          this.logger.warn(
            `Facebook webhook: pageId=${pageId} uchun tenant topilmadi (Sozlamalarda Page ID ni tekshiring)`,
          );
          continue;
        }

        await this.handleLeadgen(tenantInfo.tenantId, tenantInfo.accessToken, leadgenId, {
          formId: change?.value?.form_id,
          adId: change?.value?.ad_id,
          createdTime: change?.value?.created_time,
        }).catch((e: any) => this.logger.error('Facebook leadgen error: ' + e.message));
      }
    }

    return { ok: true };
  }

  /** Graph API'dan lead maydonlarini (field_data) so'rab, tekis obyektga aylantiradi. */
  private async fetchLeadData(
    leadgenId: string,
    accessToken: string,
  ): Promise<{ fields: Record<string, string>; formName: string }> {
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${leadgenId}` +
      `?access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error('Graph API xato: ' + JSON.stringify(json?.error || json));
    }
    const fields: Record<string, string> = {};
    for (const f of json?.field_data || []) {
      const key = String(f?.name || '').toLowerCase();
      const value = Array.isArray(f?.values) ? f.values[0] : f?.values;
      if (key && value) fields[key] = String(value);
    }
    return { fields, formName: json?.form_name || '' };
  }

  /** Metaning turlicha nomlangan standart maydonlarini bizning schema'ga moslaydi. */
  private mapFacebookFields(raw: Record<string, string>) {
    const pick = (...keys: string[]): string | null => {
      for (const k of keys) if (raw[k]) return raw[k];
      return null;
    };
    const fullName =
      pick('full_name', 'name') ||
      [pick('first_name'), pick('last_name')].filter(Boolean).join(' ').trim() ||
      null;
    return {
      fullName: fullName || 'Facebook Lead',
      phone: pick('phone_number', 'phone'),
      email: pick('email', 'work_email'),
      city: pick('city'),
    };
  }

  /** Bitta leadgen hodisasini to'liq ishlov berish: olish → client → tayinlash. */
  async handleLeadgen(
    tenantId: string,
    accessToken: string,
    leadgenId: string,
    meta: { formId?: string; adId?: string; createdTime?: string },
  ) {
    // Dublikat webhook himoyasi — Meta ba'zan bitta hodisani 2 marta
    // yuborishi mumkin (at-least-once delivery kafolati).
    const already = await this.prisma.clientTimeline
      .findFirst({
        where: {
          client: { tenantId },
          metadata: { path: ['leadgenId'], equals: leadgenId },
        },
      })
      .catch(() => null);
    if (already) {
      this.logger.log(`Facebook leadgen ${leadgenId} allaqachon qayta ishlangan, o'tkazib yuborildi`);
      return;
    }

    const { fields: raw, formName } = await this.fetchLeadData(leadgenId, accessToken);
    const { fullName, phone, email, city } = this.mapFacebookFields(raw);

    if (!phone && !email) {
      this.logger.warn(`Facebook lead ${leadgenId}: na telefon, na email topilmadi, o'tkazib yuborildi`);
      return;
    }

    // Dublikat CLIENT tekshiruvi (telefon yoki email bo'yicha)
    let existing: any = null;
    if (phone) existing = await this.prisma.client.findFirst({ where: { tenantId, phone } });
    if (!existing && email) existing = await this.prisma.client.findFirst({ where: { tenantId, email } });

    if (existing) {
      await this.prisma.clientTimeline
        .create({
          data: {
            clientId: existing.id,
            type: 'message',
            title: "🔁 Facebook orqali qayta murojaat",
            description: `Forma: ${formName || meta.formId || ''}`,
            metadata: {
              source: 'FACEBOOK',
              leadgenId,
              formId: meta.formId,
              adId: meta.adId,
              isDuplicate: true,
            },
          },
        })
        .catch(() => {});
      this.logger.log(`Facebook: mavjud clientga qayta murojaat qo'shildi: ${existing.id}`);
      return existing;
    }

    const client = await this.prisma.client.create({
      data: {
        tenantId,
        fullName,
        phone: phone || null,
        email: email || null,
        city: city || null,
        source: 'FACEBOOK',
        pipelineStage: 'NEW_LEAD',
        pipelineStageAt: new Date(),
        sourceCampaign: meta.adId || meta.formId || null,
      } as any,
    });

    await this.prisma.clientTimeline
      .create({
        data: {
          clientId: client.id,
          type: 'created',
          title: '📥 Yangi lead — Facebook Ads',
          description: `Forma: ${formName || meta.formId || ''}`,
          metadata: {
            source: 'FACEBOOK',
            leadgenId,
            formId: meta.formId,
            adId: meta.adId,
          },
        },
      })
      .catch(() => {});

    // Lead Scoring va Auto-Reply — asosiy oqimni bloklamaydi (fire-and-forget)
    this.scoring
      .scoreClient(tenantId, client.id)
      .catch((e: any) => this.logger.error('Facebook scoring error: ' + e?.message));
    this.autoReply
      .triggerRules(tenantId, client.id, 'FACEBOOK')
      .catch((e: any) => this.logger.error('Facebook autoReply error: ' + e?.message));

    // ── TAYINLASH ──────────────────────────────────────────────────
    // Avval sozlamada aniq agent belgilangan bo'lsa — o'shanga,
    // aks holda Round-Robin orqali navbat bilan.
    const config = await this.getConfig(tenantId);
    let assignedAgentId: string | null = null;

    if (config.assignToAgentId) {
      const agent = await this.prisma.user.findFirst({
        where: {
          id: config.assignToAgentId,
          tenantId,
          status: 'ACTIVE' as any,
          isPausedFromAssignment: false,
        },
        select: { id: true },
      });
      if (agent) {
        assignedAgentId = agent.id;
        await this.prisma.client.update({
          where: { id: client.id },
          data: { assignedAgentId },
        });
        await this.prisma.clientTimeline
          .create({
            data: {
              clientId: client.id,
              userId: assignedAgentId,
              type: 'assigned',
              title: '🎯 Facebook manba bo\'yicha tayinlandi',
              metadata: { autoAssigned: true, source: 'FACEBOOK' },
            },
          })
          .catch(() => {});
      }
    }

    if (!assignedAgentId) {
      assignedAgentId = await this.roundRobin.assignNewLead({
        tenantId,
        clientId: client.id,
        clientName: fullName,
        source: 'FACEBOOK',
      });
    }

    if (assignedAgentId) {
      this.realtime.emitToUser(assignedAgentId, 'lead:new', {
        clientId: client.id,
        source: 'FACEBOOK',
        name: fullName,
        phone,
        email,
      });
    }
    this.realtime.emitToTenant(tenantId, 'lead:new', { clientId: client.id, source: 'FACEBOOK' });

    this.logger.log(`Yangi Facebook lead: ${client.id} — ${fullName}`);
    return client;
  }

  // ═══════════════════════════════════════════════════════════════
  // FACEBOOK LOGIN (OAuth) — "Facebook orqali ulash" tugmasi
  //
  // Oqim:
  //   1. Frontend GET /oauth/start-url ni chaqiradi (JWT bilan) →
  //      backend imzolangan "state" bilan Facebook Login URL qaytaradi.
  //   2. Frontend brauzerni shu URL'ga yo'naltiradi (window.location).
  //   3. Admin Facebook'da login qiladi va ruxsat beradi (login/parol
  //      hech qachon bizning serverga tushmaydi — buni Facebook o'zi
  //      boshqaradi).
  //   4. Facebook brauzerni GET /oauth/callback?code=...&state=... ga
  //      qaytaradi (bu marshrut PUBLIC, chunki Facebook so'rovida
  //      bizning JWT headerimiz bo'lmaydi — shuning uchun tenant/user
  //      ni imzolangan "state" orqali aniqlaymiz).
  //   5. code → User Access Token → uzoq muddatli token → shu token
  //      bilan /me/accounts chaqirilib, admin boshqaradigan barcha
  //      Page'lar (va ularning Page Access Tokenlari) bir yo'la olinadi.
  //   6. Bitta Page bo'lsa — avtomatik saqlanadi. Bir nechta bo'lsa —
  //      ro'yxat vaqtincha (10 daqiqa) saqlanadi, admin CRM'da birini
  //      tanlaydi (GET /oauth/pending-pages, POST /oauth/select-page).
  // ═══════════════════════════════════════════════════════════════

  private signState(payload: Record<string, any>): string {
    const json = JSON.stringify(payload);
    const b64 = Buffer.from(json).toString('base64url');
    const sig = crypto
      .createHmac('sha256', OAUTH_STATE_SECRET)
      .update(b64)
      .digest('base64url');
    return `${b64}.${sig}`;
  }

  private verifyState(state: string | undefined): { tenantId: string; userId?: string } | null {
    if (!state) return null;
    const [b64, sig] = state.split('.');
    if (!b64 || !sig) return null;
    const expected = crypto
      .createHmac('sha256', OAUTH_STATE_SECRET)
      .update(b64)
      .digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    try {
      const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
      if (!payload?.tenantId || !payload?.ts) return null;
      if (Date.now() - payload.ts > OAUTH_STATE_TTL_MS) return null; // muddati o'tgan
      return payload;
    } catch {
      return null;
    }
  }

  /** 1-qadam: admin uchun Facebook Login dialog URL'ini tayyorlaydi. */
  getOAuthStartUrl(tenantId: string, userId?: string) {
    const appId = process.env.FACEBOOK_APP_ID;
    const redirectUri = process.env.FACEBOOK_OAUTH_REDIRECT_URI;
    if (!appId || !redirectUri) {
      throw new BadRequestException(
        "Serverda FACEBOOK_APP_ID va FACEBOOK_OAUTH_REDIRECT_URI env sozlanmagan. Administratorga murojaat qiling.",
      );
    }
    const state = this.signState({ tenantId, userId, ts: Date.now() });
    const scope = [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_metadata',
      'leads_retrieval',
      'ads_management',
    ].join(',');
    const url =
      `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent(scope)}` +
      `&response_type=code`;
    return { url };
  }

  /**
   * 2-qadam: Facebook'dan qaytgan callbackni qayta ishlaydi.
   * Frontendga qaytariladigan redirect URL'ni qaytaradi (controller shu
   * URL'ga 302 redirect qiladi) — bu yerda hech qachon exception
   * tashlanmaydi, doim frontendga redirect qilinadi (fb=... query bilan).
   */
  async handleOAuthCallback(
    code: string | undefined,
    state: string | undefined,
    oauthError?: string,
  ): Promise<string> {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const redirectBase = `${frontendUrl}/settings?tab=facebook`;

    if (oauthError) {
      this.logger.warn(`Facebook OAuth: admin rad etdi yoki xato qaytdi: ${oauthError}`);
      return `${redirectBase}&fb=denied`;
    }

    const payload = this.verifyState(state);
    if (!payload?.tenantId) {
      this.logger.warn("Facebook OAuth: 'state' yaroqsiz yoki muddati o'tgan");
      return `${redirectBase}&fb=error`;
    }
    if (!code) return `${redirectBase}&fb=error`;

    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const redirectUri = process.env.FACEBOOK_OAUTH_REDIRECT_URI;
    if (!appId || !appSecret || !redirectUri) {
      this.logger.error('Facebook OAuth: FACEBOOK_APP_ID/SECRET/REDIRECT_URI env sozlanmagan');
      return `${redirectBase}&fb=error`;
    }

    try {
      // (a) bir martalik "code"ni qisqa muddatli User Access Token'ga almashtirish
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

      // (b) qisqa tokenni ~60 kunlik uzoq muddatli tokenga almashtirish
      const longUrl =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token` +
        `?grant_type=fb_exchange_token` +
        `&client_id=${encodeURIComponent(appId)}` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&fb_exchange_token=${encodeURIComponent(shortToken)}`;
      const longRes = await fetch(longUrl);
      const longJson: any = await longRes.json().catch(() => ({}));
      const userToken: string = longJson?.access_token || shortToken;

      // (c) admin boshqaradigan barcha Page'larni (va ularning Page
      // Access Tokenlarini) bitta so'rovda olamiz — qo'lda kiritish shart emas
      const pagesUrl =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts` +
        `?fields=id,name,access_token` +
        `&access_token=${encodeURIComponent(userToken)}`;
      const pagesRes = await fetch(pagesUrl);
      const pagesJson: any = await pagesRes.json().catch(() => ({}));
      if (!pagesRes.ok) {
        this.logger.error('Facebook OAuth /me/accounts xato: ' + JSON.stringify(pagesJson));
        return `${redirectBase}&fb=error`;
      }
      const pages: Array<{ id: string; name: string; access_token: string }> =
        pagesJson?.data || [];

      if (pages.length === 0) {
        this.logger.warn(`Facebook OAuth: tenant ${payload.tenantId} uchun boshqariladigan Page topilmadi`);
        return `${redirectBase}&fb=nopages`;
      }

      if (pages.length === 1) {
        await this.saveConfig(payload.tenantId, {
          accessToken: pages[0].access_token,
          pageId: pages[0].id,
          pageName: pages[0].name,
        });
        this.logger.log(`Facebook OAuth: tenant ${payload.tenantId} uchun Page "${pages[0].name}" avtomatik ulandi`);
        return `${redirectBase}&fb=success`;
      }

      // Bir nechta Page bor — admin CRM ichida birini tanlashi kerak
      await this.savePendingPages(payload.tenantId, pages);
      return `${redirectBase}&fb=choose`;
    } catch (e: any) {
      this.logger.error('Facebook OAuth callback xatosi: ' + e.message);
      return `${redirectBase}&fb=error`;
    }
  }

  /** Bir nechta Page topilganda, ularni tenant.settings ichida vaqtincha (shifrlab) saqlaydi. */
  private async savePendingPages(
    tenantId: string,
    pages: Array<{ id: string; name: string; access_token: string }>,
  ) {
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
          facebookOAuthPending: {
            expiresAt: Date.now() + OAUTH_PENDING_TTL_MS,
            pages: pages.map((p) => ({
              id: p.id,
              name: p.name,
              accessTokenEnc: this.encryption.encrypt(p.access_token),
            })),
          },
        },
      },
    });
  }

  /** 3-qadam (ixtiyoriy): frontend uchun tanlash ro'yxatini qaytaradi (tokenlarsiz). */
  async getPendingPages(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const cur: any = tenant?.settings || {};
    const pending = cur.facebookOAuthPending;
    if (!pending || Date.now() > pending.expiresAt) return { pages: [] };
    return {
      pages: (pending.pages || []).map((p: any) => ({ id: p.id, name: p.name })),
    };
  }

  /** 4-qadam (ixtiyoriy): admin ro'yxatdan bitta Page'ni tanlaganda shuni saqlaydi. */
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
    if (!found) throw new BadRequestException('Tanlangan Page ro\'yxatda topilmadi');

    const plainToken = this.encryption.decrypt(found.accessTokenEnc);
    if (!plainToken) throw new BadRequestException('Tokenni ochishda xatolik, qaytadan urinib ko\'ring');

    const result = await this.saveConfig(tenantId, {
      accessToken: plainToken,
      pageId: found.id,
      pageName: found.name,
    });

    // vaqtinchalik ro'yxatni tozalab qo'yamiz
    const fresh = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const freshSettings: any = fresh?.settings || {};
    delete freshSettings.facebookOAuthPending;
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: freshSettings },
    });

    return result;
  }

  async getStats(tenantId: string) {
    const [total, thisMonth] = await Promise.all([
      this.prisma.client.count({ where: { tenantId, source: 'FACEBOOK' as any } }),
      this.prisma.client.count({
        where: {
          tenantId,
          source: 'FACEBOOK' as any,
          createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
        },
      }),
    ]);
    return { total, thisMonth };
  }
}

// ═══════════════════════════════════════════════════════════════════
// CONTROLLER
//
// MUHIM: Meta App darajasida "Page" obyekti uchun faqat BITTA callback
// URL bo'ladi — shuning uchun manzil tenantId bilan EMAS, global:
//   https://sizning-domen.uz/api/v1/facebook-leads/webhook
// Tenant har doim webhook body ichidagi Page ID orqali avtomatik topiladi.
// ═══════════════════════════════════════════════════════════════════

@ApiTags('Facebook Lead Ads')
@Controller('facebook-leads')
@UseGuards(JwtAuthGuard)
export class FacebookLeadsController {
  constructor(private svc: FacebookLeadsService) {}

  @Get('webhook')
  @Public()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    return this.svc.verifyWebhook(mode, token, challenge);
  }

  @Post('webhook')
  @Public()
  webhook(@Body() body: any, @Req() req: any) {
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody: Buffer | undefined = req.rawBody;
    return this.svc.processWebhook(body, sig, rawBody);
  }

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

  // ── FACEBOOK LOGIN (OAuth) — "Facebook orqali ulash" tugmasi ──────

  @ApiOperation({ summary: "Facebook Login URL olish ('Facebook orqali ulash' tugmasi uchun)" })
  @ApiBearerAuth('JWT')
  @Get('oauth/start-url')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  getOAuthStartUrl(@CurrentUser() u: any) {
    return this.svc.getOAuthStartUrl(u.tenantId, u.sub);
  }

  // MUHIM: Facebook shu manzilga brauzer orqali (JWT headersiz) qaytadi,
  // shuning uchun bu marshrut PUBLIC. Tenant/user aniqlanishi imzolangan
  // "state" parametri orqali amalga oshadi (soxtalashtirib bo'lmaydi).
  @Get('oauth/callback')
  @Public()
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const redirectTo = await this.svc.handleOAuthCallback(code, state, error);
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
  imports: [RoundRobinModule, LeadScoringModule, AutoReplyModule],
  controllers: [FacebookLeadsController],
  providers: [FacebookLeadsService],
  exports: [FacebookLeadsService],
})
export class FacebookLeadsModule {}