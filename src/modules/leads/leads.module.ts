import {
  Module, Injectable, Controller, Get, Post, Delete, Param, Body,
  UseGuards, BadRequestException, UnauthorizedException, ExecutionContext,
  CanActivate, Req, HttpCode,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles, Public } from '../../common/decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { safeEnum , pickNextAgent } from '../../common/utils/helpers';
import { RoundRobinService, RoundRobinModule } from '../v9/round-robin.module';
import { LeadSource, Language } from '../../prisma-types';;

const SOURCES: LeadSource[] = [
  'TELEGRAM', 'INSTAGRAM', 'WHATSAPP', 'REFERRAL', 'WALKIN',
  'WEBSITE', 'CALL', 'FACEBOOK', 'GOOGLE_ADS', 'OTHER',
];
const LANGS: Language[] = ['UZ', 'RU', 'EN'];

export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const raw = req.headers['x-api-key'] ||
      (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!raw || typeof raw !== 'string') {
      throw new UnauthorizedException('API key kerak (x-api-key header)');
    }
    const key = await this.prisma.apiKey.findFirst({
      where: { keyHash: hashApiKey(raw), isActive: true },
    });
    if (!key) throw new UnauthorizedException("API key noto'g'ri");
    if (key.expiresAt && key.expiresAt < new Date()) {
      throw new UnauthorizedException('API key muddati tugagan');
    }
    await this.prisma.apiKey.update({
      where: { id: key.id }, data: { lastUsedAt: new Date() },
    });
    req.apiKey = key;
    return true;
  }
}

@Injectable()
export class LeadsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private roundRobin: RoundRobinService,
  ) {}

  async pickAgent(tenantId: string): Promise<string | null> {
    // Strategiyani tekshir
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { leadAssignmentStrategy: true },
    });
    if (tenant?.leadAssignmentStrategy === 'MANUAL') {
      return null; // MANUAL rejimda avtomatik tayinlanmaydi
    }
    return this.roundRobin.getNextAgent(tenantId);
  }

  async importLead(tenantId: string, data: any) {
    if (!data.fullName?.trim() || !data.phone?.trim()) {
      throw new BadRequestException('fullName va phone majburiy');
    }
    const phone = String(data.phone).trim();
    const dup = await this.prisma.client.findFirst({
      where: { tenantId, phone },
    });
    let clientId: string;
    let assignedAgentId: string | null = null;

    if (dup) {
      clientId = dup.id;
      // Agar avvalgi lead agentsiz qolgan bo'lsa — qayta tayinla
      assignedAgentId = dup.assignedAgentId || (await this.pickAgent(tenantId));
      if (assignedAgentId && !dup.assignedAgentId) {
        await this.prisma.client.update({
          where: { id: dup.id },
          data: { assignedAgentId },
        });
      }
      await this.prisma.clientTimeline.create({
        data: {
          clientId: dup.id,
          type: 'duplicate_lead',
          title: 'Yana lead keldi (API)',
          description: data.note || data.sourceCampaign,
          metadata: { source: data.source, campaign: data.sourceCampaign },
        },
      });
    } else {
      assignedAgentId = data.assignTo || (await this.pickAgent(tenantId));
      const client = await this.prisma.client.create({
        data: {
          tenantId,
          assignedAgentId,
          fullName: data.fullName.trim(),
          phone,
          email: data.email?.trim()?.toLowerCase(),
          source: safeEnum(data.source, SOURCES, 'OTHER'),
          sourceCampaign: data.sourceCampaign,
          utmSource: data.utmSource,
          utmMedium: data.utmMedium,
          utmCampaign: data.utmCampaign,
          tags: Array.isArray(data.tags) ? data.tags : [],
          language: safeEnum(data.language, LANGS, 'UZ'),
          notes: data.note,
          lastContactAt: new Date(),
        },
      });
      clientId = client.id;
      await this.prisma.clientTimeline.create({
        data: {
          clientId,
          type: 'created',
          title: 'API orqali lead keldi',
          description: data.sourceCampaign,
          metadata: { source: data.source, campaign: data.sourceCampaign },
        },
      });
    }

    if (assignedAgentId) {
      await this.notifications.create({
        tenantId, userId: assignedAgentId,
        type: 'LEAD_NEW',
        title: '🔥 Yangi API lead',
        body: `${data.fullName} — ${data.sourceCampaign || data.source || ''}`,
        link: `/clients/${clientId}`,
        metadata: { clientId },
      });
    }
    return { id: clientId, assignedAgentId, isDuplicate: !!dup };
  }

  async listKeys(tenantId: string) {
    return this.prisma.apiKey.findMany({
      where: { tenantId },
      select: {
        id: true, name: true, prefix: true, scopes: true,
        isActive: true, lastUsedAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createKey(tenantId: string, name: string) {
    if (!name?.trim()) throw new BadRequestException('name majburiy');
    const raw = 'lk_' + crypto.randomBytes(24).toString('base64url');
    const keyHash = hashApiKey(raw);
    const prefix = raw.slice(0, 10) + '…';
    const key = await this.prisma.apiKey.create({
      data: { tenantId, name: name.trim(), keyHash, prefix },
    });
    return {
      id: key.id, name: key.name, key: raw, prefix,
      warning: 'BU KALITNI SAQLANG — qaytadan ko\'rsatilmaydi',
    };
  }

  async revokeKey(tenantId: string, id: string) {
    await this.prisma.apiKey.updateMany({
      where: { id, tenantId }, data: { isActive: false },
    });
    return { ok: true };
  }
}

// Public — API key required
@Controller('public/leads')
export class PublicLeadsController {
  constructor(private svc: LeadsService) {}

  @Post()
  @Public()
  @UseGuards(ApiKeyGuard)
  @HttpCode(201)
  import(@Body() body: any, @Req() req: any) {
    return this.svc.importLead(req.apiKey.tenantId, body);
  }
}

// Admin — manage API keys
@Controller('api-keys')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TENANT_ADMIN')
export class ApiKeysController {
  constructor(private svc: LeadsService) {}

  @Get()
  list(@CurrentUser() u: any) {
    return this.svc.listKeys(u.tenantId);
  }

  @Post()
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.createKey(u.tenantId, body.name);
  }

  @Delete(':id')
  revoke(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.revokeKey(u.tenantId, id);
  }

  // Test lead yuborish — UI dan sinab ko'rish uchun (JWT bilan)
  @Post(':id/test-send')
  async testSend(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() u: any,
  ) {
    // API key bu tenantga tegishli ekanini tekshir
    const key = await this.svc['prisma'].apiKey.findFirst({
      where: { id, tenantId: u.tenantId, isActive: true },
    });
    if (!key) throw new BadRequestException('API key topilmadi');

    // Har safar unique telefon — duplicate bo'lmasligi uchun
    const testPhone = body.phone && body.phone !== '+998901234567'
      ? body.phone
      : `+99890${Date.now().toString().slice(-7)}`;

    // Real importLead chaqiramiz
    return this.svc.importLead(u.tenantId, {
      fullName:    body.fullName || 'Test Klient',
      phone:       testPhone,
      email:       body.email,
      source:      body.source  || 'OTHER',
      note:        body.message,
      utmSource:   body.utmSource,
      utmMedium:   body.utmMedium,
      utmCampaign: body.utmCampaign,
    });
  }
}

@Module({
  imports: [RoundRobinModule],
  controllers: [PublicLeadsController, ApiKeysController],
  providers: [LeadsService, ApiKeyGuard],
  exports: [LeadsService],
})
export class LeadsModule {}
