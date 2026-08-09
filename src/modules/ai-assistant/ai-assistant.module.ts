import {
  Module, Injectable, Controller, Get, Post, Delete,
  Param, Body, UseGuards, UseInterceptors, UploadedFile, NotFoundException, BadRequestException,
  HttpException, HttpStatus, Logger, Optional, Inject,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import type Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { REDIS_CLIENT } from '../../common/cache/cache.constants';
import { RedisClientModule } from '../../common/cache/redis-client.module';
import { AI_TOOLS, getAnthropicToolsSpec, executeAiTool, AiToolContext, formatCurrentPipelinesForPrompt } from './ai-assistant.tools';
// v43: VEB Jarvis vidjetidagi mikrofon tugmasi — ovozli xabarni matnga
// o'girish uchun XUDDI SHU Whisper xizmatidan (qo'ng'iroq yozuvlari va
// Telegram Jarvis bot bilan BIR XIL) foydalanamiz.
import { TranscriptionModule, TranscriptionService } from '../transcription/transcription.module';

/**
 * ═══════════════════════════════════════════════════════════════
 * v40: AI YORDAMCHI ("JARVIS") — 1-BOSQICH (read-only, tool-use)
 * ═══════════════════════════════════════════════════════════════
 *
 * G'OYA: `briefing.module.ts` faqat BIR TOMONLAMA matn generatsiya
 * qiladi (siz tayyorlagan JSON'ni Claude "chiroylashtiradi"). Bu
 * modul esa ERKIN SUHBAT — agent savol beradi ("Aziz akaning holati
 * qanday?"), Claude esa kerakli CRM ma'lumotini o'ZI tool_use orqali
 * so'rab oladi (ai-assistant.tools.ts), keyin javob yozadi.
 *
 * XAVFSIZLIK:
 *  - Har bir tool ICHIDA tenantId bilan cheklangan (tools faylida).
 *  - Har bir agent uchun KUNLIK so'rov limiti bor (Redis, standart 50).
 *  - Har bir chaqirilgan tool va uning parametrlari `AiMessage.toolCalls`
 *    ustuniga yoziladi — audit uchun.
 *  - System prompt'da Claude'ga hech narsani o'ylab topmaslik aytiladi.
 *
 * XARAJATNI NAZORAT QILISH:
 *  - `max_tokens: 1024`, tool-use tsikli maksimal 4 marta aylanadi
 *    (odatda 1-3 marta yetadi — spetsifikatsiyaga ko'ra).
 *  - Kontekst uchun faqat oxirgi ~10 xabar (5 juftlik) yuboriladi —
 *    butun suhbat tarixi emas.
 */

// v45: 4 dan 6 ga oshirildi — Jarvis endi bitta xabarda bir nechta
// ketma-ket amalni (masalan: mijozni topish → tur qidirish → taklif
// yaratish) OXIRIGACHA bajarishi kutiladi (qarang: buildSystemPrompt
// "HARAKAT QIL, SO'RAB O'TIRMA"), shuning uchun tool-tsikl limiti ham
// biroz oshirildi (xarajat hali ham nazoratda: har bir tool javobi
// 6000 belgigacha qisqartiriladi, max_tokens o'zgarmagan).
const MAX_TOOL_TURNS = 6;
const CONTEXT_MESSAGE_LIMIT = 10;
const DAILY_QUOTA = parseInt(process.env.AI_ASSISTANT_DAILY_LIMIT || '50', 10);

/** Redis yo'q bo'lgandagi zaxira kvota hisoblagichi (bitta instans uchun) */
const memoryQuota = new Map<string, { count: number; resetAt: number }>();

@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger('AiAssistant');

  constructor(
    private prisma: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {}

  private get anthropicKey() {
    return (process.env.ANTHROPIC_API_KEY || '').trim();
  }
  /**
   * v41 XARAJATNI KAMAYTIRISH: Jarvis endi Telegram bot orqali ham
   * ishlaydi (faqat admin), demak so'rovlar soni oshishi mumkin.
   * `calls.module.ts`dagi kabi — bu funksiyaga XOS bo'lgan
   * `ANTHROPIC_MODEL_ASSISTANT` o'zgaruvchisi o'qiladi, standart esa
   * ARZONROQ Haiku (tool-use'ni to'liq qo'llab-quvvatlaydi). Sifat
   * kerak bo'lsa .env'da `ANTHROPIC_MODEL_ASSISTANT=claude-sonnet-5`
   * qo'yish mumkin — lekin boshqa modullarning umumiy
   * `ANTHROPIC_MODEL`i BU YERGA endi sezilmagan holda ta'sir qilmaydi.
   */
  private get anthropicModel() {
    return (process.env.ANTHROPIC_MODEL_ASSISTANT || 'claude-haiku-4-5-20251001').trim();
  }

  /** Asia/Tashkent bo'yicha bugungi kun kaliti (kvota har kuni nolga tushishi uchun) */
  private todayKey(): string {
    const tashkent = new Date(Date.now() + 5 * 3600 * 1000);
    return tashkent.toISOString().slice(0, 10);
  }

  /** Kunlik so'rov kvotasini tekshiradi va oshiradi. Limitdan oshsa xato tashlaydi. */
  private async checkAndIncrementQuota(tenantId: string, userId: string): Promise<void> {
    const key = `ai-assistant:quota:${tenantId}:${userId}:${this.todayKey()}`;

    if (this.redis) {
      try {
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, 26 * 3600); // 26 soat — Tashkent kuni bilan mos, biroz zaxira
        if (count > DAILY_QUOTA) {
          throw new HttpException(
            `Kunlik AI yordamchi so'rovlari limiti (${DAILY_QUOTA}) tugadi. Ertaga qayta urinib ko'ring.`,
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        return;
      } catch (e) {
        if (e instanceof HttpException) throw e;
        this.logger.warn(`Redis kvota tekshiruvi ishlamadi (${(e as any)?.message}) — xotira rejimiga o'tildi`);
      }
    }

    // Zaxira: in-memory
    const now = Date.now();
    const existing = memoryQuota.get(key);
    if (!existing || existing.resetAt < now) {
      memoryQuota.set(key, { count: 1, resetAt: now + 26 * 3600 * 1000 });
      return;
    }
    existing.count++;
    if (existing.count > DAILY_QUOTA) {
      throw new HttpException(
        `Kunlik AI yordamchi so'rovlari limiti (${DAILY_QUOTA}) tugadi. Ertaga qayta urinib ko'ring.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private buildSystemPrompt(role: string, channel: 'web' | 'telegram' = 'web'): string {
    const toolNames = AI_TOOLS.map((t) => t.name).join(', ');
    const channelNote = channel === 'telegram'
      ? "\n9. MUHIM: bu javob Telegram botiga ketadi — juda QISQA yoz (odatda 2-5 qator), markdown/HTML belgilar ishlatma, faqat oddiy matn va kerak bo'lsa emoji."
      : '';
    return `Sen Omon CRM tizimidagi "Jarvis" — tajribali sotuv agentlarining AI yordamchisisan. JAVOBINGNI HAR DOIM o'zbek tilida yoz — lekin foydalanuvchining SAVOLI/BUYRUG'I qaysi tilda kelishi muhim emas: u o'zbekcha, ruscha yoki ikkalasi aralash yozishi/gapirishi mumkin (O'zbekistonda bu odatiy holat) — buni TABIIY qabul qil, TUSHUN va baribir o'zbek tilida DO'STONA va ANIQ javob ber. Foydalanuvchini qaysi tilda yozgani/gapirgani uchun HECH QACHON tanbeh berma, "faqat o'zbek tilida yozing" yoki "ruscha bilan suhbat olaolmayman" kabi ma'ruza o'qima — bu foydalanuvchini charchatadi va foydasiz.
Faqat BITTA holatda alohida javob ber: agar kelgan matn HAQIQATAN HAM ma'nosiz/uzuq-yuluq bo'lsa (masalan ovozli xabarni matnga o'girishda xato ketgan, mavzuga umuman aloqasi yo'q so'zlar to'plami chiqqan bo'lsa) — buni "til muammosi" deb emas, "ovozli xabar aniq eshitilmadi" deb tushun va bitta qisqa, do'stona gap bilan qayta yuborishni so'ra (masalan: "Ovozli xabaringizni aniq tushunolmadim, iltimos qaytadan gapirib yuboring 🙏"), tilga umuman urg'u berma.

ENG MUHIM QOIDA — HARAKAT QIL, SO'RAB O'TIRMA:
Sen ijrochi yordamchisan, so'rovnoma emassan. Foydalanuvchi senga bir buyruqda bir necha narsani aytsa (masalan: "Aziz akaga Antalya, Rixos mehmonxonasi, $650, 7 kecha taklif tayyorla"), UNDA ALLAQACHON BERILGAN barcha ma'lumotni ishlat va vazifani OXIRIGACHA (kerakli tool'larni ketma-ket chaqirib) BAJAR — har bir mayda tafsilot uchun alohida savol berib, foydalanuvchini "keyingi tur" so'rab qayta-qayta band qilma. Faqat HAQIQATAN HAL QILUVCHI ma'lumot (masalan qaysi mijoz — clientId aniqlanmasa) yetishmasa, BITTA aniq savol ber va davom et — hech qachon bir xabarda 2 tadan ortiq savol berma.
Agar biror tool bo'sh natija/xato qaytarsa, buni "vazifani bajarolmayman" degani deb TUSHUNMA. Har doim quyidagicha yo'l tut:
  a) Nima topilmagani yoki nega (masalan katalog hali bo'sh, operator API hali ulanmagan) — buni QISQA va OCHIQ ayt (bitta gap yetarli, texnik tafsilotga botma).
  b) SO'NGRA — foydalanuvchi allaqachon bergan ma'lumotlar (yo'nalish, mehmonxona, narx, sana kabi) bilan vazifani DAVOM ETTIR: masalan 'searchMarketplaceTours' bo'sh natija qaytarsa, bu "bunday tur yo'q" degani EMAS — kataloqda hali mos yozuv yo'q, xolos. Bu holda tayyor tur qidirishni qayta-qayta so'rab o'tirmay, 'createOfferDraft' tool'i orqali foydalanuvchi aytgan tavsif/narx bilan TAKLIF QORALAMASINI to'g'ridan-to'g'ri yarat (tourId'siz ham yaratsa bo'ladi) — chunki createOfferDraft marketplace kataloqiga bog'liq emas.
Maqsad: har bir suhbat kamida bitta ANIQ NATIJA (yaratilgan vazifa, taklif, booking qoralamasi, o'zgartirilgan bosqich va h.k.) bilan tugashi, "keyinroq urinib ko'ring" yoki cheksiz aniqlashtiruvchi savollar bilan emas.

QOIDALAR (MAJBURIY):
1. Sen faqat berilgan tool'lar (${toolNames}) orqali CRM ma'lumotiga kirasan. Raqamlar, sanalar, narxlar, ID'lar kabi ANIQ FAKTLARNI hech qachon o'zing o'ylab topma (hallucinate qilma) — ular albatta tegishli tool natijasidan yoki foydalanuvchining o'zi aytgan gapidan olinishi kerak. Lekin bu qoida seni harakatsizlikka BAHONA qilmasin: agar foydalanuvchi allaqachon aniq ma'lumot bergan bo'lsa (masalan narx, mehmonxona nomi), buni "tasdiqlanmagan" deb rad etma — aynan shu ma'lumotni ishlatib vazifani bajar.
2. Endi CRM'da CHEKLANGAN amallarni bajara olasan: vazifa yaratish, xabar qoralamasi tayyorlash, pipeline bosqichini o'zgartirish, taklif/booking qoralamasi, yangi lead qo'shish, izoh qo'shish, vazifa/eslatmani yakunlash yoki ko'chirish. LEKIN: hech qachon xabarni o'zing yubormaysan (foydalanuvchi tasdiqlashi kerak), hech qachon pul/to'lovni tasdiqlash yoki bookingni "CONFIRMED" qilish kabi yakuniy moliyaviy amalni bajarmaysan, hech narsani o'chirmaysan va boshqa agentga hech narsa biriktirmaysan — bular faqat inson tomonidan, tegishli bo'limda bajariladi. Foydalanuvchi shularni so'rasa — buni qila olmasligingni ochiq ayt va tavsiya ber (tegishli bo'limga o'zi o'tishini ayt).
2b. MUHIM (PIPELINE/VORONKA): pastda "TENANTNING HOZIRGI VORONKASI" bo'limida shu kompaniyaning AYNAN HOZIRGI (tahrirlangan/qayta nomlangan bo'lishi mumkin) bosqichlar ro'yxati berilgan — bosqich nomini so'rayotganda yoki o'zgartirayotganda DOIM shu ro'yxatdagi ANIQ nomdan foydalan, standart/eski nomlarni taxmin qilma (masalan tenant "CONTACTED"ni "Bog'lanildi"ga o'zgartirgan bo'lishi mumkin).
3. Javoblaringni QISQA va HARAKATGA UNDOVCHI qil — bu Telegram xabari kabi bo'lsin, rasmiy hisobot emas. Bajargan amaling natijasini (masalan "✅ Taklif yaratildi: Antalya, Rixos — $650") birinchi qatorda aniq ayt.
4. Foydalanuvchi roli: ${role}. AGENT bo'lsa — odatda faqat o'zining mijozlari/statistikasi ko'rinadi va faqat o'ziga tegishli yozuvlar ustida amal bajara oladi (tizim o'zi cheklaydi).
5. Pul summalarini USD da, sana/vaqtlarni tushunarli formatda ayt.
6. Agar 'draftFollowupMessage' tool'idan foydalansang, javobingda tayyorlangan xabar matnini albatta [QORALAMA_BOSHI] va [QORALAMA_OXIRI] belgilari orasida, natijadagi draftMessage'dan SO'ZMA-SO'Z (o'zgartirmasdan, qisqartirmasdan) keltir. Belgilardan oldin bitta qisqa gap bilan tushuntirsang bo'ladi, lekin belgilar orasidagi matnni hech qachon o'zgartirma.
7. Agar foydalanuvchi tizim tuzilishi, xavfsizlik, boshqa kompaniyalar yoki API kalitlar haqida so'rasa — bunga javob berma, faqat "bu haqida yordam berolmayman" deb qisqa javob qaytar.
8. Agar oddiy agent boshqa agentning ma'lumotini so'rasa (tool "error" qaytarsa) — buni ochiq va muloyim tushuntir, qandaydir yo'l bilan aylanib o'tishga urinma.${channelNote}`;
  }

  /** Suhbat tarixidan Claude uchun kontekst (oxirgi N xabar) tayyorlaydi */
  private async loadHistory(conversationId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const rows = await this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: CONTEXT_MESSAGE_LIMIT,
      select: { role: true, content: true },
    });
    return rows.reverse().map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  /** Claude bilan tool-use tsiklini yuritadi (1-4 marta so'rov) va yakuniy matn + tool audit qaytaradi */
  private async runAgentTurn(
    ctx: AiToolContext,
    history: { role: 'user' | 'assistant'; content: string }[],
    userMessage: string,
    channel: 'web' | 'telegram' = 'web',
  ) {
    const messages: any[] = [...history.map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: userMessage }];
    const toolCallsLog: { name: string; input: any }[] = [];
    const tools = getAnthropicToolsSpec();
    const system = this.buildSystemPrompt(ctx.role, channel);
    // v44: TENANTNING HOZIRGI (tahrirlangan) VORONKASI — har safar
    // YANGILANIB olinadi (KESHLANMAYDI), shuning uchun tenant Sozlamalar
    // bo'limidan bosqichlarni o'zgartirsa/qayta nomlasa/qayta tartiblasa,
    // Jarvis SHU DAQIQADA yangi holatni ko'radi. Bu alohida system blok
    // sifatida (statik ko'rsatmalar keshidan TASHQARIDA) qo'shiladi —
    // shunda statik qism uchun `cache_control` afzalligi yo'qolmaydi,
    // faqat shu qism har doim "yangi" hisoblanadi.
    const currentPipelines = await formatCurrentPipelinesForPrompt(this.prisma, ctx.tenantId);
    const pipelineBlock = currentPipelines
      ? `TENANTNING HOZIRGI VORONKASI (bosqich nomlarini/tartibni SHU YERDAN ol, boshqa manbadan EMAS):\n\n${currentPipelines}`
      : 'TENANTNING HOZIRGI VORONKASI: hali sozlanmagan — standart bosqich nomlaridan foydalan.';
    // v41 XARAJATNI KAMAYTIRISH: Telegram javoblari qisqa bo'lishi kerak
    // (bot xabari), shuning uchun max_tokens ham pastroq — kirish
    // narxidan tashqari CHIQISH narxini ham kamaytiradi.
    const maxTokens = channel === 'telegram' ? 600 : 1024;

    let finalText = '';

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.anthropicModel,
          max_tokens: maxTokens,
          // XARAJATNI KAMAYTIRISH: system prompt rol+kanal bo'yicha bir
          // xil qaytariladi — `cache_control` bilan keshlab, 5 daqiqa
          // ichida qayta chaqirilsa kirish narxi kamayadi (calls.module.ts
          // dagi bilan bir xil naqsh).
          system: [
            { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: pipelineBlock },
          ],
          tools,
          tool_choice: { type: 'auto' },
          messages,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic API xato (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }

      const data: any = await res.json();
      const content: any[] = data?.content || [];
      const toolUseBlocks = content.filter((c) => c.type === 'tool_use');
      const textBlocks = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

      if (!toolUseBlocks.length) {
        finalText = textBlocks || "Kechirasiz, javob tayyorlay olmadim.";
        break;
      }

      // Claude'ning tool so'ragan xabarini tarixga qo'shamiz
      messages.push({ role: 'assistant', content });

      // Har bir tool'ni bajaramiz (tenantId ICHIDA cheklangan — ai-assistant.tools.ts)
      const toolResultBlocks: any[] = [];
      for (const tu of toolUseBlocks) {
        const result = await executeAiTool(this.prisma, ctx, tu.name, tu.input);
        toolCallsLog.push({ name: tu.name, input: tu.input });
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result).slice(0, 6000),
        });
      }
      messages.push({ role: 'user', content: toolResultBlocks });

      if (turn === MAX_TOOL_TURNS - 1) {
        finalText = textBlocks || "Ma'lumotlarni topdim, lekin yakuniy javob tayyorlashda muammo bo'ldi. Iltimos, savolni qayta so'rang.";
      }
    }

    return { text: finalText, toolCalls: toolCallsLog };
  }

  async chat(ctx: AiToolContext, conversationId: string | undefined, message: string, channel: 'web' | 'telegram' = 'web') {
    const text = String(message || '').trim();
    if (!text) throw new BadRequestException("Xabar bo'sh bo'lishi mumkin emas.");
    if (text.length > 2000) throw new BadRequestException("Xabar juda uzun (maksimal 2000 belgi).");

    const tenant = await this.prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { settings: true } });
    if ((tenant?.settings as any)?.aiEnabled !== true) {
      throw new HttpException("AI bu kompaniyada yoqilmagan.", HttpStatus.FORBIDDEN);
    }
    if (!this.anthropicKey) {
      throw new HttpException("AI yordamchi sozlanmagan (serverda ANTHROPIC_API_KEY yo'q).", HttpStatus.SERVICE_UNAVAILABLE);
    }

    await this.checkAndIncrementQuota(ctx.tenantId, ctx.userId);

    // Suhbatni topamiz yoki yaratamiz (FAQAT shu agentga tegishli bo'lishi shart)
    let conversation = conversationId
      ? await this.prisma.aiConversation.findFirst({ where: { id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId } })
      : null;

    if (!conversation) {
      conversation = await this.prisma.aiConversation.create({
        data: { tenantId: ctx.tenantId, userId: ctx.userId, title: text.slice(0, 60) },
      });
    }

    const history = await this.loadHistory(conversation.id);

    // Foydalanuvchi xabarini darhol saqlaymiz (Claude xato bersa ham yo'qolmasin)
    await this.prisma.aiMessage.create({
      data: { conversationId: conversation.id, role: 'user', content: text },
    });

    let result: { text: string; toolCalls: { name: string; input: any }[] };
    try {
      result = await this.runAgentTurn(ctx, history, text, channel);
    } catch (e: any) {
      this.logger.warn(`Jarvis AI xatosi: ${e.message}`);
      throw new HttpException("AI yordamchi hozir javob bera olmadi. Birozdan keyin qayta urinib ko'ring.", HttpStatus.BAD_GATEWAY);
    }

    await this.prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls.length ? (result.toolCalls as any) : undefined,
      },
    });

    await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    return {
      conversationId: conversation.id,
      reply: result.text,
      toolCalls: result.toolCalls,
    };
  }

  async listConversations(tenantId: string, userId: string) {
    return this.prisma.aiConversation.findMany({
      where: { tenantId, userId },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
  }

  async getMessages(tenantId: string, userId: string, conversationId: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, tenantId, userId },
    });
    if (!conversation) throw new NotFoundException('Suhbat topilmadi.');

    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, createdAt: true },
    });
    return { conversation, messages };
  }

  async deleteConversation(tenantId: string, userId: string, conversationId: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, tenantId, userId },
    });
    if (!conversation) throw new NotFoundException('Suhbat topilmadi.');
    await this.prisma.aiConversation.delete({ where: { id: conversationId } });
    return { success: true };
  }
}

@ApiTags('AI Assistant (Jarvis)')
@ApiBearerAuth()
@Controller('ai-assistant')
@UseGuards(JwtAuthGuard)
export class AiAssistantController {
  constructor(private svc: AiAssistantService, private transcription: TranscriptionService) {}

  @ApiOperation({ summary: "Jarvis bilan suhbat — yangi xabar yuborish (kerak bo'lsa yangi suhbat avtomatik yaratiladi)" })
  @Post('chat')
  chat(@CurrentUser() u: any, @Body() body: { conversationId?: string; message: string }) {
    return this.svc.chat({ tenantId: u.tenantId, userId: u.sub, role: u.role }, body?.conversationId, body?.message);
  }

  /**
   * v43: VEB CHATDAGI MIKROFON TUGMASI — brauzer ovozli xabarni
   * yozib (MediaRecorder), shu yerga yuboradi. Avval Whisper orqali
   * matnga o'giramiz, so'ng XUDDI YOZMA XABAR KABI (`svc.chat`) Jarvis
   * tool-use agenti orqali yuboramiz — shuning uchun ovozli BUYRUQ ham
   * ("Aziz akaning bosqichini Muzokara qil" kabi) TO'LIQ ishlaydi.
   * Javobda transkripsiya matni ham qaytariladi — vidjet buni foydalanuvchi
   * xabari sifatida ko'rsatishi uchun (u nima deganini ko'rsin).
   */
  @ApiOperation({ summary: "Jarvis bilan OVOZLI suhbat — audio yuboriladi, matnga o'girilib, tool-use agentga yuboriladi" })
  @ApiConsumes('multipart/form-data')
  @Post('voice-chat')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 24 * 1024 * 1024 } }))
  async voiceChat(
    @CurrentUser() u: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('conversationId') conversationId?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("Audio fayl kelmadi");
    }
    if (!this.transcription.isConfigured()) {
      throw new BadRequestException("Ovozli xabarlarni matnga o'girish sozlanmagan (GROQ_API_KEY/OPENAI_API_KEY yo'q). Matn bilan yozing.");
    }
    const stt = await this.transcription.transcribeBuffer(file.buffer);
    if (!stt.text) {
      throw new BadRequestException(stt.error || "Ovozli xabarni tushunib bo'lmadi. Qayta urinib ko'ring.");
    }
    const result = await this.svc.chat({ tenantId: u.tenantId, userId: u.sub, role: u.role }, conversationId, stt.text);
    return { ...result, transcript: stt.text };
  }

  @ApiOperation({ summary: "O'zining suhbatlar ro'yxati" })
  @Get('conversations')
  listConversations(@CurrentUser() u: any) {
    return this.svc.listConversations(u.tenantId, u.sub);
  }

  @ApiOperation({ summary: 'Bitta suhbatning xabarlari' })
  @Get('conversations/:id')
  getMessages(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.getMessages(u.tenantId, u.sub, id);
  }

  @ApiOperation({ summary: "Suhbatni o'chirish" })
  @Delete('conversations/:id')
  deleteConversation(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.deleteConversation(u.tenantId, u.sub, id);
  }
}

@Module({
  imports: [PrismaModule, RedisClientModule, TranscriptionModule],
  controllers: [AiAssistantController],
  providers: [AiAssistantService],
  exports: [AiAssistantService],
})
export class AiAssistantModule {}