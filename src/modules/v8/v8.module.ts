import {
  Module, Injectable, Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards,
  BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';

/**
 * v8: Yangi funksiyalar uchun unified service
 *
 * Maqsad: eski modullarga tegmasdan yangi funksiyalar qo'shish:
 *   - Duplicate detection
 *   - Lead assignment (round-robin / least-busy)
 *   - Bulk actions
 *   - Saved filters
 *   - Booking checklist
 *   - Commission calculator
 *   - Client 360 profile
 *   - Activity timeline (unified)
 */
@Injectable()
export class V8Service {
  constructor(private prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════
  // 1. DUPLICATE DETECTION
  // ═══════════════════════════════════════════════════════════

  /**
   * Telefon yoki email bo'yicha mavjud klientni topish.
   * Frontend: yangi klient qo'shishdan oldin tekshiradi.
   */
  async checkDuplicate(tenantId: string, params: { phone?: string; email?: string; telegramUsername?: string }) {
    const conditions: any[] = [];
    if (params.phone?.trim()) {
      const normalized = params.phone.replace(/[^\d]/g, '');
      conditions.push({ phone: { contains: normalized.slice(-9) } });
    }
    if (params.email?.trim()) {
      conditions.push({ email: { equals: params.email.toLowerCase().trim(), mode: 'insensitive' as any } });
    }
    if (params.telegramUsername?.trim()) {
      conditions.push({ telegramUsername: params.telegramUsername.replace(/^@/, '') });
    }

    if (!conditions.length) {
      return { found: false, matches: [] };
    }

    const matches = await this.prisma.client.findMany({
      where: {
        tenantId,
        OR: conditions,
      },
      select: {
        id: true, fullName: true, phone: true, email: true,
        telegramUsername: true, tier: true, pipelineStage: true,
        totalBookings: true, totalRevenue: true, createdAt: true,
        assignedAgent: { select: { id: true, name: true } },
      },
      take: 5,
    });

    return {
      found: matches.length > 0,
      count: matches.length,
      matches,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 2. LEAD ASSIGNMENT (round-robin, least-busy)
  // ═══════════════════════════════════════════════════════════

  /**
   * Tenant strategiyasi bo'yicha yangi lead'ga agent topadi.
   * Manual rejimda — null qaytaradi (admin qo'lda qiladi).
   */
  async pickAgentForNewLead(tenantId: string): Promise<string | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { leadAssignmentStrategy: true },
    });
    if (!tenant) return null;

    const activeAgents = await this.prisma.user.findMany({
      where: { tenantId, status: 'ACTIVE', role: 'AGENT' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!activeAgents.length) return null;

    if (tenant.leadAssignmentStrategy === 'MANUAL') {
      return null;
    }

    if (tenant.leadAssignmentStrategy === 'ROUND_ROBIN') {
      // Eng oxirgi tayinlangan agentdan keyingisini topamiz
      const lastAssigned = await this.prisma.client.findFirst({
        where: { tenantId, assignedAgentId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { assignedAgentId: true },
      });
      const ids = activeAgents.map((a) => a.id);
      if (!lastAssigned?.assignedAgentId) return ids[0];
      const lastIdx = ids.indexOf(lastAssigned.assignedAgentId);
      return ids[(lastIdx + 1) % ids.length];
    }

    if (tenant.leadAssignmentStrategy === 'LEAST_BUSY') {
      // Eng kam faol klient yuklamasi bo'lgan agent
      const counts = await Promise.all(
        activeAgents.map(async (a) => ({
          id: a.id,
          count: await this.prisma.client.count({
            where: {
              tenantId, assignedAgentId: a.id,
              pipelineStage: { notIn: ['COMPLETED', 'LOST'] },
            },
          }),
        }))
      );
      counts.sort((a, b) => a.count - b.count);
      return counts[0]?.id || null;
    }

    return null;
  }

  /**
   * Lead'ni boshqa agentga o'tkazish (faqat admin/manager)
   */
  async reassignClient(tenantId: string, clientId: string, newAgentId: string | null) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException('Klient topilmadi');

    if (newAgentId) {
      const agent = await this.prisma.user.findFirst({
        where: { id: newAgentId, tenantId, status: 'ACTIVE' },
      });
      if (!agent) throw new BadRequestException("Agent topilmadi yoki nofaol");
    }

    return this.prisma.client.update({
      where: { id: clientId },
      data: { assignedAgentId: newAgentId },
      select: {
        id: true, fullName: true,
        assignedAgent: { select: { id: true, name: true } },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 3. BULK ACTIONS
  // ═══════════════════════════════════════════════════════════

  async bulkAssign(tenantId: string, ids: string[], agentId: string | null) {
    if (!ids?.length) throw new BadRequestException("Klientlar tanlanmadi");
    if (agentId) {
      const agent = await this.prisma.user.findFirst({
        where: { id: agentId, tenantId, status: 'ACTIVE' },
      });
      if (!agent) throw new BadRequestException("Agent topilmadi");
    }
    const res = await this.prisma.client.updateMany({
      where: { tenantId, id: { in: ids } },
      data: { assignedAgentId: agentId },
    });
    return { updated: res.count };
  }

  async bulkChangeStage(tenantId: string, ids: string[], stage: string) {
    if (!ids?.length) throw new BadRequestException("Klientlar tanlanmadi");
    const validStages = ['NEW_LEAD', 'CONTACTED', 'INTERESTED', 'OFFER_SENT',
                         'NEGOTIATION', 'DEPOSIT_PAID', 'CONFIRMED',
                         'TRAVELING', 'COMPLETED', 'LOST'];
    if (!validStages.includes(stage)) {
      throw new BadRequestException("Noma'lum bosqich");
    }
    const res = await this.prisma.client.updateMany({
      where: { tenantId, id: { in: ids } },
      data: { pipelineStage: stage as any, pipelineStageAt: new Date() },
    });
    return { updated: res.count };
  }

  async bulkAddTag(tenantId: string, ids: string[], tag: string) {
    if (!ids?.length || !tag?.trim()) throw new BadRequestException("Parametr xato");
    const t = tag.trim().toLowerCase();
    const clients = await this.prisma.client.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, tags: true },
    });
    await Promise.all(
      clients.map((c) =>
        this.prisma.client.update({
          where: { id: c.id },
          data: { tags: Array.from(new Set([...(c.tags || []), t])) },
        })
      )
    );
    return { updated: clients.length };
  }

  async bulkDelete(tenantId: string, ids: string[], userId: string) {
    if (!ids?.length) throw new BadRequestException("Klientlar tanlanmadi");
    // Booking'i bor klientlarni o'chirib bo'lmaydi
    const withBookings = await this.prisma.client.findMany({
      where: { tenantId, id: { in: ids }, bookings: { some: {} } },
      select: { id: true, fullName: true },
    });
    if (withBookings.length) {
      throw new BadRequestException(
        `Quyidagi klientlarning bookingi bor, o'chirib bo'lmaydi: ${withBookings.map((c) => c.fullName).join(', ')}`
      );
    }
    const res = await this.prisma.client.deleteMany({
      where: { tenantId, id: { in: ids } },
    });
    return { deleted: res.count };
  }

  // ═══════════════════════════════════════════════════════════
  // 4. SAVED FILTERS
  // ═══════════════════════════════════════════════════════════

  async listSavedFilters(tenantId: string, userId: string, resource?: string) {
    return this.prisma.savedFilter.findMany({
      where: { tenantId, userId, ...(resource ? { resource } : {}) },
      orderBy: [{ isPinned: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async createSavedFilter(tenantId: string, userId: string, data: any) {
    if (!data.name?.trim() || !data.resource?.trim()) {
      throw new BadRequestException("Nom va resource majburiy");
    }
    return this.prisma.savedFilter.create({
      data: {
        tenantId, userId,
        name: data.name.trim(),
        resource: data.resource,
        filters: data.filters || {},
        isPinned: !!data.isPinned,
      },
    });
  }

  async deleteSavedFilter(tenantId: string, userId: string, id: string) {
    const f = await this.prisma.savedFilter.findFirst({
      where: { id, tenantId, userId },
    });
    if (!f) throw new NotFoundException();
    await this.prisma.savedFilter.delete({ where: { id } });
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════
  // 5. BOOKING CHECKLIST
  // ═══════════════════════════════════════════════════════════

  /** Standart checklist (yangi booking yaratilganda) */
  static DEFAULT_CHECKLIST = [
    'Passport',
    'Visa',
    'Hotel voucher',
    'Aviabilet',
    'Sug\'urta polisi',
    'Transfer (taxi)',
    'To\'lov tasdig\'i',
    'Klientga yo\'l-yo\'riq berildi',
  ];

  async getChecklist(tenantId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId },
      select: { id: true },
    });
    if (!booking) throw new NotFoundException('Booking topilmadi');

    let items = await this.prisma.bookingChecklist.findMany({
      where: { bookingId },
      include: { doneBy: { select: { id: true, name: true } } },
      orderBy: { sortOrder: 'asc' },
    });

    // Agar checklist hali yaratilmagan bo'lsa - default'ni yaratamiz
    if (!items.length) {
      await Promise.all(
        V8Service.DEFAULT_CHECKLIST.map((item, idx) =>
          this.prisma.bookingChecklist.create({
            data: { tenantId, bookingId, item, sortOrder: idx },
          })
        )
      );
      items = await this.prisma.bookingChecklist.findMany({
        where: { bookingId },
        include: { doneBy: { select: { id: true, name: true } } },
        orderBy: { sortOrder: 'asc' },
      });
    }

    const done = items.filter((i) => i.isDone).length;
    return {
      items,
      total: items.length,
      done,
      progress: items.length > 0 ? Math.round((done / items.length) * 100) : 0,
    };
  }

  async toggleChecklistItem(tenantId: string, itemId: string, userId: string, isDone: boolean) {
    const item = await this.prisma.bookingChecklist.findFirst({
      where: { id: itemId, tenantId },
    });
    if (!item) throw new NotFoundException();
    return this.prisma.bookingChecklist.update({
      where: { id: itemId },
      data: {
        isDone,
        doneAt: isDone ? new Date() : null,
        doneById: isDone ? userId : null,
      },
    });
  }

  async addChecklistItem(tenantId: string, bookingId: string, item: string) {
    if (!item?.trim()) throw new BadRequestException("Element nomi bo'sh");
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId },
    });
    if (!booking) throw new NotFoundException();
    const last = await this.prisma.bookingChecklist.findFirst({
      where: { bookingId },
      orderBy: { sortOrder: 'desc' },
    });
    return this.prisma.bookingChecklist.create({
      data: {
        tenantId, bookingId,
        item: item.trim(),
        sortOrder: (last?.sortOrder || 0) + 1,
      },
    });
  }

  async deleteChecklistItem(tenantId: string, itemId: string) {
    const item = await this.prisma.bookingChecklist.findFirst({
      where: { id: itemId, tenantId },
    });
    if (!item) throw new NotFoundException();
    await this.prisma.bookingChecklist.delete({ where: { id: itemId } });
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════
  // 6. COMMISSION CALCULATOR
  // ═══════════════════════════════════════════════════════════

  /**
   * Booking yopilganda chaqiriladi: agent va manager komissiyasini hisoblaydi.
   */
  async createCommissionFromBooking(tenantId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId },
      include: { agent: { select: { id: true, role: true } } },
    });
    if (!booking) throw new NotFoundException();

    // Allaqachon bormi?
    const existing = await this.prisma.commission.findUnique({ where: { bookingId } });
    if (existing) return existing;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { agentCommissionPercent: true, managerCommissionPercent: true },
    });
    if (!tenant) throw new NotFoundException();

    // Manager'ni topish (admin yoki manager — booking agent'ining boshqaruvchisi)
    const manager = await this.prisma.user.findFirst({
      where: { tenantId, role: { in: ['MANAGER', 'TENANT_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    const profit = booking.profit || 0;
    const agentPct = tenant.agentCommissionPercent;
    const managerPct = tenant.managerCommissionPercent;
    const agentAmount = +(profit * agentPct / 100).toFixed(2);
    const managerAmount = +(profit * managerPct / 100).toFixed(2);
    const companyAmount = +(profit - agentAmount - managerAmount).toFixed(2);

    return this.prisma.commission.create({
      data: {
        tenantId, bookingId,
        agentId: booking.agentId!,
        managerId: manager?.id,
        totalProfit: profit,
        agentPercent: agentPct,
        managerPercent: managerPct,
        agentAmount, managerAmount, companyAmount,
      },
    });
  }

  async listCommissions(tenantId: string, userId: string, role: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.agentId = userId;
    return this.prisma.commission.findMany({
      where,
      include: {
        booking: { select: { id: true, bookingRef: true, tourName: true, client: { select: { fullName: true } } } },
        agent: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async markCommissionPaid(tenantId: string, id: string) {
    const c = await this.prisma.commission.findFirst({ where: { id, tenantId } });
    if (!c) throw new NotFoundException();
    return this.prisma.commission.update({
      where: { id },
      data: { isPaid: true, paidAt: new Date() },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 7. CLIENT 360 — barcha ma'lumotlar bir endpoint'da
  // ═══════════════════════════════════════════════════════════

  /**
   * Client Profile sahifasi uchun barcha ma'lumotlarni bir marta yuklash.
   * Bu N+1 muammosini hal qiladi va frontend tezroq ishlaydi.
   */
  async getClient360(tenantId: string, clientId: string, userId: string, role: string) {
    const whereFilter: any = { id: clientId, tenantId };
    if (role === 'AGENT') whereFilter.assignedAgentId = userId;

    const client = await this.prisma.client.findFirst({
      where: whereFilter,
      include: {
        assignedAgent: { select: { id: true, name: true, email: true, phone: true } },
        bookings: {
          orderBy: { createdAt: 'desc' },
          include: {
            payments: { select: { id: true, amount: true, currency: true, paidAt: true, method: true } },
            agent: { select: { id: true, name: true } },
          },
        },
        timeline: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!client) throw new NotFoundException('Klient topilmadi');

    // Bookings dan moliyaviy summary
    const totalSpent = client.bookings.reduce((sum, b) => sum + (b.totalPrice || 0), 0);
    const totalProfit = role === 'AGENT' ? 0 : client.bookings.reduce((sum, b) => sum + (b.profit || 0), 0);
    const totalPaid = client.bookings.reduce((sum, b) => sum + (b.paidAmount || 0), 0);
    const balance = totalSpent - totalPaid;

    // Aktiv suhbat
    const activeConversation = await this.prisma.conversation.findFirst({
      where: { tenantId, clientId },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      select: { id: true, channel: true, lastMessageAt: true, unreadCount: true },
    });

    // Faol tasklar
    const activeTasks = await this.prisma.task.findMany({
      where: { tenantId, clientId, status: { notIn: ['DONE', 'CANCELLED'] } },
      include: { assignee: { select: { id: true, name: true } } },
      orderBy: { dueAt: 'asc' },
      take: 20,
    });

    // Hisob-fakturalar
    const invoices = await this.prisma.invoice.findMany({
      where: { tenantId, clientId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, invoiceNumber: true, salePrice: true, paidAmount: true,
        status: true, currency: true, createdAt: true, dueDate: true,
        ...(role !== 'AGENT' ? { profit: true, providerCost: true } : {}),
      },
    });

    // Hujjatlar
    const documents = await this.prisma.document.findMany({
      where: { tenantId, clientId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, fileName: true, fileUrl: true, fileMimeType: true,
        fileSize: true, createdAt: true,
        uploadedBy: { select: { name: true } },
      },
    });

    // FollowUp eslatmalar
    const followUps = await this.prisma.followUp.findMany({
      where: { tenantId, clientId, done: false },
      orderBy: { dueAt: 'asc' },
      take: 10,
    });

    return {
      client,
      financial: {
        totalSpent,
        totalProfit, // faqat admin/manager ko'radi
        totalPaid,
        balance,
        bookingsCount: client.bookings.length,
      },
      activeConversation,
      tasks: activeTasks,
      invoices,
      documents,
      followUps,
    };
  }
}

// ═══════════════════════════════════════════════════════════
// CONTROLLERS
// ═══════════════════════════════════════════════════════════

@Controller('v8')
@UseGuards(JwtAuthGuard)
export class V8Controller {
  constructor(private svc: V8Service) {}

  // ── DUPLICATE DETECTION ────────────────────────────────────
  @Get('clients/check-duplicate')
  checkDuplicate(
    @CurrentUser() u: any,
    @Query('phone') phone?: string,
    @Query('email') email?: string,
    @Query('telegramUsername') telegramUsername?: string,
  ) {
    return this.svc.checkDuplicate(u.tenantId, { phone, email, telegramUsername });
  }

  // ── LEAD ASSIGNMENT ────────────────────────────────────────
  @Patch('clients/:id/reassign')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  reassign(@Param('id') id: string, @Body() body: { agentId: string | null }, @CurrentUser() u: any) {
    return this.svc.reassignClient(u.tenantId, id, body.agentId);
  }

  // ── BULK ACTIONS ───────────────────────────────────────────
  @Post('clients/bulk/assign')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  bulkAssign(@Body() body: { ids: string[]; agentId: string | null }, @CurrentUser() u: any) {
    return this.svc.bulkAssign(u.tenantId, body.ids, body.agentId);
  }

  @Post('clients/bulk/stage')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  bulkStage(@Body() body: { ids: string[]; stage: string }, @CurrentUser() u: any) {
    return this.svc.bulkChangeStage(u.tenantId, body.ids, body.stage);
  }

  @Post('clients/bulk/tag')
  bulkTag(@Body() body: { ids: string[]; tag: string }, @CurrentUser() u: any) {
    return this.svc.bulkAddTag(u.tenantId, body.ids, body.tag);
  }

  @Post('clients/bulk/delete')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  bulkDelete(@Body() body: { ids: string[] }, @CurrentUser() u: any) {
    return this.svc.bulkDelete(u.tenantId, body.ids, u.sub);
  }

  // ── SAVED FILTERS ──────────────────────────────────────────
  @Get('saved-filters')
  listFilters(@CurrentUser() u: any, @Query('resource') resource?: string) {
    return this.svc.listSavedFilters(u.tenantId, u.sub, resource);
  }

  @Post('saved-filters')
  createFilter(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.createSavedFilter(u.tenantId, u.sub, body);
  }

  @Delete('saved-filters/:id')
  deleteFilter(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.deleteSavedFilter(u.tenantId, u.sub, id);
  }

  // ── BOOKING CHECKLIST ──────────────────────────────────────
  @Get('bookings/:id/checklist')
  getChecklist(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.getChecklist(u.tenantId, id);
  }

  @Patch('checklist/:itemId')
  toggleItem(
    @Param('itemId') itemId: string,
    @Body() body: { isDone: boolean },
    @CurrentUser() u: any,
  ) {
    return this.svc.toggleChecklistItem(u.tenantId, itemId, u.sub, body.isDone);
  }

  @Post('bookings/:id/checklist')
  addChecklistItem(@Param('id') id: string, @Body() body: { item: string }, @CurrentUser() u: any) {
    return this.svc.addChecklistItem(u.tenantId, id, body.item);
  }

  @Delete('checklist/:itemId')
  deleteChecklistItem(@Param('itemId') itemId: string, @CurrentUser() u: any) {
    return this.svc.deleteChecklistItem(u.tenantId, itemId);
  }

  // ── COMMISSION ─────────────────────────────────────────────
  @Get('commissions')
  listCommissions(@CurrentUser() u: any) {
    return this.svc.listCommissions(u.tenantId, u.sub, u.role);
  }

  @Post('bookings/:id/commission')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  createCommission(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.createCommissionFromBooking(u.tenantId, id);
  }

  @Patch('commissions/:id/paid')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  markPaid(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.markCommissionPaid(u.tenantId, id);
  }

  // ── CLIENT 360 ─────────────────────────────────────────────
  @Get('clients/:id/full')
  getClient360(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.getClient360(u.tenantId, id, u.sub, u.role);
  }
}

@Module({
  controllers: [V8Controller],
  providers: [V8Service],
  exports: [V8Service],
})
export class V8Module {}
