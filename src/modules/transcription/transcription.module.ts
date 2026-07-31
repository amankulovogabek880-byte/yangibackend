import { Module, Injectable, Logger } from '@nestjs/common';
import { normalizeAudioForWhisper } from '../../common/utils/voice-convert';

/**
 * ═══════════════════════════════════════════════════════════════
 * AVTOMATIK TRANSKRIPSIYA (Speech-to-Text) — v16
 * ═══════════════════════════════════════════════════════════════
 * MUAMMO: Anthropic (Claude) API audio faylni to'g'ridan-to'g'ri
 * qabul qilmaydi — faqat matn/rasm/PDF. Shuning uchun "AI qo'ng'iroqni
 * eshitib tahlil qilishi" uchun oldin ovozni MATNGA aylantirish kerak,
 * keyingina Claude shu matnni tahlil qiladi (calls.module.ts'dagi
 * `analyzeCall`).
 *
 * YECHIM: OpenAI Whisper (`audio/transcriptions`) orqali audio
 * yozuvni (recordingUrl) avtomatik matnga o'giramiz — Whisper
 * o'zbek tilini (til kodi: "uz") qo'llab-quvvatlaydi. Natija
 * `Call.transcript`ga yoziladi va shundan so'ng avtomatik ravishda
 * Claude tahlili (`analyzeCall`) ishga tushadi — AGENT YOKI ADMIN
 * HECH QANDAY QO'LDA HARAKAT QILMAYDI.
 *
 * SOZLASH: .env fayliga qo'shing:
 *   OPENAI_API_KEY=sk-...
 * (Bu ANTHROPIC_API_KEY'dan BOSHQA, alohida kalit — chunki Claude
 * audio qabul qilmaydi. Agar bu kalit sozlanmagan bo'lsa, avtomatik
 * transkripsiya jim o'chirilgan holda qoladi va eski usul — agent
 * qo'lda matn kiritadi — ishlashda davom etadi, hech narsa buzilmaydi.)
 */
@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger('Transcription');

  private get apiKey() {
    return (process.env.OPENAI_API_KEY || '').trim();
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Berilgan audio URL'ni yuklab olib, Whisper orqali matnga o'giradi.
   * v18: avval faqat `string | null` qaytarardi — xato bo'lsa sabab
   * FAQAT server logida qolardi, admin panelida "AI kutmoqda" abadiy
   * osilib qolardi va HECH KIM sababini ko'ra olmasdi. Endi sabab ham
   * qaytariladi — chaqiruvchi (`calls.module.ts`) buni `Call.aiError`ga
   * yozadi, shunda admin/agent buni to'g'ridan-to'g'ri UI'da ko'radi.
   */
  async transcribeFromUrl(recordingUrl: string): Promise<{ text: string | null; error?: string; transient?: boolean }> {
    if (!this.apiKey) {
      return { text: null, error: "OPENAI_API_KEY sozlanmagan (audio matnga o'girish — Whisper — uchun kerak, bu ANTHROPIC_API_KEY'dan ALOHIDA kalit)." };
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

      // 3) Whisper'ga yuboramiz (endi toza mp3, 16kHz mono)
      // v20: 'uz' (o'zbek) tili Whisper API'da QO'LLAB-QUVVATLANMAYDI —
      // OpenAI buni "unsupported_language" xatosi bilan rad etadi.
      // Shu sabab `language` maydonini umuman yubormaymiz — Whisper
      // tilni o'zi avtomatik aniqlaydi (auto-detect). Amaliyotda bu
      // o'zbek/rus aralash nutqda ham yetarlicha yaxshi ishlaydi.
      const form = new FormData();
      const blob = new Blob([new Uint8Array(normalized.buffer)], { type: 'audio/mpeg' });
      form.append('file', blob, 'recording.mp3');
      form.append('model', 'whisper-1');
      form.append('response_format', 'json');

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form as any,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const msg = `Whisper API xato (HTTP ${res.status}): ${text.slice(0, 300)}`;
        this.logger.warn(msg);
        // 5xx / 429 — vaqtinchalik server yuklamasi, qayta urinsa bo'ladi
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
      const msg = `Transkripsiya xatosi: ${e?.message}`;
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