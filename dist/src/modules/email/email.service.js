"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailService = void 0;
const common_1 = require("@nestjs/common");
const mail_1 = __importDefault(require("@sendgrid/mail"));
const prisma_service_1 = require("../../prisma/prisma.service");
let EmailService = class EmailService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger('Email');
        this.enabled = false;
        this.fromEmail = '';
        this.fromName = '';
    }
    onModuleInit() {
        const apiKey = process.env.SENDGRID_API_KEY;
        this.fromEmail = process.env.EMAIL_FROM || 'noreply@example.com';
        this.fromName = process.env.EMAIL_FROM_NAME || 'Omon CRM';
        if (!apiKey || apiKey.startsWith('SG.xxxx') || apiKey === '') {
            this.logger.warn('⚠️  SENDGRID_API_KEY .env\'da yo\'q yoki to\'ldirilmagan. Email yuborilmaydi (faqat log\'ga yoziladi)');
            this.enabled = false;
            return;
        }
        mail_1.default.setApiKey(apiKey);
        this.enabled = true;
        this.logger.log(`✅ Email service tayyor (${this.fromEmail})`);
    }
    async send(params) {
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
            const res = await mail_1.default.send({
                to: { email: params.to, name: params.toName },
                from: { email: this.fromEmail, name: this.fromName },
                subject: params.subject,
                html: params.html,
                text: params.text || params.html.replace(/<[^>]+>/g, ''),
            });
            const messageId = res?.[0]?.headers?.['x-message-id'];
            await this.prisma.emailLog.update({
                where: { id: log.id },
                data: { status: 'SENT', sentAt: new Date(), providerMsgId: messageId },
            });
            return { ok: true };
        }
        catch (e) {
            const msg = e.response?.body?.errors?.[0]?.message || e.message;
            this.logger.error(`Email xatosi: ${msg}`);
            await this.prisma.emailLog.update({
                where: { id: log.id },
                data: { status: 'FAILED', errorMessage: msg },
            });
            return { ok: false, error: msg };
        }
    }
    wrap(title, body) {
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
    async sendLoginAlert(to, name, params) {
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
    async sendPasswordChanged(to, name) {
        const html = this.wrap('Parol o\'zgardi', `
      <h2 style="margin:0 0 16px;font-size:18px;">🔐 Parolingiz o'zgartirildi</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p>Sizning Omon CRM hisobingiz paroli o'zgartirildi.</p>
      <p style="color:#ef4444;font-size:13px;"><b>Agar bu siz bo'lmasangiz</b> — darhol support'ga murojaat qiling.</p>
    `);
        return this.send({ to, toName: name, subject: '🔐 Parol o\'zgartirildi — Omon CRM', html });
    }
    async sendFailedLoginAlert(to, name, attempts) {
        const html = this.wrap('Shubhali kirish urinishlari', `
      <h2 style="margin:0 0 16px;font-size:18px;color:#ef4444;">⚠️ Shubhali faollik</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p>Hisobingizga <b>${attempts}</b> marta noto'g'ri parol bilan kirish urinildi.</p>
      <p>Hisobingiz himoya uchun vaqtincha bloklandi.</p>
    `);
        return this.send({ to, toName: name, subject: '⚠️ Shubhali faollik — Omon CRM', html });
    }
    async sendLeadNotification(to, name, params) {
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
    async sendBookingCreated(to, name, params) {
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
    async sendPaymentReceived(to, name, params) {
        const html = this.wrap('To\'lov olindi', `
      <h2 style="margin:0 0 16px;font-size:18px;color:#10b981;">💰 To'lov qabul qilindi</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p><b>$${params.amount}</b> ${params.method} orqali olindi.</p>
      <p>Booking: <code>${params.bookingRef}</code></p>
    `);
        return this.send({ to, toName: name, subject: `💰 To'lov: $${params.amount} — ${params.bookingRef}`, html });
    }
    async sendFollowUpDue(to, name, params) {
        const html = this.wrap('Eslatma', `
      <h2 style="margin:0 0 16px;font-size:18px;">⏰ ${params.title}</h2>
      <p>Salom, <b>${name}</b>!</p>
      ${params.clientName ? `<p>Klient: <b>${params.clientName}</b></p>` : ''}
      ${params.note ? `<p style="background:#f4f6fb;padding:12px;border-radius:8px;">${params.note}</p>` : ''}
    `);
        return this.send({ to, toName: name, subject: `⏰ ${params.title}`, html });
    }
    async send2FACode(to, name, code) {
        const html = this.wrap('Tasdiqlash kodi', `
      <h2 style="margin:0 0 16px;font-size:18px;">🔐 Sizning kodingiz</h2>
      <p>Salom, <b>${name}</b>!</p>
      <p>Tasdiqlash kodingiz:</p>
      <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#3d7eff;text-align:center;padding:20px;background:#f4f6fb;border-radius:12px;margin:14px 0;font-family:monospace;">${code}</div>
      <p style="color:#94a3b8;font-size:13px;">Kod 10 daqiqa amal qiladi. Hech kim bilan baham ko'rmang!</p>
    `);
        return this.send({ to, toName: name, subject: `${code} — Omon CRM tasdiqlash kodi`, html });
    }
    async sendPasswordReset(to, name, resetUrl) {
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
};
exports.EmailService = EmailService;
exports.EmailService = EmailService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], EmailService);
//# sourceMappingURL=email.service.js.map