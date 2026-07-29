import {
  Module,
  Injectable,
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';

@Injectable()
export class TenantsService {
  constructor(private prisma: PrismaService) {}

  async getSettings(tenantId: string) {
    return this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true, name: true, slug: true, status: true, plan: true,
        logoUrl: true, brandColor: true, timezone: true, locale: true,
        currency: true, settings: true, maxUsers: true, maxClients: true,
        maxBookings: true, createdAt: true, expiresAt: true,
        phoneProvider: true, phoneConfig: true,
      },
    });
  }

  async updateSettings(tenantId: string, data: any) {
    const allowed: any = {};
    const safeKeys = ['name', 'logoUrl', 'brandColor', 'timezone', 'locale', 'currency', 'settings'];
    for (const k of safeKeys) {
      if (data[k] !== undefined) allowed[k] = data[k];
    }
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: allowed,
      select: { id: true, name: true, brandColor: true, timezone: true, currency: true, settings: true },
    });
  }

  /**
   * v8: Phone provider sozlash
   * Admin tomonidan: qaysi provayder + uning kalitlari
   */
  async updatePhoneProvider(tenantId: string, data: { provider: string; config: any }) {
    const validProviders = ['STUB', 'TEL_LINK', 'TWILIO', 'ONLINEPBX', 'MYATI', 'CUSTOM_SIP', 'MOIZVONKI'];
    if (!validProviders.includes(data.provider)) {
      throw new Error(`Noma'lum provayder: ${data.provider}`);
    }

    // BUG FIX: `getPhoneProvider` API kalitlarni frontendga MASKALAB
    // (masalan "wJ8k****") qaytaradi. Agar admin sozlamalarni saqlaganda
    // shu maskalangan qiymat (kalitni o'zgartirmagan holda) qaytib kelsa,
    // uni HAQIQIY kalit deb bazaga yozib qo'yish — asl kalitni yo'q qilib
    // yuborardi. Shuning uchun: eski (haqiqiy) config'ni bazadan olib,
    // agar yangi qiymat maskalangan ko'rinishda bo'lsa — eski haqiqiy
    // qiymatni saqlab qolamiz.
    const existing = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { phoneConfig: true },
    });
    const oldCfg: any = (existing?.phoneConfig as any) || {};
    const newCfg: any = JSON.parse(JSON.stringify(data.config || {}));

    for (const provider of ['onlinepbx', 'twilio', 'myati', 'moizvonki']) {
      if (newCfg[provider]) {
        for (const key of ['apiKey', 'apiId', 'authToken']) {
          const val = newCfg[provider][key];
          // "****" bilan tugagan/ichida bo'lgan qiymat — bu maskalangan
          // ko'rinish, haqiqiy kalit emas. Bunday holda eski qiymatni
          // saqlab qolamiz (agar eskisi bo'lmasa — bo'sh qoldiramiz,
          // xato bilan haqiqiy bo'lmagan kalitni yozib qo'ymaslik uchun).
          if (typeof val === 'string' && val.includes('****')) {
            newCfg[provider][key] = oldCfg?.[provider]?.[key] ?? '';
          }
        }
      }
    }

    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        phoneProvider: data.provider as any,
        phoneConfig: newCfg,
      },
      select: {
        id: true, phoneProvider: true, phoneConfig: true,
      },
    });
  }

  /**
   * v8: Phone provider sozlamalarini olish (maskalangan API kalitlari bilan)
   */
  async getPhoneProvider(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { phoneProvider: true, phoneConfig: true },
    });
    if (!t) return null;
    // API kalitlarni maskalash
    const cfg: any = JSON.parse(JSON.stringify(t.phoneConfig || {}));
    for (const provider of ['onlinepbx', 'twilio', 'myati', 'moizvonki']) {
      if (cfg[provider]) {
        for (const key of ['apiKey', 'apiId', 'authToken']) {
          if (cfg[provider][key]) {
            cfg[provider][key] = cfg[provider][key].slice(0, 4) + '****';
          }
        }
      }
    }
    return {
      provider: t.phoneProvider,
      config: cfg,
    };
  }

  /**
   * v9: Source-based routing sozlamalarini olish
   */
  async getSourceRouting(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { sourceRouting: true },
    });
    if (!tenant) return null;
    return tenant.sourceRouting || {};
  }

  /**
   * v9: Source-based routing sozlamalarini yangilash
   */
  async updateSourceRouting(tenantId: string, sourceRouting: any) {
    // Tekshirish: har bir source uchun userId yoki 'ROUND_ROBIN'
    if (sourceRouting && typeof sourceRouting === 'object') {
      for (const [source, agentId] of Object.entries(sourceRouting)) {
        if (agentId && agentId !== 'ROUND_ROBIN') {
          // Agent mavjudligini tekshiramiz
          const agent = await this.prisma.user.findFirst({
            where: { id: agentId as string, tenantId, status: 'ACTIVE' as any },
            select: { id: true },
          });
          if (!agent) {
            throw new Error(`Agent topilmadi: ${agentId} (${source})`);
          }
        }
      }
    }

    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: { sourceRouting: sourceRouting || {} },
      select: { id: true, sourceRouting: true },
    });
  }

  async stats(tenantId: string) {
    const [users, clients, bookings] = await Promise.all([
      this.prisma.user.count({ where: { tenantId, status: 'ACTIVE' } }),
      this.prisma.client.count({ where: { tenantId } }),
      this.prisma.booking.count({ where: { tenantId } }),
    ]);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { maxUsers: true, maxClients: true, maxBookings: true, plan: true },
    });
    return {
      usage: { users, clients, bookings },
      limits: tenant,
    };
  }
}

@Controller('tenants')
@UseGuards(JwtAuthGuard)
export class TenantsController {
  constructor(private svc: TenantsService) {}

  @Get('settings')
  get(@CurrentUser() u: any) {
    return this.svc.getSettings(u.tenantId);
  }

  @Patch('settings')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  update(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.updateSettings(u.tenantId, body);
  }

  @Get('stats')
  stats(@CurrentUser() u: any) {
    return this.svc.stats(u.tenantId);
  }

  // v8: Phone Provider sozlamalari
  @Get('phone-provider')
  getPhone(@CurrentUser() u: any) {
    return this.svc.getPhoneProvider(u.tenantId);
  }

  @Patch('phone-provider')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  updatePhone(@Body() body: { provider: string; config: any }, @CurrentUser() u: any) {
    return this.svc.updatePhoneProvider(u.tenantId, body);
  }

  // v9: Source-based routing
  @Get('source-routing')
  getSourceRouting(@CurrentUser() u: any) {
    return this.svc.getSourceRouting(u.tenantId);
  }

  @Patch('source-routing')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  updateSourceRouting(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.updateSourceRouting(u.tenantId, body.sourceRouting || {});
  }
}

@Module({
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}