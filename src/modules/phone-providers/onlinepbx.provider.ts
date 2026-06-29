import { Logger } from '@nestjs/common';
import {
  IPhoneProvider, CallInitiateOptions, CallInitiateResult,
  WebhookEvent, PhoneConfig,
} from './provider.interface';

/**
 * v8: OnlinePBX.uz Provider
 *
 * ⚠️ MUHIM: API kalitlari sotib olganingizda o'zgartiring.
 *
 * OnlinePBX.uz onlayn ATS xizmati — O'zbekistonda eng mashhur.
 *
 * Qanday ishlaydi (Click2Call):
 *  1. Agent CRM'da Call tugmasini bosadi
 *  2. Backend OnlinePBX'ga so'rov yuboradi:
 *     a. Avval AGENT'ning ichki raqamiga (extension: 101) qo'ng'iroq qiladi
 *     b. Agent telefonni oladi
 *     c. Klient raqamiga avtomatik ulaydi
 *     d. Klientning telefoni jiringlaydi
 *     e. Suhbat boshlanadi
 *  3. Recording avtomatik qilinadi
 *  4. Webhook qo'ng'iroq tugaganda chaqiriladi (status + recording URL)
 *
 * API misol (real dokumentatsiya kelganda sozlanadi):
 *   POST https://YOUR_DOMAIN.onpbx.ru/Mobile/v3/Calls/originate
 *   Headers: X-API-KEY, X-API-ID
 *   Body: { from: extension, to: phone, callerId: "71XXXXXX" }
 *
 * Webhook (callback):
 *   POST /api/v1/calls/webhook
 *   Body: {
 *     uuid, type, status, duration_seconds, recording_url, ...
 *   }
 *
 * ⚠️ Endpoint nomlari va body strukturasi haqiqiy dokumentatsiyadan
 * ozgina farq qilishi mumkin — OnlinePBX qo'llab-quvvatlash xizmatidan
 * (info@onlinepbx.uz) dokumentatsiya so'rang.
 */
export class OnlinePbxProvider implements IPhoneProvider {
  name = 'ONLINEPBX';
  private readonly logger = new Logger('OnlinePbxProvider');

  constructor(private config: PhoneConfig['onlinepbx']) {}

  async initiate(options: CallInitiateOptions): Promise<CallInitiateResult> {
    if (!this.isConfigured()) {
      throw new Error('OnlinePBX sozlanmagan. Tenant Settings → Phone Provider');
    }

    const domain = this.config!.domain!.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${domain}/Mobile/v3/Calls/originate`;

    if (!options.agentExtension) {
      throw new Error(
        "Agentning extension'i kiritilmagan. " +
        "Sozlamalar → Profil → 'ATS ichki raqam' (masalan, 101)"
      );
    }

    // Klient raqamini E.164 formatga keltirish
    let toPhone = options.toPhone.replace(/[^\d+]/g, '');
    if (!toPhone.startsWith('+')) {
      if (toPhone.startsWith('998')) toPhone = '+' + toPhone;
      else if (toPhone.startsWith('8') && toPhone.length === 9) toPhone = '+998' + toPhone;
      else toPhone = '+' + toPhone;
    }

    const body = {
      from: options.agentExtension,    // Agent extension (masalan, 101)
      to: toPhone,                      // Klient raqami
      callerId: this.config!.callerId, // Sizning kompaniya raqami (mijoz ko'radi)
      recording: this.config!.recordingEnabled !== false,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.config!.apiKey || '',
          'X-API-ID': this.config!.apiId || '',
        },
        body: JSON.stringify(body),
      });

      const json: any = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          `OnlinePBX xato: ${response.status} ${json?.message || json?.error || 'Noma\'lum'}`
        );
      }

      // OnlinePBX odatda quyidagi javob qaytaradi:
      // { call_id: "...", status: "queued", ... }
      const callId = json?.call_id || json?.uuid || json?.id;
      if (!callId) {
        throw new Error('OnlinePBX call_id qaytarmadi');
      }

      return {
        providerCallId: String(callId),
        status: json?.status || 'queued',
        raw: json,
      };
    } catch (e: any) {
      this.logger.error(`OnlinePBX xato: ${e.message}`);
      throw e;
    }
  }

  async hangup(providerCallId: string): Promise<void> {
    if (!this.isConfigured()) return;
    const domain = this.config!.domain!.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${domain}/Mobile/v3/Calls/hangup`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.config!.apiKey || '',
          'X-API-ID': this.config!.apiId || '',
        },
        body: JSON.stringify({ call_id: providerCallId }),
      });
    } catch (e: any) {
      this.logger.warn(`OnlinePBX hangup xato: ${e.message}`);
    }
  }

  parseWebhook(body: any): WebhookEvent | null {
    if (!body) return null;

    // OnlinePBX webhook payload taxminiy:
    // {
    //   uuid: "...",
    //   type: "outgoing.call.history",
    //   status: "completed",
    //   duration_seconds: 45,
    //   recording_url: "https://..."
    // }

    const callId = body?.uuid || body?.call_id || body?.id;
    if (!callId) return null;

    const statusMap: Record<string, WebhookEvent['status']> = {
      'queued': 'queued',
      'ringing': 'ringing',
      'in_progress': 'in_progress',
      'answered': 'in_progress',
      'completed': 'completed',
      'finished': 'completed',
      'busy': 'busy',
      'no_answer': 'no_answer',
      'failed': 'failed',
      'canceled': 'canceled',
    };

    return {
      providerCallId: String(callId),
      status: statusMap[String(body.status).toLowerCase()] || 'completed',
      duration: body?.duration_seconds || body?.duration || 0,
      recordingUrl: body?.recording_url || body?.recording || undefined,
      raw: body,
    };
  }

  async getRecordingUrl(providerCallId: string): Promise<string | null> {
    if (!this.isConfigured()) return null;
    const domain = this.config!.domain!.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${domain}/Mobile/v3/Calls/${providerCallId}/recording`;
    try {
      const res = await fetch(url, {
        headers: {
          'X-API-KEY': this.config!.apiKey || '',
          'X-API-ID': this.config!.apiId || '',
        },
      });
      if (!res.ok) return null;
      const json: any = await res.json().catch(() => null);
      return json?.url || json?.recording_url || null;
    } catch {
      return null;
    }
  }

  isConfigured(): boolean {
    return !!(
      this.config?.domain &&
      this.config?.apiKey &&
      this.config?.apiId
    );
  }
}
