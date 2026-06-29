import {
  Module, Injectable, Controller, Get, Post, Put, Delete, Param, Body,
  UseGuards, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { safeEnum } from '../../common/utils/helpers';
import { AutomationTrigger } from '../../prisma-types';;

const TRIGGERS: AutomationTrigger[] = [
  'LEAD_CREATED', 'STAGE_CHANGED', 'BOOKING_CREATED', 'PAYMENT_RECEIVED',
  'NO_RESPONSE_24H', 'NO_RESPONSE_7D', 'TAG_ADDED', 'CALL_MISSED',
];

@Injectable()
export class AutomationsService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private notifications: NotificationsService,
  ) {}

  // BUG2 FIX: Automation executor
  private async executeAutomation(tenantId: string, trigger: string, context: any) {
    try {
      const automations = await this.prisma.automation.findMany({
        where: { tenantId, trigger: trigger as any, isActive: true },
      });
      for (const automation of automations) {
        const actions: any[] = Array.isArray(automation.actions) ? automation.actions : [];
        for (const action of actions) {
          try {
            if (action.type === 'SEND_NOTIFICATION') {
              const targetId = context.assignedAgentId || context.userId;
              if (targetId) {
                await this.notifications.create({
                  tenantId, userId: targetId, type: 'SYSTEM' as any,
                  title: action.title || 'Avtomatik bildirishnoma',
                  body: action.message || '',
                  link: context.clientId ? `/clients/${context.clientId}` : undefined,
                  metadata: { automationId: automation.id, trigger },
                });
              }
            } else if (action.type === 'CHANGE_STAGE') {
              if (context.clientId && action.stage) {
                await (this.prisma as any).client.update({
                  where: { id: context.clientId },
                  data: { pipelineStage: action.stage },
                });
              }
            } else if (action.type === 'ASSIGN_AGENT') {
              if (context.clientId && action.agentId) {
                await (this.prisma as any).client.update({
                  where: { id: context.clientId },
                  data: { assignedAgentId: action.agentId },
                });
              }
            } else if (action.type === 'CREATE_TASK') {
              if (context.clientId) {
                await (this.prisma as any).task.create({
                  data: {
                    tenantId,
                    title: action.title || 'Avtomatik vazifa',
                    clientId: context.clientId,
                    assigneeId: context.assignedAgentId || null,
                    creatorId: context.assignedAgentId || null,
                    dueAt: action.dueDays ? new Date(Date.now() + action.dueDays * 86400000) : null,
                    priority: action.priority || 'MEDIUM',
                    status: 'TODO',
                  },
                });
              }
            }
          } catch (ae: any) {
            console.error(`[Automation] action error [${automation.id}]:`, ae?.message);
          }
        }
        await this.prisma.automation.update({
          where: { id: automation.id },
          data: { runCount: { increment: 1 }, lastRunAt: new Date() },
        });
      }
    } catch (e: any) {
      console.error(`[Automation] executor error [${trigger}]:`, e?.message);
    }
  }

  @OnEvent('lead.created')
  async onLeadCreated(p: { tenantId: string; clientId: string; assignedAgentId?: string }) {
    await this.executeAutomation(p.tenantId, 'LEAD_CREATED', p);
  }
  @OnEvent('stage.changed')
  async onStageChanged(p: { tenantId: string; clientId: string; stage: string; assignedAgentId?: string }) {
    await this.executeAutomation(p.tenantId, 'STAGE_CHANGED', p);
  }
  @OnEvent('booking.created')
  async onBookingCreated(p: { tenantId: string; clientId: string; bookingId: string; assignedAgentId?: string }) {
    await this.executeAutomation(p.tenantId, 'BOOKING_CREATED', p);
  }
  @OnEvent('payment.received')
  async onPaymentReceived(p: { tenantId: string; clientId: string; amount: number }) {
    await this.executeAutomation(p.tenantId, 'PAYMENT_RECEIVED', p);
  }

  async list(tenantId: string) {
    return this.prisma.automation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(tenantId: string, id: string) {
    const a = await this.prisma.automation.findFirst({ where: { id, tenantId } });
    if (!a) throw new NotFoundException('Topilmadi');
    return a;
  }

  async create(tenantId: string, data: any) {
    if (!data.name?.trim()) throw new BadRequestException('name majburiy');
    if (!Array.isArray(data.actions) || !data.actions.length) {
      throw new BadRequestException('actions kerak');
    }
    return this.prisma.automation.create({
      data: {
        tenantId,
        name: data.name.trim(),
        trigger: safeEnum(data.trigger, TRIGGERS, 'LEAD_CREATED'),
        conditions: data.conditions || {},
        actions: data.actions,
        isActive: data.isActive ?? true,
      },
    });
  }

  async update(tenantId: string, id: string, data: any) {
    await this.findOne(tenantId, id);
    const { id: _, tenantId: _t, runCount: _r, lastRunAt: _l, ...safe } = data;
    if (safe.trigger) safe.trigger = safeEnum(safe.trigger, TRIGGERS, 'LEAD_CREATED');
    return this.prisma.automation.update({ where: { id }, data: safe });
  }

  async delete(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    await this.prisma.automation.delete({ where: { id } });
    return { ok: true };
  }

  async toggle(tenantId: string, id: string) {
    const a = await this.findOne(tenantId, id);
    return this.prisma.automation.update({
      where: { id }, data: { isActive: !a.isActive },
    });
  }
}

@Controller('automations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TENANT_ADMIN', 'MANAGER')
export class AutomationsController {
  constructor(private svc: AutomationsService) {}

  @Get()
  list(@CurrentUser() u: any) {
    return this.svc.list(u.tenantId);
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.findOne(u.tenantId, id);
  }

  @Post()
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.create(u.tenantId, body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, id);
  }

  @Post(':id/toggle')
  toggle(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.toggle(u.tenantId, id);
  }
}

@Module({
  imports: [], // NotificationsModule global shuning uchun import shart emas
  controllers: [AutomationsController],
  providers: [AutomationsService],
  exports: [AutomationsService],
})
export class AutomationsModule {}
