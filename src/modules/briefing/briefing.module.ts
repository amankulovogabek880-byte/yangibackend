import {
  Module, Injectable, Controller, Get, Post, Query, UseGuards, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { OBJECTION_CATEGORIES } from '../calls/calls.module';

/**
 * ═══════════════════════════════════════════════════════════════
 * v19: "BUGUNGI USTUVORLIK" — AI kunlik brifing
 * ═══════════════════════════════════════════════════════════════
 *
 * G'OYA: CRM'da qo'ng'iroq tahlili, chat, eslatma (follow-up) va
 * vazifalar — hammasi bor, lekin ularning har biri ALOHIDA joyda
 * yotibdi. Bu modul ularni BIRLASHTIRIB, har kuni har bir agentga
 * (va adminga — jamoa bo'yicha) shaxsiy, harakatga undovchi,
 * ustuvorlashtirilgan ro'yxat beradi: "bugun birinchi navbatda kimga
 * qo'ng'iroq qilish kerak va nega", "sizning bu haftalik eng katta
 * zaif nuqtangiz nima".
 *
 * XARAJATNI NAZORAT QILISH (juda muhim):
 * - Brifing kuniga FAQAT BIR MARTA generatsiya qilinadi va DB'da
 *   keshlanadi (tenantId+agentId+date bo'yicha unique). Dashboard
 *   necha marta ochilishidan qat'iy nazar, Claude'ga faqat BIRINCHI
 *   so'rovda murojaat qilinadi — qolganlari keshdan qaytadi.
 * - Qo'lda "Yangilash" tugmasi bor, lekin u ham 10 daqiqada bir marta
 *   ishlaydi (spam-bosishdan himoya).
 * - Promptga yuboriladigan ma'lumot hajmi qat'iy cheklangan (eng
 *   muhim 15-20 ta yozuv), xom transkriptlar EMAS — faqat allaqachon
 *   tahlil qilingan (aiSummary/aiObjections/aiFeedback) qisqa
 *   xulosalar yuboriladi, shuning uchun token sarfi kichik.
 */

type BriefingItem = {
  priority: number;
  type: 'call_back' | 'followup' | 'chat_reply' | 'task' | 'coaching';
  title: string;
  reason: string;
  clientName?: string;
  phone?: string;
};

@Injectable()
export class BriefingService {
  private readonly logger = new Logger('Briefing');

  constructor(private prisma: PrismaService) {}

  private get anthropicKey() {
    return (process.env.ANTHROPIC_API_KEY || '').trim();
  }
  private get anthropicModel() {
    return (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5').trim();
  }

  /** Asia/Tashkent bo'yicha bugungi kun kaliti (UTC+5, DST yo'q) */
  private todayKey(): string {
    const tashkent = new Date(Date.now() + 5 * 3600 * 1000);
    return tashkent.toISOString().slice(0, 10);
  }

  private sanitizeJsonControlChars(input: string): string {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (inString) {
        if (escaped) { result += ch; escaped = false; continue; }
        if (ch === '\\') { result += ch; escaped = true; continue; }
        if (ch === '"') { inString = false; result += ch; continue; }
        if (ch.charCodeAt(0) < 0x20) { continue; }
        result += ch; continue;
      }
      if (ch === '"') { inString = true; }
      result += ch;
    }
    return result;
  }

  /** Asosiy kirish nuqtasi: keshdan qaytaradi yoki yangi generatsiya qiladi */
  async getBriefing(tenantId: string, userId: string, role: string, force = false) {
    const isAgent = role === 'AGENT';
    const agentId = isAgent ? userId : null; // admin/manager -> jamoaviy (agentId: null)
    const date = this.todayKey();

    const existing = await this.prisma.dailyBriefing.findUnique({
      where: { tenantId_agentId_date: { tenantId, agentId: agentId as any, date } },
    }).catch(() => null);

    if (existing && !force) return { ...(existing.data as any), generatedAt: existing.generatedAt, cached: true };

    // Qo'lda "Yangilash" — 10 daqiqada bir marta (spam-bosishdan himoya, xarajat nazorati)
    if (existing && force) {
      const minutesSince = (Date.now() - new Date(existing.generatedAt).getTime()) / 60000;
      if (minutesSince < 10) {
        return { ...(existing.data as any), generatedAt: existing.generatedAt, cached: true, throttled: true };
      }
    }

    if (!this.anthropicKey) {
      return {
        error: "AI brifing sozlanmagan (serverda ANTHROPIC_API_KEY yo'q).",
        items: [], weakSpot: null, greeting: null, generatedAt: new Date(), cached: false,
      };
    }

    const data = isAgent
      ? await this.generateForAgent(tenantId, userId)
      : await this.generateForTenant(tenantId);

    await this.prisma.dailyBriefing.upsert({
      where: { tenantId_agentId_date: { tenantId, agentId: agentId as any, date } },
      create: { tenantId, agentId: agentId as any, date, data: data as any },
      update: { data: data as any, generatedAt: new Date() },
    }).catch((e: any) => this.logger.warn(`Brifing saqlanmadi: ${e.message}`));

    return { ...data, generatedAt: new Date(), cached: false };
  }

  // ─── AGENT uchun shaxsiy brifing ───────────────────────────────
  private async generateForAgent(tenantId: string, agentId: string) {
    const now = new Date();
    const soon = new Date(now.getTime() + 2 * 24 * 3600 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

    const [followUps, recentCalls, tasks, unrepliedChats, missedCalls, agent] = await Promise.all([
      this.prisma.followUp.findMany({
        where: { tenantId, agentId, done: false, dueAt: { lte: soon } },
        include: { client: { select: { fullName: true, phone: true } } },
        orderBy: { dueAt: 'asc' },
        take: 10,
      }),
      this.prisma.call.findMany({
        where: { tenantId, agentId: agentId, aiAnalyzedAt: { not: null }, createdAt: { gte: weekAgo } } as any,
        select: { aiSummary: true, aiObjections: true, aiFeedback: true, aiSentiment: true, createdAt: true, client: { select: { fullName: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }).catch(() => [] as any[]),
      this.prisma.task.findMany({
        where: { tenantId, assigneeId: agentId, status: { not: 'DONE' as any }, dueAt: { lte: soon } },
        include: { client: { select: { fullName: true, phone: true } } },
        orderBy: { dueAt: 'asc' },
        take: 10,
      }),
      this.prisma.conversation.findMany({
        where: { tenantId, assignedAgentId: agentId, isResolved: false, unreadCount: { gt: 0 } },
        select: { firstName: true, lastName: true, username: true, lastMessageText: true, lastMessageAt: true, clientId: true },
        orderBy: { lastMessageAt: 'desc' },
        take: 10,
      }).catch(() => [] as any[]),
      this.prisma.call.findMany({
        where: { tenantId, agentId: agentId, status: { in: ['NO_ANSWER', 'MISSED', 'BUSY'] as any }, createdAt: { gte: new Date(now.getTime() - 2 * 24 * 3600 * 1000) } } as any,
        select: { createdAt: true, client: { select: { fullName: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }).catch(() => [] as any[]),
      this.prisma.user.findUnique({ where: { id: agentId }, select: { name: true } }),
    ]);

    if (!followUps.length && !recentCalls.length && !tasks.length && !unrepliedChats.length && !missedCalls.length) {
      return {
        greeting: `Salom${agent?.name ? ', ' + agent.name.split(' ')[0] : ''}! Bugun sizda ochiq eslatma, vazifa yoki javobsiz suhbat yo'q — zo'r ish!`,
        items: [], weakSpot: null,
      };
    }

    // Faqat qisqa, allaqachon tahlil qilingan xulosalarni yuboramiz — xom
    // transkriptlar emas (token/xarajatni tejash uchun).
    const objectionCounts: Record<string, number> = {};
    const scores: number[] = [];
    for (const c of recentCalls as any[]) {
      for (const o of (c.aiObjections || [])) if (o?.category) objectionCounts[o.category] = (objectionCounts[o.category] || 0) + 1;
      if (typeof c.aiFeedback?.score === 'number') scores.push(c.aiFeedback.score);
    }
    const avgScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;

    const payload = {
      followUps: followUps.map((f) => ({ title: f.title, note: f.note, dueAt: f.dueAt, client: f.client?.fullName, phone: f.client?.phone })),
      tasks: tasks.map((t) => ({ title: t.title, dueAt: t.dueAt, priority: t.priority, client: t.client?.fullName, phone: t.client?.phone })),
      unrepliedChats: unrepliedChats.map((c: any) => ({ name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.username, lastMessage: c.lastMessageText, at: c.lastMessageAt })),
      missedCalls: missedCalls.map((c: any) => ({ client: c.client?.fullName, phone: c.client?.phone, at: c.createdAt })),
      recentCallSummaries: (recentCalls as any[]).slice(0, 12).map((c) => ({
        client: c.client?.fullName, sentiment: c.aiSentiment, summary: c.aiSummary,
        objections: (c.aiObjections || []).map((o: any) => o.label),
        feedbackScore: c.aiFeedback?.score, improvements: c.aiFeedback?.improvements,
      })),
      weeklyAvgScore: avgScore,
      topObjection: Object.entries(objectionCounts).sort((a, b) => b[1] - a[1])[0] || null,
    };

    const system = `Sen tajribali sotuv bo'lim boshlig'isan. Sotuv agentiga bugungi kunni rejalashtirishga yordam berasan. O'zbek tilida, DO'STONA, LEKIN ANIQ va QISQA yoz — bu Telegramdagi shaxsiy eslatma kabi bo'lsin, rasmiy hisobot emas. Faqat berilgan ma'lumotlarga tayan, hech narsani o'ylab topma.`;
    const prompt = `Quyida bitta sotuv agentining bugungi ochiq ishlari (JSON):
${JSON.stringify(payload, null, 1).slice(0, 9000)}

Vazifa:
1. "greeting" — 1 qisqa, samimiy jumla (ismini ishlatma, u alohida qo'shiladi).
2. "items" — eng muhim 3-6 ta ustuvor ish, ENG MUHIMI BIRINCHI (priority: 1,2,3...). Har biri: type (call_back/followup/chat_reply/task), title (qisqa, aniq harakat — "Aziz akaga qo'ng'iroq qiling"), reason (1 jumla — NEGA aynan hozir muhim, aniq faktga tayanib: "3 kun oldin narx so'ragan, hali javob kelmagan"), clientName, phone (bo'lsa).
3. "weakSpot" — agar recentCallSummaries yoki topObjection'da aniq naqsh ko'rinsa (masalan bir xil e'tiroz qayta-qayta, yoki improvements'da bir xil kamchilik takrorlansa): {"title": "qisqa ko'nikma nomi (masalan 'Yopish (closing)')", "detail": "aniq son/faktga asoslangan 1 jumla", "tip": "1 amaliy maslahat"}. Agar aniq naqsh yo'q bo'lsa yoki ma'lumot yetarli bo'lmasa — null qaytar, o'ylab topma.

FAQAT JSON qaytar, boshqa hech narsa yo'q:
{"greeting": "...", "items": [...], "weakSpot": {...} | null}`;

    return await this.callClaude(system, prompt, payload);
  }

  // ─── ADMIN/MANAGER uchun jamoaviy brifing ──────────────────────
  private async generateForTenant(tenantId: string) {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

    const [agents, overdueFollowUps, overdueTasks, unrepliedChats, recentCalls] = await Promise.all([
      this.prisma.user.findMany({ where: { tenantId, role: 'AGENT', status: 'ACTIVE' }, select: { id: true, name: true } }),
      this.prisma.followUp.count({ where: { tenantId, done: false, dueAt: { lt: now } } }),
      this.prisma.task.count({ where: { tenantId, status: { not: 'DONE' as any }, dueAt: { lt: now } } }),
      this.prisma.conversation.count({ where: { tenantId, isResolved: false, unreadCount: { gt: 0 } } }).catch(() => 0),
      this.prisma.call.findMany({
        where: { tenantId, aiAnalyzedAt: { not: null }, createdAt: { gte: weekAgo } } as any,
        select: { agentId: true, aiObjections: true, aiFeedback: true },
        take: 300,
      }).catch(() => [] as any[]),
    ]);

    if (!agents.length) {
      return { greeting: 'Hozircha jamoada faol agentlar yo\'q.', items: [], weakSpot: null };
    }

    // Har bir agent bo'yicha o'rtacha ball va e'tirozlarni hisoblaymiz
    const perAgent: Record<string, { scores: number[]; objections: Record<string, number> }> = {};
    for (const a of agents) perAgent[a.id] = { scores: [], objections: {} };
    const objectionCounts: Record<string, number> = {};
    for (const c of recentCalls as any[]) {
      const bucket = perAgent[c.agentId];
      if (bucket && typeof c.aiFeedback?.score === 'number') bucket.scores.push(c.aiFeedback.score);
      for (const o of (c.aiObjections || [])) {
        if (!o?.category) continue;
        objectionCounts[o.category] = (objectionCounts[o.category] || 0) + 1;
        if (bucket) bucket.objections[o.category] = (bucket.objections[o.category] || 0) + 1;
      }
    }

    const agentStats = agents.map((a) => {
      const b = perAgent[a.id];
      const avg = b.scores.length ? Math.round((b.scores.reduce((x, y) => x + y, 0) / b.scores.length) * 10) / 10 : null;
      const topObj = Object.entries(b.objections).sort((x, y) => y[1] - x[1])[0];
      return { name: a.name, callsAnalyzed: b.scores.length, avgScore: avg, topObjection: topObj ? OBJECTION_CATEGORIES[topObj[0]] || topObj[0] : null };
    });

    const payload = {
      agentCount: agents.length,
      overdueFollowUps,
      overdueTasks,
      unrepliedChats,
      teamTopObjection: Object.entries(objectionCounts).sort((a, b) => b[1] - a[1])[0] || null,
      agentStats,
    };

    const system = `Sen tajribali sotuv bo'lim boshlig'i uchun ishlaydigan yordamchisan. Admin/menejerga jamoaning bugungi holatini QISQA va ANIQ, harakatga undovchi tarzda yetkazasan. O'zbek tilida yoz. Faqat berilgan ma'lumotlarga tayan.`;
    const prompt = `Jamoaning bugungi holati (JSON):
${JSON.stringify(payload, null, 1).slice(0, 9000)}

Vazifa:
1. "greeting" — 1 qisqa jumla, jamoaning umumiy holati haqida.
2. "items" — eng muhim 3-6 ta ustuvor masala (priority bilan): overdue eslatma/vazifa/javobsiz chat ko'p bo'lsa shu haqda, yoki aniq bitta agent boshqalardan sezilarli past ball olayotgan bo'lsa ("coaching" turi bilan, o'sha agent nomi bilan) — har biri title (qisqa) + reason (1 jumla, aniq songa asoslangan).
3. "weakSpot" — butun jamoaning eng katta zaif nuqtasi (masalan teamTopObjection asosida yoki past avgScore'li agentlar naqshi asosida): {"title":"...", "detail":"...", "tip":"..."}. Aniq naqsh yo'q bo'lsa null.

FAQAT JSON qaytar:
{"greeting": "...", "items": [...], "weakSpot": {...} | null}`;

    return await this.callClaude(system, prompt, payload, agentStats);
  }

  private async callClaude(system: string, prompt: string, _payload: any, teamStats?: any) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.anthropicModel,
          max_tokens: 1200,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic API xato (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }
      const j: any = await res.json();
      const textBlock = (j?.content || []).find((c: any) => c.type === 'text');
      const raw = textBlock?.text || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('AI javobidan JSON topilmadi');
      let parsed: any;
      try { parsed = JSON.parse(match[0]); } catch { parsed = JSON.parse(this.sanitizeJsonControlChars(match[0])); }

      const items: BriefingItem[] = Array.isArray(parsed.items)
        ? parsed.items.slice(0, 7).map((it: any, i: number) => ({
            priority: Number(it.priority) || i + 1,
            type: ['call_back', 'followup', 'chat_reply', 'task', 'coaching'].includes(it.type) ? it.type : 'task',
            title: String(it.title || '').slice(0, 200),
            reason: String(it.reason || '').slice(0, 300),
            clientName: it.clientName ? String(it.clientName).slice(0, 100) : undefined,
            phone: it.phone ? String(it.phone).slice(0, 30) : undefined,
          }))
        : [];

      return {
        greeting: String(parsed.greeting || '').slice(0, 300) || null,
        items,
        weakSpot: parsed.weakSpot ? {
          title: String(parsed.weakSpot.title || '').slice(0, 100),
          detail: String(parsed.weakSpot.detail || '').slice(0, 300),
          tip: String(parsed.weakSpot.tip || '').slice(0, 300),
        } : null,
        ...(teamStats ? { teamStats } : {}),
      };
    } catch (e: any) {
      this.logger.warn(`Brifing AI xatosi: ${e.message}`);
      return { error: e.message, greeting: null, items: [], weakSpot: null };
    }
  }
}

@ApiTags('Daily Briefing')
@ApiBearerAuth()
@Controller('briefing')
export class BriefingController {
  constructor(private svc: BriefingService) {}

  @ApiOperation({ summary: "Bugungi ustuvorlik — AI kunlik brifing (keshlangan, kuniga 1 marta generatsiya qilinadi)" })
  @Get('today')
  @UseGuards(JwtAuthGuard)
  today(@CurrentUser() u: any) {
    return this.svc.getBriefing(u.tenantId, u.sub, u.role, false);
  }

  @ApiOperation({ summary: "Brifingni qo'lda yangilash (10 daqiqada bir marta ishlaydi)" })
  @Post('refresh')
  @UseGuards(JwtAuthGuard)
  refresh(@CurrentUser() u: any) {
    return this.svc.getBriefing(u.tenantId, u.sub, u.role, true);
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [BriefingController],
  providers: [BriefingService],
  exports: [BriefingService],
})
export class BriefingModule {}