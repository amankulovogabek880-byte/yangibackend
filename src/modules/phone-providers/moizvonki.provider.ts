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
 *      havolasi) SO'RAB OLADI (pastga qarang — sabab bilan).
 *
 * ── ✅ TO'LIQ TASDIQLANGAN (rasmiy moizvonki.ru integratsiya kodi
 *    orqali, PHP/Yii2 komponenti — moizvonki.ru/guide/api/ hujjatiga
 *    asoslangan, 2026) ──
 *
 *   Yagona endpoint: POST https://{sizning-subdomen}.moizvonki.ru/api/v1
 *   Har doim JSON body, "action" maydoni orqali funksiya tanlanadi:
 *
 *     Umumiy autentifikatsiya (HAR BIR so'rovda bo'lishi shart):
 *       user_name : hisobga kirish uchun EMAIL (admin/xodim emaili)
 *       api_key   : Sozlamalar → Integratsiya sahifasidagi API kaliti
 *
 *     1) Qo'ng'iroq boshlash (Click-to-Call):
 *          action: "calls.make_call"
 *          to:     "+998901234567"   ← qo'ng'iroq qilinadigan raqam
 *        (qaysi XODIM telefoni terishi — hisobga bog'liq: odatda
 *        `user_name`da ko'rsatilgan xodimning O'ZI teradi, shuning
 *        uchun bu yerda `user_name` = AYNAN o'sha agentning
 *        moizvonki.ru email'i, admin emaili emas!)
 *
 *     2) Qo'ng'iroqlar tarixini olish (sana oralig'ida):
 *          action: "calls.list"
 *          from_date, to_date   — UTC timestamp (soniyalarda)
 *          from_offset          — sahifalash uchun boshlang'ich indeks
 *          max_results          — nechta natija
 *          supervised           — 1 = barcha xodimlar, 0 = faqat shu user
 *
 *     3) CRM sinxronizatsiya navbati (YANGI hodisalarni olish —
 *        qo'ng'iroq tugagach yozuv+davomiylik shu orqali keladi):
 *          action: "calls.get_crm_event"
 *          app_name:    integratsiyangiz nomi (o'zingiz tanlaysiz)
 *          max_results: 1-100
 *
 *   Narx: 175₽/qurilma/oyiga (yozuvsiz), 230₽/qurilma/oyiga (ovozli
 *   yozuv bilan) — 20 kunlik bepul sinov, kartasiz. Ovozli yozuv
 *   serverda 30 kun saqlanadi (yoki cheksiz — Yandex/Google Disk
 *   ulansa). Faqat ODDIY qo'ng'iroqlar yoziladi (messenjer emas).
 *
 * ── ⚠️ HALI ANIQLASHTIRISH KERAK ──
 *   `calls.get_crm_event` javobidagi HAR BIR HODISA ichida qaysi
 *   maydonlar borligi (masalan `recording_url`, `duration`, `phone`,
 *   `direction`) — rasmiy misolda so'rov ko'rsatilgan, lekin javob
 *   namunasi yo'q. Shu sabab pastda `parseEvent()` BIR NECHTA
 *   ehtimoliy maydon nomini tekshiradi (xavfsiz — yo'q maydon
 *   shunchaki e'tiborsiz qoldiriladi). Agar CRM'da yozuvlar
 *   to'liq to'lmasa, `testConnection()` orqali qaytgan XOM javobni
 *   menga yuboring — bir necha daqiqada moslashtiraman.
 * ═══════════════════════════════════════════════════════════════
 */

interface MoiZvonkiConfig {
  subdomain?: string;
  apiKey?: string;
  adminEmail?: string;
  recordingEnabled?: boolean;
  employeeEmailMap?: Record<string, string>;
  /** CRM sinxronizatsiya navbati uchun integratsiya nomi (ixtiyoriy — bo'sh bo'lsa "crm" ishlatiladi) */
  appName?: string;
}

export class MoiZvonkiProvider implements IPhoneProvider {
  name = 'MOIZVONKI';
  private readonly logger = new Logger('MoiZvonki');
  private config: MoiZvonkiConfig | null;

  constructor(config: MoiZvonkiConfig | null) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.host && this.apiKey && this.adminEmail);
  }

  /** "kompaniya" yoki "https://kompaniya.moizvonki.ru/" → "kompaniya.moizvonki.ru" */
  private get host(): string {
    let s = String(this.config?.subdomain || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .trim();
    if (!s) return '';
    // Agar kimdir xato qilib "admin@domen" kabi email-shakldagi qiymat
    // kiritib qo'ygan bo'lsa — "@"dan OLDINGI qismni olib tashlaymiz.
    // Aks holda fetch() "Request cannot be constructed from a URL that
    // includes credentials" degan tushunarsiz texnik xato beradi.
    if (s.includes('@')) s = s.split('@').pop() || '';
    return s.includes('.moizvonki.ru') ? s : `${s}.moizvonki.ru`;
  }

  private get baseUrl(): string {
    return `https://${this.host}/api/v1`;
  }

  /**
   * 🩹 MUHIM TUZATISH: sozlamalar formasidan (frontend) yoki
   * moizvonki.ru shaxsiy kabinetidan copy-paste qilinganda, oxiriga
   * yoki boshiga ko'rinmas probel/enter belgisi qo'shilib qolishi
   * odatiy hol — bunday holda API "Username or password is invalid"
   * (403) qaytaradi, garchi qiymat ko'zga to'g'ri ko'ringan taqdirda
   * ham. Shu sabab HAR DOIM trim() qilinadi (avval bu yo'q edi).
   */
  private get apiKey(): string {
    return String(this.config?.apiKey || '').trim();
  }

  private get adminEmail(): string {
    return String(this.config?.adminEmail || '').trim();
  }

  /**
   * fetch o'rami — timeout va xavfsiz JSON parse bilan (OnlinePBX
   * provayderidagi bilan bir xil naqsh).
   *
   * `userNameOverride` — MUHIM: `calls.make_call` uchun bu **albatta**
   * o'sha agentning (kim tugmani bossa, o'shaning) moizvonki.ru login
   * emaili bo'lishi kerak, chunki `user_name` — API AYNAN qaysi
   * xodimning (demak — qaysi jismoniy telefonning) teradigan ekanini
   * shu orqali biladi. Berilmasa, hisob egasining (adminEmail)
   * emaili ishlatiladi — bu faqat hisob darajasidagi umumiy amallar
   * (masalan `calls.get_crm_event`, `testConnection`) uchun to'g'ri.
   */
  private async request(action: string, extra: Record<string, any> = {}, userNameOverride?: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const body = JSON.stringify({
      user_name: (userNameOverride && userNameOverride.trim()) || this.adminEmail,
      api_key: this.apiKey,
      action,
      ...extra,
    });
    try {
      const r = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
        body,
        signal: controller.signal as any,
      });
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
   * Moizvonki.ru hisobidagi xodim (employee) login-emailini topadi.
   * Avval xarita (`employeeEmailMap`) tekshiriladi, topilmasa CRM
   * agentining o'z emaili ishlatiladi (agar u moizvonki.ru'da xuddi
   * shu email bilan ilovaga kirgan bo'lsa — bu odatiy holat).
   */
  private resolveEmployeeEmail(crmAgentEmail: string): string {
    const mapped = this.config?.employeeEmailMap?.[crmAgentEmail];
    return String(mapped || crmAgentEmail || '').trim();
  }

  // ─────────────────────────────────────────────────────────────
  // ULANISHNI TEKSHIRISH
  // ─────────────────────────────────────────────────────────────

  /**
   * ✅ Endi TASDIQLANGAN `calls.get_crm_event` endpointi orqali
   * tekshiradi — bu haqiqiy, mavjud amal, shuning uchun natija
   * ancha ishonchli (avvalgi "ping" taxminidan farqli).
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.host) {
      return { success: false, message: "Hisob subdomeni kiritilmagan (masalan: 'kompaniya')" };
    }
    if (!this.apiKey) {
      return { success: false, message: 'API kaliti kiritilmagan' };
    }
    if (!this.adminEmail) {
      return { success: false, message: 'Admin email (hisob egasi) kiritilmagan' };
    }
    if (String(this.config.subdomain).includes('@')) {
      return {
        success: false,
        message:
          `"Hisob subdomeni" maydonida "@" belgisi bor — bu odatda email ` +
          `manzili tasodifan shu yerga yozib qo'yilganda yuz beradi. ` +
          `Faqat subdomen qismini kiriting (masalan "adsdfdf" yoki ` +
          `"adsdfdf.moizvonki.ru"), email emas.`,
      };
    }

    try {
      const res = await this.request('calls.get_crm_event', {
        app_name: this.config.appName || 'crm',
        max_results: 1,
      });

      if (res.status === 404) {
        return {
          success: false,
          message: `Manzil topilmadi (404): ${this.baseUrl}. Subdomenni tekshiring — ` +
            `Sozlamalar → Integratsiya sahifasidagi "Ваш адрес API" bilan solishtiring.`,
        };
      }
      if (res.status === 401 || res.status === 403) {
        const maskedEmail = this.adminEmail.replace(/(?<=.).(?=[^@]*@)/g, '*');
        const keyLen = this.apiKey.length;
        return {
          success: false,
          message:
            `Ruxsat rad etildi (${res.status}). Server javobi: ${res.text.slice(0, 200)}\n\n` +
            `CRM shu payt AYNAN quyidagilarni yubordi — moizvonki.ru shaxsiy ` +
            `kabinetidagi (Sozlamalar → Integratsiya) qiymatlar bilan solishtiring:\n` +
            `  • Hisob manzili: ${this.host}\n` +
            `  • Admin email:   ${maskedEmail}\n` +
            `  • API kalit:     ${keyLen} ta belgi (agar moizvonki.ru'dagi kalit boshqa ` +
            `uzunlikda bo'lsa — demak eski kalit saqlangan)\n\n` +
            `Eng ko'p uchraydigan sabablar:\n` +
            `  1) Moizvonki.ru shaxsiy kabinetida kimdir API kalitini "Изменить" ` +
            `tugmasi orqali YANGILAGAN — eski kalit endi ishlamaydi, yangisini shu ` +
            `yerga qayta kiritish kerak.\n` +
            `  2) 20 kunlik BEPUL SINOV muddati tugagan va hisob to'lov kutilmoqda — ` +
            `bunday holda moizvonki.ru API'ni butunlay to'xtatadi (403 shu sababdan ham chiqadi).\n` +
            `  3) Email yoki API kalit maydoniga nusxa ko'chirishda ko'rinmas probel/enter ` +
            `qo'shilib qolgan (CRM endi buni avtomatik tozalaydi, lekin baribir maydonlarni ` +
            `qayta kiritib ko'ring).`,
        };
      }
      if (!res.ok) {
        return { success: false, message: `Server xatosi (HTTP ${res.status}): ${res.text.slice(0, 300)}` };
      }

      // moizvonki.ru ba'zan HTTP 200 bilan ichki xato qaytarishi mumkin
      // (masalan {"error": "..."}) — buni ham alohida ko'rsatamiz
      if (res.json?.error) {
        return { success: false, message: `Server xabari: ${JSON.stringify(res.json.error).slice(0, 250)}` };
      }

      return {
        success: true,
        message: `✅ Ulanish muvaffaqiyatli (${this.host}). Endi qo'ng'iroq qilib sinab ko'rishingiz mumkin.`,
      };
    } catch (e: any) {
      return { success: false, message: e?.message || "Noma'lum xato" };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // QO'NG'IROQ BOSHLASH (Click-to-Call) — ✅ TASDIQLANGAN
  // ─────────────────────────────────────────────────────────────

  async initiate(options: CallInitiateOptions): Promise<CallInitiateResult> {
    if (!this.isConfigured()) {
      throw new Error(
        "Мои Звонки sozlanmagan. Sozlamalar → Telefoniya: subdomen, API kalit va admin email kiriting.",
      );
    }

    // ⚠️ MUHIM TUZATISH: bu yerda albatta AGENTNING (admin emas!) emaili
    // ishlatilishi kerak — aks holda tugmani QAYSI agent bossa ham,
    // har doim faqat admin hisobiga bog'langan telefon terardi.
    const employeeEmail = this.resolveEmployeeEmail(options.agentEmail || '');
    if (!employeeEmail) {
      throw new Error(
        "Bu agentning email manzili aniqlanmadi (CRM profilida email bo'sh). " +
          "Мои Звонки xuddi shu email orqali qaysi telefon terishini biladi — " +
          "iltimos, agentning CRM profilida email to'ldirilganiga ishonch hosil qiling.",
      );
    }

    const to = this.normalizePhone(options.toPhone);
    const res = await this.request('calls.make_call', { to }, employeeEmail);

    if (!res.ok) {
      throw new Error(
        `Мои Звонки qo'ng'iroqni boshlay olmadi (HTTP ${res.status}). ` +
          `Server javobi: ${res.text.slice(0, 250)}.`,
      );
    }
    if (res.json?.error) {
      const errText = JSON.stringify(res.json.error).slice(0, 250);
      // Odatiy xato — o'sha email bilan hisobda xodim ro'yxatdan
      // o'tmagan (masalan agent hali moizvonki.ru ilovasiga umuman
      // kirmagan, yoki CRM email'i moizvonki.ru email'idan farq qiladi)
      throw new Error(
        `Мои Звонки: ${errText}. Tekshiring: "${employeeEmail}" — bu agent ` +
          `aynan shu email bilan telefonidagi ilovaga kirganmi? Farqli ` +
          `bo'lsa, Sozlamalar → Telefoniya → Agentlar jadvalida "MoiZvonki ` +
          `email" ustunida to'g'irlang.`,
      );
    }

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
  // CRM SINXRONIZATSIYA — ✅ TASDIQLANGAN endpoint, ⚠️ javob
  // ichidagi HAR BIR HODISA maydonlari hali aniqlashtirilmoqda
  // ─────────────────────────────────────────────────────────────

  /**
   * Yangi qo'ng'iroq hodisalarini navbatdan oladi. `calls.module.ts`
   * ichidagi CRON shu metodni har 2-3 daqiqada chaqiradi (xuddi
   * OnlinePBX'ning `pullInboundForTenant` bilan bir xil naqshda).
   */
  async fetchCrmEvents(maxResults = 50): Promise<any[]> {
    const res = await this.request('calls.get_crm_event', {
      app_name: this.config?.appName || 'crm',
      max_results: maxResults,
    });
    if (!res.ok || res.json?.error) {
      this.logger.warn(`get_crm_event xatosi: HTTP ${res.status} — ${res.text.slice(0, 200)}`);
      return [];
    }
    const j = res.json;
    // Javob shakli turlicha bo'lishi mumkin — eng ehtimoliy variantlar tekshiriladi
    const events = j?.data?.events || j?.events || j?.data || j?.result;
    return Array.isArray(events) ? events : [];
  }

  /**
   * Bitta hodisani bizning umumiy `WebhookEvent` shakliga o'giradi.
   * ⚠️ Maydon nomlari hali 100% tasdiqlanmagan — shuning uchun bir
   * nechta ehtimoliy variant tekshiriladi (xavfsiz: yo'q maydon
   * shunchaki o'tkazib yuboriladi).
   */
  parseEvent(e: any): (WebhookEvent & {
    direction?: 'INBOUND' | 'OUTBOUND';
    fromPhone?: string;
    toPhone?: string;
    employeeEmail?: string;
  }) | null {
    if (!e || typeof e !== 'object') return null;
    const providerCallId = e.call_id || e.id || e.uuid || e.event_id;
    if (!providerCallId) return null;

    const rawStatus = String(e.status || e.call_status || e.disposition || '').toLowerCase();
    const status: WebhookEvent['status'] =
      /busy/.test(rawStatus) ? 'busy'
      : /no_?answer|missed/.test(rawStatus) ? 'no_answer'
      : /fail|error/.test(rawStatus) ? 'failed'
      : 'completed';

    const durationRaw = e.duration ?? e.talk_time ?? e.call_duration ?? e.length;
    const duration = Number(durationRaw);

    const dirRaw = String(e.direction || e.call_direction || e.type || '').toLowerCase();
    const direction = dirRaw.includes('in') ? 'INBOUND' : dirRaw.includes('out') ? 'OUTBOUND' : undefined;

    return {
      providerCallId: String(providerCallId),
      status,
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
      recordingUrl: e.recording_url || e.recording || e.record_url || e.audio_url || undefined,
      direction,
      fromPhone: e.from || e.caller || e.caller_number || e.src || e.phone,
      toPhone: e.to || e.callee || e.called_number || e.dst,
      employeeEmail: e.employee || e.employee_email || e.user || e.user_name,
      raw: e,
    };
  }

  /**
   * IPhoneProvider interfeysi talab qilishi mumkin bo'lgan umumiy
   * webhook-parse (agar kelajakda moizvonki.ru haqiqiy push-webhook
   * ham qo'shsa, shu metod ishlatiladi — hozircha asosiy yo'l emas,
   * asosiysi yuqoridagi `fetchCrmEvents`/`parseEvent`).
   */
  parseWebhook(body: any): WebhookEvent | null {
    const d = body?.data && typeof body.data === 'object' ? body.data : body;
    return this.parseEvent(d);
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