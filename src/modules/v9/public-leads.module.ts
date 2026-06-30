import {
  Module,
  Injectable,
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Headers,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { RoundRobinService, RoundRobinModule } from './round-robin.module';
import { LeadScoringService, LeadScoringModule } from './lead-scoring.module';
import { AutoReplyService, AutoReplyModule } from './auto-reply.module';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.module';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { RealtimeModule } from '../realtime/realtime.module';
import * as crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════
// PUBLIC LEADS SERVICE
//
// Oqim:
//   1. Tenant tekshir (ACTIVE)
//   2. API key tekshir (sha256 hash, scopes: leads:write)
//   3. Validatsiya (fullName + kamida bitta aloqa)
//   4. Dublikat tekshir (phone / email / telegramUsername bo'yicha)
//   5a. Dublikat → timeline yoz, shu yerda tugaydi
//   5b. Yangi → client.create → DARHOL round robin tayinla
//   6. Real-time push agentga va dashboardga
//   7. Agar agent topilmasa → adminlarga xabar
//   8. Webhook log
//
// Round Robin:
//   - RoundRobinService.assignNewLead() chaqiriladi
//   - U getNextAgent() → client.update → timeline → notification
//   - Hech qanday MANUAL/ROUND_ROBIN strategiya tekshiruvi yo'q:
//     lead kelsa — tayinlanadi, agent bo'lsa
// ═══════════════════════════════════════════════════════════════════

// Source map — tashqi qiymatlarni DB enum'ga moslashtirish
const SOURCE_MAP: Record<string, string> = {
  WEB:          'WEBSITE',
  WEBSITE:      'WEBSITE',
  TELEGRAM:     'TELEGRAM',
  TELEGRAM_BOT: 'TELEGRAM',
  INSTAGRAM:    'INSTAGRAM',
  WHATSAPP:     'WHATSAPP',
  FACEBOOK:     'FACEBOOK',
  FACEBOOK_ADS: 'FACEBOOK',
  GOOGLE_ADS:   'GOOGLE_ADS',
  REFERRAL:     'REFERRAL',
  WALKIN:       'WALKIN',
  CALL:         'CALL',
};

function mapSource(raw?: string): string {
  return SOURCE_MAP[(raw || '').toUpperCase()] || 'OTHER';
}

@Injectable()
export class PublicLeadsService {
  private readonly logger = new Logger('PublicLeads');

  constructor(
    private prisma: PrismaService,
    private roundRobin: RoundRobinService,
    private scoring: LeadScoringService,
    private autoReply: AutoReplyService,
    private notifications: NotificationsService,
    private audit: AuditService,
    private realtime: RealtimeGateway,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // ASOSIY METOD: yangi public lead qabul qilish
  //
  // POST /api/v1/public/leads/:tenantId?key=API_KEY
  // yoki Header: X-API-Key: API_KEY
  // ─────────────────────────────────────────────────────────────────
  async createLead(
    tenantId: string,
    apiKey: string,
    data: {
      fullName?: string;
      phone?: string;
      email?: string;
      telegramUsername?: string;
      message?: string;
      source?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
      tourInterest?: string;
      country?: string;
      city?: string;
      tgChatId?: string;
      tgFirstName?: string;
      tgLastName?: string;
    },
    meta?: { ip?: string; userAgent?: string },
  ) {
    const startedAt = Date.now();
    let logClientId: string | null = null;
    let logApiKey: any = null;
    let logSuccess = false;
    let logError: string | null = null;
    let logResponse: any = null;
    let logStatus = 200;

    // Webhook log yozuvchi — xato bo'lsa ham yoziladi
    const writeLog = async () => {
      try {
        await (this.prisma as any).webhookLog.create({
          data: {
            tenantId,
            apiKeyId:     logApiKey?.id || null,
            apiKeyPrefix: logApiKey?.prefix || null,
            apiKeyName:   logApiKey?.name || null,
            endpoint:     `/public/leads/${tenantId}`,
            method:       'POST',
            requestBody:  data as any,
            responseBody: logResponse,
            statusCode:   logStatus,
            success:      logSuccess,
            errorMessage: logError,
            clientId:     logClientId,
            ip:           meta?.ip || null,
            userAgent:    meta?.userAgent || null,
            duration:     Date.now() - startedAt,
          },
        });
      } catch (e) {
        this.logger.error('WebhookLog yozilmadi: ' + e);
      }
    };

    try {
      // ── 1. TENANT ────────────────────────────────────────────────
      const tenant = await this.prisma.tenant.findFirst({
        where: { id: tenantId, status: 'ACTIVE' as any },
        select: { id: true, name: true, sourceRouting: true },
      });
      if (!tenant) {
        throw new UnauthorizedException('Tenant topilmadi yoki nofaol');
      }

      // ── 2. API KEY ───────────────────────────────────────────────
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const validKey = await this.prisma.apiKey.findFirst({
        where: {
          tenantId,
          keyHash,
          isActive: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      logApiKey = validKey;

      if (!validKey) {
        throw new UnauthorizedException("API key noto'g'ri yoki muddati tugagan");
      }
      if (!validKey.scopes?.includes('leads:write')) {
        throw new UnauthorizedException("API key'da leads:write huquqi yo'q");
      }

      // ── 3. VALIDATSIYA ───────────────────────────────────────────
      const fullName = data.fullName?.trim();
      if (!fullName) {
        throw new BadRequestException('fullName majburiy');
      }

      const phone           = data.phone?.trim() || null;
      const email           = data.email?.trim().toLowerCase() || null;
      const telegramUsername = data.telegramUsername?.replace(/^@/, '').trim() || null;

      if (!phone && !email && !telegramUsername) {
        throw new BadRequestException(
          "Kamida bitta aloqa kerak: phone, email yoki telegramUsername",
        );
      }

      const mappedSource = mapSource(data.source);

      // ── 4. DUBLIKAT TEKSHIR ──────────────────────────────────────
      let existing: any = null;
      if (phone) {
        existing = await this.prisma.client.findFirst({
          where: { tenantId, phone },
        });
      }
      if (!existing && email) {
        existing = await this.prisma.client.findFirst({
          where: { tenantId, email },
        });
      }
      if (!existing && telegramUsername) {
        existing = await this.prisma.client.findFirst({
          where: { tenantId, telegramUsername },
        });
      }

      // ── 5A. DUBLIKAT — timeline qo'sh, tayinlash kerak emas ─────
      if (existing) {
        logClientId = existing.id;
        await this.prisma.clientTimeline.create({
          data: {
            clientId: existing.id,
            type: 'message',
            title: `🔁 Qayta murojaat (${mappedSource})`,
            description: data.message || `Yangi qiziqish: ${data.tourInterest || ''}`,
            metadata: {
              isDuplicate:    true,
              source:         mappedSource,
              originalSource: data.source,
              utmSource:      data.utmSource,
              utmCampaign:    data.utmCampaign,
              ip:             meta?.ip,
            },
          },
        });

        await this.prisma.apiKey.update({
          where: { id: validKey.id },
          data: { lastUsedAt: new Date() },
        }).catch(() => {});

        this.audit.log({
          tenantId,
          action:   'UPDATE',
          entity:   'client',
          entityId: existing.id,
          metadata: { isDuplicate: true, source: mappedSource, apiKeyId: validKey.id },
        });

        logSuccess = true;
        logStatus  = 200;
        logResponse = { ok: true, isDuplicate: true, clientId: existing.id };
        await writeLog();

        return {
          ok:              true,
          clientId:        existing.id,
          isDuplicate:     true,
          assignedAgentId: existing.assignedAgentId || null,
          message:         "Mavjud klientga yangi murojaat qo'shildi",
        };
      }

      // ── 5B. YANGI CLIENT YARATISH ────────────────────────────────
      const newClient = await this.prisma.client.create({
        data: {
          tenantId,
          fullName,
          phone,
          email,
          telegramUsername,
          source:        mappedSource as any,
          country:       data.country || null,
          city:          data.city || null,
          notes:         data.message || null,
          pipelineStage: 'NEW_LEAD' as any,
          status:        'ACTIVE' as any,
          tier:          'REGULAR' as any,
          utmSource:     data.utmSource || null,
          utmMedium:     data.utmMedium || null,
          utmCampaign:   data.utmCampaign || null,
        },
      });

      logClientId = newClient.id;
      this.logger.log(`[PUBLIC LEADS] Yangi client yaratildi: ${newClient.id} (${fullName}) tenant=${tenantId}`);

      // Timeline — yaratildi
      await this.prisma.clientTimeline.create({
        data: {
          clientId: newClient.id,
          type:     'created',
          title:    `📥 Yangi lead — ${mappedSource}`,
          description: data.tourInterest
            ? `Qiziqish: ${data.tourInterest}`
            : data.message || null,
          metadata: {
            source:         mappedSource,
            originalSource: data.source,
            utmSource:      data.utmSource,
            utmCampaign:    data.utmCampaign,
            ip:             meta?.ip,
            userAgent:      meta?.userAgent,
          },
        },
      }).catch(() => {});

      // Lead Scoring
      this.scoring.scoreClient(tenantId, newClient.id).catch((e: any) => {
        this.logger.error('Scoring error: ' + e?.message);
      });

      // Auto-Reply
      this.autoReply.triggerRules(tenantId, newClient.id, mappedSource).catch((e: any) => {
        this.logger.error('AutoReply error: ' + e?.message);
      });

      // ── 6. ROUND ROBIN — DARHOL TAYINLA ─────────────────────────
      //
      // Birinchi source-routing tekshiramiz (admin sozlamasi):
      //   tenant.sourceRouting = { "INSTAGRAM": "agent-id-xxx", ... }
      //   Agar manba uchun aniq agent belgilangan → shu agentga
      //   Aks holda → round robin orqali
      //
      let assignedAgentId: string | null = null;

      try {
        const sourceRouting = (tenant.sourceRouting || {}) as Record<string, string>;
        const routedAgentId = sourceRouting[mappedSource];

        if (routedAgentId && routedAgentId !== 'ROUND_ROBIN') {
          // Aniq agent ko'rsatilgan — uni tekshir va tayinla
          const routedAgent = await this.prisma.user.findFirst({
            where: {
              id:     routedAgentId,
              tenantId,
              status: 'ACTIVE' as any,
              isPausedFromAssignment: false,
            },
            select: { id: true },
          });

          if (routedAgent) {
            // Source routing agentini tayinla
            await this.prisma.client.update({
              where: { id: newClient.id },
              data:  { assignedAgentId: routedAgent.id },
            });

            await this.prisma.clientTimeline.create({
              data: {
                clientId: newClient.id,
                userId:   routedAgent.id,
                type:     'assigned',
                title:    `🎯 Tayinlandi (Source Routing: ${mappedSource})`,
                metadata: { autoAssigned: true, source: mappedSource, strategy: 'SOURCE_ROUTING' },
              },
            }).catch(() => {});

            await this.notifications.create({
              tenantId,
              userId: routedAgent.id,
              type:   'CLIENT_ASSIGNED' as any,
              title:  `🎯 Yangi lead: ${fullName}`,
              body:   `Sizga yangi mijoz tayinlandi. Manba: ${mappedSource}`,
              link:   `/clients/${newClient.id}`,
              metadata: { clientId: newClient.id, source: mappedSource, autoAssigned: true },
            }).catch(() => {});

            assignedAgentId = routedAgent.id;
            this.logger.log(
              `[PUBLIC LEADS] Source routing: Lead=${newClient.id} → Agent=${routedAgent.id} (${mappedSource})`,
            );
          }
          // Agent topilmasa — round robin'ga tushadi (pastda)
        }

        // Source routing ishlamasa yoki yo'q bo'lsa → Round Robin
        if (!assignedAgentId) {
          assignedAgentId = await this.roundRobin.assignNewLead({
            tenantId,
            clientId:   newClient.id,
            clientName: fullName,
            source:     mappedSource,
          });
        }
      } catch (rrErr: any) {
        this.logger.error(`[PUBLIC LEADS] Round Robin xato: ${rrErr?.message}`);
        // Lead yaratildi, agent tayinlanmadi — davom etamiz
      }

      // ── 7. REAL-TIME PUSH ────────────────────────────────────────
      if (assignedAgentId) {
        // Agentga: dashboardda yangi lead ko'rinsin
        this.realtime.emitToUser(assignedAgentId, 'lead:assigned', {
          clientId:   newClient.id,
          fullName,
          source:     mappedSource,
          assignedAt: new Date().toISOString(),
        });
        // Hamma adminlarga: dashboard statistikasi yangilansin
        this.realtime.emitToTenant(tenantId, 'dashboard:update', {
          type:     'new_lead',
          clientId: newClient.id,
        });
      } else {
        // Agent topilmadi — adminlarga xabar
        try {
          const admins = await this.prisma.user.findMany({
            where: {
              tenantId,
              status: 'ACTIVE' as any,
              role:   { in: ['TENANT_ADMIN', 'MANAGER'] },
            },
            select: { id: true },
          });

          for (const admin of admins) {
            await this.notifications.create({
              tenantId,
              userId: admin.id,
              type:   'LEAD_NEW' as any,
              title:  `📥 Yangi lead tayinlanmadi: ${fullName}`,
              body:   `Manba: ${mappedSource}. Agent topilmadi — qo'lda tayinlang.`,
              link:   `/clients/${newClient.id}`,
              metadata: { clientId: newClient.id, source: mappedSource, unassigned: true },
            }).catch(() => {});
          }

          this.realtime.emitToTenant(tenantId, 'dashboard:update', {
            type:     'new_lead_unassigned',
            clientId: newClient.id,
          });
        } catch (e: any) {
          this.logger.error('Admin notification xato: ' + e?.message);
        }
      }

      // ── 8. API KEY lastUsedAt ────────────────────────────────────
      await this.prisma.apiKey.update({
        where: { id: validKey.id },
        data:  { lastUsedAt: new Date() },
      }).catch(() => {});

      // ── 9. AUDIT ─────────────────────────────────────────────────
      this.audit.log({
        tenantId,
        action:   'CREATE',
        entity:   'client',
        entityId: newClient.id,
        metadata: {
          public:          true,
          apiKeyId:        validKey.id,
          source:          mappedSource,
          isDuplicate:     false,
          assignedAgentId,
          ip:              meta?.ip,
        },
      });

      // ── 10. LOG ──────────────────────────────────────────────────
      logSuccess  = true;
      logStatus   = 200;
      logResponse = { ok: true, clientId: newClient.id, assignedAgentId };
      await writeLog();

      this.logger.log(
        `[PUBLIC LEADS] ✅ Lead yaratildi: ${newClient.id} | Agent: ${assignedAgentId || "YO'Q"} | Tenant: ${tenantId}`,
      );

      return {
        ok:              true,
        clientId:        newClient.id,
        isDuplicate:     false,
        assignedAgentId,
        message: assignedAgentId
          ? 'Yangi lead yaratildi va agentga tayinlandi'
          : "Yangi lead yaratildi (agent topilmadi — qo'lda tayinlang)",
      };

    } catch (err: any) {
      logSuccess  = false;
      logStatus   = err?.status || 500;
      logError    = err?.message || 'Noma\'lum xato';
      logResponse = { error: logError };
      await writeLog();
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // API KEY CRUD
  // ─────────────────────────────────────────────────────────────────
  async listApiKeys(tenantId: string) {
    return this.prisma.apiKey.findMany({
      where: { tenantId },
      select: {
        id: true, name: true, prefix: true,
        scopes: true, isActive: true,
        lastUsedAt: true, expiresAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createApiKey(tenantId: string, name: string, expiresInDays?: number) {
    if (!name?.trim()) throw new BadRequestException('Kalit nomi kerak');

    const rawKey  = `omon_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const prefix  = rawKey.slice(0, 12) + '...';
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const apiKey = await this.prisma.apiKey.create({
      data: {
        tenantId,
        name:     name.trim(),
        keyHash,
        prefix,
        scopes:   ['leads:write'],
        isActive: true,
        expiresAt,
      },
      select: {
        id: true, name: true, prefix: true,
        scopes: true, expiresAt: true, createdAt: true,
      },
    });

    return {
      ...apiKey,
      key:     rawKey,
      warning: "Bu kalit faqat hozir ko'rsatiladi. Saqlab oling!",
    };
  }

  async revokeApiKey(tenantId: string, id: string) {
    const k = await this.prisma.apiKey.findFirst({ where: { id, tenantId } });
    if (!k) throw new BadRequestException('Kalit topilmadi');
    await this.prisma.apiKey.update({ where: { id }, data: { isActive: false } });
    return { ok: true };
  }

  async deleteApiKey(tenantId: string, id: string) {
    const k = await this.prisma.apiKey.findFirst({ where: { id, tenantId } });
    if (!k) throw new BadRequestException('Kalit topilmadi');
    await this.prisma.apiKey.delete({ where: { id } });
    return { ok: true };
  }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINT — API key bilan, JWT siz
// POST /api/v1/public/leads/:tenantId?key=xxx
// yoki Header: X-API-Key: xxx
// ═══════════════════════════════════════════════════════════════════
@Controller('public/leads')
export class PublicLeadsController {
  constructor(private svc: PublicLeadsService) {}

  @Post(':tenantId')
  @HttpCode(HttpStatus.OK)
  async create(
    @Param('tenantId') tenantId: string,
    @Body() body: any,
    @Query('key') queryKey: string,
    @Headers('x-api-key') headerKey: string,
    @Req() req: any,
  ) {
    const apiKey = queryKey || headerKey;
    if (!apiKey) {
      throw new UnauthorizedException('API key kerak (?key= yoki X-API-Key header)');
    }
    return this.svc.createLead(tenantId, apiKey, body, {
      ip:        req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// API KEYS MANAGEMENT — JWT bilan, admin
// ═══════════════════════════════════════════════════════════════════
@Controller('api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeysController {
  constructor(private svc: PublicLeadsService) {}

  @Get()
  list(@CurrentUser() u: any) {
    return this.svc.listApiKeys(u.tenantId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  create(@Body() body: { name: string; expiresInDays?: number }, @CurrentUser() u: any) {
    return this.svc.createApiKey(u.tenantId, body.name, body.expiresInDays);
  }

  @Post(':id/revoke')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  revoke(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.revokeApiKey(u.tenantId, id);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.deleteApiKey(u.tenantId, id);
  }

  @Get('integration-guide')
  guide(@CurrentUser() u: any) {
    const base = process.env.PUBLIC_API_URL || 'http://localhost:3000/api/v1';
    return {
      endpoint: `POST ${base}/public/leads/${u.tenantId}`,
      auth: [
        `?key=YOUR_API_KEY`,
        `Header: X-API-Key: YOUR_API_KEY`,
      ],
      required: ['fullName', 'phone | email | telegramUsername'],
      optional: ['source', 'message', 'tourInterest', 'country', 'city', 'utmSource', 'utmMedium', 'utmCampaign'],
      example: {
        curl: `curl -X POST "${base}/public/leads/${u.tenantId}?key=YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"fullName":"Aziz Aliyev","phone":"+998901234567","source":"WEB"}'`,
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK LOGS
// ═══════════════════════════════════════════════════════════════════
@Controller('webhook-logs')
@UseGuards(JwtAuthGuard)
export class WebhookLogsController {
  private get prisma(): any { return (this.svc as any).prisma; }
  constructor(private svc: PublicLeadsService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  async list(
    @CurrentUser() u: any,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('success')  success?: string,
    @Query('limit')    limit?: string,
  ) {
    const where: any = { tenantId: u.tenantId };
    if (apiKeyId)           where.apiKeyId = apiKeyId;
    if (success === 'true') where.success  = true;
    if (success === 'false') where.success = false;

    const take = Math.min(Number(limit) || 100, 500);

    const [logs, total, stats] = await Promise.all([
      this.prisma.webhookLog.findMany({ where, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.webhookLog.count({ where: { tenantId: u.tenantId } }),
      this.prisma.webhookLog.groupBy({
        by:    ['success'],
        where: { tenantId: u.tenantId },
        _count: { id: true },
      }),
    ]);

    const successCount = stats.find((s: any) => s.success === true)?._count.id  || 0;
    const failedCount  = stats.find((s: any) => s.success === false)?._count.id || 0;

    return {
      data:  logs,
      total,
      stats: {
        successCount,
        failedCount,
        successRate: total > 0 ? Math.round((successCount / total) * 100) : 0,
      },
    };
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  async one(@Param('id') id: string, @CurrentUser() u: any) {
    const log = await this.prisma.webhookLog.findFirst({
      where: { id, tenantId: u.tenantId },
    });
    if (!log) throw new BadRequestException('Log topilmadi');
    return log;
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('TENANT_ADMIN')
  async delete(@Param('id') id: string, @CurrentUser() u: any) {
    const log = await this.prisma.webhookLog.findFirst({
      where: { id, tenantId: u.tenantId },
    });
    if (!log) throw new BadRequestException('Log topilmadi');
    await this.prisma.webhookLog.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * v10: Webhook'ni qayta jo'natish — saqlangan requestBody asosida
   * lead import jarayonini qayta ishga tushiradi.
   */
  @Post(':id/retry')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  async retry(@Param('id') id: string, @CurrentUser() u: any) {
    const log = await this.prisma.webhookLog.findFirst({
      where: { id, tenantId: u.tenantId },
    });
    if (!log) throw new BadRequestException('Log topilmadi');
    if (!log.requestBody) throw new BadRequestException("Qayta jo'natish uchun ma'lumot yo'q");

    try {
      const result = await this.svc.createLead(u.tenantId, log.apiKeyPrefix || '', log.requestBody as any);
      await this.prisma.webhookLog.create({
        data: {
          tenantId: u.tenantId,
          apiKeyId: log.apiKeyId,
          apiKeyPrefix: log.apiKeyPrefix,
          apiKeyName: log.apiKeyName,
          endpoint: log.endpoint,
          method: log.method,
          requestBody: log.requestBody,
          responseBody: result as any,
          statusCode: 200,
          success: true,
          clientId: (result as any)?.id,
        },
      });
      return { ok: true, result };
    } catch (e: any) {
      await this.prisma.webhookLog.create({
        data: {
          tenantId: u.tenantId,
          apiKeyId: log.apiKeyId,
          apiKeyPrefix: log.apiKeyPrefix,
          apiKeyName: log.apiKeyName,
          endpoint: log.endpoint,
          method: log.method,
          requestBody: log.requestBody,
          statusCode: 400,
          success: false,
          errorMessage: e?.message || "Noma'lum xato",
        },
      });
      throw new BadRequestException(e?.message || "Qayta jo'natishda xato");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// MODULE
// ═══════════════════════════════════════════════════════════════════
@Module({
  imports: [RoundRobinModule, LeadScoringModule, AutoReplyModule, RealtimeModule],
  controllers: [PublicLeadsController, ApiKeysController, WebhookLogsController],
  providers: [PublicLeadsService],
  exports: [PublicLeadsService],
})
export class PublicLeadsModule {}