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
 * ── ✅ TO'LIQ TASDIQLANGAN (moizvonki.ru rasmiy hujjati —
 *    moizvonki.ru/guide/api/, 2026) ──
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
 *     2) Qo'ng'iroqlar tarixini olish — bu YAGONA rasmiy hujjatlashtirilgan
 *        yo'l bo'lib, YOZUV HAVOLASI (`recording`) ham shu javobning
 *        o'zida to'g'ridan-to'g'ri keladi (alohida so'rov shart emas!):
 *          action: "calls.list"
 *          from_id     — shu ID (dan boshlab, shu ID'ni ham qo'shib)
 *                        keyingi barcha qo'ng'iroqlarni qaytaradi —
 *                        ketma-ket sinxronizatsiya uchun ENG TO'G'RI usul
 *                        (0 yoki 1 — hammasini qaytaradi)
 *          from_date   — muqobil, UTC timestamp (from_id berilsa e'tiborga
 *                        olinmaydi)
 *          from_offset — sahifalash uchun boshlang'ich indeks
 *          max_results — 1-100
 *          supervised  — 1 = admin nomidan BARCHA xodimlarning
 *                        qo'ng'iroqlari (har birida `user_account` bilan
 *                        birga), 0/berilmasa = faqat shu `user_name`niki
 *        Javobdagi HAR BIR qo'ng'iroq — TASDIQLANGAN maydonlar:
 *          db_call_id, direction (0=kiruvchi,1=chiquvchi), client_number,
 *          client_name, start_time, answer_time, end_time, duration,
 *          answered (0/1), recording (URL yoki bo'sh ""), user_account
 *          (faqat supervised=1 bo'lsa), event_pbx_call_id, src_number.
 *
 *   Narx: 175₽/qurilma/oyiga (yozuvsiz), 230₽/qurilma/oyiga (ovozli
 *   yozuv bilan) — 20 kunlik bepul sinov, kartasiz. Ovozli yozuv
 *   serverda 30 kun saqlanadi (yoki cheksiz — Yandex/Google Disk
 *   ulansa). Faqat ODDIY qo'ng'iroqlar yoziladi (messenjer emas).
 *
 * ── 🩹 v19 TUZATISH: avvalgi kodda `calls.get_crm_event` degan METOD
 *    CHAQIRILARDI — LEKIN bunday action rasmiy hujjatda UMUMAN YO'Q
 *    (faqat calls.make_call, calls.send_sms, calls.get_sms_templates,
 *    calls.list, webhook.subscribe/unsubscribe/list, company.*).
 *    Shu sabab server doim xato/bo'sh javob qaytargan va YOZUV
 *    (recording) CRM'ga HECH QACHON kelmagan. Endi rasmiy `calls.list`
 *    (from_id kursor bilan, supervised=1) ishlatiladi — pastdagi
 *    `fetchRecentCalls()`/`parseCallRow()` shu orqali ishlaydi.
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
   * (masalan `calls.list` supervised=1, `testConnection`) uchun to'g'ri.
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
   * ✅ v19: TASDIQLANGAN `calls.list` endpointi orqali tekshiradi —
   * bu haqiqiy, hujjatlashtirilgan amal (avvalgi `calls.get_crm_event`
   * mavjud bo'lmagan action edi, shuning uchun har doim xato qaytarardi).
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
      // ✅ v19: `calls.list` — rasmiy hujjatdagi haqiqiy action (avvalgi
      // `calls.get_crm_event` mavjud emas edi). `from_id: 1` — hisobdagi
      // eng birinchi qo'ng'iroqdan boshlab so'raymiz, faqat 1 tasi kifoya
      // (ulanish ishlayaptimi-yo'qmi shuni tekshiramiz, xolos).
      const res = await this.request('calls.list', {
        from_id: 1,
        max_results: 1,
        supervised: 1,
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
  // QO'NG'IROQLAR TARIXI (calls.list) — ✅ TASDIQLANGAN, YOZUV
  // (recording) SHU JAVOBNING O'ZIDA KELADI
  // ─────────────────────────────────────────────────────────────

  /**
   * Kursor (`from_id`) dan boshlab qo'ng'iroqlar ro'yxatini oladi.
   * `calls.module.ts` ichidagi CRON shu metodni har 3 daqiqada
   * chaqiradi (xuddi OnlinePBX'ning `pullInboundForTenant` bilan bir
   * xil naqshda), so'ng oxirgi olingan `db_call_id + 1` ni keyingi
   * safar uchun kursor qilib saqlab qo'yadi.
   *
   * `supervised: 1` — admin nomidan BARCHA xodimlarning qo'ng'iroqlari
   * qaytadi (har birida `user_account` bilan, kim gaplashganini
   * aniqlash uchun). Buni faqat admin hisobi (`adminEmail`) bajara
   * oladi — shuning uchun bu yerda userNameOverride BERILMAYDI (default
   * `this.adminEmail` ishlatiladi).
   */
  async fetchRecentCalls(
    fromId: number,
    maxResults = 100,
    fromOffset = 0,
  ): Promise<{ results: any[]; nextOffset: number; remains: number }> {
    const res = await this.request('calls.list', {
      from_id: fromId && fromId > 0 ? fromId : 1,
      from_offset: fromOffset,
      max_results: Math.min(Math.max(maxResults, 1), 100),
      supervised: 1,
    });
    if (!res.ok || res.json?.error) {
      this.logger.warn(`calls.list xatosi: HTTP ${res.status} — ${res.text.slice(0, 200)}`);
      return { results: [], nextOffset: 0, remains: 0 };
    }
    const j = res.json || {};
    const results = Array.isArray(j.results) ? j.results : [];
    return {
      results,
      nextOffset: Number(j.results_next_offset) || 0,
      remains: Number(j.results_remains) || 0,
    };
  }

  /**
   * Bitta `calls.list` qatorini bizning umumiy `WebhookEvent` shakliga
   * o'giradi. Maydon nomlari 100% rasmiy hujjatga mos (taxmin YO'Q).
   */
  parseCallRow(e: any): (WebhookEvent & {
    direction?: 'INBOUND' | 'OUTBOUND';
    fromPhone?: string;
    toPhone?: string;
    employeeEmail?: string;
    dbCallId?: number;
  }) | null {
    if (!e || typeof e !== 'object') return null;
    const dbCallId = Number(e.db_call_id);
    if (!Number.isFinite(dbCallId) || dbCallId <= 0) return null;

    const answered = Number(e.answered) === 1;
    const duration = Number(e.duration);
    // direction: 0 - kiruvchi (входящий), 1 - chiquvchi (исходящий)
    const direction = Number(e.direction) === 1 ? 'OUTBOUND' : 'INBOUND';
    // recording bo'sh satr ("") bo'lishi mumkin — javob berilmagan yoki
    // yozuv hali tayyor bo'lmagan qo'ng'iroqlarda
    const recordingUrl = typeof e.recording === 'string' && e.recording.trim() ? e.recording.trim() : undefined;

    return {
      providerCallId: String(dbCallId),
      dbCallId,
      status: answered ? 'completed' : 'no_answer',
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
      recordingUrl,
      direction,
      // client_number — mijozning raqami (yo'nalishdan qat'i nazar)
      fromPhone: e.client_number,
      toPhone: e.client_number,
      // faqat supervised=1 so'rovda keladi — qaysi xodim gaplashgani
      employeeEmail: this.resolveCrmEmail(e.user_account),
      raw: e,
    };
  }

  /**
   * `user_account` (moizvonki.ru login emaili) → bizning CRM'dagi
   * User.email. `employeeEmailMap` teskari yo'nalishda saqlanadi
   * (bizning email → moizvonki email), shuning uchun bu yerda
   * xaritani teskari aylantirib qidiramiz. Xaritada topilmasa —
   * odatdagidek, ikkala tizimda ham bir xil email ishlatilgan deb
   * hisoblab, `user_account`ning o'zi qaytariladi.
   */
  private resolveCrmEmail(moizvonkiEmail: string | undefined): string | undefined {
    const val = String(moizvonkiEmail || '').trim();
    if (!val) return undefined;
    const map = this.config?.employeeEmailMap || {};
    for (const [crmEmail, mzEmail] of Object.entries(map)) {
      if (String(mzEmail || '').trim().toLowerCase() === val.toLowerCase()) return crmEmail;
    }
    return val;
  }

  /**
   * moizvonki.ru'ning HAQIQIY push-webhook shakli (agar admin
   * moizvonki.ru kabinetida yoki `webhook.subscribe` orqali ulagan
   * bo'lsa): { "webhook": {action, account_id, ...}, "event": {...} }.
   * Faqat `call.finish` (event_type=4) hodisasida `db_call_id`,
   * `recording`, `duration`, `answered` keladi — shu maydonlar
   * `calls.list` javobidagi qator bilan BIR XIL, shuning uchun
   * `parseCallRow()` to'g'ridan-to'g'ri qayta ishlatiladi. Boshqa
   * hodisalar (call.start/answer/sms) hozircha CRM uchun harakatga
   * sabab bo'lmaydi (yozuv/davomiylik ularda yo'q) — shuning uchun
   * `null` qaytariladi va asosiy yo'l bo'lib `calls.list` polling
   * (`fetchRecentCalls`) qoladi, bu webhook faqat qo'shimcha tezlik
   * uchun.
   */
  parseWebhook(body: any): WebhookEvent | null {
    const event = body?.event && typeof body.event === 'object' ? body.event : body;
    const eventType = Number(event?.event_type);
    if (eventType !== 4) return null; // call.finish emas — o'tkazib yuboramiz
    return this.parseCallRow(event);
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