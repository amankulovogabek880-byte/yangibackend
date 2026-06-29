import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import sgMail from '@sendgrid/mail';
import { PrismaService } from '../../prisma/prisma.service';

interface SendEmailParams {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  tenantId?: string;
  templateId?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger('Email');
  private enabled = false;
  private fromEmail = '';
  private fromName = '';

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    const apiKey = process.env.SENDGRID_API_KEY;
    this.fromEmail = process.env.EMAIL_FROM || 'noreply@example.com';
    this.fromName = process.env.EMAIL_FROM_NAME || 'Omon CRM';

    if (!apiKey || apiKey.startsWith('SG.xxxx') || apiKey === '') {
      this.logger.warn(
        '⚠️  SENDGRID_API_KEY .env\'da yo\'q yoki to\'ldirilmagan. Email yuborilmaydi (faqat log\'ga yoziladi)',
      );
      this.enabled = false;
      return;
    }
    sgMail.setApiKey(apiKey);
    this.enabled = true;
    this.logger.log(`✅ Email service tayyor (${this.fromEmail})`);
  }

  /**
   * Email yuborish. Avtomatik log saqlanadi.
   */
  async send(params: SendEmailParams): Promise<{ ok: boolean; error?: string }> {
    const log = await this.prisma.emailLog.create({
      data: {
        tenantId: params.tenantId,
        toEmail: params.to,
        toName: params.toName,
        subject: params.subject,
        templateId: params.templateId,
        status: 'QUEUED',
        metadata: params.metadata || {},
      },
    });

    if (!this.enabled) {
      this.logger.log(`[STUB] Email → ${params.to}: ${params.subject}`);
      await this.prisma.emailLog.update({
        where: { id: log.id },
        data: { status: 'SENT', sentAt: new Date(), errorMessage: 'STUB MODE (no SendGrid key)' },
      });
      return { ok: true };
    }

    try {
      const res = await sgMail.send({
        to: { email: params.to, name: params.toName },
        from: { email: this.fromEmail, name: this.fromName },
        subject: params.subject,
        html: params.html,
        text: params.text || params.html.replace(/<[^>]+>/g, ''),
      });
      const messageId = res?.[0]?.headers?.['x-message-id'] as string | undefined;
      await this.prisma.emailLog.update({
        where: { id: log.id },
        data: { status: 'SENT', sentAt: new Date(), providerMsgId: messageId },
      });
      return { ok: true };
    } catch (e: any) {
      const msg = e.response?.body?.errors?.[0]?.message || e.message;
      this.logger.error(`Email xatosi: ${msg}`);
      await this.prisma.emailLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', errorMessage: msg },
      });
      return { ok: false, error: msg };
    }
  }

  // ─── HTML TEMPLATE SHABLONLARI ──────────────────────────────

  private wrap(title: string, body: string): string {
    return `
<!DOCTYPE html>
<html lang="uz">
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="600" style="max-width:600px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
        <tr><td style="padding:30px 30px 14px;background:linear-gradient(135deg,#3d7eff,#a855f7);color:#fff;">
          <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Omon CRM</h1>
        </td></tr>
        <tr><td style="padding:30px;color:#1a1f2e;line-height:1.6;">${body}</td></tr>
        <tr><td style="padding:20px 30px;background:#f8fafc;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0;">
          Bu xabar avtomatik yuborilgan. Javob bermang.<br>© ${new Date().getFullYear()} Omon CRM
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  // ─── XAVFSIZLIK XABARNOMALARI ──────────────────────────────────

  async sendLoginAlert(to: string, name: string, params: {
    deviceName?: string; ip?: string; country?: string; city?: string; time: Date;
  }) {
    const html = this.wrap('Yangi kirish', `
      <h2 style="margin:0 0 16px;font-size:18px;">🔔 Yangi qurilmadan kirish</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p>Hisobingizga yangi qurilmadan kirildi:</p>
      <table cellpadding="8" style="background:#f4f6fb;border-radius:8px;width:100%;font-size:14px;margin:14px 0;">
        <tr><td><b>Qurilma:</b></td><td>${params.deviceName || 'Noma\'lum'}</td></tr>
        <tr><td><b>IP:</b></td><td>${params.ip || '—'}</td></tr>
        <tr><td><b>Joy:</b></td><td>${[params.city, params.country].filter(Boolean).join(', ') || '—'}</td></tr>
        <tr><td><b>Vaqt:</b></td><td>${params.time.toLocaleString('uz-UZ')}</td></tr>
      </table>
      <p style="color:#94a3b8;font-size:13px;">Agar bu siz bo'lmasangiz — darhol parolni o'zgartiring va sessiyalarni yoping.</p>
    `);
    return this.send({ to, toName: name, subject: '🔔 Yangi kirish — Omon CRM', html });
  }

  async sendPasswordChanged(to: string, name: string) {
    const html = this.wrap('Parol o\'zgardi', `
      <h2 style="margin:0 0 16px;font-size:18px;">🔐 Parolingiz o'zgartirildi</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p>Sizning Omon CRM hisobingiz paroli o'zgartirildi.</p>
      <p style="color:#ef4444;font-size:13px;"><b>Agar bu siz bo'lmasangiz</b> — darhol support'ga murojaat qiling.</p>
    `);
    return this.send({ to, toName: name, subject: '🔐 Parol o\'zgartirildi — Omon CRM', html });
  }

  async sendFailedLoginAlert(to: string, name: string, attempts: number) {
    const html = this.wrap('Shubhali kirish urinishlari', `
      <h2 style="margin:0 0 16px;font-size:18px;color:#ef4444;">⚠️ Shubhali faollik</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p>Hisobingizga <b>${attempts}</b> marta noto'g'ri parol bilan kirish urinildi.</p>
      <p>Hisobingiz himoya uchun vaqtincha bloklandi.</p>
    `);
    return this.send({ to, toName: name, subject: '⚠️ Shubhali faollik — Omon CRM', html });
  }

  // ─── BIZNES XABARLAR ──────────────────────────────────────────

  async sendLeadNotification(to: string, name: string, params: {
    leadName: string; phone: string; source: string; campaign?: string;
  }) {
    const html = this.wrap('Yangi lead', `
      <h2 style="margin:0 0 16px;font-size:18px;color:#10b981;">🔥 Yangi lead keldi!</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p>Sizga yangi mijoz tayinlandi:</p>
      <table cellpadding="8" style="background:#f4f6fb;border-radius:8px;width:100%;font-size:14px;margin:14px 0;">
        <tr><td><b>Ism:</b></td><td>${params.leadName}</td></tr>
        <tr><td><b>Telefon:</b></td><td>${params.phone}</td></tr>
        <tr><td><b>Manba:</b></td><td>${params.source}</td></tr>
        ${params.campaign ? `<tr><td><b>Kampaniya:</b></td><td>${params.campaign}</td></tr>` : ''}
      </table>
      <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;background:#3d7eff;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">CRM'da ko'rish →</a>
    `);
    return this.send({ to, toName: name, subject: `🔥 Yangi lead: ${params.leadName}`, html });
  }

  async sendBookingCreated(to: string, name: string, params: {
    bookingRef: string; clientName: string; tourName: string; totalPrice: number;
  }) {
    const html = this.wrap('Yangi booking', `
      <h2 style="margin:0 0 16px;font-size:18px;">✈️ Yangi booking yaratildi</h2>
      <p>Salom, <b>${name}</b>!</p>
      <table cellpadding="8" style="background:#f4f6fb;border-radius:8px;width:100%;font-size:14px;margin:14px 0;">
        <tr><td><b>Ref:</b></td><td><code>${params.bookingRef}</code></td></tr>
        <tr><td><b>Klient:</b></td><td>${params.clientName}</td></tr>
        <tr><td><b>Tur:</b></td><td>${params.tourName}</td></tr>
        <tr><td><b>Narx:</b></td><td><b style="color:#10b981;">$${params.totalPrice}</b></td></tr>
      </table>
    `);
    return this.send({ to, toName: name, subject: `✈️ ${params.bookingRef} — ${params.tourName}`, html });
  }

  async sendPaymentReceived(to: string, name: string, params: {
    amount: number; bookingRef: string; method: string;
  }) {
    const html = this.wrap('To\'lov olindi', `
      <h2 style="margin:0 0 16px;font-size:18px;color:#10b981;">💰 To'lov qabul qilindi</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p><b>$${params.amount}</b> ${params.method} orqali olindi.</p>
      <p>Booking: <code>${params.bookingRef}</code></p>
    `);
    return this.send({ to, toName: name, subject: `💰 To'lov: $${params.amount} — ${params.bookingRef}`, html });
  }

  async sendFollowUpDue(to: string, name: string, params: {
    title: string; clientName?: string; note?: string;
  }) {
    const html = this.wrap('Eslatma', `
      <h2 style="margin:0 0 16px;font-size:18px;">⏰ ${params.title}</h2>
      <p>Salom, <b>${name}</b>!</p>
      ${params.clientName ? `<p>Klient: <b>${params.clientName}</b></p>` : ''}
      ${params.note ? `<p style="background:#f4f6fb;padding:12px;border-radius:8px;">${params.note}</p>` : ''}
    `);
    return this.send({ to, toName: name, subject: `⏰ ${params.title}`, html });
  }

  async send2FACode(to: string, name: string, code: string) {
    const html = this.wrap('Tasdiqlash kodi', `
      <h2 style="margin:0 0 16px;font-size:18px;">🔐 Sizning kodingiz</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p>Tasdiqlash kodingiz:</p>
      <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#3d7eff;text-align:center;padding:20px;background:#f4f6fb;border-radius:12px;margin:14px 0;font-family:monospace;">${code}</div>
      <p style="color:#94a3b8;font-size:13px;">Kod 10 daqiqa amal qiladi. Hech kim bilan baham ko'rmang!</p>
    `);
    return this.send({ to, toName: name, subject: `${code} — Omon CRM tasdiqlash kodi`, html });
  }

  async sendPasswordReset(to: string, name: string, resetUrl: string) {
    const html = this.wrap('Parolni tiklash', `
      <h2 style="margin:0 0 16px;font-size:18px;">🔑 Parolni tiklash</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p>Parolni tiklash uchun pastdagi tugmani bosing (1 soat amal qiladi):</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${resetUrl}" style="background:#3d7eff;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Parolni tiklash</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;">Agar siz bu so'rovni yubormagan bo'lsangiz, e'tibor bermang.</p>
    `);
    return this.send({ to, toName: name, subject: '🔑 Parolni tiklash — Omon CRM', html });
  }
}
