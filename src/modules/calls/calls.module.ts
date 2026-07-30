import {
  Module, Injectable, Controller, Get, Post, Body, Query, Param, UseGuards,
  Logger, BadRequestException, NotFoundException, ForbiddenException,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import type { Request } from 'express';
import { Cron } from '@nestjs/schedule';
import {
  checkWebhookSecret,
  sanitizeMediaUrl,
  normalizePhone,
  phoneVariants,
} from '../../common/utils/helpers';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, Public } from '../../common/decorators';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PhoneProvidersModule, PhoneProviderFactory } from '../phone-providers/phone-providers.module';
import type { WebhookEvent } from '../phone-providers/provider.interface';
import { CallDirection, CallStatus } from '../../prisma-types';;
import { FollowUpsModule, FollowUpsService } from '../followups/followups.module';
import { TranscriptionModule, TranscriptionService } from '../transcription/transcription.module';

// E'tiroz turlari — statistikani izchil yig'ish uchun yopiq ro'yxat
// (Claude javobni shu kategoriyalardan birortasiga moslashtiradi)
export const OBJECTION_CATEGORIES: Record<string, string> = {
  price: 'Narx qimmat',
  think_it_over: "O'ylab ko'raman / vaqt kerak",
  trust: 'Ishonchsizlik / birinchi marta',
  timing: 'Sana/muddat mos kelmadi',
  competitor: 'Boshqa agentlikka qaraydi',
  availability: 'Joy/tur mos kelmadi',
  no_response: "Aloqa yo'qoldi / javob bermadi",
  other: 'Boshqa',
};

// v16: Har bir e'tiroz kategoriyasi uchun qisqa, amaliy tavsiya —
// admin panelida "eng ko'p uchragan e'tiroz" statistikasi yonida
// ko'rsatiladi ("bu e'tirozga shunday javob bering" tarzida).
export const OBJECTION_PLAYBOOK: Record<string, string> = {
  price: "Narxni emas, qiymatni gapiring: nima kiradi (mehmonxona darajasi, ovqat, ekskursiya), muqobil/chegirmali variant taklif qiling, bo'lib to'lash imkoniyatini ayting.",
  think_it_over: "Aniq muddat qo'ying (\"joylar tugab qolishi mumkin\"), qaysi savol hali ochiqligini so'rang, 2-3 kundan keyin o'zingiz qo'ng'iroq qiling — mijozga qoldirmang.",
  trust: "Avvalgi mijozlar sharhlarini, litsenziya/guvohnomani ko'rsating, kichik oldindan to'lov bilan boshlashni taklif qiling, jonli video-qo'ng'iroqqa taklif eting.",
  timing: "Muqobil sanalarni tayyor holda taklif qiling, kutish ro'yxatiga qo'shing va joy bo'shashi bilan xabar bering.",
  competitor: "Sizning noyob afzalliklaringizni (narx, xizmat, tezkorlik) aniq solishtirib ko'rsating, shoshilinch aksiya/bonus taklif qiling.",
  availability: "3 ta muqobil variant tayyorlab qo'ying (boshqa mehmonxona, boshqa sana, boshqa yo'nalish), talablarini aniq yozib oling.",
  no_response: "24-48 soatdan keyin boshqa kanal orqali (Telegram/SMS) qisqa eslatma yuboring, savol shaklida yozing (\"hali qiziqasizmi?\").",
  other: "Suhbat matnini qayta o'qib, mijozning asosiy tashvishini aniq belgilang va shaxsiy yondashuv bilan javob bering.",
};

@Injectable()
export class CallsService {
  private readonly logger = new Logger('Calls');

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
    private notifications: NotificationsService,
    private realtime: RealtimeGateway,
    private providerFactory: PhoneProviderFactory,
    private followUps: FollowUpsService,
    private transcription: TranscriptionService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // AI QO'NG'IROQ TAHLILI (Claude orqali) — v15
  // ═══════════════════════════════════════════════════════════════
  // Oqim: qo'ng'iroq matni (transcript) — yo agent qo'lda kiritadi,
  // yo kelajakda transkripsiya provayderi (masalan Whisper/Deepgram)
  // avtomatik to'ldiradi — Claude'ga yuboriladi va u:
  //   1) 2-3 gapli xulosa yozadi (nima so'radi, e'tiroz, keyingi qadam)
  //   2) mijozning kayfiyatini (sentiment) aniqlaydi
  //   3) e'tirozlarni yopiq kategoriyalar bo'yicha ajratadi (statistikaga)
  //   4) eng yaxshi keyingi qadamni (follow-up) taklif qiladi va uni
  //      avtomatik "Eslatmalar" bo'limiga qo'shadi
  //   5) agentning gaplashish sifatini 1-10 ballda baholaydi

  private get anthropicKey() {
    return (process.env.ANTHROPIC_API_KEY || '').trim();
  }
  private get anthropicModel() {
    return (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5').trim();
  }
  isAiConfigured(): boolean {
    return !!this.anthropicKey;
  }

  /** Claude ba'zan JSON ichida xom boshqaruv belgilarini qaytaradi — tozalaymiz */
  private sanitizeJsonControlChars(input: string): string {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (inString) {
        if (escaped) { result += ch; escaped = false; continue; }
        if (ch === '\\') { result += ch; escaped = true; continue; }
        if (ch === '"') { result += ch; inString = false; continue; }
        const code = ch.charCodeAt(0);
        if (ch === '\n') { result += '\\n'; continue; }
        if (ch === '\r') { result += '\\r'; continue; }
        if (ch === '\t') { result += '\\t'; continue; }
        if (code < 0x20) { result += '\\u' + code.toString(16).padStart(4, '0'); continue; }
        result += ch;
      } else {
        if (ch === '"') inString = true;
        result += ch;
      }
    }
    return result;
  }

  /**
   * Qo'ng'iroq matnini (transcript) qo'lda kiritish/tahrirlash.
   * Hozircha CRM'da avtomatik nutqni-matnga o'girish integratsiyasi
   * yo'q (Claude API audio faylni to'g'ridan-to'g'ri qabul qilmaydi),
   * shuning uchun agent yozuvni tinglab matnni shu yerga joylaydi —
   * yoki kelajakda alohida transkripsiya xizmati shu maydonni
   * avtomatik to'ldiradi. Matn kiritilgach, tahlil (`analyze`) darhol
   * shu asosda ishlaydi.
   */
  async setTranscript(tenantId: string, userId: string, callId: string, transcript: string) {
    if (!transcript?.trim()) throw new BadRequestException('Matn bo\'sh bo\'lishi mumkin emas');
    const call = await this.prisma.call.findFirst({ where: { id: callId, tenantId } });
    if (!call) throw new NotFoundException("Qo'ng'iroq topilmadi");
    return this.prisma.call.update({
      where: { id: callId },
      data: { transcript: transcript.trim() },
    });
  }

  /**
   * Qo'ng'iroqni Claude yordamida tahlil qiladi: xulosa, kayfiyat,
   * e'tirozlar, keyingi qadam (avtomatik eslatma yaratiladi) va
   * agentga qisqa feedback.
   */
  async analyzeCall(tenantId: string, userId: string, callId: string) {
    if (!this.anthropicKey) {
      throw new BadRequestException(
        "AI tahlil sozlanmagan. Serverda ANTHROPIC_API_KEY o'rnatilmagan.",
      );
    }

    const call = await this.prisma.call.findFirst({
      where: { id: callId, tenantId },
      include: {
        client: { select: { id: true, fullName: true } },
        agent: { select: { id: true, name: true } },
      },
    });
    if (!call) throw new NotFoundException("Qo'ng'iroq topilmadi");
    if (!call.transcript?.trim()) {
      throw new BadRequestException(
        "Bu qo'ng'iroqda matn (transcript) yo'q. Avval yozuvni tinglab matnini kiriting.",
      );
    }

    const categoriesList = Object.entries(OBJECTION_CATEGORIES)
      .map(([k, v]) => `- "${k}": ${v}`).join('\n');

    const system = `Sen O'zbekistondagi sayohat agentligi uchun ishlaydigan, ko'p yillik tajribaga ega sotuv menejeri va call-markaz auditorisan. Senga agent va mijoz o'rtasidagi telefon suhbati matni beriladi. Sen uni FAQAT matnga asoslanib, hech narsa to'qib chiqarmasdan tahlil qilasan. Har doim FAQAT o'zbek tilida, lotin alifbosida yozasan.

Qattiq qoidalar:
1. Xulosa (summary) 2-3 gapdan oshmasin: mijoz nima haqida so'radi, qanday e'tiroz/shubha bildirdi, keyingi qadam nima bo'lishi kerak.
2. E'tirozlarni FAQAT quyidagi kategoriyalardan tanlab belgila (agar suhbatda e'tiroz bo'lmasa — bo'sh massiv qaytar):
${categoriesList}
3. Har bir e'tiroz uchun mijozning aslidagi gapiga yaqin qisqa "quote" ber (matndan, 15 so'zdan oshmasin).
4. Keyingi qadam (nextAction) — aniq, bajarish mumkin bo'lgan harakat bo'lsin (masalan "3 kundan keyin narx bo'yicha qayta bog'laning va 5% chegirma taklif qiling"), daysUntilDue — necha kundan keyin bajarilishi kerakligi (1-14 oralig'ida butun son).
5. Agent feedback — agentning gaplashish sifatini xolisona baholaysan (1-10 ball): savol berish, tinglash, e'tirozga javob berish, yakunlash ko'nikmalari. Kuchli va yaxshilash kerak bo'lgan tomonlarni QISQA (har biri 1 jumla) ko'rsat. Haqoratli emas, konstruktiv bo'l.
6. Agar suhbat juda qisqa yoki mazmunsiz bo'lsa (masalan javob bermadi), buni halol yoz — o'ylab topma.

Javobni FAQAT quyidagi JSON formatida qaytar — hech qanday izoh, sarlavha yoki markdown belgisi qo'shma:
{
  "summary": "...",
  "sentiment": "positive" | "neutral" | "negative",
  "objections": [{"category": "price", "label": "Narx qimmat", "quote": "..."}],
  "nextAction": {"title": "...", "note": "...", "daysUntilDue": 3},
  "feedback": {"score": 8, "strengths": ["..."], "improvements": ["..."]}
}`;

    const prompt = `Mijoz: ${call.client?.fullName || 'Notanish mijoz'}
Agent: ${call.agent?.name || 'Notanish agent'}
Qo'ng'iroq davomiyligi: ${call.duration || 0} soniya

SUHBAT MATNI:
"""
${call.transcript.trim().slice(0, 12000)}
"""

Yuqoridagi qoidalarga rioya qilib tahlilni JSON formatida ber.`;

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
          max_tokens: 1500,
          temperature: 0.4,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic API xato (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }

      const j: any = await res.json();
      const textBlock = (j?.content || []).find((c: any) => c.type === 'text');
      raw = textBlock?.text || '';

      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('AI javobidan JSON topilmadi');
      let parsed: any;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = JSON.parse(this.sanitizeJsonControlChars(match[0]));
      }

      const objections = Array.isArray(parsed.objections)
        ? parsed.objections
            .filter((o: any) => o?.category && OBJECTION_CATEGORIES[o.category])
            .map((o: any) => ({
              category: o.category,
              label: OBJECTION_CATEGORIES[o.category],
              quote: String(o.quote || '').slice(0, 300),
            }))
        : [];

      const nextAction = parsed.nextAction?.title ? {
        title: String(parsed.nextAction.title).slice(0, 200),
        note: String(parsed.nextAction.note || '').slice(0, 1000),
        daysUntilDue: Math.min(Math.max(Number(parsed.nextAction.daysUntilDue) || 3, 1), 14),
      } : null;

      const feedback = parsed.feedback ? {
        score: Math.min(Math.max(Number(parsed.feedback.score) || 5, 1), 10),
        strengths: Array.isArray(parsed.feedback.strengths) ? parsed.feedback.strengths.slice(0, 5) : [],
        improvements: Array.isArray(parsed.feedback.improvements) ? parsed.feedback.improvements.slice(0, 5) : [],
      } : null;

      const sentiment = ['positive', 'neutral', 'negative'].includes(parsed.sentiment)
        ? parsed.sentiment : 'neutral';

      // Keyingi qadamni avtomatik "Eslatmalar" (FollowUp) bo'limiga qo'shamiz
      let followUpId: string | undefined;
      if (nextAction && call.agentId) {
        try {
          const due = new Date();
          due.setDate(due.getDate() + nextAction.daysUntilDue);
          const fu = await this.followUps.create(tenantId, call.agentId, {
            title: `📞 AI: ${nextAction.title}`,
            note: nextAction.note,
            dueAt: due.toISOString(),
            clientId: call.clientId || undefined,
            agentId: call.agentId,
          });
          followUpId = fu.id;
        } catch (e: any) {
          this.logger.warn(`AI eslatma yaratilmadi: ${e.message}`);
        }
      }

      const updated = await this.prisma.call.update({
        where: { id: callId },
        data: {
          aiSummary: String(parsed.summary || '').slice(0, 2000),
          aiSentiment: sentiment,
          aiObjections: objections,
          aiNextAction: nextAction ? { ...nextAction, followUpId } : null,
          aiFeedback: feedback,
          aiAnalyzedAt: new Date(),
        } as any,
      });

      if (call.agentId) {
        this.realtime.emitToUser(call.agentId, 'call:analyzed', { callId, summary: updated.aiSummary });
      }

      return updated;
    } catch (e: any) {
      this.logger.error(`AI tahlil xato: ${e.message} | raw: ${raw.slice(0, 200)}`);
      throw new BadRequestException(`Qo'ng'iroqni tahlil qilib bo'lmadi: ${e.message}`);
    }
  }

  /**
   * Berilgan davr uchun eng ko'p uchragan e'tirozlar statistikasi
   * (Hisobotlar / Dashboard'da ko'rsatish uchun).
   */
  async getObjectionsStats(tenantId: string, days: number, agentId?: string) {
    const from = new Date(Date.now() - days * 86400000);
    const where: any = { tenantId, aiAnalyzedAt: { gte: from }, NOT: { aiObjections: null } };
    if (agentId) where.agentId = agentId;

    const calls = await this.prisma.call.findMany({
      where,
      select: { aiObjections: true },
    });

    const counts: Record<string, { category: string; label: string; count: number }> = {};
    let analyzedWithObjections = 0;
    for (const c of calls) {
      const list = (c as any).aiObjections as any[] | null;
      if (!Array.isArray(list) || !list.length) continue;
      analyzedWithObjections++;
      for (const o of list) {
        if (!o?.category) continue;
        if (!counts[o.category]) {
          counts[o.category] = { category: o.category, label: OBJECTION_CATEGORIES[o.category] || o.category, count: 0 };
        }
        counts[o.category].count++;
      }
    }

    const totalAnalyzed = calls.length;
    const sorted = Object.values(counts).sort((a, b) => b.count - a.count);
    // v16: eng ko'p uchragan e'tirozga tayyor tavsiya — admin/agent panelida
    // "bu e'tiroz ko'p chiqyapti, shunday qiling" tarzida ko'rsatish uchun
    const topRecommendation = sorted.length
      ? { category: sorted[0].category, label: sorted[0].label, tip: OBJECTION_PLAYBOOK[sorted[0].category] || OBJECTION_PLAYBOOK.other }
      : null;
    return {
      totalAnalyzed,
      callsWithObjections: analyzedWithObjections,
      objections: sorted,
      topRecommendation,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // AVTOMATIK TRANSKRIPSIYA + TAHLIL (v16) — hech kim qo'l tegizmaydi
  // ═══════════════════════════════════════════════════════════════
  // Oqim: yozuv (recordingUrl) paydo bo'ladi → Whisper orqali matnga
  // o'giriladi → transcript saqlanadi → Claude avtomatik tahlil qiladi
  // (analyzeCall). Agent yoki admin HECH QANDAY tugma bosishi shart
  // emas. Bu — foydalanuvchi so'ragan "AI doim eshitib, doim tahlil
  // qilib beradi, hech kim AI'ga savol bera olmaydi" talabining aynan
  // o'zi: bu yerda faqat avtomatik pipeline bor, erkin savol-javob
  // (chat) endpointi umuman mavjud emas.
  @Cron('*/4 * * * *')
  async autoTranscribeAndAnalyze() {
    // v18 TUZATISH: avval bu yerda konfiguratsiya yo'q bo'lsa jimgina
    // `return` qilinardi — hech qanday izsiz, admin panelida qo'ng'iroqlar
    // "AI kutmoqda" holatida ABADIY osilib qolardi, sababini HECH KIM
    // ko'ra olmasdi (faqat server logiga kirish huquqi bo'lganlar bilardi).
    // Endi: konfiguratsiya yo'q bo'lsa ham, navbatdagi qo'ng'iroqlarga
    // ANIQ sabab yoziladi (`Call.aiError`) — bu UI'da ko'rinadi.
    const missingConfig: string[] = [];
    if (!this.transcription.isConfigured()) missingConfig.push("OPENAI_API_KEY (Whisper — audio matnga o'girish uchun)");
    if (!this.anthropicKey) missingConfig.push('ANTHROPIC_API_KEY (Claude — tahlil uchun)');

    // Faqat oxirgi 48 soatda tugagan, yozuvi bor, hali matni yo'q, hali
    // tahlil qilinmagan VA hali xato bilan to'xtamagan (aiError: null),
    // real suhbat bo'lgan (15 soniyadan uzun) qo'ng'iroqlarni olamiz —
    // eskilarini/doimiy xato beradiganlarini abadiy qayta urinmaslik uchun.
    const since = new Date(Date.now() - 48 * 3600 * 1000);
    const candidates = await this.prisma.call.findMany({
      where: {
        status: 'COMPLETED',
        recordingUrl: { not: null },
        transcript: null,
        aiAnalyzedAt: null,
        aiError: null,
        duration: { gte: 15 },
        createdAt: { gte: since },
      },
      select: { id: true, tenantId: true, recordingUrl: true },
      take: 15,
    }).catch(() => [] as any[]);

    if (!candidates.length) return;

    if (missingConfig.length) {
      const msg = `AI tahlil ishlamayapti — serverda quyidagi sozlama(lar) yo'q: ${missingConfig.join(', ')}. Sozlab, so'ng "Qayta urinish" tugmasini bosing.`;
      await this.prisma.call.updateMany({
        where: { id: { in: candidates.map((c: any) => c.id) } },
        data: { aiError: msg, aiErrorAt: new Date() } as any,
      }).catch((e: any) => this.logger.warn(`aiError yozilmadi: ${e.message}`));
      this.logger.warn(msg);
      return;
    }

    for (const c of candidates) {
      await this.processAiPipelineForCall(c.id, c.tenantId, c.recordingUrl!);
    }
  }

  /**
   * Bitta qo'ng'iroq uchun: transkripsiya (Whisper) → Claude tahlili.
   * Har ikkala bosqichda ham xato bo'lsa, ANIQ sababi `Call.aiError`ga
   * yoziladi (server logi emas) — shuning uchun admin/agent buni to'g'ridan
   * -to'g'ri UI'da ko'radi. Muvaffaqiyatli tahlildan so'ng `aiError`
   * tozalanadi. Ham avtomatik cron, ham qo'lda "Qayta urinish" tugmasi
   * (`retryAi`) shu metoddan foydalanadi.
   */
  private async processAiPipelineForCall(callId: string, tenantId: string, recordingUrl: string) {
    try {
      const { text, error } = await this.transcription.transcribeFromUrl(recordingUrl);
      if (!text) {
        if (error) {
          await this.prisma.call.update({
            where: { id: callId },
            data: { aiError: error, aiErrorAt: new Date() } as any,
          }).catch(() => {});
        }
        return;
      }

      await this.prisma.call.update({
        where: { id: callId },
        data: { transcript: text, aiError: null, aiErrorAt: null } as any,
      });

      // Matn tayyor bo'lgach — darhol Claude tahlilini ham ishga tushiramiz
      await this.analyzeCall(tenantId, '', callId).catch(async (e: any) => {
        this.logger.warn(`Avtomatik tahlil xato [${callId}]: ${e?.message}`);
        await this.prisma.call.update({
          where: { id: callId },
          data: { aiError: String(e?.message || "AI tahlilida noma'lum xato").slice(0, 1000), aiErrorAt: new Date() } as any,
        }).catch(() => {});
      });
    } catch (e: any) {
      this.logger.warn(`Avtomatik transkripsiya xato [${callId}]: ${e?.message}`);
      await this.prisma.call.update({
        where: { id: callId },
        data: { aiError: String(e?.message || "Noma'lum xato").slice(0, 1000), aiErrorAt: new Date() } as any,
      }).catch(() => {});
    }
  }

  /**
   * Admin/agent "Qayta urinish" tugmasini bossa chaqiriladi — avvalgi
   * xatoni tozalab, darhol qaytadan urinadi (4 daqiqalik cron kutmasdan).
   */
  async retryAi(tenantId: string, callId: string) {
    const call = await this.prisma.call.findFirst({ where: { id: callId, tenantId } });
    if (!call) throw new NotFoundException("Qo'ng'iroq topilmadi");
    if (!call.recordingUrl) throw new BadRequestException("Bu qo'ng'iroqda audio yozuv yo'q");

    await this.prisma.call.update({
      where: { id: callId },
      data: { aiError: null, aiErrorAt: null } as any,
    });

    if (call.transcript?.trim()) {
      // Matn allaqachon bor — to'g'ridan-to'g'ri tahlilni qayta ishga tushiramiz
      return this.analyzeCall(tenantId, '', callId);
    }
    await this.processAiPipelineForCall(callId, tenantId, call.recordingUrl);
    return this.prisma.call.findFirst({ where: { id: callId, tenantId } });
  }

  async initiate(tenantId: string, userId: string, data: {
    toPhone: string; clientId?: string; bookingId?: string;
  }) {
    if (!data.toPhone) throw new BadRequestException('Telefon raqami kerak');

    const toMasked = this.encryption.maskPhone(data.toPhone);
    const toRaw = this.encryption.encrypt(data.toPhone);

    const agent = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, callbackPhone: true, extension: true },
    });
    if (!agent) throw new NotFoundException('Agent topilmadi');

    let clientName = 'Notanish';
    if (data.clientId) {
      const c = await this.prisma.client.findFirst({
        where: { id: data.clientId, tenantId },
        select: { fullName: true },
      });
      if (c) clientName = (c as any).fullName;
    }

    const call = await this.prisma.call.create({
      data: {
        tenantId, agentId: userId,
        clientId: data.clientId, bookingId: data.bookingId,
        toMasked, toRaw,
        direction: 'OUTBOUND', status: 'QUEUED',
      },
    });

    this.realtime.emitToUser(userId, 'call:queued', {
      callId: call.id, clientName, phone: toMasked, clientId: data.clientId,
    });

    try {
      // 🩹 MUHIM TUZATISH: bu ilgari try/catch'dan TASHQARIDA edi —
      // agar shu yerda (masalan vaqtinchalik DB ulanish uzilishi
      // tufayli) xato chiqsa, `call` yozuvi abadiy "QUEUED" holatida
      // qolib ketardi va foydalanuvchiga xom server xatosi ko'rsatilardi.
      const provider = await this.providerFactory.getProvider(tenantId);

      const result = await provider.initiate({
        toPhone: data.toPhone,
        agentId: userId,
        agentPhone: agent.callbackPhone || undefined,
        agentExtension: agent.extension || undefined,
        agentEmail: agent.email || undefined,
        clientName,
      });

      await this.prisma.call.update({
        where: { id: call.id },
        data: { providerCallId: result.providerCallId, status: 'INITIATED' as any, startedAt: new Date() },
      });

      if (provider.name === 'STUB') {
        // STUB: real qongiroq qilinmaydi - faqat UI simulatsiya
        this.logger.warn(
          'STUB provider ishlatilmoqda. ' +
          'Sozlamalar → Telefon dan OnlinePBX yoki Custom SIP sozlang!'
        );
        this.simulateStubCall(call.id, userId, tenantId);
        // Frontend'ga xabar
        this.realtime.emitToUser(userId, 'call:warning', {
          callId: call.id,
          message: 'Sinov rejimi: real qongiroq emas. Sozlamalar → Telefon dan provayder sozlang.',
        });
      }

      return {
        id: call.id,
        providerCallId: result.providerCallId,
        providerName: provider.name,
        status: result.status,
        clientAction: result.clientAction,
      };
    } catch (e: any) {
      this.logger.error(`Qongiroq xatosi: ${e.message}`);
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'FAILED' as any, notes: `Xato: ${e.message}` },
      });
      this.realtime.emitToUser(userId, 'call:failed', { callId: call.id, error: e.message });
      throw new BadRequestException(`Qongiroq xatosi: ${e.message}`);
    }
  }

  private async simulateStubCall(callId: string, userId: string, tenantId: string) {
    setTimeout(async () => {
      const c = await this.prisma.call.findUnique({ where: { id: callId } });
      if (!c || c.status === 'COMPLETED') return;
      await this.prisma.call.update({ where: { id: callId }, data: { status: 'RINGING' as any } });
      this.realtime.emitToUser(userId, 'call:status', { callId, status: 'RINGING' });
    }, 2000);

    setTimeout(async () => {
      const c = await this.prisma.call.findUnique({ where: { id: callId } });
      if (!c || c.status === 'COMPLETED') return;
      const answered = Math.random() > 0.2;
      if (answered) {
        await this.prisma.call.update({ where: { id: callId }, data: { status: 'IN_PROGRESS' as any } });
        this.realtime.emitToUser(userId, 'call:status', { callId, status: 'IN_PROGRESS' });
      } else {
        await this.prisma.call.update({
          where: { id: callId },
          data: { status: 'NO_ANSWER' as any, endedAt: new Date() },
        });
        this.realtime.emitToUser(userId, 'call:status', { callId, status: 'NO_ANSWER' });
      }
    }, 5500);
  }

  async hangup(tenantId: string, userId: string, callId: string) {
    const call = await this.prisma.call.findFirst({
      where: { id: callId, tenantId, agentId: userId },
    });
    if (!call) throw new NotFoundException('Qongiroq topilmadi');
    if (call.status === 'COMPLETED' || call.status === 'CANCELED') return call;

    const duration = call.startedAt
      ? Math.round((Date.now() - new Date(call.startedAt).getTime()) / 1000)
      : 0;

    const provider = await this.providerFactory.getProvider(tenantId);
    if (provider.hangup && call.providerCallId) {
      try { await provider.hangup(call.providerCallId); } catch {}
    }

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: 'COMPLETED' as any, endedAt: new Date(), duration },
    });

    this.realtime.emitToUser(userId, 'call:status', { callId, status: 'COMPLETED', duration });
    return updated;
  }

  /**
   * Telefoniya ulanishini tekshiradi.
   *
   * OnlinePBX uchun bu FAQAT auth.json'ni chaqiradi — u rasmiy hujjatda
   * tasdiqlangan endpoint, shuning uchun natijaga ishonish mumkin:
   * muvaffaqiyatli bo'lsa domen va API kalit to'g'ri degani.
   */
  async testConnection(tenantId: string) {
    const provider: any = await this.providerFactory.getProvider(tenantId);
    if (!provider) {
      return { success: false, message: 'Telefoniya provayderi sozlanmagan' };
    }
    if (typeof provider.testConnection !== 'function') {
      return {
        success: provider.isConfigured?.() ?? false,
        message: provider.isConfigured?.()
          ? `${provider.name}: sozlangan (bu provayder alohida tekshiruvni qo'llab-quvvatlamaydi)`
          : `${provider.name}: sozlanmagan`,
      };
    }
    return provider.testConnection();
  }


  // ═══════════════════════════════════════════════════════════════
  // KIRUVCHI QO'NG'IROQLAR (v12.3)
  // ═══════════════════════════════════════════════════════════════
  //
  // MUAMMO: webhook faqat MAVJUD qo'ng'iroq yozuvini yangilaydi
  // (providerCallId bo'yicha topadi). Mijoz o'zi qo'ng'iroq qilsa
  // CRM'da hech qanday yozuv paydo bo'lmasdi.
  //
  // YECHIM: OnlinePBX tarixini muntazam o'qib, kiruvchi qo'ng'iroqlarni
  // yaratamiz va telefon bo'yicha mijozni topamiz.
  //
  // mongo_history/search.json — rasmiy hujjatda tasdiqlangan endpoint.

  /** Har 3 daqiqada kiruvchi qo'ng'iroqlarni tortib olamiz */
  @Cron('*/3 * * * *')
  async syncInboundCalls() {
    // Telefoniya sozlamasi ALOHIDA ustunda: tenant.phoneConfig
    // (tenant.settings ichida EMAS — provayder fabrikasi ham shundan o'qiydi)
    const tenants = await this.prisma.tenant.findMany({
      where: { status: 'ACTIVE', phoneProvider: 'ONLINEPBX' as any },
      select: { id: true, phoneConfig: true },
    }).catch(() => [] as any[]);

    for (const t of tenants) {
      const opbx: any = ((t as any).phoneConfig || {}).onlinepbx;
      if (!opbx?.domain || !opbx?.apiKey) continue;

      try {
        await this.pullInboundForTenant(t.id);
      } catch (e: any) {
        this.logger.warn(`Kiruvchi sinx xato [${t.id}]: ${e?.message}`);
      }
    }
  }

  /**
   * Har 5 daqiqada — audio yozuvi hali yo'q, lekin javob berilgan
   * (duration > 0) qo'ng'iroqlarni topib, tasdiqlangan `download=1`
   * mexanizmi orqali qayta urinadi.
   *
   * Bu KIRUVCHI (agar getRecordingUrl birinchi urinishda ulgurmagan
   * bo'lsa — masalan yozuv hali qayta ishlanayotgan bo'lsa) VA
   * CHIQUVCHI (webhook orqali recordingUrl kelmagan yoki umuman
   * webhook ishlamagan) qo'ng'iroqlar uchun ham ishlaydi.
   *
   * Faqat oxirgi 2 soatdagi qo'ng'iroqlarni tekshiradi — eskilarini
   * abadiy qayta urinib, tizimni ortiqcha yuklamaslik uchun.
   */
  @Cron('*/5 * * * *')
  async backfillMissingRecordings() {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: 'ACTIVE', phoneProvider: 'ONLINEPBX' as any },
      select: { id: true, phoneConfig: true },
    }).catch(() => [] as any[]);

    for (const t of tenants) {
      const opbx: any = ((t as any).phoneConfig || {}).onlinepbx;
      if (!opbx?.domain || !opbx?.apiKey) continue;
      // Yozib olish yoqilmagan bo'lsa — urinishning ma'nosi yo'q
      if (opbx?.recordingEnabled === false) continue;

      try {
        const provider: any = await this.providerFactory.getProvider(t.id);
        if (!provider || typeof provider.getRecordingUrl !== 'function') continue;

        const since = new Date(Date.now() - 2 * 3600 * 1000);
        const candidates = await this.prisma.call.findMany({
          where: {
            tenantId: t.id,
            recordingUrl: null,
            duration: { gt: 0 },
            providerCallId: { not: null },
            createdAt: { gte: since },
            status: 'COMPLETED',
          },
          select: { id: true, providerCallId: true },
          take: 50,
        });

        for (const c of candidates) {
          try {
            const url = await provider.getRecordingUrl(c.providerCallId);
            const safe = url ? sanitizeMediaUrl(url) : null;
            if (safe) {
              await this.prisma.call.update({
                where: { id: c.id },
                data: { recordingUrl: safe },
              });
            }
          } catch {
            // Bitta yozuv topilmasa ham davom etamiz
          }
        }
      } catch (e: any) {
        this.logger.warn(`Audio backfill xato [${t.id}]: ${e?.message}`);
      }
    }
  }

  /** Bitta tenant uchun tarixdan kiruvchi qo'ng'iroqlarni oladi */
  async pullInboundForTenant(tenantId: string) {
    const provider: any = await this.providerFactory.getProvider(tenantId);
    if (!provider || typeof provider.fetchHistory !== 'function') return { created: 0 };

    // Oxirgi 30 daqiqa (kesishuv bo'lsa dublikat tekshiruvi ushlaydi)
    const since = new Date(Date.now() - 30 * 60 * 1000);
    const rows: any[] = await provider.fetchHistory(since, 200);
    if (!Array.isArray(rows) || rows.length === 0) return { created: 0 };

    let created = 0;

    for (const r of rows) {
      // ✅ TASDIQLANGAN maydon: `accountcode` (mongo_history/search.json
      // rasmiy hujjati). `r.direction`/`r.call_direction`/`r.type` bu
      // endpointda mavjud emas — faqat qo'shimcha xavfsizlik uchun
      // tekshiriladi (zarar keltirmaydi, lekin ular umuman kelmaydi).
      const dir = String(r.direction || r.call_direction || r.type || '').toLowerCase();
      const isInbound = r.accountcode === 'inbound' || dir.includes('in');
      if (!isInbound) continue;

      const providerCallId = String(r.uuid || r.call_id || r.id || '');
      if (!providerCallId) continue;

      // Allaqachon yozilganmi? (tenant bo'yicha ham cheklangan —
      // turli tenantlar orasida providerCallId to'qnashuvining oldini oladi)
      const exists = await this.prisma.call.findFirst({
        where: { providerCallId, tenantId },
        select: { id: true },
      });
      if (exists) continue;

      // ✅ TASDIQLANGAN maydon: `caller_id_number`
      const fromPhone = normalizePhone(r.caller_id_number || r.from || r.src);
      if (!fromPhone) continue;

      // Mijozni raqam bo'yicha topamiz (barcha formatlarni tekshiramiz)
      const client = await this.prisma.client.findFirst({
        where: { tenantId, phone: { in: phoneVariants(fromPhone) } },
        select: { id: true, fullName: true, assignedAgentId: true },
      });

      // ✅ TASDIQLANGAN maydonlar: `duration`, `user_talk_time`.
      // `billsec` OnlinePBX hujjatida yo'q — faqat orqaga moslik uchun
      // pastroq ustuvorlikda qoldirilgan.
      const durationRaw = Number(r.duration ?? r.user_talk_time ?? r.billsec ?? 0);
      const answered = durationRaw > 0;

      // ⚠️ MUHIM: mongo_history/search.json javobida recording_url
      // KABI MAYDON YO'Q (rasmiy hujjatda tasdiqlangan). Audio faqat
      // alohida `download=1` so'rovi orqali olinadi — pastda,
      // qo'ng'iroq yozuvi yaratilgandan KEYIN, alohida so'rov bilan.
      const call = await this.prisma.call.create({
        data: {
          tenantId,
          clientId: client?.id || null,
          agentId: client?.assignedAgentId || null,
          direction: 'INBOUND' as any,
          status: (answered ? 'COMPLETED' : 'NO_ANSWER') as any,
          providerCallId,
          // Kiruvchida qo'ng'iroq qiluvchi = mijoz, shuning uchun fromMasked.
          // toMasked ham to'ldiriladi — mavjud ro'yxat UI'si shuni o'qiydi.
          fromMasked: fromPhone,
          toMasked: fromPhone,
          duration: Number.isFinite(durationRaw) ? Math.round(durationRaw) : 0,
          startedAt: r.start_stamp ? new Date(Number(r.start_stamp) * 1000) : new Date(),
        } as any,
      }).catch(() => null);

      if (!call) continue;
      created++;

      // Audio yozuvni ALOHIDA so'rov bilan olamiz (tasdiqlangan
      // `download=1` mexanizmi orqali) — javob bo'lgan qo'ng'iroqlar
      // uchungina, va xato bo'lsa asosiy oqim buzilmasin.
      if (answered && typeof provider.getRecordingUrl === 'function') {
        provider.getRecordingUrl(providerCallId)
          .then((url: string | null) => {
            if (!url) return;
            const safe = sanitizeMediaUrl(url);
            if (!safe) return;
            return this.prisma.call.update({
              where: { id: call.id },
              data: { recordingUrl: safe },
            });
          })
          .catch((e: any) => {
            this.logger.warn(`Audio yozuv olinmadi [${providerCallId}]: ${e?.message}`);
          });
      }

      // Agentga darhol ko'rsatamiz — mijoz kartochkasi ochilishi uchun
      const payload = {
        callId: call.id,
        clientId: client?.id || null,
        clientName: client?.fullName || null,
        phone: fromPhone,
        answered,
      };
      if (client?.assignedAgentId) {
        this.realtime.emitToUser(client.assignedAgentId, 'call:inbound', payload);
      } else {
        this.realtime.emitToTenant(tenantId, 'call:inbound', payload);
      }

      // Javobsiz qo'ng'iroq — bu yo'qotilgan mijoz bo'lishi mumkin
      if (!answered && client?.assignedAgentId) {
        await this.notifications.create({
          tenantId,
          userId: client.assignedAgentId,
          type: 'CALL_MISSED',
          title: "📞 Javobsiz qo'ng'iroq",
          body: `${client.fullName || fromPhone} qo'ng'iroq qildi`,
          link: client.id ? `/clients/${client.id}` : '/calls',
          metadata: { callId: call.id, phone: fromPhone },
        }).catch(() => {});
      }
    }

    if (created) this.logger.log(`Kiruvchi qo'ng'iroqlar [${tenantId}]: +${created}`);
    return { created };
  }

  async handleWebhook(body: any) {
    const providerName = this.providerFactory.identifyProvider(body);
    if (!providerName) {
      this.logger.warn(`Webhook: provayder aniqlanmadi - ${JSON.stringify(body).slice(0, 200)}`);
      return { ok: true };
    }

    const tempProvider = providerName === 'ONLINEPBX'
      ? new (await import('../phone-providers/onlinepbx.provider')).OnlinePbxProvider({})
      : new (await import('../phone-providers/twilio.provider')).TwilioProvider({});

    const event = tempProvider.parseWebhook?.(body);
    if (!event) return { ok: true };

    const call = await this.prisma.call.findFirst({
      where: { providerCallId: event.providerCallId },
    });
    if (!call) {
      this.logger.warn(`Webhook: call topilmadi ${event.providerCallId}`);
      return { ok: true };
    }

    const statusMap: Record<string, CallStatus> = {
      queued: 'QUEUED', initiated: 'INITIATED', ringing: 'RINGING',
      in_progress: 'IN_PROGRESS', completed: 'COMPLETED',
      busy: 'BUSY', failed: 'FAILED', no_answer: 'NO_ANSWER', canceled: 'CANCELED',
    };

    const newStatus = statusMap[event.status] || call.status;
    const updateData: any = { status: newStatus };
    if (event.duration && event.duration > 0) updateData.duration = event.duration;
    // XAVFSIZLIK: provayder yuborgan havolani tekshiramiz — faqat http(s).
    // Aks holda `javascript:` sxemali havola agent brauzerida ishga tushardi.
    const safeRecording = sanitizeMediaUrl(event.recordingUrl);
    if (safeRecording) updateData.recordingUrl = safeRecording;
    if (['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY'].includes(newStatus)) {
      updateData.endedAt = new Date();
    }

    await this.prisma.call.update({ where: { id: call.id }, data: updateData });

    this.realtime.emitToUser(call.agentId, 'call:status', {
      callId: call.id, status: newStatus,
      duration: event.duration,
      recordingUrl: safeRecording,
    });

    if (newStatus === 'NO_ANSWER' || newStatus === 'BUSY') {
      this.notifications.create({
        tenantId: call.tenantId,
        userId: call.agentId,
        type: 'CALL_MISSED' as any,
        title: 'Javob berilmadi',
        body: `Raqam: ${call.toMasked}`,
        link: call.clientId ? `/clients/${call.clientId}` : '/calls',
        metadata: { callId: call.id },
      }).catch(() => {});
    }

    return { ok: true };
  }

  /**
   * Мои Звонки uchun ALOHIDA webhook handleri.
   *
   * NEGA ALOHIDA (umumiy handleWebhook() dan farqli): OnlinePBX/Twilio
   * uchun webhook FAQAT allaqachon initiate() orqali yaratilgan
   * (chiquvchi) qo'ng'iroqni yangilaydi — kiruvchilar alohida cron
   * (fetchHistory) orqali tortib olinadi. МоиЗвонки uchun ASOSIY yo'l —
   * `calls.list` cron sinxronizatsiyasi (`pullMoiZvonkiEvents`, pastda),
   * bu endpoint esa QO'SHIMCHA — agar admin moizvonki.ru kabinetida
   * `webhook.subscribe` orqali real-vaqt push'ni ham yoqsa, hodisa
   * tezroq (3 daqiqalik cron kutmasdan) keladi. Ikkalasi ham bir xil
   * `processMoiZvonkiEvent()`ga tushadi, shuning uchun dublikat bo'lmaydi.
   *
   * Oqim:
   *   1) providerCallId bo'yicha mavjud Call qidiriladi (agar CRM'dan
   *      initiate() orqali boshlangan bo'lsa — topiladi, yangilanadi).
   *   2) Topilmasa — bu KIRUVCHI (yoki telefon'dan to'g'ridan-to'g'ri,
   *      CRM orqali emas, terilgan chiquvchi) qo'ng'iroq deb hisoblab,
   *      YANGI Call yozuvi yaratiladi, mijoz raqami bo'yicha
   *      qidiriladi (pullInboundForTenant bilan bir xil mantiq).
   */
  async handleMoiZvonkiWebhook(tenantId: string, body: any) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, phoneProvider: true, phoneConfig: true },
    });
    if (!tenant) throw new NotFoundException('Tenant topilmadi');

    const { MoiZvonkiProvider } = await import('../phone-providers/moizvonki.provider');
    const cfg: any = ((tenant as any).phoneConfig || {}).moizvonki || {};
    const provider = new MoiZvonkiProvider(cfg);

    const event = provider.parseWebhook(body);
    if (!event) {
      this.logger.warn(`MoiZvonki webhook: tanib bo'lmadi — ${JSON.stringify(body).slice(0, 200)}`);
      return { ok: true };
    }
    return this.processMoiZvonkiEvent(tenantId, event as any);
  }

  /**
   * ✅ v19 TUZATISH: asosiy sinxronizatsiya yo'li endi `calls.list`
   * (kursor — `from_id`) orqali ishlaydi. Avvalgi kod `calls.get_crm_event`
   * degan MAVJUD BO'LMAGAN action'ni chaqirardi (rasmiy hujjatda bunday
   * amal yo'q) — shu sabab yozuv (recording) HECH QACHON CRM'ga kelmasdi.
   * `calls.list` javobida `recording` maydoni to'g'ridan-to'g'ri keladi,
   * alohida so'rov shart emas. Har 3 daqiqada barcha MOIZVONKI ulangan
   * tenantlar uchun ishga tushadi — xuddi OnlinePBX uchun
   * `syncInboundCalls` qanday ishlasa, shunday.
   */
  @Cron('*/3 * * * *')
  async pullMoiZvonkiEvents() {
    const tenants = await this.prisma.tenant.findMany({
      where: { phoneProvider: 'MOIZVONKI' as any },
      select: { id: true, phoneConfig: true },
    });
    if (!tenants.length) return;

    const { MoiZvonkiProvider } = await import('../phone-providers/moizvonki.provider');
    let total = 0;

    for (const tenant of tenants) {
      try {
        const phoneConfig: any = (tenant as any).phoneConfig || {};
        const cfg: any = phoneConfig.moizvonki || {};
        const missing: string[] = [];
        if (!cfg.subdomain) missing.push('subdomain');
        if (!cfg.apiKey) missing.push('apiKey');
        if (!cfg.adminEmail) missing.push('adminEmail');
        if (missing.length) {
          this.logger.warn(`MoiZvonki sozlanmagan [tenant ${tenant.id}] — yetishmayotgan maydon(lar): ${missing.join(', ')}. Sozlamalar > Telefoniya sahifasida to'ldiring.`);
          continue;
        }

        const provider = new MoiZvonkiProvider(cfg);
        let fromId = Number(cfg.lastSyncCallId) || 1;
        let fromOffset = 0;
        let maxDbCallId = fromId - 1;
        let pageCount = 0;

        // Bir CRON aylanishida bir nechta sahifani ketma-ket o'qiymiz
        // (agar bir vaqtda ko'p qo'ng'iroq to'planib qolgan bo'lsa),
        // lekin cheksiz aylanmaslik uchun 10 sahifa bilan cheklaymiz.
        while (pageCount < 10) {
          pageCount++;
          const { results, nextOffset, remains } = await provider.fetchRecentCalls(fromId, 100, fromOffset);
          if (!results.length) {
            if (pageCount === 1) {
              this.logger.log(`MoiZvonki [tenant ${tenant.id}]: yangi qo'ng'iroq yo'q (from_id=${fromId})`);
            }
            break;
          }

          for (const raw of results) {
            const event = provider.parseCallRow(raw);
            if (!event) continue;
            if (event.dbCallId && event.dbCallId > maxDbCallId) maxDbCallId = event.dbCallId;

            const result = await this.processMoiZvonkiEvent(tenant.id, event).catch((e) => {
              this.logger.warn(`MoiZvonki hodisa xatosi [${tenant.id}]: ${e.message}`);
              return null;
            });
            if (result?.mode === 'created') total++;
          }

          if (!remains || !nextOffset) break;
          fromOffset = nextOffset;
        }

        // Kursorni bir qadam oldinga suramiz — keyingi safar shu ID'dan
        // KEYIN (o'zi qo'shilmasdan) davom etamiz.
        if (maxDbCallId >= fromId) {
          const newCfg = { ...phoneConfig, moizvonki: { ...cfg, lastSyncCallId: maxDbCallId + 1 } };
          await this.prisma.tenant.update({
            where: { id: tenant.id },
            data: { phoneConfig: newCfg } as any,
          }).catch((e: any) => {
            this.logger.warn(`MoiZvonki kursor saqlanmadi [${tenant.id}]: ${e.message}`);
          });
        }
      } catch (e: any) {
        this.logger.warn(`MoiZvonki sinxronizatsiya xatosi [${tenant.id}]: ${e.message}`);
      }
    }

    if (total) this.logger.log(`Мои Звонки: +${total} yangi qo'ng'iroq`);
  }

  /**
   * Bitta MoiZvonki hodisasini (webhook orqali kelgan yoki
   * `calls.list` orqali sinxronlashtirilgan — ikkalasi ham
   * bir xil unifikatsiya qilingan shaklda keladi) CRM'ga yozadi.
   *
   * Oqim:
   *   1) providerCallId bo'yicha mavjud Call qidiriladi (agar CRM'dan
   *      initiate() orqali boshlangan bo'lsa — topiladi, yangilanadi).
   *   2) Topilmasa — bu YANGI (odatda kiruvchi) qo'ng'iroq deb
   *      hisoblab, YANGI Call yozuvi yaratiladi, mijoz raqami
   *      bo'yicha qidiriladi (pullInboundForTenant bilan bir xil mantiq).
   */
  private async processMoiZvonkiEvent(
    tenantId: string,
    event: WebhookEvent & {
      direction?: 'INBOUND' | 'OUTBOUND';
      fromPhone?: string;
      toPhone?: string;
      employeeEmail?: string;
    },
  ) {
    const statusMap: Record<string, CallStatus> = {
      queued: 'QUEUED', initiated: 'INITIATED', ringing: 'RINGING',
      in_progress: 'IN_PROGRESS', completed: 'COMPLETED',
      busy: 'BUSY', failed: 'FAILED', no_answer: 'NO_ANSWER', canceled: 'CANCELED',
    };
    const newStatus = statusMap[event.status] || 'COMPLETED';
    const safeRecording = sanitizeMediaUrl(event.recordingUrl);

    // 1) Avval CRM orqali BOSHLANGAN (initiate()) qo'ng'iroqni qidiramiz
    const existing = await this.prisma.call.findFirst({
      where: { providerCallId: event.providerCallId, tenantId },
    });

    if (existing) {
      // Allaqachon to'liq qayta ishlangan hodisani qayta yangilamaymiz
      // (calls.list bir xil qatorni qayta qaytarishi mumkin, masalan kursor to'liq ilgarilamasa)
      if (existing.status === 'COMPLETED' && existing.recordingUrl) {
        return { ok: true, callId: existing.id, mode: 'skipped' as const };
      }

      const updateData: any = { status: newStatus };
      if (event.duration && event.duration > 0) updateData.duration = event.duration;
      if (safeRecording) updateData.recordingUrl = safeRecording;
      if (['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY'].includes(newStatus)) {
        updateData.endedAt = new Date();
      }
      // v20: agar bu qo'ng'iroq hali agentga bog'lanmagan bo'lsa (masalan
      // initiate() vaqtida agent noaniq bo'lgan), lekin endi MoiZvonki
      // aniq xodim email'ini yuborgan bo'lsa — to'g'irlaymiz.
      if (!existing.agentId && event.employeeEmail) {
        const byEmail = await this.prisma.user.findFirst({
          where: { tenantId, email: { equals: event.employeeEmail.trim(), mode: 'insensitive' } },
          select: { id: true },
        });
        if (byEmail) updateData.agentId = byEmail.id;
      }
      await this.prisma.call.update({ where: { id: existing.id }, data: updateData });

      if (existing.agentId) {
        this.realtime.emitToUser(existing.agentId, 'call:status', {
          callId: existing.id, status: newStatus, duration: event.duration, recordingUrl: safeRecording,
        });
      }
      return { ok: true, callId: existing.id, mode: 'updated' as const };
    }

    // 2) Topilmasa — bu YANGI (odatda kiruvchi) qo'ng'iroq
    const fromPhone = normalizePhone(event.fromPhone || event.toPhone || '');
    if (!fromPhone) {
      this.logger.warn(`MoiZvonki: telefon raqami topilmadi — ${JSON.stringify(event.raw).slice(0, 200)}`);
      return { ok: true, mode: 'skipped' as const };
    }

    const client = await this.prisma.client.findFirst({
      where: { tenantId, phone: { in: phoneVariants(fromPhone) } },
      select: { id: true, fullName: true, assignedAgentId: true },
    });

    // Qaysi agent gaplashgani — xodim email'i orqali (bizning User.email bilan mos)
    let agentId: string | null = client?.assignedAgentId || null;
    if (event.employeeEmail) {
      // v20 FIX: avval bu solishtiruv katta-kichik harfga SEZGIR edi
      // (Prisma default) — MoiZvonki'dan kelgan login/email CRM'dagi bilan
      // harflar registri bo'yicha farq qilsa (masalan "Agent@Mail.com" vs
      // "agent@mail.com"), moslik doim TOPILMASDI va qo'ng'iroq JIMGINA
      // mijozning standart agentiga (ko'pincha ADMIN) yozilib qolardi —
      // aynan shu "men gaplashsam, admin gaplashdi deb yozadi" xatosi.
      const byEmail = await this.prisma.user.findFirst({
        where: { tenantId, email: { equals: event.employeeEmail.trim(), mode: 'insensitive' } },
        select: { id: true },
      });
      if (byEmail) {
        agentId = byEmail.id;
      } else {
        // v20 FIX: MoiZvonki ANIQ kim gaplashganini aytgan (`user_account`),
        // lekin bu CRM'dagi hech qanday foydalanuvchi email'iga mos
        // kelmadi — bunday holda ilgari JIMGINA mijozning standart
        // agentiga (noto'g'ri!) yozib qo'yilardi. Endi: bunday qo'ng'iroq
        // ANIQ SABABI bilan ogohlantiriladi va "Agentsiz" (agentId=null)
        // qoldiriladi — noto'g'ri odamga yozib qo'yishdan ko'ra, ochiq
        // "aniqlanmadi" holati ancha yaxshi va tuzatish oson.
        this.logger.warn(
          `MoiZvonki: xodim email topilmadi — MoiZvonki'dan "${event.employeeEmail}" keldi, ` +
          `lekin CRM'da bunday email'li foydalanuvchi yo'q. Sozlamalar > Telefoniya > ` +
          `"employeeEmailMap" orqali "${event.employeeEmail}" ni to'g'ri CRM xodimiga bog'lang. ` +
          `Hozircha bu qo'ng'iroq "Agentsiz" sifatida saqlanadi (mijozning standart agentiga emas).`,
        );
        agentId = null;
      }
    }

    const direction = event.direction || 'INBOUND';
    const answered = (event.duration || 0) > 0 || newStatus === 'COMPLETED';

    const call = await this.prisma.call.create({
      data: {
        tenantId,
        clientId: client?.id || null,
        agentId,
        direction: direction as any,
        status: (answered ? 'COMPLETED' : newStatus) as any,
        providerCallId: event.providerCallId,
        fromMasked: fromPhone,
        toMasked: fromPhone,
        duration: event.duration || 0,
        recordingUrl: safeRecording || null,
        startedAt: new Date(),
        endedAt: new Date(),
      } as any,
    });

    const payload = {
      callId: call.id, clientId: client?.id || null, clientName: client?.fullName || null,
      phone: fromPhone, answered, recordingUrl: safeRecording,
    };
    if (agentId) {
      this.realtime.emitToUser(agentId, 'call:inbound', payload);
    } else {
      this.realtime.emitToTenant(tenantId, 'call:inbound', payload);
    }

    if (!answered && agentId) {
      await this.notifications.create({
        tenantId, userId: agentId, type: 'CALL_MISSED' as any,
        title: "📞 Javobsiz qo'ng'iroq (Мои Звонки)",
        body: `${client?.fullName || fromPhone} qo'ng'iroq qildi`,
        link: client?.id ? `/clients/${client.id}` : '/calls',
        metadata: { callId: call.id, phone: fromPhone },
      }).catch(() => {});
    }

    return { ok: true, callId: call.id, mode: 'created' as const };
  }

  async getActive(userId: string) {
    return this.prisma.call.findFirst({
      where: {
        agentId: userId,
        status: { in: ['QUEUED', 'INITIATED', 'RINGING', 'IN_PROGRESS'] as CallStatus[] },
      },
      include: { client: { select: { id: true, fullName: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getStats(tenantId: string, userId: string, role: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const where: any = { tenantId, createdAt: { gte: today } };
    if (role === 'AGENT') where.agentId = userId;

    const [total, answered, missed, durSum] = await Promise.all([
      this.prisma.call.count({ where }),
      this.prisma.call.count({ where: { ...where, status: 'COMPLETED' } }),
      this.prisma.call.count({ where: { ...where, status: { in: ['NO_ANSWER', 'BUSY', 'FAILED'] as CallStatus[] } } }),
      this.prisma.call.aggregate({ where, _sum: { duration: true } }),
    ]);

    const totalDuration = durSum._sum.duration || 0;
    return {
      total, completed: answered, answered, missed, noAnswer: missed,
      totalDuration,
      avgDuration: total > 0 ? Math.round(totalDuration / total) : 0,
      totalMinutes: Math.round(totalDuration / 60),
      answerRate: total > 0 ? Math.round((answered / total) * 100) : 0,
    };
  }

  async addNote(tenantId: string, userId: string, callId: string, notes: string) {
    const call = await this.prisma.call.findFirst({ where: { id: callId, tenantId } });
    if (!call) throw new NotFoundException();
    if (call.agentId !== userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user || !['TENANT_ADMIN', 'MANAGER'].includes(user.role)) throw new ForbiddenException();
    }
    return this.prisma.call.update({ where: { id: callId }, data: { notes } });
  }

  async list(tenantId: string, userId: string, role: string, params: any) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.agentId = userId;
    // v14.2: admin/manager — Hisobotlar → Qo'ng'iroqlar bo'limidan
    // muayyan agentning qo'ng'iroqlarini (yozuvlari bilan) ko'rish uchun
    else if (params.agentId) where.agentId = params.agentId;
    if (params.clientId) where.clientId = params.clientId;
    if (params.status) where.status = params.status;
    if (params.direction) where.direction = params.direction;
    if (params.from || params.to) {
      where.createdAt = {};
      if (params.from) where.createdAt.gte = new Date(params.from);
      if (params.to) where.createdAt.lte = new Date(params.to);
    }

    const limit = Number(params.limit) || 50;
    const skip = ((Number(params.page) || 1) - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.call.findMany({
        where,
        include: {
          agent: { select: { id: true, name: true } },
          client: { select: { id: true, fullName: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.call.count({ where }),
    ]);

    return { data, total, page: Number(params.page) || 1, limit };
  }

  async logManual(tenantId: string, userId: string, data: any) {
    return this.prisma.call.create({
      data: {
        tenantId, agentId: userId,
        clientId: data.clientId, bookingId: data.bookingId,
        direction: (data.direction as CallDirection) || 'OUTBOUND',
        status: 'COMPLETED' as any,
        duration: Number(data.duration) || 0,
        notes: data.notes,
        startedAt: new Date(), endedAt: new Date(),
      },
    });
  }
}

// ─── Controller ───────────────────────────────────────────────────────────────
@ApiTags('IP Telefoniya (Calls)')
@ApiBearerAuth('JWT')
@Controller('calls')
export class CallsController {
  constructor(private svc: CallsService) {}

  @ApiOperation({ summary: 'Telefoniya ulanishini tekshirish' })
  @Post('test-connection')
  @UseGuards(JwtAuthGuard)
  testConnection(@CurrentUser() u: any) {
    return this.svc.testConnection(u.tenantId);
  }

  @ApiOperation({ summary: "Qo'ng'iroqlar tarixi" })
  @Get()
  @UseGuards(JwtAuthGuard)
  list(
    @CurrentUser() u: any,
    @Query('clientId') clientId?: string,
    @Query('status') status?: string,
    @Query('direction') direction?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('agentId') agentId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.list(u.tenantId, u.sub, u.role, { clientId, status, direction, page, limit, agentId, from, to });
  }

  @ApiOperation({ summary: "Joriy faol qo'ng'iroq" })
  @Get('active')
  @UseGuards(JwtAuthGuard)
  active(@CurrentUser() u: any) {
    return this.svc.getActive(u.sub);
  }

  @ApiOperation({ summary: "Bugungi qo'ng'iroq statistikasi" })
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  stats(@CurrentUser() u: any) {
    return this.svc.getStats(u.tenantId, u.sub, u.role);
  }

  @ApiOperation({
    summary: 'Click-to-Call: qongiroq boshlash',
    description: [
      'OnlinePBX orqali chiquvchi qongiroq boshlaydi.',
      '1. Agent extensioniga qongiroq qiladi',
      '2. Agent koteradi',
      '3. Klient raqamiga ulanadi',
      '',
      'Kerakli sozlamalar: Settings -> Telefon -> OnlinePBX',
    ].join('\n'),
  })
  @ApiBody({
    schema: {
      example: { toPhone: '+998901234567', clientId: 'optional_client_id' },
    },
  })
  @Post('initiate')
  @UseGuards(JwtAuthGuard)
  initiate(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.initiate(u.tenantId, u.sub, body);
  }

  @ApiOperation({ summary: "Qo'ng'iroqni tugatish" })
  @Post(':id/hangup')
  @UseGuards(JwtAuthGuard)
  hangup(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.hangup(u.tenantId, u.sub, id);
  }

  @ApiOperation({ summary: "Qo'ng'iroqqa izoh qo'shish" })
  @Post(':id/note')
  @UseGuards(JwtAuthGuard)
  note(@Param('id') id: string, @Body() body: { notes: string }, @CurrentUser() u: any) {
    return this.svc.addNote(u.tenantId, u.sub, id, body.notes);
  }

  @ApiOperation({ summary: "Qo'ng'iroqni qo'lda yozish" })
  @Post('log')
  @UseGuards(JwtAuthGuard)
  log(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.logManual(u.tenantId, u.sub, body);
  }

  @ApiOperation({
    summary: "Qo'ng'iroq matnini (transcript) kiritish/tahrirlash",
    description: "Avtomatik transkripsiya hozircha ulanmagan — agent yozuvni tinglab matnini shu yerga joylaydi. Keyin /analyze chaqirilsa, AI shu matn asosida ishlaydi.",
  })
  @Post(':id/transcript')
  @UseGuards(JwtAuthGuard)
  setTranscript(@Param('id') id: string, @Body() body: { transcript: string }, @CurrentUser() u: any) {
    return this.svc.setTranscript(u.tenantId, u.sub, id, body.transcript);
  }

  @ApiOperation({
    summary: "Qo'ng'iroqni AI (Claude) yordamida tahlil qilish",
    description: "Xulosa, mijoz kayfiyati, e'tirozlar va keyingi qadamni chiqaradi; keyingi qadam avtomatik ravishda Eslatmalar bo'limiga qo'shiladi. Bajarish uchun avval /transcript orqali matn kiritilgan bo'lishi kerak.",
  })
  @Post(':id/analyze')
  @UseGuards(JwtAuthGuard)
  analyze(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.analyzeCall(u.tenantId, u.sub, id);
  }

  @ApiOperation({
    summary: "AI tahlilni qayta urinish",
    description: "Avvalgi xatoni (aiError) tozalab, transkripsiya/tahlilni darhol qayta ishga tushiradi (4 daqiqalik cron kutmasdan). Sozlama (masalan OPENAI_API_KEY) tuzatilgandan keyin ishlatiladi.",
  })
  @Post(':id/retry-ai')
  @UseGuards(JwtAuthGuard)
  retryAi(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.retryAi(u.tenantId, id);
  }

  @ApiOperation({ summary: "Eng ko'p uchragan e'tirozlar statistikasi" })
  @Get('objections-stats')
  @UseGuards(JwtAuthGuard)
  objectionsStats(@CurrentUser() u: any, @Query('days') days?: string, @Query('agentId') agentId?: string) {
    const d = Math.min(Number(days) || 30, 365);
    const aId = u.role === 'AGENT' ? u.sub : agentId;
    return this.svc.getObjectionsStats(u.tenantId, d, aId);
  }

  @ApiOperation({
    summary: 'OnlinePBX / Twilio Webhook',
    description: [
      'OnlinePBX qongiroq holati ozgarganda ushbu endpointni chaqiradi.',
      '',
      'Webhook URL (OnlinePBX kabinetiga kiriting):',
      'POST https://yourdomain.com/api/v1/calls/webhook',
      '',
      'OnlinePBX payload namunasi:',
      '{ "uuid": "xxx", "status": "completed", "duration_seconds": 45, "recording_url": "https://..." }',
    ].join('\n'),
  })
  @ApiBody({
    schema: {
      example: {
        uuid: 'call-uuid-from-onlinepbx',
        status: 'completed',
        duration_seconds: 45,
        recording_url: 'https://onlinepbx.uz/recordings/xxx.mp3',
      },
    },
  })
  /**
   * Telefoniya provayderidan keladigan webhook.
   *
   * XAVFSIZLIK: bu endpoint tashqi dunyoga ochiq (@Public), shuning uchun
   * MAXFIY KALIT bilan himoyalangan. Kalitsiz kimdir soxta qo'ng'iroq
   * yozuvi yoki zararli `recording_url` yuborishi mumkin edi.
   *
   * Sozlash: .env ga PHONE_WEBHOOK_SECRET qo'shing, so'ng provayderda
   * webhook manzilini shunday ko'rsating:
   *   https://sizning-server/calls/webhook?secret=SIZNING_KALIT
   * yoki `x-webhook-secret` header'ida yuboring.
   *
   * Kalit sozlanmagan bo'lsa — ishlashda davom etadi (mavjud o'rnatmalar
   * buzilmasin), lekin ogohlantirish log'ga yoziladi.
   */
  @Post('webhook')
  @Public()
  webhook(@Body() body: any, @Req() req: Request) {
    const res = checkWebhookSecret(
      req.headers as any,
      req.query as any,
      process.env.PHONE_WEBHOOK_SECRET,
    );
    if (!res.ok) throw new UnauthorizedException("Webhook kaliti noto'g'ri");
    if (!res.configured) this.warnOnce();

    return this.svc.handleWebhook(body);
  }

  @ApiOperation({
    summary: 'Мои Звонки Webhook',
    description: [
      "Мои Звонки qo'ng'iroq tugagach ushbu endpointni chaqiradi.",
      '',
      'Webhook URL (moizvonki.ru Sozlamalar → Integratsiya sahifasiga kiriting):',
      'POST https://yourdomain.com/api/v1/calls/webhook/moizvonki/{tenantId}?secret=SIZNING_KALIT',
      '',
      "Boshqa provayderlardan farqli o'laroq, URL ichida tenantId bor — chunki",
      "kiruvchi qo'ng'iroqlar uchun hali CRM'da hech qanday yozuv yo'q va biz",
      "so'rovni qaysi agentlikka tegishli ekanini boshqa yo'l bilan bilolmaymiz.",
    ].join('\n'),
  })
  @Post('webhook/moizvonki/:tenantId')
  @Public()
  webhookMoiZvonki(
    @Param('tenantId') tenantId: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const res = checkWebhookSecret(
      req.headers as any,
      req.query as any,
      process.env.PHONE_WEBHOOK_SECRET,
    );
    if (!res.ok) throw new UnauthorizedException("Webhook kaliti noto'g'ri");
    if (!res.configured) this.warnOnce();

    return this.svc.handleMoiZvonkiWebhook(tenantId, body);
  }

  private static warned = false;
  private warnOnce() {
    if (CallsController.warned) return;
    CallsController.warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[XAVFSIZLIK] PHONE_WEBHOOK_SECRET sozlanmagan — /calls/webhook himoyasiz. ' +
      'Ishlab chiqarishda albatta sozlang.',
    );
  }
}

@Module({
  imports: [PhoneProvidersModule, FollowUpsModule, TranscriptionModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}