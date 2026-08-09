import { Module, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeAudioForWhisper } from '../../common/utils/voice-convert';


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

 
  private async getPreferredProvider(): Promise<SttProvider> {
    try {
      const row = await this.prisma.platformSetting.findUnique({ where: { key: 'sttProvider' } });
      if (row?.value === 'openai' || row?.value === 'groq') return row.value;
    } catch (e: any) {
      this.logger.warn(`sttProvider sozlamasi o'qilmadi (standart: groq): ${e.message}`);
    }
    return 'groq';
  }

  /**
   * v22: Whisper'ga yuboriladigan til kodi — endi qattiq kodlanmagan,
   * `platformSetting` (kalit: 'sttLanguage') orqali sozlanadi, standart
   * 'uz' (o'zbek). Agar kelajakda boshqa til (masalan aralash rus nutqi
   * ko'p bo'lgan filial uchun 'ru') kerak bo'lsa, buni owner panelidan
   * kodni o'zgartirmasdan sozlash mumkin bo'ladi.
   */
  private async getSttLanguage(): Promise<string> {
    try {
      const row = await this.prisma.platformSetting.findUnique({ where: { key: 'sttLanguage' } });
      const v = String(row?.value || '').trim().toLowerCase();
      if (v && /^[a-z]{2}$/.test(v)) return v;
    } catch (e: any) {
      this.logger.warn(`sttLanguage sozlamasi o'qilmadi (standart: uz): ${e.message}`);
    }
    return 'uz';
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

      return this.transcribeBuffer(Buffer.from(arrayBuf));
    } catch (e: any) {
      const msg = `Transkripsiya xatosi: ${e?.message}`;
      this.logger.warn(msg);
      return { text: null, error: msg, transient: true };
    }
  }

  
  async transcribeBuffer(rawBuffer: Buffer): Promise<TranscribeResult> {
    if (!this.isConfigured()) {
      return { text: null, error: "GROQ_API_KEY yoki OPENAI_API_KEY sozlanmagan (audio matnga o'girish uchun kerak, bu ANTHROPIC_API_KEY'dan ALOHIDA kalit)." };
    }
    if (!rawBuffer || rawBuffer.byteLength < 500) {
      return { text: null, error: "Audio fayl bo'sh yoki buzilgan (juda kichik hajm)", transient: true };
    }
    if (rawBuffer.byteLength > 24 * 1024 * 1024) {
      return { text: null, error: `Audio juda katta (${Math.round(rawBuffer.byteLength / 1024 / 1024)}MB, limit 25MB)` };
    }

    try {
      // v19: Whisper'ga yuborishdan OLDIN ffmpeg orqali "tozalab" qayta
      // kodlaymiz — brauzerdan kelgan audio ko'pincha nostandart/streaming
      // sarlavhali bo'ladi va Whisper buni to'g'ridan-to'g'ri qabul qilsa
      // "duration":0 xatosi berishi mumkin (garchi brauzerda ijro etilsa ham).
      const normalized = await normalizeAudioForWhisper(rawBuffer);
      if ('error' in normalized) {
        const msg = `Audio tozalashda xato: ${normalized.error}`;
        this.logger.warn(msg);
        return { text: null, error: msg, transient: true };
      }
      const audioBuffer = Buffer.from(normalized.buffer);

      // Qaysi provayder "asosiy" ekanini owner panelidan o'qiymiz,
      // so'ng shundan boshlab, kerak bo'lsa ikkinchisiga o'tamiz.
      const preferred = await this.getPreferredProvider();
      const order: SttProvider[] = preferred === 'groq' ? ['groq', 'openai'] : ['openai', 'groq'];

      const language = await this.getSttLanguage();

      let lastResult: TranscribeResult | null = null;
      for (const provider of order) {
        const key = provider === 'groq' ? this.groqKey : this.openaiKey;
        if (!key) continue; // bu provayderning kaliti yo'q — o'tkazib yuboramiz
        const result = await this.callProvider(provider, key, audioBuffer, language);
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
  private async callProvider(provider: SttProvider, apiKey: string, audioBuffer: Buffer, language: string): Promise<TranscribeResult> {
    const endpoint = provider === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://api.openai.com/v1/audio/transcriptions';
    // Groq: whisper-large-v3-turbo — OpenAI'ning whisper-1'iga qaraganda
    // ~9x arzon va aslida sifat jihatdan ham teng/yaxshiroq (Large v3).
    const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

    // v22 TUZATISH: eski kod tilni MAJBURIY 'ru' (rus) qilib yuborardi —
    // izohda "Whisper o'zbek tilini qo'llab-quvvatlamaydi" deyilgan edi,
    // lekin bu NOTO'G'RI: Whisper large-v3 (demak Groq'ning
    // whisper-large-v3-turbo'si ham, OpenAI whisper-1 ham) rasman 'uz'
    // (o'zbek) tilini qo'llab-quvvatlaydi. Tilni 'ru'ga majburlash
    // natijasida o'zbekcha ovozli xabar RUS FONETIKASI bilan
    // transkripsiya qilinardi — natija chalkash/noto'g'ri matn bo'lardi,
    // Jarvis esa shu buzuq matnni o'qib to'g'ri javob berolmasdi va/yoki
    // o'zi ham chalkash/rus tilida javob qaytarardi.
    //
    // YECHIM: tilni 'uz'ga o'zgartiramiz. Agar kelajakda aralash
    // o'zbek-rus nutq muammo qilsa, buni PLATFORM SOZLAMASI
    // (`platformSetting` — xuddi sttProvider kabi) orqali
    // sozlanadigan qilish mumkin, lekin standart holat endi TO'G'RI
    // tilga (o'zbek) mos.
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/mpeg' });
    form.append('file', blob, 'recording.mp3');
    form.append('model', model);
    form.append('language', language);
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