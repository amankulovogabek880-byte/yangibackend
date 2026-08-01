import { Module, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeAudioForWhisper } from '../../common/utils/voice-convert';

/**
 * ═══════════════════════════════════════════════════════════════
 * AVTOMATIK TRANSKRIPSIYA (Speech-to-Text) — v16, v37 (Groq qo'shildi)
 * ═══════════════════════════════════════════════════════════════
 * MUAMMO: Anthropic (Claude) API audio faylni to'g'ridan-to'g'ri
 * qabul qilmaydi — faqat matn/rasm/PDF. Shuning uchun "AI qo'ng'iroqni
 * eshitib tahlil qilishi" uchun oldin ovozni MATNGA aylantirish kerak,
 * keyingina Claude shu matnni tahlil qiladi (calls.module.ts'dagi
 * `analyzeCall`).
 *
 * v37: IKKITA provayder qo'llab-quvvatlanadi — GROQ (Whisper Large v3
 * Turbo, ~9x ARZONROQ, OpenAI bilan bir xil API formatida) va OpenAI
 * (asl Whisper). Qaysi biri "asosiy" (birinchi urinib ko'riladigan)
 * ekanini PLATFORM_OWNER `/owner` panelidan, kodga tegmasdan,
 * ISH VAQTIDA o'zgartira oladi (PlatformSetting jadvali orqali,
 * key = "sttProvider", qiymati "groq" yoki "openai").
 *
 * ZAXIRA (fallback): tanlangan asosiy provayder ishlamay qolsa
 * (masalan kalit sozlanmagan yoki server xatosi bersa), ikkinchisi
 * AVTOMATIK sinab ko'riladi — agar uning ham kaliti bo'lsa. Shu
 * tufayli ikkalasining kalitini ham .env'da saqlash tavsiya etiladi:
 * ular bir-birini "sug'urtalaydi".
 *
 * SOZLASH: .env fayliga qo'shing:
 *   GROQ_API_KEY=gsk_...      (https://console.groq.com — bepul boshlanadi)
 *   OPENAI_API_KEY=sk-...     (mavjud, ANTHROPIC_API_KEY'dan ALOHIDA kalit)
 * Ikkalasi ham bo'lmasa, avtomatik transkripsiya jim o'chirilgan
 * holda qoladi va eski usul — agent qo'lda matn kiritadi — ishlashda
 * davom etadi, hech narsa buzilmaydi.
 *
 * ESLATMA: har bir kompaniya uchun AI umuman yoqiq/o'chiqligi
 * (`tenant.settings.aiEnabled`) — bu FAYLDA emas, `calls.module.ts`
 * (`isAiEnabledForTenant`) darajasida tekshiriladi. Bu servis faqat
 * "QAYSI provayder" savoliga javob beradi, "yoqilganmi" degan
 * savolga emas.
 */

type SttProvider = 'groq' | 'openai';
type TranscribeResult = { text: string | null; error?: string; transient?: boolean };

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger('Transcription');

  constructor(private prisma: PrismaService) {}

  private get groqKey() {
    return (process.env.GROQ_API_KEY || '').trim();
  }
  private get openaiKey() {
    return (process.env.OPENAI_API_KEY || '').trim();
  }

  isConfigured(): boolean {
    return !!this.groqKey || !!this.openaiKey;
  }

  /**
   * PLATFORM_OWNER `/owner` panelidan belgilagan "asosiy" provayderni
   * o'qiydi. Hech narsa belgilanmagan bo'lsa (birinchi marta) — GROQ
   * standart (arzonroq bo'lgani uchun).
   */
  private async getPreferredProvider(): Promise<SttProvider> {
    try {
      const row = await this.prisma.platformSetting.findUnique({ where: { key: 'sttProvider' } });
      if (row?.value === 'openai' || row?.value === 'groq') return row.value;
    } catch (e: any) {
      this.logger.warn(`sttProvider sozlamasi o'qilmadi (standart: groq): ${e.message}`);
    }
    return 'groq';
  }

  async getSttProviderSetting(): Promise<{ preferred: SttProvider; groqConfigured: boolean; openaiConfigured: boolean }> {
    return {
      preferred: await this.getPreferredProvider(),
      groqConfigured: !!this.groqKey,
      openaiConfigured: !!this.openaiKey,
    };
  }

  async setSttProvider(provider: SttProvider) {
    await this.prisma.platformSetting.upsert({
      where: { key: 'sttProvider' },
      create: { key: 'sttProvider', value: provider },
      update: { value: provider },
    });
    return this.getSttProviderSetting();
  }

  /**
   * Berilgan audio URL'ni yuklab olib, Whisper orqali matnga o'giradi.
   * v18: avval faqat `string | null` qaytarardi — xato bo'lsa sabab
   * FAQAT server logida qolardi, admin panelida "AI kutmoqda" abadiy
   * osilib qolardi va HECH KIM sababini ko'ra olmasdi. Endi sabab ham
   * qaytariladi — chaqiruvchi (`calls.module.ts`) buni `Call.aiError`ga
   * yozadi, shunda admin/agent buni to'g'ridan-to'g'ri UI'da ko'radi.
   *
   * v37: avval audio bir marta yuklab olinadi/tozalanadi, so'ng
   * TANLANGAN provayderga yuboriladi; u ishlamasa (yoki kaliti bo'lmasa)
   * — IKKINCHI provayderga (agar kaliti bo'lsa) qayta urinib ko'riladi.
   */
  async transcribeFromUrl(recordingUrl: string): Promise<TranscribeResult> {
    if (!this.isConfigured()) {
      return { text: null, error: "GROQ_API_KEY yoki OPENAI_API_KEY sozlanmagan (audio matnga o'girish uchun kerak, bu ANTHROPIC_API_KEY'dan ALOHIDA kalit)." };
    }
    if (!/^https?:\/\//i.test(recordingUrl)) {
      return { text: null, error: `Yozuv havolasi noto'g'ri: ${String(recordingUrl).slice(0, 100)}` };
    }

    try {
      // 1) Audio faylni yuklab olamiz
      const audioRes = await fetch(recordingUrl);
      if (!audioRes.ok) {
        const msg = `Audio yuklab bo'lmadi (HTTP ${audioRes.status}): ${recordingUrl.slice(0, 100)}`;
        this.logger.warn(msg);
        // PBX tomonidan vaqtinchalik bo'lishi mumkin (yozuv hali tayyorlanmoqda)
        return { text: null, error: msg, transient: true };
      }
      const contentLength = Number(audioRes.headers.get('content-length') || 0);
      // Whisper API cheklovi ~25MB — undan katta fayllarni o'tkazib yuboramiz
      if (contentLength && contentLength > 24 * 1024 * 1024) {
        const msg = `Audio juda katta (${Math.round(contentLength / 1024 / 1024)}MB, limit 25MB)`;
        this.logger.warn(msg);
        return { text: null, error: msg };
      }
      const arrayBuf = await audioRes.arrayBuffer();
      if (!arrayBuf || arrayBuf.byteLength < 500) {
        return { text: null, error: "Audio fayl bo'sh yoki buzilgan (juda kichik hajm)", transient: true };
      }

      // 2) v19: Whisper'ga yuborishdan OLDIN ffmpeg orqali "tozalab" qayta
      // kodlaymiz — PBX'dan kelgan audio ko'pincha nostandart/streaming
      // sarlavhali bo'ladi va Whisper buni to'g'ridan-to'g'ri qabul qilsa
      // "duration":0 xatosi berishi mumkin (garchi brauzerda ijro etilsa ham).
      const normalized = await normalizeAudioForWhisper(Buffer.from(arrayBuf));
      if ('error' in normalized) {
        const msg = `Audio tozalashda xato: ${normalized.error}`;
        this.logger.warn(msg);
        // Bo'sh/hali tayyor bo'lmagan yozuv — vaqtinchalik, avtomatik qayta sinaladi
        return { text: null, error: msg, transient: true };
      }
      const audioBuffer = Buffer.from(normalized.buffer);

      // 3) Qaysi provayder "asosiy" ekanini owner panelidan o'qiymiz,
      // so'ng shundan boshlab, kerak bo'lsa ikkinchisiga o'tamiz.
      const preferred = await this.getPreferredProvider();
      const order: SttProvider[] = preferred === 'groq' ? ['groq', 'openai'] : ['openai', 'groq'];

      let lastResult: TranscribeResult | null = null;
      for (const provider of order) {
        const key = provider === 'groq' ? this.groqKey : this.openaiKey;
        if (!key) continue; // bu provayderning kaliti yo'q — o'tkazib yuboramiz
        const result = await this.callProvider(provider, key, audioBuffer);
        if (result.text != null || !result.transient) {
          // Muvaffaqiyatli YOKI "qat'iy" xato (qayta urinish foydasiz) —
          // ikkinchi provayderga o'tishning hojati yo'q.
          return result;
        }
        // Vaqtinchalik xato — boshqa provayderni sinab ko'ramiz.
        lastResult = result;
        this.logger.warn(`${provider} orqali transkripsiya vaqtincha ishlamadi, boshqa provayder sinaladi (agar mavjud bo'lsa): ${result.error}`);
      }

      return lastResult || { text: null, error: 'Hech qanday STT provayder sozlanmagan (GROQ_API_KEY/OPENAI_API_KEY yo\'q).' };
    } catch (e: any) {
      const msg = `Transkripsiya xatosi: ${e?.message}`;
      this.logger.warn(msg);
      return { text: null, error: msg, transient: true };
    }
  }

  /**
   * Bitta provayderga (Groq yoki OpenAI) audio yuboradi. Ikkalasi ham
   * OpenAI bilan BIR XIL `multipart/form-data` formatini kutadi —
   * shuning uchun bu funksiya ikkalasiga ham xizmat qiladi, faqat URL
   * va model nomi farq qiladi.
   */
  private async callProvider(provider: SttProvider, apiKey: string, audioBuffer: Buffer): Promise<TranscribeResult> {
    const endpoint = provider === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://api.openai.com/v1/audio/transcriptions';
    // Groq: whisper-large-v3-turbo — OpenAI'ning whisper-1'iga qaraganda
    // ~9x arzon va aslida sifat jihatdan ham teng/yaxshiroq (Large v3).
    const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

    // v21: auto-detect (language yubormaslik) ba'zan noto'g'ri tilni
    // "topib" (masalan Rumincha) chalkash matn qaytarardi. Whisper
    // o'zbek tilini qo'llab-quvvatlamagani uchun eng yaqin va yaxshi
    // qo'llab-quvvatlanadigan til — rus tiliga majburlaymiz (O'zbekistonda
    // aralash o'zbek-rus nutq ko'p uchraydi, Whisper buni rus sifatida
    // ancha to'g'ri tanib oladi — auto-detect'ga qaraganda barqarorroq).
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/mpeg' });
    form.append('file', blob, 'recording.mp3');
    form.append('model', model);
    form.append('language', 'ru');
    form.append('response_format', 'json');

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form as any,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const msg = `${provider === 'groq' ? 'Groq' : 'OpenAI'} Whisper API xato (HTTP ${res.status}): ${text.slice(0, 300)}`;
        this.logger.warn(msg);
        // 5xx / 429 — vaqtinchalik server yuklamasi, boshqa provayder/qayta urinish bilan tuzalishi mumkin
        return { text: null, error: msg, transient: res.status >= 500 || res.status === 429 };
      }

      const j: any = await res.json();
      const text = String(j?.text || '').trim();
      if (!text || text.length < 5) {
        // Xato emas — qo'ng'iroqda gap-so'z kam bo'lgani uchun bo'lishi mumkin,
        // shuning uchun "error" emas, shunchaki bo'sh natija qaytaramiz.
        return { text: null };
      }
      return { text };
    } catch (e: any) {
      const msg = `${provider === 'groq' ? 'Groq' : 'OpenAI'} so'rovida tarmoq xatosi: ${e?.message}`;
      this.logger.warn(msg);
      return { text: null, error: msg, transient: true };
    }
  }
}

@Module({
  providers: [TranscriptionService],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}