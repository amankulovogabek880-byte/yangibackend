import {
  Module, Injectable, Controller, Get, Post, Put, Delete, Param, Body, Query,
  UseGuards, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { safeEnum } from '../../common/utils/helpers';
import { KpiMetric, KpiPeriod } from '../../prisma-types';;
import { CacheService } from '../../common/cache/cache.service';
import { CACHE_TTL, kpiKey } from '../../common/cache/cache.constants';

const METRICS: KpiMetric[] = ['REVENUE', 'BOOKINGS', 'NEW_CLIENTS', 'CONVERSIONS', 'CALLS', 'MESSAGES', 'TASKS_COMPLETED'];
const PERIODS: KpiPeriod[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'];

@Injectable()
export class KpiService {
  constructor(private prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════
  // COMMISSION TIERS (v9-FINAL: Admin KPI configuration)
  // ═══════════════════════════════════════════════════════════

  async getTiers(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { kpiTiers: true },
    });

    if (!tenant) throw new BadRequestException('Tenant topilmadi');

    try {
      const tiers = Array.isArray(tenant.kpiTiers) 
        ? tenant.kpiTiers 
        : JSON.parse((tenant.kpiTiers as string) || '[]');
      return (tiers || []).sort((a: any, b: any) => a.minRevenue - b.minRevenue);
    } catch {
      return [];
    }
  }

  async saveTiers(tenantId: string, tiers: any[]) {
    if (!Array.isArray(tiers) || tiers.length === 0) {
      throw new BadRequestException('Kamita 1 ta tier bo\'lishi kerak');
    }

    // Validate
    const sorted = [...tiers].sort((a, b) => a.minRevenue - b.minRevenue);
    
    for (let i = 0; i < sorted.length; i++) {
      const tier = sorted[i];
      
      if (tier.minRevenue < 0 || tier.commissionPercent < 0 || tier.commissionPercent > 100) {
        throw new BadRequestException(`Tier ${i + 1}: Noto'g'ri qiymatlar`);
      }

      // Check gap
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev.maxRevenue !== null && prev.maxRevenue !== tier.minRevenue) {
          throw new BadRequestException(`Tier ${i + 1}: Gap detected`);
        }
      }

      // Last tier must end with null (unlimited)
      if (i === sorted.length - 1) {
        tier.maxRevenue = null;
      }
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { kpiTiers: sorted },
    });

    return sorted;
  }

  calculateCommission(revenue: number, tiers: any[]): { percent: number; amount: number } {
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return { percent: 0, amount: 0 };
    }

    const sorted = (tiers || []).sort((a: any, b: any) => a.minRevenue - b.minRevenue);
    
    for (const tier of sorted) {
      const inRange = revenue >= tier.minRevenue && 
                      (tier.maxRevenue === null || revenue < tier.maxRevenue);
      
      if (inRange) {
        return {
          percent: tier.commissionPercent,
          amount: Math.round((revenue * tier.commissionPercent) / 100),
        };
      }
    }

    // Default to last tier
    const lastTier = sorted[sorted.length - 1];
    return {
      percent: lastTier?.commissionPercent || 0,
      amount: Math.round((revenue * (lastTier?.commissionPercent || 0)) / 100),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // EXISTING KPI TARGETS CODE
  // ═══════════════════════════════════════════════════════════

  async list(tenantId: string, userId?: string, role?: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.OR = [{ userId }, { userId: null }];
    else if (userId) where.userId = userId;
    return this.prisma.kpi.findMany({
      where,
      include: { user: { select: { id: true, name: true } } },
      orderBy: [{ endDate: 'desc' }],
    });
  }

  async create(tenantId: string, actorRole: string, data: any) {
    if (!['TENANT_ADMIN', 'MANAGER'].includes(actorRole)) {
      throw new BadRequestException("Ruxsat yo'q");
    }
    if (!data.target || data.target <= 0) {
      throw new BadRequestException('Target musbat bo\'lishi kerak');
    }
    return this.prisma.kpi.create({
      data: {
        tenantId,
        userId: data.userId || null,
        metric: safeEnum(data.metric, METRICS, 'REVENUE'),
        period: safeEnum(data.period, PERIODS, 'MONTHLY'),
        target: Number(data.target),
        bonus: data.bonus ? Number(data.bonus) : undefined,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        notes: data.notes,
      },
    });
  }

  async update(tenantId: string, actorRole: string, id: string, data: any) {
    if (!['TENANT_ADMIN', 'MANAGER'].includes(actorRole)) {
      throw new BadRequestException("Ruxsat yo'q");
    }
    const kpi = await this.prisma.kpi.findFirst({ where: { id, tenantId } });
    if (!kpi) throw new NotFoundException('KPI topilmadi');
    const { id: _i, tenantId: _t, ...safe } = data;
    if (safe.startDate) safe.startDate = new Date(safe.startDate);
    if (safe.endDate) safe.endDate = new Date(safe.endDate);
    if (safe.metric) safe.metric = safeEnum(safe.metric, METRICS, kpi.metric);
    if (safe.period) safe.period = safeEnum(safe.period, PERIODS, kpi.period);
    if (safe.target) safe.target = Number(safe.target);
    return this.prisma.kpi.update({ where: { id }, data: safe });
  }

  async delete(tenantId: string, actorRole: string, id: string) {
    if (!['TENANT_ADMIN', 'MANAGER'].includes(actorRole)) {
      throw new BadRequestException("Ruxsat yo'q");
    }
    await this.prisma.kpi.deleteMany({ where: { id, tenantId } });
    return { ok: true };
  }

  async progress(tenantId: string, kpiId: string) {
    const kpi = await this.prisma.kpi.findFirst({ where: { id: kpiId, tenantId } });
    if (!kpi) throw new NotFoundException('KPI topilmadi');
    const start = kpi.startDate, end = kpi.endDate;
    let actual = 0;

    if (kpi.metric === 'REVENUE') {
      const r = await this.prisma.payment.aggregate({
        where: {
          tenantId, status: 'COMPLETED',
          paidAt: { gte: start, lte: end },
          ...(kpi.userId ? { booking: { agentId: kpi.userId } } : {}),
        },
        _sum: { amount: true },
      });
      actual = r._sum.amount || 0;
    } else if (kpi.metric === 'BOOKINGS') {
      actual = await this.prisma.booking.count({
        where: {
          tenantId, createdAt: { gte: start, lte: end },
          status: { not: 'CANCELLED' },
          ...(kpi.userId ? { agentId: kpi.userId } : {}),
        },
      });
    } else if (kpi.metric === 'NEW_CLIENTS') {
      actual = await this.prisma.client.count({
        where: {
          tenantId, createdAt: { gte: start, lte: end },
          ...(kpi.userId ? { assignedAgentId: kpi.userId } : {}),
        },
      });
    } else if (kpi.metric === 'CONVERSIONS') {
      const leadsWhere: any = { tenantId, createdAt: { gte: start, lte: end } };
      if (kpi.userId) leadsWhere.assignedAgentId = kpi.userId;
      const leads = await this.prisma.client.count({ where: leadsWhere });
      const converted = await this.prisma.client.count({
        where: { ...leadsWhere, totalBookings: { gt: 0 } },
      });
      actual = leads > 0 ? (converted / leads) * 100 : 0;
    } else if (kpi.metric === 'CALLS') {
      actual = await this.prisma.call.count({
        where: {
          tenantId, createdAt: { gte: start, lte: end },
          ...(kpi.userId ? { agentId: kpi.userId } : {}),
        },
      });
    } else if (kpi.metric === 'TASKS_COMPLETED') {
      actual = await this.prisma.task.count({
        where: {
          tenantId, status: 'DONE', completedAt: { gte: start, lte: end },
          ...(kpi.userId ? { assigneeId: kpi.userId } : {}),
        },
      });
    }

    const pct = kpi.target > 0 ? Math.min(200, Math.round((actual / kpi.target) * 100)) : 0;
    return { kpi, actual, progressPct: pct, isMet: actual >= kpi.target };
  }
}

@Controller('kpi')
@UseGuards(JwtAuthGuard)
export class KpiController {
  constructor(
    private svc: KpiService,
    private cache: CacheService,
  ) {}

  // ── COMMISSION TIERS ──
  @Get('tiers')
  getTiers(@CurrentUser() u: any) {
    // Tier'lar deyarli o'zgarmaydi (konfiguratsiya) → LONG (900s).
    return this.cache.getOrSet(
      kpiKey(u.tenantId, 'tiers'),
      CACHE_TTL.LONG,
      () => this.svc.getTiers(u.tenantId),
    );
  }

  @Put('tiers')
  async saveTiers(@CurrentUser() u: any, @Body() body: { tiers: any[] }) {
    if (!['TENANT_ADMIN', 'OWNER'].includes(u.role)) {
      throw new BadRequestException('Ruxsat yo\'q');
    }
    const result = await this.svc.saveTiers(u.tenantId, body.tiers);
    // Tier'lar maosh/komissiya hisobotlariga ham ta'sir qiladi → reports + kpi tozalanadi.
    void this.cache.invalidateReports(u.tenantId);
    return result;
  }

  // ── KPI TARGETS ──
  @Get()
  list(@CurrentUser() u: any, @Query('userId') userId?: string) {
    const scope = userId || u.sub;
    return this.cache.getOrSet(
      kpiKey(u.tenantId, 'list', u.role, scope),
      CACHE_TTL.SHORT,
      () => this.svc.list(u.tenantId, scope, u.role),
    );
  }

  @Get(':id/progress')
  progress(@Param('id') id: string, @CurrentUser() u: any) {
    // Progress og'ir aggregate (payment/booking/client...) → SHORT (60s).
    return this.cache.getOrSet(
      kpiKey(u.tenantId, 'progress', id),
      CACHE_TTL.SHORT,
      () => this.svc.progress(u.tenantId, id),
    );
  }

  @Post()
  async create(@Body() body: any, @CurrentUser() u: any) {
    const result = await this.svc.create(u.tenantId, u.role, body);
    void this.cache.invalidateReports(u.tenantId);
    return result;
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    const result = await this.svc.update(u.tenantId, u.role, id, body);
    void this.cache.invalidateReports(u.tenantId);
    return result;
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentUser() u: any) {
    const result = await this.svc.delete(u.tenantId, u.role, id);
    void this.cache.invalidateReports(u.tenantId);
    return result;
  }
}

@Module({
  controllers: [KpiController],
  providers: [KpiService],
})
export class KpiModule {}