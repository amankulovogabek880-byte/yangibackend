import {
  Module, Injectable, Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards, Logger, BadRequestException,
  NotFoundException, Req,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { checkWebhookSecret } from '../../common/utils/helpers';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { ClientsService } from '../clients/clients.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import axios from 'axios';
import { RoundRobinService, RoundRobinModule } from '../v9/round-robin.module';

/**
 * WhatsApp integratsiya — UltraMsg API orqali
 *
 * UltraMsg (https://ultramsg.com):
 * - 3 kun bepul trial
 * - Oylik $15 dan
 * - O'rnatish: ultramsg.com -> Instance yarating -> Token oling
 *
 * .env da kerakli:
 *   (Sozlamalar DB da saqlanadi - admin panel orqali qo'shiladi)
 */

interface WhatsAppConfig {
  instanceId: string;
  token: string;
  webhookUrl?: string;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger('WhatsApp');

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private clients: ClientsService,
    private realtime: RealtimeGateway,
    private roundRobin: RoundRobinService,
  ) {}

  // ─── CONFIG ────────────────────────────────────────────────────

  private async getConfig(tenantId: string): Promise<WhatsAppConfig | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const settings = tenant?.settings as any;
    const cfg = settings?.whatsapp;
    if (!cfg?.instanceId || !cfg?.token) return null;
    return cfg as WhatsAppConfig;
  }

  async saveConfig(tenantId: string, config: WhatsAppConfig) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const existing = (tenant?.settings as any) || {};
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        settings: {
          ...existing,
          whatsapp: {
            instanceId: config.instanceId.trim(),
            token: config.token.trim(),
            webhookUrl: config.webhookUrl?.trim() || '',
          },
        },
      },
    });
    return { ok: true };
  }

  async getConfigMasked(tenantId: string) {
    const cfg = await this.getConfig(tenantId);
    if (!cfg) return { connected: false };
    return {
      connected: true,
      instanceId: cfg.instanceId,
      token: cfg.token.slice(0, 6) + '••••••••',
      webhookUrl: cfg.webhookUrl,
    };
  }

  // ─── SEND MESSAGE ──────────────────────────────────────────────

  async sendMessage(tenantId: string, to: string, message: string, mediaUrl?: string) {
    const cfg = await this.getConfig(tenantId);
    if (!cfg) throw new BadRequestException('WhatsApp sozlanmagan. Settings → WhatsApp');

    // Telefon raqamni tozalash (+998901234567 -> 998901234567)
    const phone = to.replace(/[^0-9]/g, '');
    if (phone.length < 9) throw new BadRequestException("Telefon raqam noto'g'ri");

    const baseUrl = `https://api.ultramsg.com/${cfg.instanceId}`;

    try {
      let response;
      if (mediaUrl) {
        // Rasm/fayl yuborish
        const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(mediaUrl);
        const endpoint = isImage ? '/messages/image' : '/messages/document';
        response = await axios.post(`${baseUrl}${endpoint}`, {
          token: cfg.token,
          to: phone,
          image: isImage ? mediaUrl : undefined,
          document: !isImage ? mediaUrl : undefined,
          caption: message,
        }, { timeout: 15000 });
      } else {
        response = await axios.post(`${baseUrl}/messages/chat`, {
          token: cfg.token,
          to: phone,
          body: message,
        }, { timeout: 15000 });
      }

      const msgId = response.data?.id || response.data?.sent;
      this.logger.log(`WhatsApp yuborildi → ${phone}: ${msgId}`);
      return { ok: true, messageId: msgId };

    } catch (e: any) {
      const err = e.response?.data?.error || e.message;
      this.logger.error(`WhatsApp xato (${phone}): ${err}`);
      throw new BadRequestException(`WhatsApp xato: ${err}`);
    }
  }

  // ─── WEBHOOK (kiruvchi xabarlar) ───────────────────────────────

  async handleWebhook(tenantId: string, payload: any) {
    this.logger.debug(`WhatsApp webhook: ${JSON.stringify(payload).slice(0, 200)}`);

    // UltraMsg webhook formati
    const msgData = payload?.data;
    if (!msgData || msgData.fromMe) return { ok: true }; // o'ziniki - skip

    const from = (msgData.from || '').replace('@c.us', '').replace(/[^0-9]/g, '');
    const text = msgData.body || '';
    const msgType = msgData.type || 'chat'; // chat, image, document, audio, video

    if (!from || !text) return { ok: true };

    // Klient topish yoki yaratish
    let client = await this.prisma.client.findFirst({
      where: { tenantId, phone: { contains: from.slice(-9) } },
    });

    if (!client) {
      // Yangi klient - WhatsApp dan kelgan lead
      try {
        const pushName = msgData.pushName || msgData.notifyName || `WA_${from.slice(-9)}`;
        const waAgent = await this.roundRobin.getNextAgent(tenantId);
        client = await this.prisma.client.create({
          data: {
            tenantId,
            fullName: pushName,
            phone: `+${from}`,
            source: 'WHATSAPP' as any,
            notes: `WhatsApp orqali kelgan lead`,
            lastContactAt: new Date(),
            firstContactAt: new Date(),
            assignedAgentId: waAgent,
          },
        });
        this.logger.log(`Yangi WhatsApp lead: ${pushName} (${from})`);
      } catch { return { ok: true }; }
    }

    // Conversation topish yoki yaratish
    let conv = await this.prisma.conversation.findFirst({
      where: { tenantId, channel: 'WHATSAPP' as any, externalChatId: from },
    });

    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: {
          tenantId,
          channel: 'WHATSAPP' as any,
          externalChatId: from,
          clientId: client.id,
          firstName: client.fullName,
        },
      });
    }

    // Xabarni saqlash
    await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'INBOUND',
        messageType: (msgType === 'chat' ? 'TEXT' : 'PHOTO') as any,
        text,
        externalMsgId: msgData.id,
      },
    });

    // Conversation yangilash
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: new Date(),
        lastMessageText: text.slice(0, 200),
        unreadCount: { increment: 1 },
      },
    });

    // Agent ga notification
    if (conv.assignedAgentId) {
      await this.notifications.create({
        tenantId,
        userId: conv.assignedAgentId,
        type: 'NEW_MESSAGE',
        title: `📱 WhatsApp: ${client.fullName}`,
        body: text.slice(0, 80),
        link: `/inbox`,
        metadata: { conversationId: conv.id, clientId: client.id },
      }).catch(() => {});
    }

    // Realtime
    try {
      this.realtime.emitToTenant(tenantId, 'message:new', {
        conversationId: conv.id, channel: 'WHATSAPP',
        clientName: client.fullName, text: text.slice(0, 100),
      });
    } catch {}

    return { ok: true };
  }

  // ─── INSTANCE STATUS ───────────────────────────────────────────

  async getStatus(tenantId: string) {
    const cfg = await this.getConfig(tenantId);
    if (!cfg) return { connected: false, status: 'not_configured' };

    try {
      const res = await axios.get(
        `https://api.ultramsg.com/${cfg.instanceId}/instance/status?token=${cfg.token}`,
        { timeout: 10000 }
      );
      return {
        connected: true,
        status: res.data?.status?.accountStatus?.status || 'unknown',
        phoneNumber: res.data?.status?.accountInfo?.Wid || null,
        battery: res.data?.status?.accountInfo?.Battery || null,
      };
    } catch (e: any) {
      return { connected: false, status: 'error', error: e.message };
    }
  }

  // ─── TEMPLATE XABARLAR ────────────────────────────────────────

  async sendBookingConfirmation(tenantId: string, phone: string, data: {
    clientName: string; tourName: string; bookingRef: string;
    departureDate?: string; totalPrice?: number; currency?: string;
  }) {
    const lines = [
      `✈️ *Booking tasdiqlandi!*`,
      ``,
      `Hurmatli *${data.clientName}*,`,
      `Sizning buyurtmangiz qabul qilindi.`,
      ``,
      `📋 *Booking ma'lumotlari:*`,
      `• Ref: \`${data.bookingRef}\``,
      `• Tur: ${data.tourName}`,
      data.departureDate ? `• Ketish: ${data.departureDate}` : null,
      data.totalPrice ? `• Narx: *${data.totalPrice} ${data.currency || 'USD'}*` : null,
      ``,
      `📞 Savollar uchun bog'laning!`,
    ].filter(Boolean).join('\n');

    return this.sendMessage(tenantId, phone, lines);
  }

  async sendPaymentReminder(tenantId: string, phone: string, data: {
    clientName: string; amount: number; currency: string;
    bookingRef: string; dueDate?: string;
  }) {
    const msg = [
      `💰 *To'lov eslatmasi*`,
      ``,
      `Hurmatli *${data.clientName}*,`,
      ``,
      `• Booking: \`${data.bookingRef}\``,
      `• Summa: *${data.amount} ${data.currency}*`,
      data.dueDate ? `• Muddat: ${data.dueDate}` : null,
      ``,
      `Iltimos, belgilangan muddatda to'lovni amalga oshiring.`,
    ].filter(Boolean).join('\n');

    return this.sendMessage(tenantId, phone, msg);
  }
}

// ─── CONTROLLER ────────────────────────────────────────────────

@Controller('whatsapp')
@UseGuards(JwtAuthGuard)
export class WhatsAppController {
  constructor(private svc: WhatsAppService) {}

  @Get('config')
  getConfig(@CurrentUser() u: any) {
    return this.svc.getConfigMasked(u.tenantId);
  }

  @Patch('config')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  saveConfig(@Body() body: { instanceId: string; token: string; webhookUrl?: string }, @CurrentUser() u: any) {
    if (!body.instanceId?.trim() || !body.token?.trim()) {
      throw new BadRequestException('instanceId va token majburiy');
    }
    return this.svc.saveConfig(u.tenantId, body);
  }

  @Get('status')
  status(@CurrentUser() u: any) {
    return this.svc.getStatus(u.tenantId);
  }

  @Post('send')
  send(@Body() body: { to: string; message: string; mediaUrl?: string }, @CurrentUser() u: any) {
    if (!body.to?.trim()) throw new BadRequestException('to majburiy');
    if (!body.message?.trim()) throw new BadRequestException('message majburiy');
    return this.svc.sendMessage(u.tenantId, body.to, body.message, body.mediaUrl);
  }

  // Booking tasdiqlash xabari
  @Post('send/booking-confirmation')
  sendBooking(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.sendBookingConfirmation(u.tenantId, body.phone, body);
  }

  // To'lov eslatmasi
  @Post('send/payment-reminder')
  sendPayment(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.sendPaymentReminder(u.tenantId, body.phone, body);
  }
}

// ─── PUBLIC WEBHOOK ────────────────────────────────────────────

@Controller('public/whatsapp')
export class WhatsAppWebhookController {
  constructor(private svc: WhatsAppService) {}

  // UltraMsg webhook: POST /api/v1/public/whatsapp/webhook/TENANT_ID
  /**
   * XAVFSIZLIK: manzilda tenantId ochiq turadi, ya'ni uni bilgan
   * har kim soxta xabar yubora olardi. Endi maxfiy kalit talab
   * qilinadi (.env → WHATSAPP_WEBHOOK_SECRET).
   *
   * UltraMsg'da webhook manzilini shunday ko'rsating:
   *   https://server/api/v1/public/whatsapp/webhook/TENANT_ID?secret=KALIT
   */
  @Post('webhook/:tenantId')
  @Public()
  webhook(
    @Param('tenantId') tenantId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const res = checkWebhookSecret(
      req?.headers || {},
      req?.query || {},
      process.env.WHATSAPP_WEBHOOK_SECRET,
    );
    if (!res.ok) throw new UnauthorizedException("Webhook kaliti noto'g'ri");
    if (!res.configured) {
      if (!WhatsAppWebhookController.warned) {
        WhatsAppWebhookController.warned = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[XAVFSIZLIK] WHATSAPP_WEBHOOK_SECRET sozlanmagan — WhatsApp webhook himoyasiz.',
        );
      }
    }
    return this.svc.handleWebhook(tenantId, body);
  }

  private static warned = false;

  // GET - UltraMsg webhook verification uchun
  @Get('webhook/:tenantId')
  @Public()
  verify() {
    return { status: 'ok', service: 'Omon CRM WhatsApp Webhook' };
  }
}

// ─── MODULE ────────────────────────────────────────────────────

@Module({
  controllers: [WhatsAppController, WhatsAppWebhookController],
  imports: [RoundRobinModule],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}