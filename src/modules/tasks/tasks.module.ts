import {
  Module, Injectable, Controller, Get, Post, Put, Patch, Delete, Param, Body, Query,
  UseGuards, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { safeEnum, paginate, meta, clean } from '../../common/utils/helpers';
import { NotificationsService } from '../notifications/notifications.service';
import { Prisma } from '@prisma/client';
import { TaskStatus, TaskPriority } from '../../prisma-types';;

const STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
const PRIORITIES: TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async list(tenantId: string, userId: string, role: string, params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where: any = { tenantId };
    if (role === 'AGENT') where.assigneeId = userId;
    if (params.status) where.status = params.status as TaskStatus;
    if (params.assigneeId && role !== 'AGENT') where.assigneeId = params.assigneeId;
    if (params.clientId) where.clientId = params.clientId;
    if (params.bookingId) where.bookingId = params.bookingId;
    if (params.priority) where.priority = params.priority as TaskPriority;

    // v40: bajarilgan (DONE) vazifa 1 kundan keyin ro'yxatdan avtomatik
    // yo'qoladi — bazadan o'chirilmaydi (tarix saqlanadi), faqat
    // ro'yxatga chiqmaydi. Agar kimdir aniq `status=DONE` bilan
    // filtrlab qarasa (masalan tarixni ko'rish uchun), bu cheklov
    // qo'llanilmaydi — chunki u holda foydalanuvchi ATAYIN bajarilgan
    // vazifalarni so'rayapti.
    if (!params.status) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      where.NOT = {
        status: 'DONE',
        completedAt: { lt: oneDayAgo },
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where, skip, take,
        include: {
          creator: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
          client: { select: { id: true, fullName: true } },
        },
        orderBy: [{ status: 'asc' }, { priority: 'desc' }, { dueAt: 'asc' }],
      }),
      this.prisma.task.count({ where }),
    ]);
    return { data, meta: meta(total, page, limit) };
  }

  async create(tenantId: string, userId: string, data: any) {
    if (!data.title?.trim()) throw new BadRequestException('title majburiy');

    const task = await this.prisma.task.create({
      data: {
        tenantId,
        creatorId: userId,
        assigneeId: data.assigneeId || userId,
        clientId: data.clientId,
        bookingId: data.bookingId,
        title: data.title.trim(),
        description: data.description,
        status: safeEnum(data.status, STATUSES, 'TODO'),
        priority: safeEnum(data.priority, PRIORITIES, 'MEDIUM'),
        dueAt: data.dueAt ? new Date(data.dueAt) : undefined,
        recurrence: data.recurrence,
        tags: Array.isArray(data.tags) ? data.tags : [],
      },
    });

    if (task.assigneeId !== userId) {
      await this.notifications.create({
        tenantId,
        userId: task.assigneeId,
        type: 'TASK_ASSIGNED',
        title: '📋 Sizga vazifa tayinlandi',
        body: task.title,
        link: `/tasks?id=${task.id}`,
        metadata: { taskId: task.id },
      }).catch(() => {});
    }
    return task;
  }

  async update(tenantId: string, id: string, userId: string, role: string, data: any) {
    const t = await this.prisma.task.findFirst({ where: { id, tenantId } });
    if (!t) throw new NotFoundException('Topilmadi');
    if (role === 'AGENT' && t.assigneeId !== userId && t.creatorId !== userId) {
      throw new NotFoundException('Topilmadi');
    }

    const { id: _, tenantId: _t, creatorId: _c, createdAt: _ca, ...safe } = data;
    if (safe.dueAt) safe.dueAt = new Date(safe.dueAt);
    if (safe.status) safe.status = safeEnum(safe.status, STATUSES, t.status);
    if (safe.priority) safe.priority = safeEnum(safe.priority, PRIORITIES, t.priority);
    if (safe.status === 'DONE' && !t.completedAt) safe.completedAt = new Date();

    const updated = await this.prisma.task.update({ where: { id }, data: clean(safe) });

    // Notify: task completed → notify creator
    if (safe.status === 'DONE' && t.status !== 'DONE' && t.creatorId && t.creatorId !== userId) {
      await this.notifications.create({
        tenantId, userId: t.creatorId,
        type: 'TASK_ASSIGNED',
        title: '✅ Vazifa bajarildi',
        body: t.title,
        link: t.clientId ? `/clients/${t.clientId}` : '/tasks',
        metadata: { taskId: id },
      }).catch(() => {});
    }

    // Notify: assigned → due soon reminder (if status changed to IN_PROGRESS)
    if (safe.status === 'IN_PROGRESS' && t.status === 'TODO' && t.assigneeId && t.assigneeId !== userId) {
      await this.notifications.create({
        tenantId, userId: t.assigneeId,
        type: 'TASK_ASSIGNED',
        title: '🔄 Vazifa boshlandi',
        body: t.title,
        metadata: { taskId: id },
      }).catch(() => {});
    }

    return updated;
  }

  async delete(tenantId: string, id: string, userId: string, role: string) {
    const t = await this.prisma.task.findFirst({ where: { id, tenantId } });
    if (!t) throw new NotFoundException('Topilmadi');
    if (role === 'AGENT' && t.creatorId !== userId) {
      throw new BadRequestException("Faqat o'zingiz yaratgan vazifani o'chira olasiz");
    }
    await this.prisma.task.delete({ where: { id } });
    return { ok: true };
  }
}

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(private svc: TasksService) {}

  @Get()
  list(
    @CurrentUser() u: any,
    @Query('status') status?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('clientId') clientId?: string,
    @Query('bookingId') bookingId?: string,
    @Query('priority') priority?: string,
    @Query('page') page?: any,
    @Query('limit') limit?: any,
  ) {
    return this.svc.list(u.tenantId, u.sub, u.role, {
      status, assigneeId, clientId, bookingId, priority, page, limit,
    });
  }

  @Post()
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.create(u.tenantId, u.sub, body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.sub, u.role, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, id, u.sub, u.role);
  }

  /** v6: Kanban drag-drop — status o'zgartirish */
  @Patch(':id/status')
  changeStatus(@Param('id') id: string, @Body() body: { status: string }, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.sub, u.role, { status: body.status });
  }

  /** v6: Kanban board — barcha task'larni status bo'yicha guruhlab beradi */
  @Get('board')
  async board(@CurrentUser() u: any, @Query('assigneeId') assigneeId?: string) {
    const result = await this.svc.list(u.tenantId, u.sub, u.role, {
      assigneeId, page: 1, limit: 500,
    });
    const tasks = result.data || [];
    const statuses = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
    const board: Record<string, any[]> = {};
    statuses.forEach((s) => (board[s] = []));
    tasks.forEach((t: any) => {
      if (board[t.status]) board[t.status].push(t);
    });
    return board;
  }
}

@Module({
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}