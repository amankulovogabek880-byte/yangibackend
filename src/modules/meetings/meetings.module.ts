import {
  Module, Injectable, Controller, Get, Post, Put, Patch, Delete, Param, Body, Query,
  UseGuards, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { safeEnum, clean } from '../../common/utils/helpers';
import { NotificationsService } from '../notifications/notifications.service';
import { MeetingType, MeetingStatus } from '../../prisma-types';

const TYPES: MeetingType[] = ['MEETING', 'CALL', 'VISIT', 'OTHER'];
const STATUSES: MeetingStatus[] = ['SCHEDULED', 'DONE', 'CANCELLED'];

/**
 * Kalendar / Uchrashuvlar moduli (AMO/Bitrix uslubidagi kalendar).
 * Har bir yozuv — bitta agentga (va ixtiyoriy ravishda bitta mijozga)
 * bog'langan uchrashuv/vazifa/qo'ng'iroq. Belgilangan vaqtdan
 * `reminderMinutesBefore` daqiqa oldin agentga eslatma (notification)
 * yuboriladi.
 */
@Injectable()
export class MeetingsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async list(tenantId: string, userId: string, role: string, params: any) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.agentId = userId;
    else if (params.agentId) where.agentId = params.agentId;
    if (params.clientId) where.clientId = params.clientId;
    if (params.status) where.status = safeEnum(params.status, STATUSES, undefined as any);
    if (params.from || params.to) {
      where.startAt = {};
      if (params.from) where.startAt.gte = new Date(params.from);
      if (params.to) where.startAt.lte = new Date(params.to);
    }

    return this.prisma.meeting.findMany({
      where,
      include: {
        agent: { select: { id: true, name: true } },
        client: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: { startAt: 'asc' },
      take: 500,
    });
  }

  /** Kalendar oy/hafta ko'rinishi uchun — berilgan sana oralig'idagi barcha uchrashuvlar */
  async calendar(tenantId: string, userId: string, role: string, params: any) {
    const from = params.from ? new Date(params.from) : new Date();
    const to = params.to ? new Date(params.to) : (() => {
      const d = new Date(from);
      d.setDate(d.getDate() + 42);
      return d;
    })();

    const where: any = { tenantId, startAt: { gte: from, lte: to } };
    if (role === 'AGENT') where.agentId = userId;
    else if (params.agentId) where.agentId = params.agentId;

    const items = await this.prisma.meeting.findMany({
      where,
      include: {
        agent: { select: { id: true, name: true } },
        client: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: { startAt: 'asc' },
    });
    return { items };
  }

  async create(tenantId: string, userId: string, data: any) {
    if (!data.title?.trim()) throw new BadRequestException('Sarlavha majburiy');
    if (!data.startAt) throw new BadRequestException('Sana va vaqt majburiy');
    const start = new Date(data.startAt);
    if (isNaN(start.getTime())) throw new BadRequestException("Sana noto'g'ri");
    const end = data.endAt ? new Date(data.endAt) : undefined;

    const meeting = await this.prisma.meeting.create({
      data: {
        tenantId,
        createdById: userId,
        agentId: data.agentId || userId,
        clientId: data.clientId || undefined,
        title: data.title.trim(),
        type: safeEnum(data.type, TYPES, 'MEETING'),
        status: 'SCHEDULED',
        startAt: start,
        endAt: end,
        location: data.location?.trim() || undefined,
        note: data.note?.trim() || undefined,
        reminderMinutesBefore: Number.isFinite(Number(data.reminderMinutesBefore))
          ? Math.max(0, Math.floor(Number(data.reminderMinutesBefore)))
          : 30,
      },
      include: {
        agent: { select: { id: true, name: true } },
        client: { select: { id: true, fullName: true, phone: true } },
      },
    });

    if (meeting.agentId !== userId) {
      await this.notifications.create({
        tenantId,
        userId: meeting.agentId,
        type: 'MEETING_ASSIGNED',
        title: '📅 Sizga uchrashuv belgilandi',
        body: `${meeting.title} — ${start.toLocaleString('uz-UZ')}`,
        link: meeting.clientId ? `/clients/${meeting.clientId}` : '/calendar',
        metadata: { meetingId: meeting.id },
      }).catch(() => {});
    }
    return meeting;
  }

  async update(tenantId: string, id: string, userId: string, role: string, data: any) {
    const where: any = { id, tenantId };
    if (role === 'AGENT') where.agentId = userId;
    const m = await this.prisma.meeting.findFirst({ where });
    if (!m) throw new NotFoundException('Topilmadi');

    const { id: _id, tenantId: _t, createdById: _c, createdAt: _ca, ...safe } = data;
    if (safe.startAt) {
      safe.startAt = new Date(safe.startAt);
      // Vaqt o'zgartirilsa — eslatma qayta yuborilishi uchun tozalanadi
      safe.remindedAt = null;
    }
    if (safe.endAt) safe.endAt = new Date(safe.endAt);
    if (safe.type) safe.type = safeEnum(safe.type, TYPES, m.type);
    if (safe.status) safe.status = safeEnum(safe.status, STATUSES, m.status);
    if (safe.title) safe.title = String(safe.title).trim();

    return this.prisma.meeting.update({
      where: { id },
      data: clean(safe),
      include: {
        agent: { select: { id: true, name: true } },
        client: { select: { id: true, fullName: true, phone: true } },
      },
    });
  }

  async delete(tenantId: string, id: string, userId: string, role: string) {
    const where: any = { id, tenantId };
    if (role === 'AGENT') where.agentId = userId;
    const m = await this.prisma.meeting.findFirst({ where });
    if (!m) throw new NotFoundException('Topilmadi');
    await this.prisma.meeting.delete({ where: { id } });
    return { ok: true };
  }

  /** Har daqiqada tekshiradi: reminderMinutesBefore vaqti kelgan uchrashuvlarga eslatma yuboradi */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkReminders() {
    const now = new Date();
    const upcoming = await this.prisma.meeting.findMany({
      where: { status: 'SCHEDULED', remindedAt: null, startAt: { gte: now } },
      include: { client: { select: { fullName: true } } },
      take: 200,
    });
    for (const m of upcoming) {
      const minutesUntil = (m.startAt.getTime() - now.getTime()) / 60000;
      if (minutesUntil > m.reminderMinutesBefore) continue;
      try {
        await this.notifications.create({
          tenantId: m.tenantId,
          userId: m.agentId,
          type: 'MEETING_REMINDER',
          title: `⏰ Uchrashuv: ${m.title}`,
          body: m.client
            ? `${m.client.fullName} — ${m.startAt.toLocaleString('uz-UZ')}`
            : m.startAt.toLocaleString('uz-UZ'),
          link: m.clientId ? `/clients/${m.clientId}` : '/calendar',
          metadata: { meetingId: m.id },
        });
        await this.prisma.meeting.update({ where: { id: m.id }, data: { remindedAt: now } });
      } catch {}
    }

    // O'tib ketgan (startAt < now), hali SCHEDULED holatidagi uchrashuvlarga ham
    // (agar eslatma hali yuborilmagan bo'lsa) darhol eslatma yuboriladi — masalan
    // server bir muddat ishlamay qolgan bo'lishi mumkin.
    const overdue = await this.prisma.meeting.findMany({
      where: { status: 'SCHEDULED', remindedAt: null, startAt: { lt: now } },
      include: { client: { select: { fullName: true } } },
      take: 100,
    });
    for (const m of overdue) {
      try {
        await this.notifications.create({
          tenantId: m.tenantId,
          userId: m.agentId,
          type: 'MEETING_REMINDER',
          title: `⏰ Uchrashuv vaqti keldi: ${m.title}`,
          body: m.client ? m.client.fullName : undefined,
          link: m.clientId ? `/clients/${m.clientId}` : '/calendar',
          metadata: { meetingId: m.id },
        });
        await this.prisma.meeting.update({ where: { id: m.id }, data: { remindedAt: now } });
      } catch {}
    }
  }
}

@Controller('meetings')
@UseGuards(JwtAuthGuard)
export class MeetingsController {
  constructor(private svc: MeetingsService) {}

  @Get()
  list(
    @CurrentUser() u: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('agentId') agentId?: string,
    @Query('clientId') clientId?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.list(u.tenantId, u.sub, u.role, { from, to, agentId, clientId, status });
  }

  /** Oy/hafta ko'rinishidagi kalendar uchun — sana oralig'idagi barcha uchrashuvlar */
  @Get('calendar')
  calendar(
    @CurrentUser() u: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('agentId') agentId?: string,
  ) {
    return this.svc.calendar(u.tenantId, u.sub, u.role, { from, to, agentId });
  }

  @Post()
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.create(u.tenantId, u.sub, body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.sub, u.role, body);
  }

  @Patch(':id/status')
  changeStatus(@Param('id') id: string, @Body() body: { status: string }, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.sub, u.role, { status: body.status });
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, id, u.sub, u.role);
  }
}

@Module({
  controllers: [MeetingsController],
  providers: [MeetingsService],
  exports: [MeetingsService],
})
export class MeetingsModule {}