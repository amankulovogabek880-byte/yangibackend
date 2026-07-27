import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Param, Body, Query,
  UseGuards, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class FollowUpsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async list(tenantId: string, userId: string, role: string, params: any) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.agentId = userId;
    if (params.done !== undefined) where.done = params.done === 'true' ? true : params.done === 'false' ? false : undefined;
    if (params.clientId) where.clientId = params.clientId;
    return this.prisma.followUp.findMany({
      where,
      include: {
        agent: { select: { id: true, name: true } },
        client: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: [{ done: 'asc' }, { dueAt: 'asc' }],
      take: 200,
    });
  }

  async create(tenantId: string, userId: string, data: any) {
    if (!data.title?.trim()) throw new BadRequestException('Sarlavha majburiy');
    if (!data.dueAt) throw new BadRequestException('Vaqt majburiy');
    const due = new Date(data.dueAt);
    if (isNaN(due.getTime())) throw new BadRequestException("Vaqt noto'g'ri");

    return this.prisma.followUp.create({
      data: {
        tenantId,
        agentId: data.agentId || userId,
        clientId: data.clientId,
        title: data.title.trim(),
        note: data.note,
        dueAt: due,
      },
    });
  }

  async complete(tenantId: string, userId: string, role: string, id: string) {
    const where: any = { id, tenantId };
    if (role === 'AGENT') where.agentId = userId;
    const fu = await this.prisma.followUp.findFirst({ where });
    if (!fu) throw new NotFoundException("Eslatma topilmadi");
    return this.prisma.followUp.update({
      where: { id }, data: { done: true, doneAt: new Date() },
    });
  }

  async delete(tenantId: string, userId: string, role: string, id: string) {
    const where: any = { id, tenantId };
    if (role === 'AGENT') where.agentId = userId;
    const fu = await this.prisma.followUp.findFirst({ where });
    if (!fu) throw new NotFoundException("Eslatma topilmadi");
    await this.prisma.followUp.delete({ where: { id } });
    return { ok: true };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkDueFollowUps() {
    const now = new Date();
    const due = await this.prisma.followUp.findMany({
      where: { done: false, dueAt: { lte: now }, notifiedAt: null },
      include: { client: { select: { fullName: true } } },
      take: 100,
    });
    for (const fu of due) {
      try {
        await this.notifications.create({
          tenantId: fu.tenantId,
          userId: fu.agentId,
          type: 'FOLLOWUP_DUE',
          title: `⏰ Eslatma: ${fu.title}`,
          body: fu.client ? `${fu.client.fullName} — ${fu.note || ''}`.trim() : fu.note || undefined,
          link: fu.clientId ? `/clients/${fu.clientId}` : '/followups',
          metadata: { followUpId: fu.id },
        });
        await this.prisma.followUp.update({
          where: { id: fu.id }, data: { notifiedAt: now },
        });
      } catch {}
    }
  }
}

@Controller('followups')
@UseGuards(JwtAuthGuard)
export class FollowUpsController {
  constructor(private svc: FollowUpsService) {}

  @Get()
  list(@CurrentUser() u: any, @Query('done') done?: string, @Query('clientId') clientId?: string) {
    return this.svc.list(u.tenantId, u.sub, u.role, { done, clientId });
  }

  @Post()
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.create(u.tenantId, u.sub, body);
  }

  @Patch(':id/complete')
  complete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.complete(u.tenantId, u.sub, u.role, id);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, u.sub, u.role, id);
  }

  /** v6: Calendar view (date range filter) */
  @Get('calendar')
  async calendar(
    @CurrentUser() u: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : new Date();
    const toDate = to ? new Date(to) : (() => {
      const d = new Date(fromDate);
      d.setDate(d.getDate() + 30);
      return d;
    })();

    const where: any = {
      tenantId: u.tenantId,
      dueAt: { gte: fromDate, lte: toDate },
    };
    if (u.role === 'AGENT') where.agentId = u.sub;

    const items = await (this.svc as any).prisma.followUp.findMany({
      where,
      include: {
        client: { select: { id: true, fullName: true, phone: true } },
        agent: { select: { id: true, name: true } },
      },
      orderBy: { dueAt: 'asc' },
    });

    // Sana bo'yicha guruhlash
    const byDate: Record<string, any[]> = {};
    items.forEach((f: any) => {
      const k = f.dueAt.toISOString().slice(0, 10);
      if (!byDate[k]) byDate[k] = [];
      byDate[k].push(f);
    });
    return { items, byDate };
  }
}

@Module({
  controllers: [FollowUpsController],
  providers: [FollowUpsService],
})
export class FollowUpsModule {}