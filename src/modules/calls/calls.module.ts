import {
  Module, Injectable, Controller, Get, Post, Body, Query, Param, UseGuards,
  Logger, BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, Public } from '../../common/decorators';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PhoneProvidersModule, PhoneProviderFactory } from '../phone-providers/phone-providers.module';
import { CallDirection, CallStatus } from '../../prisma-types';;

@Injectable()
export class CallsService {
  private readonly logger = new Logger('Calls');

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
    private notifications: NotificationsService,
    private realtime: RealtimeGateway,
    private providerFactory: PhoneProviderFactory,
  ) {}

  async initiate(tenantId: string, userId: string, data: {
    toPhone: string; clientId?: string; bookingId?: string;
  }) {
    if (!data.toPhone) throw new BadRequestException('Telefon raqami kerak');

    const toMasked = this.encryption.maskPhone(data.toPhone);
    const toRaw = this.encryption.encrypt(data.toPhone);

    const agent = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, callbackPhone: true, extension: true },
    });
    if (!agent) throw new NotFoundException('Agent topilmadi');

    let clientName = 'Notanish';
    if (data.clientId) {
      const c = await this.prisma.client.findFirst({
        where: { id: data.clientId, tenantId },
        select: { fullName: true },
      });
      if (c) clientName = (c as any).fullName;
    }

    const call = await this.prisma.call.create({
      data: {
        tenantId, agentId: userId,
        clientId: data.clientId, bookingId: data.bookingId,
        toMasked, toRaw,
        direction: 'OUTBOUND', status: 'QUEUED',
      },
    });

    this.realtime.emitToUser(userId, 'call:queued', {
      callId: call.id, clientName, phone: toMasked, clientId: data.clientId,
    });

    const provider = await this.providerFactory.getProvider(tenantId);

    try {
      const result = await provider.initiate({
        toPhone: data.toPhone,
        agentId: userId,
        agentPhone: agent.callbackPhone || undefined,
        agentExtension: agent.extension || undefined,
        clientName,
      });

      await this.prisma.call.update({
        where: { id: call.id },
        data: { providerCallId: result.providerCallId, status: 'INITIATED' as any, startedAt: new Date() },
      });

      if (provider.name === 'STUB') {
        // STUB: real qongiroq qilinmaydi - faqat UI simulatsiya
        this.logger.warn(
          'STUB provider ishlatilmoqda. ' +
          'Sozlamalar → Telefon dan OnlinePBX yoki Custom SIP sozlang!'
        );
        this.simulateStubCall(call.id, userId, tenantId);
        // Frontend'ga xabar
        this.realtime.emitToUser(userId, 'call:warning', {
          callId: call.id,
          message: 'Sinov rejimi: real qongiroq emas. Sozlamalar → Telefon dan provayder sozlang.',
        });
      }

      return {
        id: call.id,
        providerCallId: result.providerCallId,
        providerName: provider.name,
        status: result.status,
        clientAction: result.clientAction,
      };
    } catch (e: any) {
      this.logger.error(`Qongiroq xatosi: ${e.message}`);
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'FAILED' as any, notes: `Xato: ${e.message}` },
      });
      this.realtime.emitToUser(userId, 'call:failed', { callId: call.id, error: e.message });
      throw new BadRequestException(`Qongiroq xatosi: ${e.message}`);
    }
  }

  private async simulateStubCall(callId: string, userId: string, tenantId: string) {
    setTimeout(async () => {
      const c = await this.prisma.call.findUnique({ where: { id: callId } });
      if (!c || c.status === 'COMPLETED') return;
      await this.prisma.call.update({ where: { id: callId }, data: { status: 'RINGING' as any } });
      this.realtime.emitToUser(userId, 'call:status', { callId, status: 'RINGING' });
    }, 2000);

    setTimeout(async () => {
      const c = await this.prisma.call.findUnique({ where: { id: callId } });
      if (!c || c.status === 'COMPLETED') return;
      const answered = Math.random() > 0.2;
      if (answered) {
        await this.prisma.call.update({ where: { id: callId }, data: { status: 'IN_PROGRESS' as any } });
        this.realtime.emitToUser(userId, 'call:status', { callId, status: 'IN_PROGRESS' });
      } else {
        await this.prisma.call.update({
          where: { id: callId },
          data: { status: 'NO_ANSWER' as any, endedAt: new Date() },
        });
        this.realtime.emitToUser(userId, 'call:status', { callId, status: 'NO_ANSWER' });
      }
    }, 5500);
  }

  async hangup(tenantId: string, userId: string, callId: string) {
    const call = await this.prisma.call.findFirst({
      where: { id: callId, tenantId, agentId: userId },
    });
    if (!call) throw new NotFoundException('Qongiroq topilmadi');
    if (call.status === 'COMPLETED' || call.status === 'CANCELED') return call;

    const duration = call.startedAt
      ? Math.round((Date.now() - new Date(call.startedAt).getTime()) / 1000)
      : 0;

    const provider = await this.providerFactory.getProvider(tenantId);
    if (provider.hangup && call.providerCallId) {
      try { await provider.hangup(call.providerCallId); } catch {}
    }

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: 'COMPLETED' as any, endedAt: new Date(), duration },
    });

    this.realtime.emitToUser(userId, 'call:status', { callId, status: 'COMPLETED', duration });
    return updated;
  }

  /**
   * Telefoniya ulanishini tekshiradi.
   *
   * OnlinePBX uchun bu FAQAT auth.json'ni chaqiradi — u rasmiy hujjatda
   * tasdiqlangan endpoint, shuning uchun natijaga ishonish mumkin:
   * muvaffaqiyatli bo'lsa domen va API kalit to'g'ri degani.
   */
  async testConnection(tenantId: string) {
    const provider: any = await this.providerFactory.getProvider(tenantId);
    if (!provider) {
      return { success: false, message: 'Telefoniya provayderi sozlanmagan' };
    }
    if (typeof provider.testConnection !== 'function') {
      return {
        success: provider.isConfigured?.() ?? false,
        message: provider.isConfigured?.()
          ? `${provider.name}: sozlangan (bu provayder alohida tekshiruvni qo'llab-quvvatlamaydi)`
          : `${provider.name}: sozlanmagan`,
      };
    }
    return provider.testConnection();
  }

  async handleWebhook(body: any) {
    const providerName = this.providerFactory.identifyProvider(body);
    if (!providerName) {
      this.logger.warn(`Webhook: provayder aniqlanmadi - ${JSON.stringify(body).slice(0, 200)}`);
      return { ok: true };
    }

    const tempProvider = providerName === 'ONLINEPBX'
      ? new (await import('../phone-providers/onlinepbx.provider')).OnlinePbxProvider({})
      : new (await import('../phone-providers/twilio.provider')).TwilioProvider({});

    const event = tempProvider.parseWebhook?.(body);
    if (!event) return { ok: true };

    const call = await this.prisma.call.findFirst({
      where: { providerCallId: event.providerCallId },
    });
    if (!call) {
      this.logger.warn(`Webhook: call topilmadi ${event.providerCallId}`);
      return { ok: true };
    }

    const statusMap: Record<string, CallStatus> = {
      queued: 'QUEUED', initiated: 'INITIATED', ringing: 'RINGING',
      in_progress: 'IN_PROGRESS', completed: 'COMPLETED',
      busy: 'BUSY', failed: 'FAILED', no_answer: 'NO_ANSWER', canceled: 'CANCELED',
    };

    const newStatus = statusMap[event.status] || call.status;
    const updateData: any = { status: newStatus };
    if (event.duration && event.duration > 0) updateData.duration = event.duration;
    if (event.recordingUrl) updateData.recordingUrl = event.recordingUrl;
    if (['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY'].includes(newStatus)) {
      updateData.endedAt = new Date();
    }

    await this.prisma.call.update({ where: { id: call.id }, data: updateData });

    this.realtime.emitToUser(call.agentId, 'call:status', {
      callId: call.id, status: newStatus,
      duration: event.duration,
      recordingUrl: event.recordingUrl,
    });

    if (newStatus === 'NO_ANSWER' || newStatus === 'BUSY') {
      this.notifications.create({
        tenantId: call.tenantId,
        userId: call.agentId,
        type: 'CALL_MISSED' as any,
        title: 'Javob berilmadi',
        body: `Raqam: ${call.toMasked}`,
        link: call.clientId ? `/clients/${call.clientId}` : '/calls',
        metadata: { callId: call.id },
      }).catch(() => {});
    }

    return { ok: true };
  }

  async getActive(userId: string) {
    return this.prisma.call.findFirst({
      where: {
        agentId: userId,
        status: { in: ['QUEUED', 'INITIATED', 'RINGING', 'IN_PROGRESS'] as CallStatus[] },
      },
      include: { client: { select: { id: true, fullName: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getStats(tenantId: string, userId: string, role: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const where: any = { tenantId, createdAt: { gte: today } };
    if (role === 'AGENT') where.agentId = userId;

    const [total, answered, missed, durSum] = await Promise.all([
      this.prisma.call.count({ where }),
      this.prisma.call.count({ where: { ...where, status: 'COMPLETED' } }),
      this.prisma.call.count({ where: { ...where, status: { in: ['NO_ANSWER', 'BUSY', 'FAILED'] as CallStatus[] } } }),
      this.prisma.call.aggregate({ where, _sum: { duration: true } }),
    ]);

    const totalDuration = durSum._sum.duration || 0;
    return {
      total, completed: answered, answered, missed, noAnswer: missed,
      totalDuration,
      avgDuration: total > 0 ? Math.round(totalDuration / total) : 0,
      totalMinutes: Math.round(totalDuration / 60),
      answerRate: total > 0 ? Math.round((answered / total) * 100) : 0,
    };
  }

  async addNote(tenantId: string, userId: string, callId: string, notes: string) {
    const call = await this.prisma.call.findFirst({ where: { id: callId, tenantId } });
    if (!call) throw new NotFoundException();
    if (call.agentId !== userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user || !['TENANT_ADMIN', 'MANAGER'].includes(user.role)) throw new ForbiddenException();
    }
    return this.prisma.call.update({ where: { id: callId }, data: { notes } });
  }

  async list(tenantId: string, userId: string, role: string, params: any) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.agentId = userId;
    if (params.clientId) where.clientId = params.clientId;
    if (params.status) where.status = params.status;
    if (params.direction) where.direction = params.direction;

    const limit = Number(params.limit) || 50;
    const skip = ((Number(params.page) || 1) - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.call.findMany({
        where,
        include: {
          agent: { select: { id: true, name: true } },
          client: { select: { id: true, fullName: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.call.count({ where }),
    ]);

    return { data, total, page: Number(params.page) || 1, limit };
  }

  async logManual(tenantId: string, userId: string, data: any) {
    return this.prisma.call.create({
      data: {
        tenantId, agentId: userId,
        clientId: data.clientId, bookingId: data.bookingId,
        direction: (data.direction as CallDirection) || 'OUTBOUND',
        status: 'COMPLETED' as any,
        duration: Number(data.duration) || 0,
        notes: data.notes,
        startedAt: new Date(), endedAt: new Date(),
      },
    });
  }
}

// ─── Controller ───────────────────────────────────────────────────────────────
@ApiTags('IP Telefoniya (Calls)')
@ApiBearerAuth('JWT')
@Controller('calls')
export class CallsController {
  constructor(private svc: CallsService) {}

  @ApiOperation({ summary: 'Telefoniya ulanishini tekshirish' })
  @Post('test-connection')
  @UseGuards(JwtAuthGuard)
  testConnection(@CurrentUser() u: any) {
    return this.svc.testConnection(u.tenantId);
  }

  @ApiOperation({ summary: "Qo'ng'iroqlar tarixi" })
  @Get()
  @UseGuards(JwtAuthGuard)
  list(
    @CurrentUser() u: any,
    @Query('clientId') clientId?: string,
    @Query('status') status?: string,
    @Query('direction') direction?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list(u.tenantId, u.sub, u.role, { clientId, status, direction, page, limit });
  }

  @ApiOperation({ summary: "Joriy faol qo'ng'iroq" })
  @Get('active')
  @UseGuards(JwtAuthGuard)
  active(@CurrentUser() u: any) {
    return this.svc.getActive(u.sub);
  }

  @ApiOperation({ summary: "Bugungi qo'ng'iroq statistikasi" })
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  stats(@CurrentUser() u: any) {
    return this.svc.getStats(u.tenantId, u.sub, u.role);
  }

  @ApiOperation({
    summary: 'Click-to-Call: qongiroq boshlash',
    description: [
      'OnlinePBX orqali chiquvchi qongiroq boshlaydi.',
      '1. Agent extensioniga qongiroq qiladi',
      '2. Agent koteradi',
      '3. Klient raqamiga ulanadi',
      '',
      'Kerakli sozlamalar: Settings -> Telefon -> OnlinePBX',
    ].join('\n'),
  })
  @ApiBody({
    schema: {
      example: { toPhone: '+998901234567', clientId: 'optional_client_id' },
    },
  })
  @Post('initiate')
  @UseGuards(JwtAuthGuard)
  initiate(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.initiate(u.tenantId, u.sub, body);
  }

  @ApiOperation({ summary: "Qo'ng'iroqni tugatish" })
  @Post(':id/hangup')
  @UseGuards(JwtAuthGuard)
  hangup(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.hangup(u.tenantId, u.sub, id);
  }

  @ApiOperation({ summary: "Qo'ng'iroqqa izoh qo'shish" })
  @Post(':id/note')
  @UseGuards(JwtAuthGuard)
  note(@Param('id') id: string, @Body() body: { notes: string }, @CurrentUser() u: any) {
    return this.svc.addNote(u.tenantId, u.sub, id, body.notes);
  }

  @ApiOperation({ summary: "Qo'ng'iroqni qo'lda yozish" })
  @Post('log')
  @UseGuards(JwtAuthGuard)
  log(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.logManual(u.tenantId, u.sub, body);
  }

  @ApiOperation({
    summary: 'OnlinePBX / Twilio Webhook',
    description: [
      'OnlinePBX qongiroq holati ozgarganda ushbu endpointni chaqiradi.',
      '',
      'Webhook URL (OnlinePBX kabinetiga kiriting):',
      'POST https://yourdomain.com/api/v1/calls/webhook',
      '',
      'OnlinePBX payload namunasi:',
      '{ "uuid": "xxx", "status": "completed", "duration_seconds": 45, "recording_url": "https://..." }',
    ].join('\n'),
  })
  @ApiBody({
    schema: {
      example: {
        uuid: 'call-uuid-from-onlinepbx',
        status: 'completed',
        duration_seconds: 45,
        recording_url: 'https://onlinepbx.uz/recordings/xxx.mp3',
      },
    },
  })
  @Post('webhook')
  @Public()
  webhook(@Body() body: any) {
    return this.svc.handleWebhook(body);
  }
}

@Module({
  imports: [PhoneProvidersModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}