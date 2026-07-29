import { Module, Injectable, Logger } from '@nestjs/common';

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
   * Xato bo'lsa — `null` qaytaradi (chaqiruvchi tomon jim o'tkazib
   * yuborishi kerak, butun cron'ni to'xtatmasligi uchun).
   */
  async transcribeFromUrl(recordingUrl: string): Promise<string | null> {
    if (!this.apiKey) return null;
    if (!/^https?:\/\//i.test(recordingUrl)) return null;

    try {
      // 1) Audio faylni yuklab olamiz
      const audioRes = await fetch(recordingUrl);
      if (!audioRes.ok) {
        this.logger.warn(`Audio yuklab bo'lmadi (HTTP ${audioRes.status}): ${recordingUrl.slice(0, 100)}`);
        return null;
      }
      const contentLength = Number(audioRes.headers.get('content-length') || 0);
      // Whisper API cheklovi ~25MB — undan katta fayllarni o'tkazib yuboramiz
      if (contentLength && contentLength > 24 * 1024 * 1024) {
        this.logger.warn(`Audio juda katta (${contentLength} bayt) — o'tkazib yuborildi`);
        return null;
      }
      const arrayBuf = await audioRes.arrayBuffer();
      if (!arrayBuf || arrayBuf.byteLength < 500) return null; // bo'sh/buzuq fayl

      // 2) Whisper'ga yuboramiz
      const form = new FormData();
      const contentType = audioRes.headers.get('content-type') || 'audio/mpeg';
      const blob = new Blob([arrayBuf], { type: contentType });
      form.append('file', blob, 'recording.mp3');
      form.append('model', 'whisper-1');
      form.append('language', 'uz'); // O'zbek tili
      form.append('response_format', 'json');

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form as any,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn(`Whisper API xato (HTTP ${res.status}): ${text.slice(0, 300)}`);
        return null;
      }

      const j: any = await res.json();
      const text = String(j?.text || '').trim();
      if (!text || text.length < 5) return null;
      return text;
    } catch (e: any) {
      this.logger.warn(`Transkripsiya xatosi: ${e?.message}`);
      return null;
    }
  }
}

@Module({
  providers: [TranscriptionService],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}