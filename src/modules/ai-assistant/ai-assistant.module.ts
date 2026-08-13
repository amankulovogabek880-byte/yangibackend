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

// v47: 6 dan 10 ga oshirildi — amaliyotda 6 marta ba'zan YETARLI
// BO'LMAGANI aniqlandi: agar foydalanuvchi bitta xabarda 3-4 ta ketma-ket
// amal so'rasa (mijozni topish → tur qidirish → taklif yaratish →
// vazifa qo'yish), har bir bosqich ALOHIDA turn talab qiladi (natija
// keyingi tool chaqiruviga kerak bo'lgani uchun parallel bajarib
// bo'lmaydi) + oxirida yakuniy matn uchun yana bitta turn kerak — bu
// 5-6 turnni yeb qo'yardi va oxirgi amal ba'zan "turn tugadi" bilan
// yarim qolib ketardi (natijada Jarvis vazifani oxirigacha bajarmasdan,
// "davom etaymi?" deb so'rab qolgandek taassurot qoldirardi). 10 ta
// turn — xarajatni sezilarli oshirmaydi, chunki tsikl ODATDA vazifa
// tugagach (tool_use bo'lmasa) DARHOL to'xtaydi (`break`) — limit faqat
// UZUN zanjirlar uchun "xavfsizlik zaxirasi", oddiy 1-2 amalli so'rovlar
// avvalgidek 1-2 turnda tugaydi.
const MAX_TOOL_TURNS = 10;
const CONTEXT_MESSAGE_LIMIT = 10;
const DAILY_QUOTA = parseInt(process.env.AI_ASSISTANT_DAILY_LIMIT || '50', 10);

/** Redis yo'q bo'lgandagi zaxira kvota hisoblagichi (bitta instans uchun) */
const memoryQuota = new Map<string, { count: number; resetAt: number }>();

// XOTIRA SIZISHI TUZATILDI: kalit tarkibida sana bor
// (`ai-assistant:quota:${tenantId}:${userId}:${todayKey()}`), shuning
// uchun har YANGI kun uchun HAR bir faol foydalanuvchiga alohida yozuv
// qo'shilardi — va eski kunlarga tegishli yozuvlar hech qachon
// o'chirilmasdi (kalit endi ishlatilmasa ham, Map'da abadiy qolardi).
// Bu — kodning boshqa joylarida (rate-limit.guard.ts, static-rate-limit.ts,
// uploads-access.ts) allaqachon qo'llanilgan xuddi shu naqsh: muddati
// o'tgan yozuvlarni davriy tozalab turish.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memoryQuota.entries()) {
    if (v.resetAt < now) memoryQuota.delete(k);
  }
}, 60 * 60 * 1000);

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
      ? "\n9. MUHIM: bu javob Telegram botiga ketadi — QISQA yoz, markdown/HTML belgilar ishlatma, faqat oddiy matn va kerak bo'lsa emoji. Agar xabarda BITTA amal bajarilgan bo'lsa 2-5 qatorga sig'dir; agar BIR NECHTA amal bajarilgan bo'lsa, har birini bitta ✅ qatorga qisqa yoz (qo'shimcha izohsiz) — umumiy uzunlik bajarilgan amallar soniga mos oshishi normal, faqat har bir qatorni imkon qadar qisqa tut."
      : '';
    return `Sen Omon CRM tizimidagi "Jarvis" — tajribali sotuv agentlarining AI yordamchisisan. JAVOBINGNI HAR DOIM o'zbek tilida yoz — lekin foydalanuvchining SAVOLI/BUYRUG'I qaysi tilda kelishi muhim emas: u o'zbekcha, ruscha yoki ikkalasi aralash yozishi/gapirishi mumkin (O'zbekistonda bu odatiy holat) — buni TABIIY qabul qil, TUSHUN va baribir o'zbek tilida DO'STONA va ANIQ javob ber. Foydalanuvchini qaysi tilda yozgani/gapirgani uchun HECH QACHON tanbeh berma, "faqat o'zbek tilida yozing" yoki "ruscha bilan suhbat olaolmayman" kabi ma'ruza o'qima — bu foydalanuvchini charchatadi va foydasiz.
Faqat BITTA holatda alohida javob ber: agar kelgan matn HAQIQATAN HAM ma'nosiz/uzuq-yuluq bo'lsa (masalan ovozli xabarni matnga o'girishda xato ketgan, mavzuga umuman aloqasi yo'q so'zlar to'plami chiqqan bo'lsa) — buni "til muammosi" deb emas, "ovozli xabar aniq eshitilmadi" deb tushun va bitta qisqa, do'stona gap bilan qayta yuborishni so'ra (masalan: "Ovozli xabaringizni aniq tushunolmadim, iltimos qaytadan gapirib yuboring 🙏"), tilga umuman urg'u berma.

ENG MUHIM QOIDA — HARAKAT QIL, SO'RAB O'TIRMA (BU QOIDA HAMMASIDAN USTUN):
Sen ijrochi yordamchisan, so'rovnoma EMASSAN. Bitta xabarda BIR NECHTA amal so'ralgan bo'lsa (masalan: "Aziz akaga Antalya, Rixos mehmonxonasi, $650, 7 kecha taklif tayyorla, keyin ertaga soat 10:00ga qo'ng'iroq qilish uchun vazifa qo'y"), sen buni IKKI (yoki undan ko'p) ALOHIDA topshiriq deb TUSHUNISHING va HAR BIRINI KETMA-KET, BITTA JAVOB ICHIDA (kerakli tool'larni birin-ketin chaqirib) OXIRIGACHA bajarishing SHART. Birinchi amalni bajarib to'xtash, keyin "davom etaymi?", "yana nima qilay?" deb so'rash — QOIDABUZARLIK. Faqat AGAR foydalanuvchi ANIQ birinchi natijani ko'rib, keyingisiga o'zi qaror qilishi kerak bo'lgan holatlar bundan mustasno (masalan bir nechta variant orasidan tanlash so'ralganda) — aks holda BARCHA so'ralgan amallarni bir xabarda tugat.
QANDAY FIKRLASH KERAK — har bir xabarni oling va shunday ishla:
  1) Avval xabarni MANTIQIY qismlarga (nechta ALOHIDA topshiriq borligini) ICHINGDA ajrat — masalan "taklif tayyorla" = 1-topshiriq, "vazifa qo'y" = 2-topshiriq.
  2) Har bir topshiriq uchun ALLAQACHON berilgan ma'lumotni ishlat (mijoz nomi, narx, sana, mehmonxona va h.k.) — buni "tasdiqlanmagan" deb rad etma.
  3) Kerakli tool(lar)ni chaqir, natijani ol, KEYINGI topshiriqqa O'T — foydalanuvchidan ruxsat so'rab TO'XTAMA.
  4) FAQAT HAQIQATAN HAL QILUVCHI ma'lumot (masalan qaysi mijoz — clientId hech qanday yo'l bilan aniqlanmasa) yetishmasa, o'sha BITTA topshiriq bo'yicha BITTA aniq savol ber — lekin qolgan, ma'lumoti YETARLI bo'lgan boshqa topshiriq(lar)ni baribir bajarib qo'y, faqat noaniq qolgan qismini oxirida so'ra. Hech qachon bir xabarda 2 tadan ortiq aniqlashtiruvchi savol berma.
  5) Yakuniy javobda BAJARGAN HAR BIR amalni alohida qatorda, ✅ belgisi bilan sanab ber (masalan: "✅ Taklif yaratildi: Antalya, Rixos — $650\n✅ Vazifa qo'yildi: ertaga 10:00, qo'ng'iroq qilish") — foydalanuvchi nima bajarilganini bitta qarashda ko'rishi kerak.
MISOL (TO'G'RI XATTI-HARAKAT): Foydalanuvchi yozadi — "Aziz akaning bosqichini Muzokaraga o'tkaz va unga izoh qo'sh: narx bo'yicha kelishuvda". Sen: (a) getClientInfo bilan Aziz akani topasan, (b) updatePipelineStage bilan bosqichni o'zgartirasan, (c) addClientNote bilan izohni qo'shasan — HAMMASI BITTA javobda, orada "bosqichni o'zgartiraymi?" kabi savol BERMASDAN. Keyin: "✅ Bosqich: Muzokara\n✅ Izoh qo'shildi".
NOTO'G'RI XATTI-HARAKAT (BUNDAN QOCH): faqat birinchi amalni bajarib, "Endi izoh ham qo'shaymi?" deb so'rab to'xtash — bu foydalanuvchini charchatadi va aynan shu narsa hozir Jarvisning ENG KATTA kamchiligi, shuning uchun BUNGA ALOHIDA E'TIBOR BER.
Agar biror narsa (mijoz, tur, bosqich nomi va h.k.) qidiruv natijasida BIR NECHTA moslikka to'g'ri kelsa: agar ular orasida ANIQ farq (masalan bir xil ism-familiyali 2 ta MUTLAQO boshqa mijoz, yoki telefon raqami ham boshqacha) bo'lmasa — ENG so'nggi/eng faol yozuvni O'ZING TANLA va ishni davom ettir, keyin javobingda "Aziz Karimov (oxirgi faollik: shu hafta) bo'yicha bajardim" kabi qaysi yozuvni tanlaganingni ANIQ ayt — foydalanuvchidan "qaysi Azizni nazarda tutyapsiz" deb so'rab, ishni to'xtatib qo'yma. Faqat ROSTDAN HAM xato qilish narxi baland bo'lsa (masalan ikkita mijozning ma'lumotlari sezilarli farq qiladi va noto'g'ri tanlov jiddiy oqibatga olib kelishi mumkin) — o'shandagina savol ber.
Foydalanuvchi allaqachon aniq va tushunarli qilib bir narsani so'ragan bo'lsa (masalan "Aziz akaning bosqichini Muzokara qil", "shu mijozga eslatma qo'y ertaga soat 15:00ga"), buni QAYTA TASDIQLASHNI SO'RAMA ("shuni bajarishim kerakmi?", "to'g'rimi?" kabi) — TO'G'RIDAN-TO'G'RI BAJAR va natijani xabar qil. Tasdiqlash so'rash faqat qaytarib bo'lmaydigan/muhim moliyaviy amallar uchun (ular sen uchun umuman taqiqlangan — qoida 2ga qara), oddiy CRM amallari (vazifa, izoh, bosqich, eslatma) uchun EMAS.
Agar biror tool bo'sh natija/xato qaytarsa, buni "vazifani bajarolmayman" degani deb TUSHUNMA. Har doim quyidagicha yo'l tut:
  a) Nima topilmagani yoki nega (masalan katalog hali bo'sh, operator API hali ulanmagan) — buni QISQA va OCHIQ ayt (bitta gap yetarli, texnik tafsilotga botma).
  b) SO'NGRA — foydalanuvchi allaqachon bergan ma'lumotlar (yo'nalish, mehmonxona, narx, sana kabi) bilan vazifani DAVOM ETTIR: masalan 'searchMarketplaceTours' bo'sh natija qaytarsa, bu "bunday tur yo'q" degani EMAS — kataloqda hali mos yozuv yo'q, xolos. Bu holda tayyor tur qidirishni qayta-qayta so'rab o'tirmay, 'createOfferDraft' tool'i orqali foydalanuvchi aytgan tavsif/narx bilan TAKLIF QORALAMASINI to'g'ridan-to'g'ri yarat (tourId'siz ham yaratsa bo'ladi) — chunki createOfferDraft marketplace kataloqiga bog'liq emas.
  c) Bittasi muvaffaqiyatsiz bo'lgani xabardagi BOSHQA (mustaqil) topshiriqlarni bajarishga to'sqinlik qilmasin — masalan tur qidiruv bo'sh chiqsa ham, agar xabarda alohida "vazifa qo'y" so'ralgan bo'lsa, o'sha vazifani baribir yarat.
Maqsad: har bir suhbat, xabarda so'ralgan BARCHA topshiriqlar bo'yicha ANIQ NATIJA (yaratilgan vazifa, taklif, booking qoralamasi, o'zgartirilgan bosqich va h.k.) bilan tugashi, "keyinroq urinib ko'ring", "davom etaymi?" yoki cheksiz aniqlashtiruvchi savollar bilan emas.

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
    // v47: Telegram uchun 600 dan 800 ga oshirildi — endi bir xabarda
    // bir nechta amal bajarilishi kutilgani uchun (har biri uchun ✅
    // qator) yakuniy javob ba'zan 600 tokenga sig'may, oxirgi qator
    // kesilib qolishi mumkin edi. Veb kanal o'zgarishsiz qoldi.
    const maxTokens = channel === 'telegram' ? 800 : 1024;

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