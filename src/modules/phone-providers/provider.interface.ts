/**
 * v8: Phone Provider Abstraction
 *
 * Bu interface har xil telefon provayderlar uchun umumiy shablon.
 * Yangi provayder qo'shish uchun bu interface'ni implement qiling.
 *
 * Hozir bor:
 *   - StubProvider       - simulyatsiya (demo)
 *   - TelLinkProvider    - tel: link (bepul, brauzerdan)
 *   - TwilioProvider     - Twilio (xalqaro)
 *   - OnlinePbxProvider  - OnlinePBX.uz (O'zbek raqami)
 *   - CustomSipProvider  - Shaxsiy server (Asterisk/FreePBX)
 */

export interface CallInitiateOptions {
  /** Klient raqami (E.164 formatda: +998901234567) */
  toPhone: string;
  /** Agent ID (bizning CRM'da) */
  agentId: string;
  /** Agentning shaxsiy callback raqami */
  agentPhone?: string;
  /** Agentning ATS ichki raqami (extension) */
  agentExtension?: string;
  /** Klient ismi (CRM ko'rsatish uchun) */
  clientName?: string;
}

export interface CallInitiateResult {
  /** Provayder tomonidan berilgan call ID */
  providerCallId: string;
  /** Holat: queued, ringing, in_progress, va h.k. */
  status: string;
  /** Qo'shimcha ma'lumot — provayder formatida */
  raw?: any;
  /** Frontend uchun maxsus xabar (masalan, tel: link) */
  clientAction?: {
    type: 'tel' | 'redirect' | 'none';
    payload: string;
  };
}

export interface WebhookEvent {
  providerCallId: string;
  status: 'queued' | 'initiated' | 'ringing' | 'in_progress' | 'completed' |
          'busy' | 'failed' | 'no_answer' | 'canceled';
  duration?: number;
  recordingUrl?: string;
  raw?: any;
}

export interface IPhoneProvider {
  /** Provayder nomi */
  name: string;

  /** Qo'ng'iroqni boshlash */
  initiate(options: CallInitiateOptions): Promise<CallInitiateResult>;

  /** Qo'ng'iroqni tugatish (provayder qo'llab-quvvatlasa) */
  hangup?(providerCallId: string): Promise<void>;

  /** Webhook'dan kelgan ma'lumotni parse qilish */
  parseWebhook?(body: any): WebhookEvent | null;

  /** Recording faylini olish (URL yoki binary) */
  getRecordingUrl?(providerCallId: string): Promise<string | null>;

  /** Provayder sozlanganmi va ishlayaptimi? */
  isConfigured(): boolean;
}

/** Provayder konfiguratsiya — Tenant.phoneConfig JSON */
export interface PhoneConfig {
  // Umumiy
  enabled?: boolean;
  defaultProvider?: string;

  // OnlinePBX
  onlinepbx?: {
    domain?: string;        // sizning_kompaniya.onpbx.ru
    apiKey?: string;
    apiId?: string;
    callerId?: string;      // sizning_raqamingiz: 71-XXX-XX-XX
    recordingEnabled?: boolean;
  };

  // Twilio
  twilio?: {
    accountSid?: string;
    authToken?: string;
    fromNumber?: string;
    twimlUrl?: string;
    recordingEnabled?: boolean;
  };

  // CustomSIP (Asterisk / FreePBX / FusionPBX)
  customSip?: {
    amiHost?: string;
    amiPort?: number;
    amiUser?: string;
    amiPassword?: string;
    context?: string;
    callerId?: string;
    restUrl?: string;
    restKey?: string;
    restType?: string;
  };

  // MyAti
  myati?: {
    apiKey?: string;
    domain?: string;
  };
}
