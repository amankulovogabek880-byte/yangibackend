import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../prisma-types';;
import { hashPassword } from '../auth/auth.service';

const ALLOWED_CREATE_ROLES: Role[] = ['AGENT', 'MANAGER', 'ACCOUNTANT'];
const ALLOWED_EDIT_ROLES: Role[] = ['TENANT_ADMIN', 'MANAGER', 'AGENT', 'ACCOUNTANT'];

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId, role: { not: 'PLATFORM_OWNER' } },
      select: {
        id: true, name: true, email: true, role: true, phone: true,
        status: true, avatarUrl: true, twoFactorEnabled: true,
        totalBookings: true, totalRevenue: true, totalClients: true,
        conversionRate: true,
        lastLoginAt: true, lastSeenAt: true, createdAt: true,
        // v14 FIX: pauza holati ro'yxatga qaytmasdi — shuning uchun "Agentlarni
        // boshqarish"da pauza ko'rinmas va ochib bo'lmasdi (pauza qilib bo'lmayapti).
        isPausedFromAssignment: true, dailyLeadLimit: true, pausedUntil: true,
        permissions: true,
        _count: { select: { assignedClients: true, bookings: true } },
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * v8: TEAM endpoint — admin uchun jamoa to'liq ma'lumoti.
   * Har agent uchun: leadlari, bookinglari, bu oydagi foydasi, oyligi.
   */
  async getTeam(tenantId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { agentCommissionPercent: true, currency: true },
    });

    const users = await this.prisma.user.findMany({
      where: { tenantId, role: { not: 'PLATFORM_OWNER' } },
      select: {
        id: true, name: true, email: true, role: true, phone: true,
        status: true, avatarUrl: true, callbackPhone: true, extension: true,
        lastLoginAt: true, createdAt: true,
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });

    // Har bir foydalanuvchi uchun stats
    const result = await Promise.all(
      users.map(async (u) => {
        const [leadsCount, bookingsCount, monthBookings] = await Promise.all([
          this.prisma.client.count({ where: { tenantId, assignedAgentId: u.id } }),
          this.prisma.booking.count({
            where: { tenantId, agentId: u.id, status: { not: 'CANCELLED' } },
          }),
          this.prisma.booking.aggregate({
            where: {
              tenantId, agentId: u.id,
              status: { in: ['CONFIRMED', 'COMPLETED'] },
              createdAt: { gte: monthStart },
            },
            _sum: { totalPrice: true, profit: true },
          }),
        ]);

        const monthRevenue = monthBookings._sum.totalPrice || 0;
        const monthProfit = monthBookings._sum.profit || 0;
        const monthSalary = +(monthProfit * (tenant?.agentCommissionPercent || 10) / 100).toFixed(2);

        return {
          ...u,
          stats: {
            leadsTotal: leadsCount,
            bookingsTotal: bookingsCount,
            monthRevenue,
            monthProfit,
            monthSalary,
          },
        };
      })
    );

    return result;
  }

  async findOne(tenantId: string, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
      select: {
        id: true, name: true, email: true, role: true, phone: true,
        status: true, avatarUrl: true, language: true,
        totalBookings: true, totalRevenue: true, conversionRate: true,
        lastLoginAt: true, createdAt: true,
        twoFactorEnabled: true,
        callbackPhone: true, extension: true,
      },
    });
    if (!user) throw new NotFoundException('Topilmadi');
    return user;
  }

  /**
   * v5: Admin yangi agent yaratadi.
   * Faqat TENANT_ADMIN va MANAGER yaratishi mumkin.
   */
  async create(tenantId: string, creatorRole: string, data: any) {
    if (!['TENANT_ADMIN', 'MANAGER'].includes(creatorRole)) {
      throw new BadRequestException('Sizda yangi agent yaratish huquqi yo\'q');
    }

    if (!data.email?.trim() || !data.password || !data.name?.trim()) {
      throw new BadRequestException('Email, parol va ism majburiy');
    }

    if (data.password.length < 8) {
      throw new BadRequestException("Parol kamida 8 belgi bo'lishi kerak");
    }

    // Faqat AGENT, MANAGER, ACCOUNTANT yaratish mumkin
    const role: Role = ALLOWED_CREATE_ROLES.includes(data.role) ? data.role : 'AGENT';

    // MANAGER faqat AGENT yarata oladi
    if (creatorRole === 'MANAGER' && role !== 'AGENT') {
      throw new BadRequestException("Manager faqat agent yarata oladi");
    }

    const email = data.email.toLowerCase().trim();

    // Email tekshirish
    const exists = await this.prisma.user.findFirst({ where: { tenantId, email } });
    if (exists) throw new ConflictException("Bu email shu kompaniyada allaqachon mavjud");

    const passwordHash = await hashPassword(data.password);

    const user = await this.prisma.user.create({
      data: {
        tenantId,
        email,
        passwordHash,
        name: data.name.trim(),
        phone: data.phone?.trim(),
        role,
        status: 'ACTIVE',
        language: data.language || 'UZ',
        mustChangePassword: false, // login qilish uchun bloklanmasin
      },
      select: {
        id: true, name: true, email: true, role: true,
        phone: true, status: true, createdAt: true,
      },
    });

    return user;
  }

  async toggle(tenantId: string, id: string) {
    const u = await this.prisma.user.findFirst({
      where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
    });
    if (!u) throw new NotFoundException('Topilmadi');
    return this.prisma.user.update({
      where: { id },
      data: { status: u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
      select: { id: true, status: true },
    });
  }

  async update(tenantId: string, id: string, editorRole: string, data: any) {
    const u = await this.prisma.user.findFirst({
      where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
    });
    if (!u) throw new NotFoundException('Topilmadi');

    const safe: any = {};
    if (typeof data.name === 'string') safe.name = data.name.trim();
    if (typeof data.phone === 'string') safe.phone = data.phone.trim();
    if (typeof data.avatarUrl === 'string') safe.avatarUrl = data.avatarUrl;
    if (typeof data.language === 'string' && ['UZ', 'RU', 'EN'].includes(data.language)) {
      safe.language = data.language;
    }
    // Rol faqat TENANT_ADMIN o'zgartira oladi
    if (data.role && editorRole === 'TENANT_ADMIN' && ALLOWED_EDIT_ROLES.includes(data.role)) {
      safe.role = data.role;
    }
    if (typeof data.notifyInApp === 'boolean') safe.notifyInApp = data.notifyInApp;
    if (typeof data.notifyEmail === 'boolean') safe.notifyEmail = data.notifyEmail;
    if (typeof data.notifyTelegram === 'boolean') safe.notifyTelegram = data.notifyTelegram;
    // Admin agent uchun telefon/extension o'zgartira oladi
    if (typeof data.callbackPhone === 'string') safe.callbackPhone = data.callbackPhone.trim() || null;
    if (typeof data.extension === 'string') safe.extension = data.extension.trim() || null;

    return this.prisma.user.update({
      where: { id },
      data: safe,
      select: {
        id: true, name: true, email: true, role: true, phone: true,
        status: true, language: true, callbackPhone: true, extension: true,
      },
    });
  }

  /**
   * v5: Admin agentni o'chiradi.
   * Faqat TENANT_ADMIN va faqat o'zining tenant'idagi userni.
   * O'zini o'chira olmaydi.
   */
  async delete(tenantId: string, id: string, deleterId: string) {
    if (id === deleterId) {
      throw new BadRequestException("O'zingizni o'chira olmaysiz");
    }
    const u = await this.prisma.user.findFirst({
      where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
    });
    if (!u) throw new NotFoundException('Topilmadi');

    if (u.role === 'TENANT_ADMIN') {
      // Kompaniyada faqat 1 admin bo'lsa, o'chirib bo'lmaydi
      const adminCount = await this.prisma.user.count({
        where: { tenantId, role: 'TENANT_ADMIN', status: 'ACTIVE' },
      });
      if (adminCount <= 1) {
        throw new BadRequestException("Kompaniyada kamida 1 ta admin qolishi kerak");
      }
    }

    // v14 DATA-SAQLASH: agent ishdan bo'shasa, uni "o'chiramiz" — LEKIN hech
    // qanday kompaniya datasi o'chib ketmasligi kerak. Ilgari `user.delete()`
    // ishlatilardi — bu (a) Commission/FollowUp kabi MAJBURIY aloqalar sabab
    // ba'zan umuman bloklanardi, (b) sessiyalar bilan birga ba'zi datani
    // yo'qotardi. Endi YUMSHOQ o'chirish: user statusi INACTIVE bo'ladi
    // (login bloklanadi, ro'yxatlardan yo'qoladi), lekin barcha xabar/booking/
    // invoice/klient/komissiya tarixi kompaniyada TO'LIQ saqlanadi.

    // 1) Ochiq (hal qilinmagan) suhbatlarni bo'shatamiz — keyingi xabarda
    //    round-robin orqali boshqa agentga avtomatik o'tadi (lead yo'qolmasin).
    await this.prisma.conversation.updateMany({
      where: { tenantId, assignedAgentId: id, isResolved: false },
      data: { assignedAgentId: null },
    });
    // 2) Klientlarni bo'shatamiz (admin qayta taqsimlashi mumkin) — klient
    //    yozuvlari o'chmaydi, faqat biriktirilmagan bo'ladi.
    await this.prisma.client.updateMany({
      where: { tenantId, assignedAgentId: id },
      data: { assignedAgentId: null },
    });
    // DIQQAT: booking/invoice/message/commission agentId'sini NULL QILMAYMIZ —
    // sotuv/moliya tarixi kim tomonidan qilinganini saqlab qolamiz.

    // 3) Agentni round-robin'dan chiqaramiz va login'ni bloklaymiz (soft delete)
    await this.prisma.user.update({
      where: { id },
      data: {
        status: 'INACTIVE',
        isPausedFromAssignment: true,
      } as any,
    });
    // Faol sessiyalarni o'chiramiz — bloklangan agent kira olmasin
    await this.prisma.userSession.deleteMany({ where: { userId: id } }).catch(() => {});

    return { ok: true };
  }

  /**
   * v5: Admin agentning parolini reset qiladi (yangi parol beradi)
   */
  async resetPassword(tenantId: string, id: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException("Parol kamida 8 belgi");
    }
    const u = await this.prisma.user.findFirst({
      where: { id, tenantId, role: { not: 'PLATFORM_OWNER' } },
    });
    if (!u) throw new NotFoundException('Topilmadi');

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash,
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    // Barcha sessiyalarni yopamiz
    await this.prisma.userSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'password_reset_by_admin' },
    });
    return { ok: true };
  }

  async updateMyTelegramUsername(userId: string, username: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { telegramUsername: username } as any,
      select: { id: true, name: true, telegramUsername: true } as any,
    });
  }

  async updateMe(userId: string, data: any) {
    const safe: any = {};
    if (typeof data.name === 'string') safe.name = data.name.trim();
    if (typeof data.phone === 'string') safe.phone = data.phone.trim();
    if (typeof data.avatarUrl === 'string') safe.avatarUrl = data.avatarUrl;
    if (typeof data.language === 'string' && ['UZ', 'RU', 'EN'].includes(data.language)) {
      safe.language = data.language;
    }
    if (typeof data.notifyInApp === 'boolean') safe.notifyInApp = data.notifyInApp;
    if (typeof data.notifyEmail === 'boolean') safe.notifyEmail = data.notifyEmail;
    if (typeof data.notifyTelegram === 'boolean') safe.notifyTelegram = data.notifyTelegram;
    if (typeof data.timezone === 'string') safe.timezone = data.timezone;
    // v8: Phone fields
    if (typeof data.callbackPhone === 'string') safe.callbackPhone = data.callbackPhone.trim();
    if (typeof data.extension === 'string') safe.extension = data.extension.trim();

    return this.prisma.user.update({
      where: { id: userId },
      data: safe,
      select: {
        id: true, name: true, email: true, role: true, phone: true,
        avatarUrl: true, language: true, timezone: true,
        notifyInApp: true, notifyEmail: true, notifyTelegram: true,
        callbackPhone: true, extension: true,
      },
    });
  }

  /**
   * v17: Moslashtiriladigan ruxsatlar (custom permissions).
   * Faqat TENANT_ADMIN chaqira oladi (controller darajasida cheklangan).
   */
  async getPermissions(tenantId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, name: true, role: true, permissions: true },
    });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    return user;
  }

  async setPermissions(tenantId: string, userId: string, permissions: Record<string, boolean>) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    if (user.role === 'TENANT_ADMIN' || user.role === 'PLATFORM_OWNER') {
      throw new BadRequestException("Admin ruxsatlari cheklanmaydi — u allaqachon barcha huquqlarga ega");
    }
    // Faqat ma'lum kalitlarni qabul qilamiz (bo'lak-bo'lak, xavfsizlik uchun)
    const { PERMISSION_DEFS } = await import('../../common/permissions/permissions.constants');
    const validKeys = new Set(PERMISSION_DEFS.map((p) => p.key));
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(permissions || {})) {
      if (validKeys.has(k as any) && typeof v === 'boolean') clean[k] = v;
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: { permissions: clean as any },
      select: { id: true, name: true, role: true, permissions: true },
    });
  }
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private svc: UsersService) {}

  @Get()
  list(@CurrentUser() u: any) {
    return this.svc.findAll(u.tenantId);
  }

  /**
   * v8: TEAM endpoint — admin uchun to'liq jamoa ma'lumoti
   * Har agent uchun: leadlar, bookinglar, foyda, maosh
   */
  @Get('team')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  team(@CurrentUser() u: any) {
    return this.svc.getTeam(u.tenantId);
  }

  @Get('me')
  me(@CurrentUser() u: any) {
    return this.svc.findOne(u.tenantId, u.sub);
  }

  @Post('me/telegram')
  @UseGuards(JwtAuthGuard)
  async updateMyTelegram(@CurrentUser() u: any, @Body() body: { telegramUsername: string }) {
    if (!body.telegramUsername?.trim()) throw new BadRequestException('Username kerak');
    const username = body.telegramUsername.replace('@', '').trim();
    return this.svc.updateMyTelegramUsername(u.id || u.sub, username);
  }

  @Patch('me')
  updateMe(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.updateMe(u.sub, body);
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.findOne(u.tenantId, id);
  }

  /** v5: Yangi agent yaratish (admin/manager tomonidan) */
  @Post()
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.create(u.tenantId, u.role, body);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.role, body);
  }

  @Patch(':id/toggle')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  toggle(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.toggle(u.tenantId, id);
  }

  /** v5: Admin agent parolini reset qilish */
  @Post(':id/reset-password')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  resetPassword(
    @Param('id') id: string,
    @Body() body: { newPassword: string },
    @CurrentUser() u: any,
  ) {
    return this.svc.resetPassword(u.tenantId, id, body.newPassword);
  }

  /** v5: Agent o'chirish */
  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, id, u.sub);
  }

  /** v17: Moslashtiriladigan ruxsatlar — faqat TENANT_ADMIN ko'ra/o'zgartira oladi */
  @Get(':id/permissions')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  getPermissions(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.getPermissions(u.tenantId, id);
  }

  @Patch(':id/permissions')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  setPermissions(@Param('id') id: string, @Body() body: { permissions: Record<string, boolean> }, @CurrentUser() u: any) {
    return this.svc.setPermissions(u.tenantId, id, body.permissions || {});
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}