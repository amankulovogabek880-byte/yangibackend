import { Logger } from '@nestjs/common';
import {
  IPhoneProvider,
  CallInitiateOptions,
  CallInitiateResult,
  WebhookEvent,
} from './provider.interface';

/**
 * ═══════════════════════════════════════════════════════════════
 * Мои Звонки (moizvonki.ru) provayderi — "Облако Технологий"
 * ═══════════════════════════════════════════════════════════════
 *
 * NIMA UCHUN BU PROVAYDER BOSHQACHA ISHLAYDI:
 * OnlinePBX/Twilio kabi bulutli ATS emas — qo'ng'iroqning O'ZI har
 * bir agentning shaxsiy Android telefoni orqali, mobil operator
 * tarifi bilan amalga oshadi. Bizning CRM faqat ikkita narsa qiladi:
 *   1) Terishni BOSHLAB BERADI (agent telefoniga buyruq yuboradi)
 *   2) Qo'ng'iroq tugagach, natijani (davomiylik + ovozli yozuv
 *      havolasi) WEBHOOK orqali QABUL QILADI va mijoz kartochkasiga
 *      biriktiradi.
 * Shuning uchun bu yerda OnlinePBX'dagi kabi WebSocket/hangup yo'q —
 * qo'ng'iroqni tugatish ham jismoniy telefonda bo'ladi.
 *
 * ── TASDIQLANGAN (moizvonki.ru rasmiy sayti + hamkorlar hujjati, 2026) ──
 *   • Xizmat mavjud va O'zbekistonda ishlaydi (hamkorlar orasida
 *     "Uysot" — business.uysot.uz — O'zbek CRM'i ham bor).
 *   • Ochiq API manzili: https://api.moizvonki.ru/
 *   • Har bir hisobning O'ZINING API manzili va API kaliti bor —
 *     булар Shaxsiy kabinet → Sozlamalar → Integratsiya sahifasida
 *     ko'rsatiladi (login qilgandan keyin).
 *   • So'rov namunasi (rasmiy hujjatdan ko'chirilgan parcha):
 *       POST /api/v1  Host: {hisobingiz}.moizvonki.ru
 *       Content-Type: application/json
 *       { "user_name": "sizning@emailingiz", ... }
 *   • Narx: 175₽/qurilma/oyiga (yozuvsiz), 230₽/qurilma/oyiga
 *     (ovozli yozuv bilan) — 20 kunlik bepul sinov, kartasiz.
 *   • Ovozli yozuv serverda 30 kun saqlanadi (yoki cheksiz —
 *     o'zingizning Yandex/Google diskingizni ulasangiz).
 *   • Faqat ODDIY qo'ng'iroqlar yoziladi (messenjer orqali gaplashuv
 *     emas).
 *
 * ── HALI TO'LIQ TASDIQLANMAGAN (hisob ochilgach aniqlash kerak) ──
 *   1) `user_name`dan KEYINGI aniq maydon nomlari (API kaliti,
 *      qo'ng'iroq raqami, harakat turi) — rasmiy hujjat login talab
 *      qiladi, tashqaridan to'liq ko'rib bo'lmadi. Shu sabab quyida
 *      BIR NECHTA ehtimoliy nom BIRGA yuborilyapti (ortiqcha
 *      maydonlar odatda e'tiborsiz qoldiriladi — xuddi shu usul
 *      OnlinePBX provayderida ham auth uchun ishlatilgan).
 *   2) Webhook payload shakli — moizvonki.ru "Integratsiya" sahifasi
 *      "boshqa tizim" (custom CRM) uchun ham webhook/qaytish
 *      mexanizmini ko'rsatadi, lekin ANIQ maydon nomlari hisobga xos
 *      sahifada.
 *
 *   Hisob ochilgach: Sozlamalar → Integratsiya sahifasidagi "API
 *   manzili" va "API kaliti"ni CRM Sozlamalar → Telefoniya bo'limiga
 *   kiriting, so'ng "Ulanishni tekshirish" tugmasini bosing — agar
 *   javob formati mos kelmasa, xato xabarida SERVERNING XOM javobi
 *   ko'rsatiladi (pastda `testConnection`), shu orqali aniq maydon
 *   nomini bilib, osongina moslashtirish mumkin (kod qayta yozishga
 *   ehtiyoj yo'q — faqat quyidagi FIELD_CANDIDATES ro'yxatini kengaytirish kifoya).
 * ═══════════════════════════════════════════════════════════════
 */

interface MoiZvonkiConfig {
  subdomain?: string;
  apiKey?: string;
  adminEmail?: string;
  recordingEnabled?: boolean;
  employeeEmailMap?: Record<string, string>;
}

export class MoiZvonkiProvider implements IPhoneProvider {
  name = 'MOIZVONKI';
  private readonly logger = new Logger('MoiZvonki');
  private config: MoiZvonkiConfig | null;

  constructor(config: MoiZvonkiConfig | null) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.config?.subdomain && this.config?.apiKey && this.config?.adminEmail);
  }

  /** "kompaniya" yoki "https://kompaniya.moizvonki.ru/" → "kompaniya.moizvonki.ru" */
  private get host(): string {
    let s = String(this.config?.subdomain || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .trim();
    if (!s) return '';
    return s.includes('.moizvonki.ru') ? s : `${s}.moizvonki.ru`;
  }

  private get baseUrl(): string {
    return `https://${this.host}/api/v1`;
  }

  /** fetch o'rami — timeout va xavfsiz JSON parse bilan (OnlinePBX provayderidagi bilan bir xil naqsh) */
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
      throw new Error(`Мои Звонки ulanish xatosi: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Moizvonki.ru hisobidagi xodim (employee) email'ini topadi.
   * Avval xarita (`employeeEmailMap`) tekshiriladi, topilmasa CRM
   * agentining o'z emaili ishlatiladi (agar u moizvonki.ru'da xuddi
   * shu email bilan ro'yxatdan o'tgan bo'lsa — bu odatiy holat).
   */
  private resolveEmployeeEmail(crmAgentEmail: string): string {
    return this.config?.employeeEmailMap?.[crmAgentEmail] || crmAgentEmail;
  }

  // ─────────────────────────────────────────────────────────────
  // ULANISHNI TEKSHIRISH
  // ─────────────────────────────────────────────────────────────

  /**
   * Sozlamalar to'g'riligini tekshiradi. Aniq "auth" endpointi hali
   * tasdiqlanmagani uchun oddiy so'rov yuborib, SERVER JAVOBINI
   * (status kodi + matn) qaytaramiz — shunda admin darhol ko'radi:
   * "401" bo'lsa kalit noto'g'ri, "404" bo'lsa manzil/yo'l noto'g'ri,
   * va hokazo. Bu — taxminiy maydon nomlarini tuzatishda eng tezkor yo'l.
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.config?.subdomain) {
      return { success: false, message: "Hisob subdomeni kiritilmagan (masalan: 'kompaniya')" };
    }
    if (!this.config?.apiKey) {
      return { success: false, message: 'API kaliti kiritilmagan' };
    }
    if (!this.config?.adminEmail) {
      return { success: false, message: 'Admin email (hisob egasi) kiritilmagan' };
    }

    try {
      const res = await this.request(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_name: this.config.adminEmail,
          api_key: this.config.apiKey,
          key: this.config.apiKey,
          action: 'ping',
        }),
      });

      if (res.status === 404) {
        return {
          success: false,
          message: `Manzil topilmadi (404): ${this.baseUrl}. Subdomenni tekshiring — ` +
            `Sozlamalar → Integratsiya sahifasidagi "API manzili" bilan solishtiring.`,
        };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          success: false,
          message: `Ruxsat rad etildi (${res.status}). API kaliti yoki admin email noto'g'ri bo'lishi mumkin. ` +
            `Server javobi: ${res.text.slice(0, 200)}`,
        };
      }

      return {
        success: res.ok,
        message: res.ok
          ? `Server javob berdi (${this.host}). Agar qo'ng'iroq baribir ishlamasa, quyidagi xom javobni ` +
            `menga yuboring, aniq maydon nomlarini moslashtiraman: ${res.text.slice(0, 300)}`
          : `Server xatosi (HTTP ${res.status}): ${res.text.slice(0, 300)}`,
      };
    } catch (e: any) {
      return { success: false, message: e?.message || "Noma'lum xato" };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // QO'NG'IROQ BOSHLASH (Click-to-Call)
  // ─────────────────────────────────────────────────────────────

  /**
   * ⚠️ TAXMINIY so'rov shakli (aniq maydon nomlari hisobga xos —
   * yuqoridagi izohga qarang). Bir nechta ehtimoliy maydon nomi
   * BIRGA yuboriladi — noma'lum/keraksiz maydonlar odatda server
   * tomonidan e'tiborsiz qoldiriladi, shuning uchun bu zarar
   * keltirmaydi, faqat moslikni oshiradi.
   */
  async initiate(options: CallInitiateOptions): Promise<CallInitiateResult> {
    if (!this.isConfigured()) {
      throw new Error(
        "Мои Звонки sozlanmagan. Sozlamalar → Telefoniya: subdomen, API kalit va admin email kiriting.",
      );
    }

    const employeeEmail = this.resolveEmployeeEmail(options.agentEmail || '');
    if (!employeeEmail) {
      throw new Error(
        "Agentning email manzili aniqlanmadi. Agentning CRM profilida email to'ldirilganiga ishonch hosil qiling.",
      );
    }

    const to = this.normalizePhone(options.toPhone);

    const body: Record<string, any> = {
      user_name: this.config!.adminEmail,
      api_key: this.config!.apiKey,
      key: this.config!.apiKey,
      auth_key: this.config!.apiKey,
      // Harakat turi — aniq nomi tasdiqlanmagani uchun ikkalasi ham yuboriladi
      action: 'make_call',
      method: 'make_call',
      // Qaysi xodim telefoni terishi kerak
      employee: employeeEmail,
      employee_email: employeeEmail,
      user: employeeEmail,
      // Qo'ng'iroq qilinadigan raqam
      phone: to,
      to,
      number: to,
    };

    const res = await this.request(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `Мои Звонки qo'ng'iroqni boshlay olmadi (HTTP ${res.status}). ` +
          `Server javobi: ${res.text.slice(0, 250)}. ` +
          `Sozlamalar → Telefoniya → "Ulanishni tekshirish" orqali xom javobni ko'ring.`,
      );
    }

    // Javobdan call ID'ni topishga harakat qilamiz — topilmasa vaqtinchalik ID yaratamiz
    // (webhook kelganda providerCallId bo'yicha moslashtirib bo'lmasa, u baribir
    // yangi kiruvchi/chiquvchi yozuv sifatida qayd etiladi — ma'lumot yo'qolmaydi).
    const j = res.json || {};
    const callId =
      j?.data?.id || j?.data?.call_id || j?.call_id || j?.id || `mz-${Date.now()}`;

    return {
      providerCallId: String(callId),
      status: 'queued',
      raw: j,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // WEBHOOK — qo'ng'iroq tugagach kelgan ma'lumot
  // ─────────────────────────────────────────────────────────────

  /**
   * ⚠️ TAXMINIY payload shakli — moizvonki.ru "Integratsiya" sahifasi
   * har bir hisobga xos webhook formatini ko'rsatadi (login talab
   * qiladi). Quyida eng ehtimoliy maydon nomlari (bir nechta variant)
   * tekshiriladi. Agar mos kelmasa, webhookni CRM serverida logga
   * yozib (calls.module.ts → handleMoiZvonkiWebhook) xom JSON'ni
   * ko'rish va shu ro'yxatni kengaytirish kifoya.
   */
  parseWebhook(body: any): WebhookEvent | null {
    if (!body || typeof body !== 'object') return null;
    const d = body.data && typeof body.data === 'object' ? body.data : body;

    const providerCallId = d.call_id || d.callId || d.id || d.uuid;
    if (!providerCallId) return null;

    const rawStatus = String(d.status || d.call_status || d.disposition || '').toLowerCase();
    const status: WebhookEvent['status'] =
      /answer|complete|success/.test(rawStatus) ? 'completed'
      : /busy/.test(rawStatus) ? 'busy'
      : /no_?answer|missed/.test(rawStatus) ? 'no_answer'
      : /fail|error/.test(rawStatus) ? 'failed'
      : /ring/.test(rawStatus) ? 'ringing'
      : /progress|talk/.test(rawStatus) ? 'in_progress'
      : 'completed';

    const durationRaw = d.duration ?? d.talk_time ?? d.call_duration;
    const duration = Number(durationRaw);

    return {
      providerCallId: String(providerCallId),
      status,
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
      recordingUrl: d.recording_url || d.recording || d.record_url || d.audio_url || undefined,
      raw: body,
    };
  }

  /**
   * Bu yordamchi metod — asosiy IPhoneProvider interfeysida yo'q,
   * lekin calls.module.ts'dagi maxsus MoiZvonki webhook handleri
   * yo'nalish (INBOUND/OUTBOUND), mijoz raqami va xodim email'ini
   * shu yerdan (xom body'dan) o'qiydi, chunki umumiy `WebhookEvent`
   * interfeysida bu maydonlar yo'q (faqat OnlinePBX/Twilio uchun
   * mo'ljallangan).
   */
  parseWebhookDetails(body: any): {
    direction?: 'INBOUND' | 'OUTBOUND';
    fromPhone?: string;
    toPhone?: string;
    employeeEmail?: string;
  } {
    const d = (body?.data && typeof body.data === 'object' ? body.data : body) || {};
    const dirRaw = String(d.direction || d.call_direction || d.type || '').toLowerCase();
    const direction = dirRaw.includes('in') ? 'INBOUND' : dirRaw.includes('out') ? 'OUTBOUND' : undefined;
    return {
      direction,
      fromPhone: d.from || d.caller || d.caller_number || d.src,
      toPhone: d.to || d.callee || d.called_number || d.dst,
      employeeEmail: d.employee || d.employee_email || d.user || d.user_name,
    };
  }

  /** O'zbek raqamlarini E.164 ga keltiradi (OnlinePBX provayderidagi bilan bir xil) */
  private normalizePhone(input: string): string {
    let p = String(input || '').replace(/[^\d+]/g, '');
    if (p.startsWith('+')) return p;
    if (p.startsWith('998')) return '+' + p;
    if (p.length === 9) return '+998' + p;
    if (p.length === 10 && p.startsWith('8')) return '+998' + p.slice(1);
    return '+' + p;
  }
}