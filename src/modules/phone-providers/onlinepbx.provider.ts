import { Logger } from '@nestjs/common';
import {
  IPhoneProvider,
  CallInitiateOptions,
  CallInitiateResult,
  WebhookEvent,
} from './provider.interface';

/**
 * ═══════════════════════════════════════════════════════════════
 * OnlinePBX provayderi — API 2.0 (api2.onlinepbx.ru)
 * ═══════════════════════════════════════════════════════════════
 *
 * ⚠️ MUHIM TARIX: bu fayl ilgari `{domain}/Mobile/v3/Calls/originate`
 * manziliga `X-API-KEY`/`X-API-ID` header'lari bilan so'rov yuborardi.
 * Bunday endpoint OnlinePBX'da MAVJUD EMAS — kod taxmin asosida
 * yozilgan edi va hech qachon ishlamagan.
 *
 * ── TASDIQLANGAN (rasmiy hujjat bo'yicha) ──────────────────────
 *   Bazaviy manzil:  https://api2.onlinepbx.ru/{domain}/...
 *   Autentifikatsiya: POST {domain}/auth.json  →  { key_id, key }
 *   Keyingi so'rovlar header'i:  x-pbx-authentication: key_id:key
 *   Qo'ng'iroqlar tarixi: POST {domain}/mongo_history/search.json
 *   Eski API 1.0 (HMAC) 2020-yil 1-apreldan buyon ishlamaydi.
 *
 * ── TASDIQLANMAGAN ─────────────────────────────────────────────
 *   Qo'ng'iroq boshlash (callback/originate) endpointining ANIQ nomi
 *   va tanasi. Shu sababli u QATTIQ YOZILMAGAN — `originatePath`
 *   sozlamasi orqali o'zgartiriladi (standart: command/reverse.json).
 *
 *   Aniq qiymatni bilish uchun:
 *     https://api2.onlinepbx.ru/documentation  (Swagger)
 *     yoki support@onlinepbx.ru
 *
 *   `testConnection()` faqat TASDIQLANGAN auth.json'ni tekshiradi —
 *   shuning uchun u ishlasa, domen va API kalit to'g'ri degani.
 * ═══════════════════════════════════════════════════════════════
 */

interface OnlinePbxConfig {
  domain?: string;      // masalan: kompaniya.onpbx.ru
  apiKey?: string;      // Kabinet → Интеграция → API
  callerId?: string;    // mijoz ko'radigan raqam
  recordingEnabled?: boolean;
  /** Qo'ng'iroq boshlash endpointi (tasdiqlanmagan — sozlanadi) */
  originatePath?: string;
  /** Eski sozlama — endi ishlatilmaydi, moslik uchun qoldirilgan */
  apiId?: string;
}

/** Auth tokeni qancha vaqt keshda turadi (OnlinePBX odatda uzoqroq beradi) */
const AUTH_TTL_MS = 20 * 60 * 1000; // 20 daqiqa

const DEFAULT_ORIGINATE_PATH = 'command/reverse.json';

export class OnlinePbxProvider implements IPhoneProvider {
  name = 'ONLINEPBX';
  private readonly logger = new Logger('OnlinePBX');
  private config: OnlinePbxConfig | null;

  /** key_id:key keshi — har so'rovda auth.json chaqirmaslik uchun */
  private auth: { header: string; at: number } | null = null;

  constructor(config: OnlinePbxConfig | null) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.config?.domain && this.config?.apiKey);
  }

  /** Domenni tozalaydi: "https://x.onpbx.ru/" → "x.onpbx.ru" */
  private get domain(): string {
    return String(this.config?.domain || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .trim();
  }

  private url(path: string): string {
    const p = String(path || '').replace(/^\/+/, '');
    return `https://api2.onlinepbx.ru/${this.domain}/${p}`;
  }

  // ─────────────────────────────────────────────────────────────
  // AUTENTIFIKATSIYA (tasdiqlangan)
  // ─────────────────────────────────────────────────────────────

  /**
   * auth.json orqali key_id va key oladi.
   * Natija keshlanadi — har qo'ng'iroqda qayta so'ralmaydi.
   */
  private async getAuthHeader(force = false): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(
        "OnlinePBX sozlanmagan. Sozlamalar → Telefoniya: domen va API kalit kiriting.",
      );
    }

    if (!force && this.auth && Date.now() - this.auth.at < AUTH_TTL_MS) {
      return this.auth.header;
    }

    const res = await this.request(this.url('auth.json'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_key: this.config!.apiKey }),
    });

    if (!res.ok) {
      throw new Error(
        `OnlinePBX autentifikatsiya xatosi (HTTP ${res.status}). ` +
        `Domen va API kalitni tekshiring: ${res.text.slice(0, 200)}`,
      );
    }

    // Javob shakli turlicha bo'lishi mumkin — bir nechta variantni tekshiramiz
    const j: any = res.json || {};
    const data = j.data || j.result || j;
    const keyId = data.key_id || data.keyId;
    const key = data.key;

    if (!keyId || !key) {
      throw new Error(
        `OnlinePBX auth.json kutilgan key_id/key qaytarmadi. Javob: ${JSON.stringify(j).slice(0, 200)}`,
      );
    }

    this.auth = { header: `${keyId}:${key}`, at: Date.now() };
    return this.auth.header;
  }

  /** Autentifikatsiyalangan so'rov. 401 bo'lsa bir marta qayta urinadi. */
  private async authed(path: string, body: any, retry = true): Promise<any> {
    const header = await this.getAuthHeader();
    const res = await this.request(this.url(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pbx-authentication': header,
      },
      body: JSON.stringify(body || {}),
    });

    // Token eskirgan bo'lsa — yangilab qayta urinamiz
    if ((res.status === 401 || res.status === 403) && retry) {
      this.auth = null;
      return this.authed(path, body, false);
    }

    if (!res.ok) {
      throw new Error(`OnlinePBX xato (HTTP ${res.status}): ${res.text.slice(0, 250)}`);
    }
    return res.json;
  }

  /** fetch o'rami — timeout va xavfsiz JSON parse bilan */
  private async request(url: string, init: any) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const r = await fetch(url, { ...init, signal: controller.signal as any });
      const text = await r.text().catch(() => '');
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* JSON emas */ }
      return { ok: r.ok, status: r.status, text, json };
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? "So'rov vaqti tugadi (20s)" : e?.message;
      throw new Error(`OnlinePBX ulanish xatosi: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ULANISHNI TEKSHIRISH (faqat tasdiqlangan endpoint)
  // ─────────────────────────────────────────────────────────────

  /**
   * Domen va API kalit to'g'riligini tekshiradi.
   * Bu FAQAT auth.json'ni ishlatadi — u rasmiy hujjatda tasdiqlangan,
   * shuning uchun natijaga ishonish mumkin.
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.getAuthHeader(true);
      return {
        success: true,
        message: `OnlinePBX ulanishi muvaffaqiyatli (${this.domain})`,
      };
    } catch (e: any) {
      return { success: false, message: e?.message || "Noma'lum xato" };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // QO'NG'IROQ TARIXI (tasdiqlangan) — kiruvchi qo'ng'iroqlar uchun
  // ─────────────────────────────────────────────────────────────

  /**
   * Qo'ng'iroqlar tarixini oladi (mongo_history/search.json).
   *
   * Bu KIRUVCHI qo'ng'iroqlarni CRM'ga tushirish uchun ishlatiladi —
   * webhook faqat mavjud yozuvni yangilaydi, kiruvchini yaratmaydi.
   *
   * @param fromDate — shu sanadan keyingi qo'ng'iroqlar
   */
  async fetchHistory(fromDate: Date, limit = 200): Promise<any[]> {
    const j = await this.authed('mongo_history/search.json', {
      start_stamp_from: Math.floor(fromDate.getTime() / 1000),
      limit,
    });
    const data = j?.data || j?.result || j;
    return Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  }

  // ─────────────────────────────────────────────────────────────
  // QO'NG'IROQ BOSHLASH
  // ─────────────────────────────────────────────────────────────

  /**
   * Callback usuli: avval AGENTNING ichki raqami jiringlaydi,
   * u ko'targach mijozga ulanadi. OnlinePBX integratsiyalarida
   * (RetailCRM, SalesMan va h.k.) aynan shu usul qo'llaniladi.
   *
   * ⚠️ Endpoint nomi tasdiqlanmagan — `originatePath` orqali sozlanadi.
   * Xato bo'lsa foydalanuvchiga TUSHUNARLI xabar qaytadi (jimgina
   * ishlamay qolmaydi).
   */
  async initiate(options: CallInitiateOptions): Promise<CallInitiateResult> {
    if (!this.isConfigured()) {
      throw new Error('OnlinePBX sozlanmagan. Sozlamalar → Telefoniya');
    }
    if (!options.agentExtension) {
      throw new Error(
        "Agentning ichki raqami (extension) kiritilmagan. " +
        "Sozlamalar → Profil → 'ATS ichki raqam' (masalan, 101)",
      );
    }

    const to = this.normalizePhone(options.toPhone);
    const path = this.config?.originatePath || DEFAULT_ORIGINATE_PATH;

    const body: any = {
      from: options.agentExtension, // avval agent jiringlaydi
      to,                            // keyin mijozga ulanadi
    };
    if (this.config?.callerId) body.callerid = this.config.callerId;

    let j: any;
    try {
      j = await this.authed(path, body);
    } catch (e: any) {
      // Endpoint topilmasa — aniq yo'l ko'rsatuvchi xabar beramiz
      if (/HTTP 404|HTTP 400/.test(e?.message || '')) {
        throw new Error(
          `OnlinePBX qo'ng'iroq endpointi qabul qilmadi ("${path}"). ` +
          `Sozlamalarda "originatePath" qiymatini OnlinePBX hujjatidagi ` +
          `to'g'ri manzilga o'zgartiring (https://api2.onlinepbx.ru/documentation). ` +
          `Asl xato: ${e.message}`,
        );
      }
      throw e;
    }

    const data = j?.data || j?.result || j || {};
    const callId =
      data.uuid || data.call_id || data.callId || data.id ||
      // ID qaytmasa ham qo'ng'iroq ketgan bo'lishi mumkin —
      // vaqtinchalik ID beramiz, webhook keyin moslashtiradi
      `opbx-${Date.now()}`;

    return {
      providerCallId: String(callId),
      status: data.status || 'queued',
      raw: j,
    };
  }

  async hangup(providerCallId: string): Promise<void> {
    try {
      await this.authed('command/hangup.json', { uuid: providerCallId });
    } catch (e: any) {
      // Tugatish ishlamasa ham asosiy oqim buzilmasin
      this.logger.warn(`OnlinePBX hangup xato: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // WEBHOOK
  // ─────────────────────────────────────────────────────────────

  /**
   * OnlinePBX webhook'ini o'qiydi.
   *
   * Maydon nomlari o'rnatmaga qarab farq qilishi mumkin, shuning uchun
   * bir nechta variantni tekshiramiz. Kerakli ID topilmasa — null
   * qaytaramiz (soxta yozuv yaratilmaydi).
   */
  parseWebhook(body: any): WebhookEvent | null {
    if (!body || typeof body !== 'object') return null;

    const providerCallId =
      body.uuid || body.call_id || body.callId || body.id || body.callUuid;
    if (!providerCallId) return null;

    const raw = String(
      body.status || body.call_status || body.disposition || body.hangup_cause || '',
    ).toLowerCase();

    const status: WebhookEvent['status'] =
      /answer|complete|success|normal_clearing/.test(raw) ? 'completed'
      : /busy|user_busy/.test(raw) ? 'busy'
      : /no_?answer|noanswer|timeout/.test(raw) ? 'no_answer'
      : /cancel/.test(raw) ? 'canceled'
      : /fail|error|congestion/.test(raw) ? 'failed'
      : /ring/.test(raw) ? 'ringing'
      : /progress|talk|bridge/.test(raw) ? 'in_progress'
      : 'completed';

    const durationRaw =
      body.duration_seconds ?? body.duration ?? body.billsec ?? body.talk_time;
    const duration = Number(durationRaw);

    return {
      providerCallId: String(providerCallId),
      status,
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
      recordingUrl:
        body.recording_url || body.recording || body.record_url || body.file_url || undefined,
      raw: body,
    };
  }

  async getRecordingUrl(providerCallId: string): Promise<string | null> {
    try {
      const j = await this.authed('mongo_history/search.json', { uuid: providerCallId });
      const data = j?.data || j?.result || j;
      const item = Array.isArray(data) ? data[0] : data;
      return item?.recording_url || item?.record_url || item?.file_url || null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────

  /** O'zbek raqamlarini E.164 ga keltiradi */
  private normalizePhone(input: string): string {
    let p = String(input || '').replace(/[^\d+]/g, '');
    if (p.startsWith('+')) return p;
    if (p.startsWith('998')) return '+' + p;
    // 901234567 (9 xona) → +998901234567
    if (p.length === 9) return '+998' + p;
    // 8901234567 → +998901234567
    if (p.length === 10 && p.startsWith('8')) return '+998' + p.slice(1);
    return '+' + p;
  }
}