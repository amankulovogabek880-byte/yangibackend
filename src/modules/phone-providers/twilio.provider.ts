import { Logger } from '@nestjs/common';
import { Twilio } from 'twilio';
import {
  IPhoneProvider, CallInitiateOptions, CallInitiateResult,
  WebhookEvent, PhoneConfig,
} from './provider.interface';

/**
 * v8: Twilio Provider
 *
 * ⚠️ Twilio O'zbekiston raqami sotmaydi (faqat AQSh va Yevropa)
 * Klient begona raqamni ko'radi va ko'pincha javob bermaydi.
 *
 * Tavsiya: OnlinePBX yoki MyAti.uz dan foydalaning.
 */
export class TwilioProvider implements IPhoneProvider {
  name = 'TWILIO';
  private readonly logger = new Logger('TwilioProvider');
  private twilio: Twilio | null = null;

  constructor(private config: PhoneConfig['twilio']) {
    if (config?.accountSid && config?.authToken) {
      this.twilio = new Twilio(config.accountSid, config.authToken);
    }
  }

  async initiate(options: CallInitiateOptions): Promise<CallInitiateResult> {
    if (!this.isConfigured() || !this.twilio) {
      throw new Error('Twilio sozlanmagan');
    }

    try {
      const call = await this.twilio.calls.create({
        to: options.toPhone,
        from: this.config!.fromNumber!,
        url: this.config!.twimlUrl || 'http://demo.twilio.com/docs/voice.xml',
        record: this.config!.recordingEnabled !== false,
        recordingStatusCallback: process.env.PUBLIC_URL
          ? `${process.env.PUBLIC_URL}/api/v1/calls/webhook`
          : undefined,
      });

      return {
        providerCallId: call.sid,
        status: 'queued',
        raw: { sid: call.sid },
      };
    } catch (e: any) {
      this.logger.error(`Twilio xato: ${e.message}`);
      throw new Error(`Twilio: ${e.message}`);
    }
  }

  async hangup(providerCallId: string): Promise<void> {
    if (!this.twilio) return;
    try {
      await this.twilio.calls(providerCallId).update({ status: 'completed' });
    } catch (e: any) {
      this.logger.warn(`Twilio hangup xato: ${e.message}`);
    }
  }

  parseWebhook(body: any): WebhookEvent | null {
    const sid = body?.CallSid;
    if (!sid) return null;

    const statusMap: Record<string, WebhookEvent['status']> = {
      'queued': 'queued', 'initiated': 'initiated', 'ringing': 'ringing',
      'in-progress': 'in_progress', 'completed': 'completed',
      'busy': 'busy', 'failed': 'failed',
      'no-answer': 'no_answer', 'canceled': 'canceled',
    };

    return {
      providerCallId: sid,
      status: statusMap[body.CallStatus] || 'completed',
      duration: parseInt(body.CallDuration || '0', 10),
      recordingUrl: body.RecordingUrl || undefined,
      raw: body,
    };
  }

  isConfigured(): boolean {
    return !!(
      this.config?.accountSid &&
      this.config?.authToken &&
      this.config?.fromNumber
    );
  }
}
