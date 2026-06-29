import { RoundRobinService, RoundRobinModule } from '../v9/round-robin.module';
import {
  Module, Injectable, Controller,
  Get, Post, Body, Query, Param,
  UseGuards, Logger, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, Public } from '../../common/decorators';
import { RealtimeGateway } from '../realtime/realtime.gateway';

type BotStep = 'ASK_NAME' | 'ASK_DESTINATION' | 'ASK_PHONE' | 'ASK_DATE' | 'DONE';

interface BotSession {
  step: BotStep;
  stepIndex?: number;
  name?: string;
  destination?: string;
  phone?: string;
  date?: string;
  instagramUserId: string;
  tenantId: string;
  startedAt: Date;
  [key: string]: any;
}

// DB-backed session storage (survives restarts)
// Sessions stored in Tenant.settings as instagramSessions JSON
const botSessionsCache = new Map<string, BotSession>(); // local cache for speed

@Injectable()
export class InstagramService {
  private readonly logger = new Logger('Instagram');

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private roundRobin: RoundRobinService,
  ) {}

  async getConfig(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const s: any = tenant?.settings || {};
    const defaultSteps = [
      { id: 'name', question: 'Ismingizni yozing', field: 'name' },
      { id: 'destination', question: 'Qayerga sayohat qilmoqchisiz?', field: 'destination' },
      { id: 'phone', question: 'Telefon raqamingizni yozing (+998...)', field: 'phone' },
      { id: 'date', question: 'Qachon ketmoqchisiz?', field: 'date' },
    ];
    return {
      accessToken: s.instagramAccessToken || null,
      pageId: s.instagramPageId || null,
      verifyToken: s.instagramVerifyToken || 'omoncrm_verify',
      botName: s.instagramBotName || 'Travel Bot',
      greetingMessage: s.instagramGreeting || 'Salom! Sizga yordam berishdan mamnunman.',
      farewell: s.instagramFarewell || 'Rahmat! Tez orada siz bilan boglanamiz.',
      assignToAgentId: s.instagramAssignAgentId || null,
      isEnabled: !!s.instagramAccessToken,
      botSteps: s.instagramBotSteps || defaultSteps,
    };
  }

  async saveConfig(tenantId: string, data: {
    accessToken?: string;
    pageId?: string;
    verifyToken?: string;
    botName?: string;
    greetingMessage?: string;
    assignToAgentId?: string;
  }) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const cur: any = tenant?.settings || {};
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        settings: {
          ...cur,
          instagramAccessToken: data.accessToken ?? cur.instagramAccessToken,
          instagramPageId: data.pageId ?? cur.instagramPageId,
          instagramVerifyToken: data.verifyToken ?? cur.instagramVerifyToken,
          instagramBotName: data.botName ?? cur.instagramBotName,
          instagramGreeting: data.greetingMessage ?? cur.instagramGreeting,
          instagramFarewell: (data as any).farewell ?? cur.instagramFarewell,
          instagramBotSteps: (data as any).botSteps ?? cur.instagramBotSteps,
          instagramAssignAgentId: data.assignToAgentId ?? cur.instagramAssignAgentId,
        },
      },
    });
    return this.getConfig(tenantId);
  }

  verifyWebhook(tenantId: string, mode: string, token: string, challenge: string, verifyToken: string) {
    if (mode === 'subscribe' && token === (verifyToken || 'omoncrm_verify')) {
      return challenge;
    }
    throw new BadRequestException('Webhook verification failed');
  }

  async processWebhook(tenantId: string, body: any, signature?: string) {
    if (body?.object !== 'instagram' && body?.object !== 'page') return { ok: true };
    // Meta signature verification (X-Hub-Signature-256)
    if (signature && process.env.NODE_ENV === 'production') {
      const config = await this.getConfig(tenantId);
      if (config.accessToken) {
        try {
          const crypto = await import('crypto');
          const expected = 'sha256=' + crypto.createHmac('sha256', config.accessToken)
            .update(JSON.stringify(body)).digest('hex');
          if (signature !== expected) {
            this.logger.warn('Instagram webhook: invalid signature');
            return { ok: false };
          }
        } catch {}
      }
    }
    this.logger.log('Instagram webhook received: ' + JSON.stringify(body).slice(0, 300));
    const entries: any[] = body?.entry || [];
    for (const entry of entries) {
      for (const event of (entry?.messaging || [])) {
        if (event?.message && !event.message.is_echo) {
          await this.handleMessage(tenantId, event).catch((e: any) =>
            this.logger.error('Instagram msg error: ' + e.message)
          );
        }
      }
    }
    return { ok: true };
  }

  private async handleMessage(tenantId: string, event: any) {
    const senderId: string = event.sender?.id;
    const text: string = (event.message?.text || '').trim();
    if (!senderId || !text) return;

    const config = await this.getConfig(tenantId);
    if (!config.isEnabled) return;

    const key = senderId + ':' + tenantId;
    let session = botSessionsCache.get(key);
    if (!session) {
      session = await this.getSession(tenantId, senderId);
      if (session) botSessionsCache.set(key, session);
    }

    if (!session) {
      session = { step: 'ASK_NAME', instagramUserId: senderId, tenantId, startedAt: new Date() };
      botSessionsCache.set(key, session);
      await this.saveSession(tenantId, senderId, session);
      const steps = config.botSteps || [];
      const firstQ = steps.length > 0 ? String.fromCharCode(10) + steps[0].question : '';
      await this.reply(config.accessToken!, senderId, config.greetingMessage + firstQ);
      session.stepIndex = 0;
      await this.saveSession(tenantId, senderId, session);
      return;
    }

    let next = '';
    if (session.step === 'ASK_NAME') {
      session.name = text;
      session.step = 'ASK_DESTINATION';
      await this.saveSession(tenantId, senderId, session);
      next = 'Rahmat ' + text + '! Qayerga sayohat qilmoqchisiz? (Masalan: Dubay, Turkiya, Tailand)';
    } else if (session.step === 'ASK_DESTINATION') {
      session.destination = text;
      session.step = 'ASK_PHONE';
      await this.saveSession(tenantId, senderId, session);
      next = 'Ajoyib! Telefon raqamingizni yuboring (+998XXXXXXXXX)';
    } else if (session.step === 'ASK_PHONE') {
      session.phone = text;
      session.step = 'ASK_DATE';
      await this.saveSession(tenantId, senderId, session);
      next = 'Qachon ketmoqchisiz? (oy yoki aniq sana kiriting)';
    } else if (session.step === 'ASK_DATE') {
      session.date = text;
      session.step = 'DONE';
      next = 'Rahmat ' + (session.name || '') + '! Menejerimiz tez orada siz bilan boglanadi. Yaxshi kun!';
      await this.createLead(tenantId, { ...session }, config);
      botSessionsCache.delete(key);
      await this.deleteSession(tenantId, senderId);
    } else {
      botSessionsCache.delete(key);
      await this.deleteSession(tenantId, senderId);
      const fresh: BotSession = { step: 'ASK_NAME', instagramUserId: senderId, tenantId, startedAt: new Date() };
      botSessionsCache.set(key, fresh);
      next = config.greetingMessage;
    }

    if (next) await this.reply(config.accessToken!, senderId, next);
  }

  private async createLead(tenantId: string, s: BotSession, config: any) {
    let agentId = config.assignToAgentId;
    if (!agentId) {
      // Round-Robin: strategiya tekshirib navbat bilan tayinlash
      agentId = await this.roundRobin.getNextAgent(tenantId);
    }

    // Check duplicate
    if (s.phone) {
      const dup = await this.prisma.client.findFirst({ where: { tenantId, phone: s.phone } });
      if (dup) {
        this.logger.log('Instagram duplicate phone: ' + s.phone);
        return dup;
      }
    }

    const client = await this.prisma.client.create({
      data: {
        tenantId,
        fullName: s.name || 'Instagram foydalanuvchi',
        phone: s.phone || '',
        source: 'INSTAGRAM',
        pipelineStage: 'NEW_LEAD',
        pipelineStageAt: new Date(),
        assignedAgentId: agentId,
        notes: ['Instagram bot orqali keldi', s.destination ? 'Yonalish: ' + s.destination : '', s.date ? 'Sana: ' + s.date : ''].filter(Boolean).join('\n'),
        preferences: {
          travelDestination: s.destination,
          travelDateRequest: s.date,
          instagramUserId: s.instagramUserId,
        },
      } as any,
    });

    await this.prisma.clientTimeline.create({
      data: {
        clientId: client.id,
        type: 'created',
        title: 'Instagram bot orqali yangi lead',
        description: 'Yonalish: ' + s.destination + ' | Tel: ' + s.phone + ' | Sana: ' + s.date,
        metadata: { source: 'instagram_bot', instagramUserId: s.instagramUserId },
      } as any,
    }).catch(() => {});

    if (agentId) {
      this.realtime.emitToUser(agentId, 'lead:new', {
        clientId: client.id, source: 'INSTAGRAM',
        name: s.name, phone: s.phone, destination: s.destination,
      });
    }
    this.realtime.emitToTenant(tenantId, 'lead:new', { clientId: client.id, source: 'INSTAGRAM' });

    this.logger.log('New Instagram lead: ' + client.id + ' - ' + s.name);
    return client;
  }

  private async reply(accessToken: string, recipientId: string, text: string) {
    if (!accessToken) { this.logger.warn('Instagram: no accessToken'); return; }
    try {
      const res = await fetch('https://graph.facebook.com/v18.0/me/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.logger.error('Instagram send failed: ' + JSON.stringify(err));
      }
    } catch (e: any) {
      this.logger.error('Instagram send error: ' + e.message);
    }
  }

  // ── DB session helpers ─────────────────────────────────────────────────────
  private async getSession(tenantId: string, senderId: string): Promise<BotSession | null> {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const sessions: any = (tenant?.settings as any)?.instagramSessions || {};
      return sessions[senderId] || null;
    } catch { return null; }
  }

  private async saveSession(tenantId: string, senderId: string, session: BotSession) {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const cur: any = tenant?.settings || {};
      const sessions: any = cur.instagramSessions || {};
      sessions[senderId] = { ...session, savedAt: new Date().toISOString() };
      // Keep max 200 sessions
      const keys = Object.keys(sessions);
      if (keys.length > 200) {
        const oldest = keys.sort((a, b) => (sessions[a].savedAt || '') < (sessions[b].savedAt || '') ? -1 : 1).slice(0, keys.length - 200);
        oldest.forEach(k => delete sessions[k]);
      }
      await this.prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...cur, instagramSessions: sessions } } });
    } catch (e: any) { this.logger.warn('saveSession error: ' + e.message); }
  }

  private async deleteSession(tenantId: string, senderId: string) {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const cur: any = tenant?.settings || {};
      const sessions: any = cur.instagramSessions || {};
      delete sessions[senderId];
      await this.prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...cur, instagramSessions: sessions } } });
      botSessionsCache.delete(senderId + ':' + tenantId);
    } catch (e: any) { this.logger.warn('deleteSession error: ' + e.message); }
  }

  async getStats(tenantId: string) {
    const [total, thisMonth] = await Promise.all([
      this.prisma.client.count({ where: { tenantId, source: 'INSTAGRAM' } }),
      this.prisma.client.count({
        where: { tenantId, source: 'INSTAGRAM', createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
      }),
    ]);
    return { total, thisMonth, activeSessions: botSessionsCache.size };
  }
}

@ApiTags('Instagram Lead Bot')
@Controller('instagram')
export class InstagramController {
  constructor(private svc: InstagramService) {}

  @Get('webhook/:tenantId')
  @Public()
  async verifyWebhook(
    @Param('tenantId') tenantId: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const config = await this.svc.getConfig(tenantId);
    return this.svc.verifyWebhook(tenantId, mode, token, challenge, config.verifyToken);
  }

  @Post('webhook/:tenantId')
  @Public()
  webhook(
    @Param('tenantId') tenantId: string,
    @Body() body: any,
    @Query('signature') sig?: string,
  ) {
    // Get signature from header via body raw (passed as query in some setups)
    return this.svc.processWebhook(tenantId, body, sig);
  }

  @ApiOperation({ summary: 'Instagram bot sozlamalarini olish' })
  @ApiBearerAuth('JWT')
  @Get('config')
  @UseGuards(JwtAuthGuard)
  getConfig(@CurrentUser() u: any) {
    return this.svc.getConfig(u.tenantId);
  }

  @ApiOperation({ summary: 'Instagram bot sozlamalarini saqlash' })
  @ApiBearerAuth('JWT')
  @Post('config')
  @UseGuards(JwtAuthGuard)
  saveConfig(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.saveConfig(u.tenantId, body);
  }

  @ApiOperation({ summary: 'Instagram statistikasi' })
  @ApiBearerAuth('JWT')
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  stats(@CurrentUser() u: any) {
    return this.svc.getStats(u.tenantId);
  }
}

@Module({
  controllers: [InstagramController],
  imports: [RoundRobinModule],
  providers: [InstagramService],
  exports: [InstagramService],
})
export class InstagramModule {}