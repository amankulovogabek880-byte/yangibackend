import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Patch,
  Body,
  UseGuards,
  BadRequestException,
  Param,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.module';

// ═══════════════════════════════════════════════════════════════════
// ROUND ROBIN SERVICE
//
// Yagona mas'ul: yangi lead kelganda kimga tayinlash kerak.
//
// Asosiy qoida:
//   - isPausedFromAssignment = false bo'lgan agentlargina
//   - status = ACTIVE
//   - dailyLeadLimit (0 = cheksiz)
//   - role: AGENT | MANAGER | TENANT_ADMIN
//   - lastAssignedAt = null yoki eng eski → birinchi navbat
//   - Agar hech kim bo'lmasa → null (tayinlanmaydi)
//
// getNextAgent()      — faqat ID qaytaradi
// assignNewLead()     — ID + client.update + timeline + notification
// assignUnassigned()  — faqat admin "Reassign all" tugmasi uchun
// ═══════════════════════════════════════════════════════════════════

@Injectable()
export class RoundRobinService {
  private readonly logger = new Logger('RoundRobin');

  constructor(
    private _prisma: PrismaService,
    private notifications: NotificationsService,
    private audit: AuditService,
  ) {}

  private get prisma(): any {
    return this._prisma;
  }

  // ─────────────────────────────────────────────────────────────────
  // getNextAgent — round-robin algoritmi
  //
  // lastAssignedAt = null (hech qachon olmagan) → birinchi navbatda
  // lastAssignedAt eng eski → keyingi navbatda
  // Tanlanganidan keyin uning lastAssignedAt = now() yangilanadi
  // ─────────────────────────────────────────────────────────────────
  async getNextAgent(tenantId: string): Promise<string | null> {
    // 1. Barcha faol, pauzasiz agentlarni ol
    const agents = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        isPausedFromAssignment: false,
        role: { in: ['AGENT', 'MANAGER', 'TENANT_ADMIN'] },
      },
      select: {
        id: true,
        lastAssignedAt: true,
        dailyLeadLimit: true,
      },
    });

    if (!agents || agents.length === 0) {
      this.logger.warn(`[ROUND ROBIN] Tenant: ${tenantId} — faol agent yo'q`);
      return null;
    }

    // 2. Kunlik limit tekshir
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const available: any[] = [];
    for (const agent of agents) {
      // dailyLeadLimit = 0 yoki null → cheksiz
      if (!agent.dailyLeadLimit) {
        available.push(agent);
        continue;
      }
      const todayCount = await this.prisma.client.count({
        where: {
          assignedAgentId: agent.id,
          createdAt: { gte: todayStart },
        },
      });
      if (todayCount < agent.dailyLeadLimit) {
        available.push(agent);
      }
    }

    if (available.length === 0) {
      this.logger.warn(`[ROUND ROBIN] Tenant: ${tenantId} — barcha agentlar kunlik limitga yetdi`);
      return null;
    }

    // 3. Round-Robin tartiblash:
    //    lastAssignedAt = null → getTime() = 0 → eng birinchi
    //    lastAssignedAt eng kichik → eng birinchi
    available.sort((a: any, b: any) => {
      const aTime = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
      const bTime = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
      return aTime - bTime;
    });

    const chosen = available[0];

    // 4. lastAssignedAt yangilash
    try {
      await this.prisma.user.update({
        where: { id: chosen.id },
        data: { lastAssignedAt: new Date() },
      });
    } catch (err: any) {
      this.logger.error(`[ROUND ROBIN] lastAssignedAt yangilanmadi agent=${chosen.id}: ${err?.message}`);
    }

    this.logger.log(`[ROUND ROBIN] Tenant: ${tenantId} | Agent: ${chosen.id} | lastAssigned: ${chosen.lastAssignedAt}`);
    return chosen.id;
  }

  // ─────────────────────────────────────────────────────────────────
  // assignNewLead — yangi lead yaratilgandan keyin chaqiriladi
  //
  // Qiladi:
  //   1. getNextAgent() → agentId
  //   2. client.assignedAgentId = agentId
  //   3. Timeline yozadi
  //   4. Agentga notification yuboradi
  //   5. Audit log
  //
  // Qaytaradi: agentId yoki null (agent topilmasa)
  // ─────────────────────────────────────────────────────────────────
  async assignNewLead(params: {
    tenantId: string;
    clientId: string;
    clientName: string;
    source?: string;
  }): Promise<string | null> {
    const { tenantId, clientId, clientName, source } = params;

    const agentId = await this.getNextAgent(tenantId);
    if (!agentId) {
      this.logger.warn(`[ROUND ROBIN] Lead: ${clientId} — agent topilmadi, tayinlanmadi`);
      return null;
    }

    // 1. Clientga agentni tayinla
    try {
      await this.prisma.client.update({
        where: { id: clientId },
        data: { assignedAgentId: agentId },
      });
    } catch (err: any) {
      this.logger.error(`[ROUND ROBIN] client.update xato client=${clientId}: ${err?.message}`);
      return null;
    }

    // 2. Timeline
    await this.prisma.clientTimeline.create({
      data: {
        clientId,
        userId: agentId,
        type: 'assigned',
        title: '🎯 Avtomatik tayinlandi (Round Robin)',
        metadata: { autoAssigned: true, source: source || 'SYSTEM' },
      },
    }).catch((err: any) => {
      this.logger.error(`[ROUND ROBIN] timeline.create xato: ${err?.message}`);
    });

    // 3. Agentga notification
    await this.notifications.create({
      tenantId,
      userId: agentId,
      type: 'CLIENT_ASSIGNED' as any,
      title: `🎯 Yangi lead: ${clientName}`,
      body: `Sizga yangi mijoz avtomatik tayinlandi. Manba: ${source || 'SYSTEM'}`,
      link: `/clients/${clientId}`,
      metadata: { clientId, source, autoAssigned: true },
    }).catch((err: any) => {
      this.logger.error(`[ROUND ROBIN] notification.create xato: ${err?.message}`);
    });

    // 4. Audit
    this.audit.log({
      tenantId,
      userId: agentId,
      action: 'ASSIGN',
      entity: 'client',
      entityId: clientId,
      metadata: { auto: true, strategy: 'ROUND_ROBIN', source },
    });

    this.logger.log(
      `[ROUND ROBIN] Lead: ${clientId} | Agent: ${agentId} | Tenant: ${tenantId} | Source: ${source || 'SYSTEM'}`,
    );

    return agentId;
  }

  // ─────────────────────────────────────────────────────────────────
  // assignUnassigned — FAQAT admin "Reassign all" tugmasi uchun
  //
  // assignedAgentId = null bo'lgan barcha leadlarni taqsimlaydi.
  // Yangi kelayotgan leadlar uchun EMAS — ular assignNewLead() orqali.
  // ─────────────────────────────────────────────────────────────────
  async assignUnassigned(tenantId: string): Promise<{ assigned: number; skipped: number }> {
    const unassigned = await this.prisma.client.findMany({
      where: { tenantId, assignedAgentId: null },
      select: { id: true, fullName: true, source: true },
      orderBy: { createdAt: 'asc' },
    });

    let assigned = 0;
    let skipped = 0;

    for (const client of unassigned) {
      const agentId = await this.getNextAgent(tenantId);
      if (!agentId) {
        skipped++;
        continue;
      }

      await this.prisma.client.update({
        where: { id: client.id },
        data: { assignedAgentId: agentId },
      }).catch(() => {});

      await this.prisma.clientTimeline.create({
        data: {
          clientId: client.id,
          userId: agentId,
          type: 'assigned',
          title: '🔄 Qayta tayinlandi (Admin)',
          metadata: { autoAssigned: true, strategy: 'REASSIGN_ALL' },
        },
      }).catch(() => {});

      this.logger.log(`[ROUND ROBIN] Reassign: Lead=${client.id} → Agent=${agentId}`);
      assigned++;
    }

    return { assigned, skipped };
  }

  // ─────────────────────────────────────────────────────────────────
  // autoAssignClient — bitta clientni qo'lda qayta tayinlash (admin)
  // ─────────────────────────────────────────────────────────────────
  async autoAssignClient(tenantId: string, clientId: string): Promise<string | null> {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: { id: true, fullName: true, source: true },
    });
    if (!client) return null;

    return this.assignNewLead({
      tenantId,
      clientId,
      clientName: client.fullName,
      source: client.source,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Strategiya (MANUAL / ROUND_ROBIN)
  // ─────────────────────────────────────────────────────────────────
  async setStrategy(tenantId: string, strategy: string) {
    const valid = ['MANUAL', 'ROUND_ROBIN'];
    const s = valid.includes(strategy) ? strategy : 'ROUND_ROBIN';
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: { leadAssignmentStrategy: s as any },
    });
  }

  async getStrategy(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { leadAssignmentStrategy: true },
    });
    return { strategy: t?.leadAssignmentStrategy || 'ROUND_ROBIN' };
  }

  // ─────────────────────────────────────────────────────────────────
  // Navbat holati — kim keyingisi
  // ─────────────────────────────────────────────────────────────────
  async getQueue(tenantId: string) {
    const agents = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        role: { in: ['AGENT', 'MANAGER', 'TENANT_ADMIN'] },
      },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        role: true,
        lastAssignedAt: true,
        isPausedFromAssignment: true,
        dailyLeadLimit: true,
        _count: { select: { assignedClients: true } },
      },
    });

    agents.sort((a: any, b: any) => {
      const aTime = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
      const bTime = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
      return aTime - bTime;
    });

    return agents.map((a: any, idx: number) => ({
      id: a.id,
      name: a.name,
      avatarUrl: a.avatarUrl,
      role: a.role,
      lastAssignedAt: a.lastAssignedAt,
      isPaused: a.isPausedFromAssignment,
      dailyLeadLimit: a.dailyLeadLimit,
      activeClients: a._count.assignedClients,
      position: idx + 1,
      isNext: idx === 0 && !a.isPausedFromAssignment,
    }));
  }

  // ─────────────────────────────────────────────────────────────────
  // Agent boshqaruv
  // ─────────────────────────────────────────────────────────────────
  async pauseAgent(tenantId: string, agentId: string, reason?: string, until?: string) {
    await this.prisma.user.update({
      where: { id: agentId, tenantId },
      data: {
        isPausedFromAssignment: true,
        pausedReason: reason || null,
        pausedUntil: until ? new Date(until) : null,
      },
    });
    return { success: true };
  }

  async unpauseAgent(tenantId: string, agentId: string) {
    await this.prisma.user.update({
      where: { id: agentId, tenantId },
      data: {
        isPausedFromAssignment: false,
        pausedReason: null,
        pausedUntil: null,
      },
    });
    return { success: true };
  }

  async setDailyLimit(tenantId: string, agentId: string, limit: number) {
    if (limit < 0) throw new BadRequestException("Limit 0 yoki undan ko'p bo'lishi kerak");
    await this.prisma.user.update({
      where: { id: agentId, tenantId },
      data: { dailyLeadLimit: Math.max(0, limit) },
    });
    return { success: true };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ROUND ROBIN CONTROLLER
// ═══════════════════════════════════════════════════════════════════
@Controller('lead-assignment')
@UseGuards(JwtAuthGuard)
export class RoundRobinController {
  constructor(private svc: RoundRobinService) {}

  @Get('strategy')
  getStrategy(@CurrentUser() u: any) {
    return this.svc.getStrategy(u.tenantId);
  }

  @Post('strategy')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  setStrategy(@Body() body: { strategy: string }, @CurrentUser() u: any) {
    return this.svc.setStrategy(u.tenantId, body.strategy);
  }

  @Get('queue')
  queue(@CurrentUser() u: any) {
    return this.svc.getQueue(u.tenantId);
  }

  @Post('assign/:clientId')
  assign(@Param('clientId') clientId: string, @CurrentUser() u: any) {
    return this.svc.autoAssignClient(u.tenantId, clientId);
  }

  @Post('assign-unassigned')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  assignAll(@CurrentUser() u: any) {
    return this.svc.assignUnassigned(u.tenantId);
  }

  @Post('agents/:agentId/pause')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  pauseAgent(
    @CurrentUser() u: any,
    @Param('agentId') agentId: string,
    @Body() body: { reason?: string; until?: string },
  ) {
    return this.svc.pauseAgent(u.tenantId, agentId, body.reason, body.until);
  }

  @Post('agents/:agentId/unpause')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  unpauseAgent(@CurrentUser() u: any, @Param('agentId') agentId: string) {
    return this.svc.unpauseAgent(u.tenantId, agentId);
  }

  @Patch('agents/:agentId/daily-limit')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  setDailyLimit(
    @CurrentUser() u: any,
    @Param('agentId') agentId: string,
    @Body() body: { limit: number },
  ) {
    return this.svc.setDailyLimit(u.tenantId, agentId, body.limit);
  }
}

// ═══════════════════════════════════════════════════════════════════
// MODULE
// ═══════════════════════════════════════════════════════════════════
@Module({
  controllers: [RoundRobinController],
  providers: [RoundRobinService],
  exports: [RoundRobinService],
})
export class RoundRobinModule {}
