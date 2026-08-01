import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Param, Body, Query,
  UseGuards, ForbiddenException, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { hashPassword } from '../auth/auth.service';
import { BackupService } from '../backup/backup.service';
import { safeEnum } from '../../common/utils/helpers';
import { TenantStatus, SubscriptionPlan } from '../../prisma-types';;

const PLANS: SubscriptionPlan[] = ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'];
const STATUSES: TenantStatus[] = ['ACTIVE', 'TRIAL', 'SUSPENDED'];

const PLAN_LIMITS: Record<SubscriptionPlan, { users: number; clients: number; bookings: number }> = {
  FREE: { users: 2, clients: 100, bookings: 20 },
  STARTER: { users: 5, clients: 500, bookings: 100 },
  PROFESSIONAL: { users: 20, clients: 5000, bookings: 1000 },
  ENTERPRISE: { users: 999, clients: 999999, bookings: 999999 },
};

@Injectable()
export class OwnerService {
  constructor(private prisma: PrismaService) {}

  async getStats() {
    const [totalTenants, activeTenants, totalUsers, totalBookings, payments] = await Promise.all([
      this.prisma.tenant.count({ where: { slug: { not: '_platform' } } }),
      this.prisma.tenant.count({ where: { slug: { not: '_platform' }, status: 'ACTIVE' } }),
      this.prisma.user.count({ where: { role: { not: 'PLATFORM_OWNER' } } }),
      this.prisma.booking.count(),
      this.prisma.payment.aggregate({ where: { status: 'COMPLETED' }, _sum: { amount: true } }),
    ]);
    return {
      tenants: totalTenants, activeTenants, users: totalUsers,
      bookings: totalBookings, totalRevenue: payments._sum.amount || 0,
    };
  }

  async getLeaderboard() {
    // N+1 muammo bartaraf — groupBy bilan bitta query
    const [bookingStats, users] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['agentId'],
        where: { status: { not: 'CANCELLED' }, agentId: { not: null } },
        _count: { id: true },
        _sum: { profit: true, totalPrice: true },
        orderBy: { _sum: { totalPrice: 'desc' } },
        take: 20,
      }),
      this.prisma.user.findMany({
        where: { role: { in: ['AGENT', 'MANAGER'] }, status: 'ACTIVE' },
        select: { id: true, name: true, avatarUrl: true, tenant: { select: { name: true } } },
      }),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    return bookingStats
      .map((s: any) => {
        const u: any = userMap.get(s.agentId!);
        if (!u) return null;
        return {
          id: u.id, name: u.name, avatarUrl: u.avatarUrl,
          tenantName: u.tenant?.name,
          revenue: Number(s._sum.totalPrice) || 0,
          profit: Number(s._sum.profit) || 0,
          bookings: s._count.id,
        };
      })
      .filter(Boolean)
      .slice(0, 10);
  }

  async getCompanies() {
    const tenants = await this.prisma.tenant.findMany({
      where: { slug: { not: '_platform' } },
      include: {
        _count: { select: { users: true, clients: true, bookings: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // v26: har bir kompaniya uchun `aiEnabled`ni tekis (top-level) maydon
    // sifatida ham qaytaramiz — frontend `settings` JSON ichiga kirmasdan
    // to'g'ridan-to'g'ri `c.aiEnabled` deb o'qiy oladi.
    return tenants.map((t: any) => ({ ...t, aiEnabled: (t.settings as any)?.aiEnabled === true }));
  }

  async getCompany(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        users: { select: { id: true, name: true, email: true, role: true, status: true } },
        _count: { select: { users: true, clients: true, bookings: true, payments: true } },
      },
    });
    if (!tenant) throw new NotFoundException('Topilmadi');
    return { ...tenant, aiEnabled: (tenant.settings as any)?.aiEnabled === true };
  }

  async createCompany(data: {
    name: string; slug: string; adminName: string; adminEmail: string;
    adminPassword: string; plan?: string; aiEnabled?: boolean;
  }) {
    if (!data.name?.trim()) throw new BadRequestException('name majburiy');
    if (!data.slug?.trim()) throw new BadRequestException('slug majburiy');
    if (!data.adminEmail?.trim()) throw new BadRequestException('adminEmail majburiy');
    if (!data.adminName?.trim()) throw new BadRequestException('adminName majburiy');
    if (!data.adminPassword || data.adminPassword.length < 8) {
      throw new BadRequestException("Parol kamida 8 belgi bo'lishi kerak");
    }

    const slug = data.slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');
    if (slug === '_platform') throw new BadRequestException('Bu nomdan foydalanish mumkin emas');

    const adminEmail = data.adminEmail.toLowerCase().trim();

    // Slug allaqachon bor?
    const slugExists = await this.prisma.tenant.findUnique({ where: { slug } });
    if (slugExists) throw new BadRequestException(`"${slug}" slug allaqachon band`);

    // Email allaqachon bor?
    const emailExists = await this.prisma.user.findFirst({ where: { email: adminEmail } });
    if (emailExists) throw new BadRequestException(`Bu email (${adminEmail}) allaqachon mavjud`);

    const plan = safeEnum(data.plan, PLANS, 'STARTER');
    const limits = PLAN_LIMITS[plan];
    const passwordHash = await hashPassword(data.adminPassword);

    // Transaction: tenant + admin bir vaqtda yaratiladi
    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: data.name.trim(), slug,
          status: 'ACTIVE', plan,
          maxUsers: limits.users,
          maxClients: limits.clients,
          maxBookings: limits.bookings,
          leadAssignmentStrategy: 'ROUND_ROBIN' as any,
          // v26: AI (transkripsiya + Claude tahlil) — PULLIK QO'SHIMCHA XIZMAT.
          // Yangi kompaniya yaratilganda owner o'zi belgilaydi: agar
          // belgilanmasa, standart holatda O'CHIQ (faqat yozuv/recording
          // bo'ladi, AI xarajat qilinmaydi). Owner istalgan vaqt
          // "Kompaniyalar" jadvalidan yoqib/o'chirib qo'ya oladi.
          settings: { aiEnabled: data.aiEnabled === true },
        },
      });

      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: adminEmail,
          passwordHash,
          name: data.adminName.trim(),
          role: 'TENANT_ADMIN',
          status: 'ACTIVE',
          mustChangePassword: false,
        },
      });

      return { tenant, adminEmail: admin.email };
    });

    return {
      ...result.tenant,
      adminEmail: result.adminEmail,
      message: `Kompaniya yaratildi. Admin: ${result.adminEmail}`,
    };
  }

  async setStatus(id: string, status: string) {
    const s = safeEnum(status, STATUSES, 'ACTIVE');
    return this.prisma.tenant.update({
      where: { id },
      data: { status: s },
      select: { id: true, name: true, status: true },
    });
  }

  // v26: Owner panelidan bitta kompaniyaga AI (transkripsiya + Claude
  // tahlil)ni yoqish/o'chirish. O'CHIQ bo'lsa — o'sha kompaniyada
  // qo'ng'iroqlar FAQAT yozuv (recording) sifatida saqlanadi, Whisper/
  // Claude'ga umuman so'rov ketmaydi (xarajat sarflanmaydi). Bu holat
  // `calls.module.ts`dagi `analyzeCall` va `processAiPipelineForCall`
  // metodlarida tekshiriladi.
  async setAiEnabled(id: string, aiEnabled: boolean) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, select: { settings: true } });
    if (!tenant) throw new NotFoundException("Kompaniya topilmadi");
    const settings: any = (tenant.settings as any) || {};
    return this.prisma.tenant.update({
      where: { id },
      data: { settings: { ...settings, aiEnabled: !!aiEnabled } },
      select: { id: true, name: true, settings: true },
    });
  }

  // v9-FINAL: Kompaniya nomi, plan, lokatsiya'sini o'zgartirish
  async updateCompany(id: string, data: {
    name?: string;
    plan?: string;
    timezone?: string;
    currency?: string;
    country?: string;
    city?: string;
    phone?: string;
    email?: string;
    website?: string;
    aiEnabled?: boolean;
  }) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException("Kompaniya topilmadi");

    const updateData: any = {};
    if (data.name?.trim()) updateData.name = data.name.trim();
    if (data.plan) updateData.plan = safeEnum(data.plan, ['FREE', 'STARTER', 'PRO', 'ENTERPRISE'], 'FREE');
    if (data.timezone) updateData.timezone = data.timezone;
    if (data.currency) updateData.currency = data.currency;
    if (data.country !== undefined) updateData.country = data.country;
    if (data.city !== undefined) updateData.city = data.city;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.website !== undefined) updateData.website = data.website;
    // v26: AI yoqilgan/o'chirilganini ham shu umumiy tahrirlash orqali
    // o'zgartirish mumkin (settings JSON ichida saqlanadi).
    if (data.aiEnabled !== undefined) {
      const settings: any = (tenant.settings as any) || {};
      updateData.settings = { ...settings, aiEnabled: !!data.aiEnabled };
    }

    return this.prisma.tenant.update({
      where: { id },
      data: updateData,
      select: { id: true, name: true, status: true, plan: true, settings: true },
    });
  }

  // v9-FINAL: Kompaniyani o'chirish (ehtiyot: cascade delete!)
  async deleteCompany(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: { _count: { select: { users: true, clients: true, bookings: true } } },
    });
    if (!tenant) throw new NotFoundException("Kompaniya topilmadi");

    // Ehtiyot: cascade delete'dan oldin ogohlantirish
    const counts = tenant._count;
    await this.prisma.tenant.delete({ where: { id } });

    return {
      ok: true,
      deletedTenant: tenant.name,
      affected: counts,
      message: `Kompaniya "${tenant.name}" o'chirildi. ` +
        `${counts.users} foydalanuvchi, ${counts.clients} klient, ${counts.bookings} booking ham o'chirildi.`,
    };
  }

  /**
   * v7: Oxirgi 50 ta login (muvaffaqiyatli + muvaffaqiyatsiz)
   * Platforma egasi qaysi kompaniyalardan kim kirayotganini ko'radi
   */
  async getRecentLogins(limit = 50) {
    const attempts = await this.prisma.loginAttempt.findMany({
      take: Math.min(limit, 100),
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true, name: true, email: true, role: true,
            tenant: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });
    return attempts.map((a) => ({
      id: a.id,
      email: a.email,
      ip: a.ip,
      country: a.country,
      success: a.success,
      reason: a.reason,
      userAgent: a.userAgent,
      createdAt: a.createdAt,
      user: a.user ? {
        id: a.user.id,
        name: a.user.name,
        role: a.user.role,
        tenant: a.user.tenant,
      } : null,
    }));
  }
}
@Controller('owner')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_OWNER')
export class OwnerController {
  constructor(
    private svc: OwnerService,
    private backup: BackupService,
  ) {}

  @Get('stats')
  stats() { return this.svc.getStats(); }

  @Get('leaderboard')
  leaderboard() { return this.svc.getLeaderboard(); }

  @Get('companies')
  companies() { return this.svc.getCompanies(); }

  @Get('companies/:id')
  company(@Param('id') id: string) { return this.svc.getCompany(id); }

  @Post('companies')
  create(@Body() body: any) { return this.svc.createCompany(body); }

  @Patch('companies/:id/status')
  status(@Param('id') id: string, @Body() body: any) {
    return this.svc.setStatus(id, body.status);
  }

  // v26: bitta bosishda kompaniyaga AI (transkripsiya + tahlil)ni
  // yoqish/o'chirish — status select'iga o'xshab ishlaydi.
  @Patch('companies/:id/ai')
  setAi(@Param('id') id: string, @Body() body: any) {
    return this.svc.setAiEnabled(id, !!body.aiEnabled);
  }

  // v9-FINAL: Kompaniyani to'liq tahrirlash (nom, plan, lokatsiya)
  @Patch('companies/:id')
  updateCompany(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateCompany(id, body);
  }

  // v9-FINAL: Kompaniyani o'chirish (ehtiyot bilan)
  @Delete('companies/:id')
  deleteCompany(@Param('id') id: string) {
    return this.svc.deleteCompany(id);
  }

  /**
   * v7: Oxirgi 50 ta login urinishlari
   * GET /api/v1/owner/recent-logins?limit=50
   */
  // v9: Manual backup trigger
  @Post('backup')
  async triggerBackup() {
    return this.backup.triggerManual();
  }

  @Get('recent-logins')
  recentLogins(@Query('limit') limit?: string) {
    return this.svc.getRecentLogins(limit ? parseInt(limit) : 50);
  }
}

@Module({
  controllers: [OwnerController],
  providers: [OwnerService, BackupService],
})
export class OwnerModule {}