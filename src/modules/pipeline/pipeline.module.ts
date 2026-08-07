import {
  Module, Injectable, Controller,
  Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards,
  NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CronLockService } from '../../common/utils/cron-lock.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { PipelineStage } from '../../prisma-types';;
import { Prisma } from '@prisma/client';
import { swallow } from '../../common/utils/swallow';

// ─── Stage config (no DB changes needed) ─────────────────────────────────────
const STAGE_LABELS_UZ: Record<string, string> = {
  NEW_LEAD: 'Yangi lid', CONTACTED: 'Aloqa o\'rnatildi',
  INTERESTED: 'Qiziqdi', OFFER_SENT: 'Taklif yuborildi',
  NEGOTIATION: 'Muzokara', DEPOSIT_PAID: 'Avans olindi',
  CONFIRMED: 'Tasdiqlandi', TRAVELING: 'Sayohatda',
  COMPLETED: 'Yakunlandi', LOST: 'Yo\'qotildi',
};

const STAGE_COLORS: Record<string, string> = {
  NEW_LEAD: '#6366f1', CONTACTED: '#3b82f6', INTERESTED: '#06b6d4',
  OFFER_SENT: '#8b5cf6', NEGOTIATION: '#a855f7', DEPOSIT_PAID: '#22c55e',
  CONFIRMED: '#10b981', TRAVELING: '#84cc16', COMPLETED: '#64748b', LOST: '#dc2626',
};

const TERMINAL_STAGES = ['COMPLETED', 'LOST'];

// Auto-transitions
const AUTO_TRANSITIONS: Record<string, PipelineStage> = {
  DID_NOT_COME: 'NEGOTIATION', // kelmadi → qayta aloqa (NEGOTIATION maps to follow-up)
};

// v10 stage display names (stored in CustomStage.name via seed)
const V10_STAGE_KEYS: Record<string, string> = {
  'Yangi lid': 'NEW_LEAD',
  'Aloqa o\'rnatildi': 'CONTACTED',
  'Aloqa o\'rnatilmadi': 'INTERESTED', // mapped to INTERESTED
  'Taklif yuborildi': 'OFFER_SENT',
  'Qayta aloqa': 'NEGOTIATION',
  'Offisga chaqirildi': 'DEPOSIT_PAID',
  'Keldi': 'CONFIRMED',
  'Kelmadi': 'TRAVELING',
  'Avans to\'landi': 'DEPOSIT_PAID',
  'To\'landi': 'COMPLETED',
  'Yo\'qotildi': 'LOST',
  'Sayohatga ketuvchilar': 'CONFIRMED',
  'Sayohatdagilar': 'TRAVELING',
  'Sayohatdan qaytganlar': 'COMPLETED',
};

@Injectable()
export class PipelineService {
  private readonly logger = new Logger('Pipeline');
  constructor(private prisma: PrismaService,
    // v12.7: cron qulfi (ko'p instansda takrorlanmasin)
    private readonly cronLock: CronLockService,
  ) {}

  // v36 FIX: "Sotildi"/"Yo'qotildi" kabi belgilangan (isClosing/isLost)
  // bosqichlar har doim ro'yxat OXIRIDA ko'rinishi kerak — bu HAR BIR
  // pipeline (presale, postsale, custom — nomidan qat'iy nazar) uchun amal
  // qiladi. Bazadagi `order` qiymati eski/noto'g'ri bo'lib qolgan bo'lsa ham
  // (masalan avval xato bilan qo'shilgan bosqichlar), bu funksiya ko'rinishni
  // har doim to'g'rilab beradi — DB'ni qo'lda tuzatish shart emas.
  private sortStagesFixedLast(stages: any[]): any[] {
    return [...(stages || [])].sort((a: any, b: any) => {
      const af = (a.isClosing || a.isLost) ? 1 : 0;
      const bf = (b.isClosing || b.isLost) ? 1 : 0;
      if (af !== bf) return af - bf;
      return a.order - b.order;
    });
  }

  // ─── v34 FIX: har bir tenant uchun ANIQ bitta "default" (kirish) pipeline
  // kafolatlanadi ─────────────────────────────────────────────────────────
  // MUAMMO EDI: agentlik o'z voronkasini o'ziga moslab tahrirlaganda (nom
  // o'zgartirish/yangi pipeline yaratish) hech qanday joyda `isDefault: true`
  // qo'yilmas edi (createPipeline har doim isDefault:false yozadi). Natijada
  // getBoard() bu pipelineni "default" deb tanimay qoldi va yangi
  // lead/mijozlar hech qaysi ustunga (hatto birinchisiga ham) tushmay,
  // pipeline bo'sh ko'rinardi — garchi "Mijozlar" ro'yxatida bor bo'lsada.
  // Bu funksiya har chaqirilganda avtomatik davolaydi: agar tenantda
  // isDefault=true pipeline bo'lmasa — eng birinchi (eng eski) pipeline
  // shunday deb belgilanadi; umuman pipeline bo'lmasa — standart bosqichlar
  // bilan yangisi yaratiladi. Shu tufayli qo'lda DB'ga kirib tuzatish shart
  // emas — muammo o'z-o'zidan tuzaladi.
  async ensureDefaultPipeline(tenantId: string) {
    let pipeline: any = await this.prisma.pipeline.findFirst({
      where: { tenantId, isDefault: true },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (pipeline) return pipeline;

    const oldest = await this.prisma.pipeline.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (oldest) {
      await this.prisma.pipeline.update({ where: { id: oldest.id }, data: { isDefault: true } });
      this.logger.log(`[PIPELINE HEAL] Tenant ${tenantId}: "${oldest.name}" default deb belgilandi`);
      return { ...oldest, isDefault: true };
    }

    // Tenantda umuman pipeline yo'q — standart bosqichlar bilan yaratamiz.
    const created: any = await this.createPipeline(tenantId, { name: 'Sotuvgacha', pipelineType: 'NEW_SALE' });
    await this.prisma.pipeline.update({ where: { id: created.id }, data: { isDefault: true } });
    return { ...created, isDefault: true };
  }

  // Yangi lead/mijoz yaratilganda qaysi pipeline/bosqichga tushishi kerakligini
  // aniqlaydi (nomlar qanday bo'lishidan qat'iy nazar — har doim tenantning
  // ANIQLANGAN default pipelinesining BIRINCHI bosqichi).
  async getEntryStage(tenantId: string): Promise<{ pipelineId: string; stageId: string | null }> {
    const pl = await this.ensureDefaultPipeline(tenantId);
    const first = this.sortStagesFixedLast(pl.stages || [])[0];
    return { pipelineId: pl.id, stageId: first?.id || null };
  }

  // Klient profilida (mijozga kirganda) ko'rsatiladigan bosqich ro'yxati —
  // agentlik voronkasini qanday tahrirlagan bo'lsa, ANIQ o'sha ro'yxat
  // qaytariladi (frontendda qattiq kodlangan/eskirgan ro'yxat emas).
  async getClientPipelineStages(tenantId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException('Klient topilmadi');

    let pipeline: any = null;
    if ((client as any).customStageId) {
      const cs = await this.prisma.customStage.findFirst({
        where: { id: (client as any).customStageId, tenantId },
        include: { pipeline: { include: { stages: { orderBy: { order: 'asc' } } } } },
      });
      pipeline = cs?.pipeline || null;
    }
    if (!pipeline) pipeline = await this.ensureDefaultPipeline(tenantId);

    const stages = (pipeline.stages || []).map((s: any) => ({
      key: `CUSTOM_${s.id}`, id: s.id, name: s.name, color: s.color,
      isClosing: s.isClosing, isLost: s.isLost,
    }));

    let currentKey: string | null = (client as any).customStageId ? `CUSTOM_${(client as any).customStageId}` : null;
    if (!currentKey) {
      // Eski/legacy mijoz — customStageId hali qo'yilmagan. Nomi bo'yicha
      // shu pipeline ichidan moslashtirishga harakat qilamiz, topilmasa
      // birinchi bosqichga tushadi (deb ko'rsatiladi — bosilsa haqiqatan
      // ham o'sha bosqichga o'tkaziladi).
      const match = (pipeline.stages || []).find((s: any) => V10_STAGE_KEYS[s.name] === (client as any).pipelineStage);
      currentKey = match ? `CUSTOM_${match.id}` : (stages[0]?.key || (client as any).pipelineStage);
    }

    return {
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      stages,
      currentKey,
    };
  }

  // ─── Pipeline list (works with existing DB) ────────────────────────────────
  async listPipelines(tenantId: string) {
    await this.ensureDefaultPipeline(tenantId); // v34: default belgisini davolaydi
    const pipelines = await this.prisma.pipeline.findMany({
      where: { tenantId },
      include: { stages: { orderBy: { order: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    // Add pipelineType based on isDefault flag (renaming a pipeline no longer breaks this)
    return pipelines.map(pl => ({
      ...pl,
      pipelineType: pl.isDefault ? 'NEW_SALE' : 'POST_SALE',
      color: pl.isDefault ? '#3d7eff' : '#10b981',
    }));
  }

  // ─── Create pipeline (NO pipelineType column) ─────────────────────────────
  async createPipeline(tenantId: string, data: { name: string; pipelineType?: string; color?: string }) {
    const isPost = data.pipelineType === 'POST_SALE';
    
    const pl = await this.prisma.pipeline.create({
      data: {
        tenantId,
        name: data.name,
        isDefault: false,
      },
    });

    // Create stages
    const stages = isPost ? [
      { name: 'Sayohatga ketuvchilar', color: '#6366f1', order: 1 },
      { name: 'Sayohatdagilar',        color: '#10b981', order: 2 },
      { name: 'Sayohatdan qaytganlar', color: '#8b5cf6', order: 3, isClosing: true },
    ] : [
      { name: 'Yangi lid',           color: '#6366f1', order: 1 },
      { name: 'Aloqa o\'rnatildi',   color: '#3b82f6', order: 2 },
      { name: 'Aloqa o\'rnatilmadi', color: '#f97316', order: 3 },
      { name: 'Taklif yuborildi',    color: '#8b5cf6', order: 4 },
      { name: 'Qayta aloqa',         color: '#06b6d4', order: 5 },
      { name: 'Offisga chaqirildi',  color: '#f59e0b', order: 6 },
      { name: 'Keldi',               color: '#10b981', order: 7 },
      { name: 'Kelmadi',             color: '#ef4444', order: 8 },
      { name: 'Avans to\'landi',     color: '#22c55e', order: 9 },
      { name: 'To\'landi',           color: '#16a34a', order: 10, isClosing: true },
      { name: 'Yo\'qotildi',         color: '#dc2626', order: 11, isLost: true },
    ];

    // v12.9: 12 ta alohida INSERT o'rniga bitta so'rov.
    // Bu yangi agentlik yaratilganda ishlaydi — 12 marta bazaga
    // borish o'rniga bir marta boriladi.
    await this.prisma.customStage.createMany({
      data: stages.map((s: any) => ({
        tenantId,
        pipelineId: pl.id,
        name: s.name,
        color: s.color,
        order: s.order,
        isClosing: s.isClosing || false,
        isLost: s.isLost || false,
      })),
    });

    return this.prisma.pipeline.findUnique({
      where: { id: pl.id },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
  }

  async updatePipeline(tenantId: string, id: string, data: any) {
    const pl = await this.prisma.pipeline.findFirst({ where: { id, tenantId } });
    if (!pl) throw new NotFoundException('Pipeline topilmadi');
    return this.prisma.pipeline.update({ where: { id }, data: { name: data.name || pl.name } });
  }

  async deletePipeline(tenantId: string, id: string) {
    const pl = await this.prisma.pipeline.findFirst({ where: { id, tenantId } });
    if (!pl) throw new NotFoundException('Pipeline topilmadi');
    if (pl.isDefault) throw new BadRequestException('Default pipeline o\'chirilmaydi');
    await this.prisma.pipeline.delete({ where: { id } });
    return { success: true };
  }

  // ─── Board (original logic + custom stages by pipeline) ───────────────────
  async getBoard(tenantId: string, userId: string, role: string, agentId?: string, pipelineId?: string) {
    const where: any = { tenantId, status: 'ACTIVE' };
    if (role === 'AGENT') where.assignedAgentId = userId;
    else if (agentId) where.assignedAgentId = agentId;

    const rawClients = await this.prisma.client.findMany({
      where,
      include: {
        assignedAgent: { select: { id: true, name: true, avatarUrl: true } },
        _count: { select: { bookings: true, conversations: true, calls: true } },
      },
      orderBy: { pipelineStageAt: 'desc' },
      take: 500,
    });

    // Yo'qotilgan (LOST) leadlar bosqichga tushgandan keyin 2 kun davomida
    // pipelineda ko'rinib turadi (agentga ko'rish/qayta ko'rib chiqish uchun),
    // shundan keyin avtomatik ravishda umumiy pipelinedan yo'qoladi va faqat
    // "Yo'qotilgan leadlar" arxivida (getLostLeads) qoladi — bo'lmasa lidlar
    // to'planib, odamni chalg'itadi.
    const LOST_VISIBLE_MS = 2 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const clients = rawClients.filter((c: any) => {
      if (c.pipelineStage !== 'LOST') return true;
      const enteredAt = new Date(c.pipelineStageAt).getTime();
      return now - enteredAt < LOST_VISIBLE_MS;
    });

    // If specific pipeline requested - show its custom stages
    if (pipelineId) {
      const pipeline = await this.prisma.pipeline.findFirst({
        where: { id: pipelineId, tenantId },
        include: { stages: { orderBy: { order: 'asc' } } },
      });
      if (!pipeline) throw new NotFoundException('Pipeline topilmadi');

      // v34 FIX: pipeline.isDefault ustuniga ko'r-ko'rona ishonmaymiz — u
      // hech qachon to'g'ri qo'yilmagan bo'lishi mumkin (aynan shu sabab
      // pipeline "bo'sh" ko'rinardi). ensureDefaultPipeline avtomatik
      // davolaydi va ANIQ default pipelineni qaytaradi; shu bilan solishtirib
      // aniqlaymiz.
      const healedDefault = await this.ensureDefaultPipeline(tenantId);
      const isDefaultPipeline = pipeline.id === healedDefault.id;

      // Faqat DEFAULT (sotuvgacha) pipeline "kelib tushgan" lidlarni o'ziga
      // tortadi va bosqich NOMI orqali global enum'ga moslashtiradi. Boshqa
      // (post-sale/custom) voronkalar lidni faqat customStageId to'g'ri
      // mos kelganda ko'rsatadi — status/nom qanday bo'lishidan qat'iy nazar.

      // v36 FIX: ustunlar tartibi ham "isClosing/isLost — har doim oxirida"
      // qoidasiga bo'ysunishi kerak (kanban ko'rinishida ham, modal ro'yxatida
      // ham bir xil tartib bo'lishi uchun).
      const orderedStages = this.sortStagesFixedLast(pipeline.stages || []);
      const columns = orderedStages.map((stage: any) => {
        // Map stage name to PipelineStage enum value
        const stageEnumKey = V10_STAGE_KEYS[stage.name] || null;
        const isFirstStage = orderedStages[0]?.id === stage.id;
        const stageClients = clients.filter((c: any) => {
          // Lid biror maxsus bosqichda (customStageId) tursa — faqat o'sha
          // aniq ID mos kelgan ustunda ko'rinadi. Eski/qoldiq pipelineStage
          // qiymati (masalan avvalgi "COMPLETED") boshqa voronkada uni
          // qayta chiqarib yubormasligi uchun bu tekshiruv birinchi turadi.
          if (c.customStageId) return c.customStageId === stage.id;
          if (isDefaultPipeline && stageEnumKey) return c.pipelineStage === stageEnumKey;
          // First column catches unmatched/new leads — faqat DEFAULT pipelineda.
          if (isDefaultPipeline && isFirstStage && (c.pipelineStage === 'NEW_LEAD' || !clients.some((cl: any) =>
            (pipeline.stages || []).some((s: any) => {
              const k = V10_STAGE_KEYS[s.name];
              return cl.id === c.id && (k && cl.pipelineStage === k);
            })
          ))) return true;
          return false;
        });
        return {
          stage: {
            ...stage,
            stageKey: stageEnumKey || `CUSTOM_${stage.id}`,
            label: stage.name,
          },
          clients: stageClients.map((c: any) => this.mapClient(c)),
          count: stageClients.length,
        };
      });

      // Add pipelineType based on isDefault flag (nom o'zgarsa ham buzilmaydi)
      const pipelineType = isDefaultPipeline ? 'NEW_SALE' : 'POST_SALE';
      return { pipeline: { ...pipeline, pipelineType, color: pipeline.isDefault ? '#3d7eff' : '#10b981' }, columns };
    }

    // Default board: original ALL_STAGES logic
    const ALL_STAGES: PipelineStage[] = [
      'NEW_LEAD', 'CONTACTED', 'INTERESTED', 'OFFER_SENT',
      'NEGOTIATION', 'DEPOSIT_PAID', 'CONFIRMED', 'TRAVELING',
      'COMPLETED', 'LOST',
    ];

    const stages = ALL_STAGES.map((stage) => ({
      stage,
      label: STAGE_LABELS_UZ[stage] || stage,
      color: STAGE_COLORS[stage] || '#64748b',
      isClosing: TERMINAL_STAGES.includes(stage),
      stageKey: stage,
      // Lid customStageId'ga ega bo'lsa (maxsus/post-sale bosqichda), eski
      // pipelineStage qiymati orqali bu yerda qayta chiqib qolmasligi kerak.
      clients: clients.filter((c: any) => !c.customStageId && c.pipelineStage === stage).map((c) => this.mapClient(c)),
      count: 0,
      totalValue: 0,
    }));

    for (const s of stages) {
      s.count = s.clients.length;
      (s as any).totalValue = s.clients.reduce((sum: number, c: any) => sum + (c.totalRevenue || 0), 0);
    }

    // Add custom stages
    try {
      const customStages = await this.prisma.customStage.findMany({
        where: { tenantId },
        orderBy: { order: 'asc' },
        include: { pipeline: { select: { isDefault: true } } },
      });
      for (const cs of customStages as any[]) {
        // Faqat DEFAULT pipelinega tegishli bosqichlar nom orqali global
        // enum'ga moslanadi (nom to'qnashuvi boshqa voronkalardan lid
        // tortib chiqarmasin uchun); boshqalari faqat o'z ID'si bilan.
        const isDefaultPipelineStage = !!cs.pipeline?.isDefault;
        const stageEnumKey = isDefaultPipelineStage ? V10_STAGE_KEYS[cs.name] : null;
        const csClients = clients.filter((c: any) =>
          c.customStageId === cs.id ||
          (!c.customStageId && stageEnumKey && c.pipelineStage === stageEnumKey)
        ).map((c: any) => this.mapClient(c));
        (stages as any[]).push({
          stage: `CUSTOM_${cs.id}`,
          customStageId: cs.id,
          stageKey: stageEnumKey || `CUSTOM_${cs.id}`,
          label: cs.name,
          color: cs.color,
          isClosing: cs.isClosing,
          clients: csClients,
          count: csClients.length,
          totalValue: csClients.reduce((s: number, c: any) => s + (c.totalRevenue || 0), 0),
          isCustom: true,
        });
      }
    } catch (e) {
      // ignore
    }

    return { stages };
  }

  // ─── Yo'qotilgan leadlar arxivi ─────────────────────────────────────────────
  // Umumiy pipeline/dashboardda ko'rinmaydigan, lekin butunlay saqlanadigan
  // LOST leadlar ro'yxati. Agentlar maxsus shu yerga kirib ishlashi mumkin.
  async getLostLeads(tenantId: string, userId: string, role: string, agentId?: string) {
    const where: any = { tenantId, pipelineStage: 'LOST' };
    if (role === 'AGENT') where.assignedAgentId = userId;
    else if (agentId) where.assignedAgentId = agentId;

    const clients = await this.prisma.client.findMany({
      where,
      include: {
        assignedAgent: { select: { id: true, name: true, avatarUrl: true } },
        _count: { select: { bookings: true, conversations: true, calls: true } },
      },
      orderBy: { pipelineStageAt: 'desc' },
      take: 500,
    });

    return {
      count: clients.length,
      clients: clients.map((c: any) => ({ ...this.mapClient(c), lostReason: c.lostReason })),
    };
  }

  private mapClient(c: any) {
    // Travel info stored in preferences JSON
    const prefs = c.preferences || {};
    return {
      id: c.id,
      fullName: c.fullName,
      phone: c.phone,
      tier: c.tier,
      leadScore: c.leadScore,
      source: c.source,
      assignedAgent: c.assignedAgent,
      stageEnteredAt: c.pipelineStageAt,
      customStageId: c.customStageId || null,
      daysInStage: Math.floor((Date.now() - new Date(c.pipelineStageAt).getTime()) / 86400000),
      tags: c.tags,
      totalRevenue: c.totalRevenue,
      noContactAttempts: prefs.noContactAttempts || 0,
      nextCallAt: prefs.nextCallAt || null,
      travelDepartDate: prefs.travelDepartDate || null,
      travelDestination: prefs.travelDestination || null,
      bookingsCount: c._count.bookings,
      messagesCount: c._count.conversations,
      callsCount: c._count.calls,
      lastContactAt: c.lastContactAt,
    };
  }

  // ─── Move stage ────────────────────────────────────────────────────────────
  async moveStage(tenantId: string, userId: string, role: string, clientId: string, data: {
    stage: string; note?: string; lostReason?: string; lostReasonDetail?: string;
  }) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException('Klient topilmadi');

    // v33.2: CUSTOM_<id> — maxsus bosqich. pipelineStage ENUM bo'lgani uchun
    // bunday satrni to'g'ridan-to'g'ri yozib bo'lmaydi (Prisma validatsiya
    // xatosi beradi) — shu sabab avval bu funksiya ham amalda ishlamas edi.
    // Endi alohida customStageId ustuniga yoziladi; pipelineStage ENUM bosqichga
    // o'tilganda customStageId tozalanadi (aksincha — eski qiymatida qoladi,
    // hisobot/filtrlar buzilmasin uchun).
    const toStage = data.stage;
    const isCustomStage = toStage.startsWith('CUSTOM_');
    const updateData: any = { pipelineStageAt: new Date() };
    if (isCustomStage) {
      updateData.customStageId = toStage.slice('CUSTOM_'.length);
    } else {
      updateData.pipelineStage = toStage as any;
      updateData.customStageId = null;
    }
    // lostReason exists in original schema
    if ((toStage === 'LOST' || toStage.includes('LOST')) && data.lostReason) {
      updateData.lostReason = data.lostReason as any;
    }

    // noContactAttempts stored in preferences JSON (no schema change)
    if (toStage === 'INTERESTED') { // INTERESTED = "Aloqa o'rnatilmadi"
      const prefs = (client as any).preferences || {};
      prefs.noContactAttempts = 0;
      prefs.nextCallAt = new Date(Date.now() + 24 * 3600000).toISOString();
      prefs.callReminded = false; // yangi muddat — eslatma qayta yuborilishi mumkin
      updateData.preferences = prefs;
    }

    await this.prisma.client.update({ where: { id: clientId }, data: updateData });

    // Timeline entry
    await this.prisma.clientTimeline.create({
      data: {
        clientId, userId, type: 'stage_change',
        title: `Bosqich: ${client.pipelineStage} → ${toStage}`,
        description: data.note || null,
        metadata: { from: client.pipelineStage, to: toStage, lostReasonDetail: data.lostReasonDetail },
      } as any,
    }).catch(swallow('mijoz tarixi'));

    // Auto-transition: 'TRAVELING' (Kelmadi) → NEGOTIATION (Qayta aloqa)
    if (toStage === ('TRAVELING' as any)) {
      setTimeout(async () => {
        try {
          await this.prisma.client.update({
            where: { id: clientId },
            data: { pipelineStage: 'NEGOTIATION', pipelineStageAt: new Date() },
          });
        } catch {}
      }, 3000);
    }

    // Auto-transition: sotuvgacha bo'lgan (default) voronkaning yopiluvchi
    // bosqichiga (masalan "To'landi" / COMPLETED) yetgan lid avtomatik
    // ravishda sotuvdan keyingi (POST_SALE) voronkaning birinchi bosqichiga
    // (customStageId orqali) ko'chiriladi.
    await this.maybeAdvanceToPostSalePipeline(tenantId, clientId, toStage);

    return this.prisma.client.findUnique({ where: { id: clientId } });
  }

  // ─── Sotuv yopilganda: pre-sale → post-sale voronkaga avtomatik ko'chirish ──
  // v35 FIX: ilgari faqat DEFAULT pipelinening isClosing bosqichi (asl seed
  // orqali "To'landi"ga qo'yilgan bayroq) ishlar edi. Lekin admin UI orqali
  // o'zi qo'shgan bosqichlarda (masalan "Sold") isClosing belgilash imkoni
  // umuman yo'q edi — shuning uchun "Sold"ga o'tkazilgan lead hech qachon
  // keyingi voronkaga o'tmasdi. Endi:
  //   1) updateCustomStage orqali istalgan bosqichni "yopiluvchi" deb
  //      belgilash mumkin (frontendda checkbox qo'shildi);
  //   2) agar pipelineda birorta bosqich ham ANIQ isClosing deb
  //      belgilanmagan bo'lsa — o'sha pipelinening ENG OXIRGI (eng katta
  //      order, isLost bo'lmagan) bosqichi avtomatik "yopiluvchi" deb
  //      hisoblanadi (admin hech narsa sozlamasa ham ishlashi uchun);
  //   3) "keyingi voronka" endi tasodifiy pipeline emas — xuddi shu
  //      pipelinedan KEYIN yaratilgan (createdAt bo'yicha) ENG YAQIN
  //      pipeline tanlanadi (bir nechta post-sale voronka bo'lsa ham,
  //      "navbatdagisi"ga tushadi).
  private async maybeAdvanceToPostSalePipeline(tenantId: string, clientId: string, toStage: string) {
    try {
      if (!toStage.startsWith('CUSTOM_') && toStage !== 'COMPLETED') return;

      let sourcePipeline: any = null;
      let dealWon = false;

      if (toStage.startsWith('CUSTOM_')) {
        const stageId = toStage.slice('CUSTOM_'.length);
        const cs = await this.prisma.customStage.findFirst({
          where: { id: stageId, tenantId },
          include: { pipeline: { include: { stages: { orderBy: { order: 'asc' } } } } },
        });
        if (!cs || !cs.pipeline) return;
        sourcePipeline = cs.pipeline;

        if (cs.isLost) {
          dealWon = false;
        } else if (cs.isClosing) {
          dealWon = true;
        } else {
          // Hech qaysi bosqich aniq isClosing deb belgilanmaganmi? Bo'lsa,
          // shu pipelinening eng oxirgi (isLost bo'lmagan) bosqichini
          // "yopiluvchi" deb hisoblaymiz.
          const stages = (sourcePipeline.stages || []).filter((s: any) => !s.isLost);
          const anyExplicit = stages.some((s: any) => s.isClosing);
          if (!anyExplicit && stages.length) {
            const maxOrder = Math.max(...stages.map((s: any) => s.order));
            dealWon = cs.order === maxOrder;
          }
        }
      } else if (toStage === 'COMPLETED') {
        dealWon = true;
        sourcePipeline = await this.ensureDefaultPipeline(tenantId);
      }

      if (!dealWon || !sourcePipeline) return;

      // "Keyingi" voronka — xuddi shu pipelinedan KEYIN yaratilgan eng yaqin
      // pipeline (tenant ichida, shu pipelinedan boshqa).
      const nextPipeline = await this.prisma.pipeline.findFirst({
        where: { tenantId, id: { not: sourcePipeline.id }, createdAt: { gt: sourcePipeline.createdAt } },
        orderBy: { createdAt: 'asc' },
        include: { stages: { orderBy: { order: 'asc' } } },
      });
      if (!nextPipeline || !nextPipeline.stages?.length) return;

      const firstStage = this.sortStagesFixedLast(nextPipeline.stages)[0];
      await this.prisma.client.update({
        where: { id: clientId },
        data: { customStageId: firstStage.id, pipelineStageAt: new Date() },
      });

      await this.prisma.clientTimeline.create({
        data: {
          clientId, userId: null, type: 'stage_change',
          title: `Sotuv yakunlandi → "${nextPipeline.name}" voronkasiga o'tkazildi`,
          description: `Bosqich: ${firstStage.name}`,
          metadata: { from: toStage, to: `CUSTOM_${firstStage.id}`, auto: true },
        } as any,
      }).catch(swallow('mijoz tarixi'));
    } catch (e) {
      this.logger.warn(`Post-sale auto-transition xatosi: ${e}`);
    }
  }

  // ─── Call attempts (stored in preferences JSON) ────────────────────────────
  async recordCallAttempt(tenantId: string, agentId: string, clientId: string, data: {
    outcome: string; note?: string; nextCallAt?: string;
  }) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException('Klient topilmadi');

    const prefs: any = (client as any).preferences || {};
    const attempts = (prefs.noContactAttempts || 0) + 1;
    const nextCallAt = data.nextCallAt || new Date(Date.now() + 24 * 3600000).toISOString();

    prefs.noContactAttempts = attempts;
    prefs.nextCallAt = nextCallAt;
    prefs.callReminded = false; // yangi muddat — eslatma qayta yuborilishi mumkin
    prefs.lastCallOutcome = data.outcome;
    if (!prefs.callHistory) prefs.callHistory = [];
    prefs.callHistory.push({ attemptNo: attempts, outcome: data.outcome, note: data.note, at: new Date().toISOString() });

    const updateData: any = { preferences: prefs };
    if (attempts >= 6 && data.outcome === 'NO_ANSWER') {
      updateData.pipelineStage = 'LOST';
      updateData.lostReason = 'NO_RESPONSE';
      updateData.pipelineStageAt = new Date();
    }

    await this.prisma.client.update({ where: { id: clientId }, data: updateData });

    // Create task for next call
    if (attempts < 6) {
      await this.prisma.task.create({
        data: {
          tenantId, creatorId: agentId, assigneeId: agentId, clientId,
          title: `${(client as any).fullName}ga qo'ng'iroq (${attempts}/6)`,
          priority: 'HIGH', status: 'TODO', dueAt: new Date(nextCallAt),
        } as any,
      }).catch(swallow('yozuv yaratish'));
      // Notification
      await this.prisma.notification.create({
        data: {
          tenantId, userId: agentId, type: 'CALL_REMINDER' as any,
          title: `${(client as any).fullName}ga qo'ng'iroq (${attempts}/6)`,
          body: `Keyingi: ${new Date(nextCallAt).toLocaleDateString('uz-UZ')}`,
          link: `/clients/${clientId}`, metadata: {},
        } as any,
      }).catch(swallow('bildirishnoma'));
    }

    return { attempts, nextCallAt, outcome: data.outcome };
  }

  // ─── Custom stages CRUD (original schema - no stageKey) ───────────────────
  async getCustomStages(tenantId: string, pipelineId?: string) {
    const where: any = { tenantId };
    if (pipelineId) where.pipelineId = pipelineId;
    const stages = await this.prisma.customStage.findMany({ where, orderBy: { order: 'asc' } });
    return this.sortStagesFixedLast(stages);
  }

  async createCustomStage(tenantId: string, data: {
    name: string; color?: string; order?: number; isClosing?: boolean; pipelineId?: string;
  }) {
    let pipelineId = data.pipelineId;
    if (!pipelineId) {
      let pl = await this.prisma.pipeline.findFirst({ where: { tenantId, isDefault: true } });
      if (!pl) pl = await this.prisma.pipeline.findFirst({ where: { tenantId } });
      if (!pl) throw new BadRequestException('Pipeline topilmadi');
      pipelineId = pl.id;
    }
    const all = await this.prisma.customStage.findMany({
      where: { tenantId, pipelineId },
      orderBy: { order: 'asc' },
    });

    let order = data.order;
    if (order == null) {
      // v36 FIX: yangi bosqich ilgari ro'yxat OXIRIGA (masalan "Yo'qotildi"dan
      // ham keyin) qo'shilardi. "Sotildi" / "Yo'qotildi" kabi yopiluvchi
      // (isClosing) yoki yo'qotilgan (isLost) bosqichlar HAR DOIM oxirida
      // turishi kerak — shuning uchun yangi bosqich ana shu belgilangan
      // bosqichlar guruhidan OLDIN qo'yiladi, nechta marta qo'shilishidan
      // qat'i nazar (har safar ular oldiga suriladi).
      const fixed = all.filter((s: any) => s.isClosing || s.isLost);
      if (fixed.length) {
        const insertAt = Math.min(...fixed.map((s: any) => s.order));
        order = insertAt;
        // insertAt va undan keyingi hamma bosqichlarni bittaga suramiz
        await Promise.all(
          all
            .filter((s: any) => s.order >= insertAt)
            .map((s: any) => this.prisma.customStage.update({
              where: { id: s.id },
              data: { order: s.order + 1 },
            })),
        );
      } else {
        const last = all[all.length - 1];
        order = (last?.order ?? 0) + 1;
      }
    }

    return this.prisma.customStage.create({
      data: {
        tenantId, pipelineId, name: data.name,
        color: data.color || '#3d7eff',
        order,
        isClosing: data.isClosing || false,
      },
    });
  }

  async updateCustomStage(tenantId: string, id: string, data: any) {
    const s = await this.prisma.customStage.findFirst({ where: { id, tenantId } });
    if (!s) throw new NotFoundException();
    // v35 FIX: ilgari isClosing/isLost bayroqlari e'tiborga olinmas edi —
    // shu sabab admin UI'dan bosqichni "yopiluvchi" deb belgilay olmasdi.
    return this.prisma.customStage.update({
      where: { id },
      data: {
        name: data.name ?? s.name,
        color: data.color ?? s.color,
        order: data.order ?? s.order,
        isClosing: typeof data.isClosing === 'boolean' ? data.isClosing : s.isClosing,
        isLost: typeof data.isLost === 'boolean' ? data.isLost : s.isLost,
      },
    });
  }

  async deleteCustomStage(tenantId: string, id: string) {
    const s = await this.prisma.customStage.findFirst({ where: { id, tenantId } });
    if (!s) throw new NotFoundException();
    // v36 FIX: "Yo'qotildi" (isLost) bosqichi frontendda o'chirish tugmasi
    // ko'rsatilmasa ham, backend uni himoya qilmasdi — API orqali to'g'ridan
    // to'g'ri o'chirib bo'lardi. Endi isClosing bilan bir xil himoyalangan.
    if (s.isClosing || s.isLost) throw new BadRequestException('Bu bosqich o\'chirilmaydi');
    await this.prisma.customStage.delete({ where: { id } });
    return { success: true };
  }

  async reorderCustomStages(tenantId: string, orderedIds: string[]) {
    // v36 FIX: qo'lda qayta tartiblashda ham "isClosing/isLost — har doim
    // oxirida" qoidasi buzilmasligi kerak — kimdir tasodifan "Sotildi"ni
    // o'rtaga tashlab qo'ymasin.
    const stages: any[] = await this.prisma.customStage.findMany({ where: { tenantId, id: { in: orderedIds } } });
    const byId = new Map<string, any>(stages.map((s: any) => [s.id, s]));
    const requestedOrder = orderedIds.filter((id) => byId.has(id));
    const normal = requestedOrder.filter((id) => !(byId.get(id).isClosing || byId.get(id).isLost));
    const fixed = requestedOrder.filter((id) => byId.get(id).isClosing || byId.get(id).isLost);
    const finalOrder = [...normal, ...fixed];
    await Promise.all(finalOrder.map((id, i) =>
      this.prisma.customStage.updateMany({ where: { id, tenantId }, data: { order: i + 1 } })
    ));
    // v37 FIX: ilgari bu yerda pipelineId berilmagani uchun getCustomStages
    // TENANTNING BARCHA pipelinelaridagi bosqichlarni aralashtirib
    // qaytarardi (masalan Presale'ni tartiblaganda javobda Postsale
    // bosqichlari ham chiqib, frontendda ro'yxat buzilib ketardi). Endi
    // qayta tartiblanayotgan bosqichlarning O'ZINING pipelineId'si orqali
    // faqat O'SHA pipeline bosqichlari qaytariladi.
    const pipelineId = stages[0]?.pipelineId;
    return this.getCustomStages(tenantId, pipelineId);
  }

  async getHistory(tenantId: string, clientId: string) {
    // XAVFSIZLIK (v12.6): ilgari `tenantId` qabul qilinardi, lekin
    // ISHLATILMAS edi — so'rov faqat clientId bo'yicha ketardi.
    // Ya'ni boshqa agentlikning clientId'si yuborilsa, uning pipeline
    // tarixi ko'rinardi (cross-tenant sizish).
    //
    // StageHistory'da tenantId ustuni yo'q, shuning uchun bog'langan
    // Client orqali filtrlaymiz — bu bitta so'rovda hal bo'ladi.
    return this.prisma.stageHistory.findMany({
      where: { clientId, client: { tenantId } },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async analytics(tenantId: string) {
    const groups = await this.prisma.client.groupBy({
      by: ['pipelineStage'],
      where: { tenantId, status: 'ACTIVE' },
      _count: { id: true },
    });
    return { stageDistribution: groups };
  }

  async bulkMove(tenantId: string, userId: string, clientIds: string[], stage: string) {
    await this.prisma.client.updateMany({
      where: { id: { in: clientIds }, tenantId },
      data: { pipelineStage: stage as PipelineStage, pipelineStageAt: new Date() },
    });
    return { updated: clientIds.length };
  }

  // ─── CRON: Travel notifications (reads from preferences JSON) ─────────────
  @Cron(CronExpression.EVERY_HOUR)
  async travelNotifications() {
    // v12.7: bir nechta instansda TAKROR bajarilmasin —
    // qulfni birinchi olgan instans bajaradi, qolganlari o'tkazadi.
    await this.cronLock.runOnce('travel-notify', 3000, async () => {
      const now = new Date();

      // Find clients with travel info in preferences
      const travelingClients = await this.prisma.client.findMany({
        where: {
          pipelineStage: { in: ['CONFIRMED', 'TRAVELING'] as PipelineStage[] },
          status: 'ACTIVE',
        },
        take: 100,
      });

      for (const c of travelingClients) {
        const prefs: any = (c as any).preferences || {};
        if (!prefs.travelDepartDate || !(c as any).assignedAgentId) continue;

        const depart = new Date(prefs.travelDepartDate);
        const diff = depart.getTime() - now.getTime();

        // 1 day before departure
        if (diff > 0 && diff < 25 * 3600000 && !prefs.departureNotified) {
          await this.prisma.notification.create({
            data: {
              tenantId: c.tenantId, userId: (c as any).assignedAgentId,
              type: 'STAGE_CHANGED' as any,
              title: `${(c as any).fullName} ertaga sayohatga ketadi!`,
              body: 'Omadli yo\'l tiling.', link: `/clients/${c.id}`, metadata: {},
            } as any,
          }).catch(swallow('bildirishnoma'));
          await this.prisma.task.create({
            data: {
              tenantId: c.tenantId, creatorId: (c as any).assignedAgentId,
              assigneeId: (c as any).assignedAgentId, clientId: c.id,
              title: `${(c as any).fullName}ga omadli yo'l tiling`,
              priority: 'HIGH', status: 'TODO', dueAt: depart,
            } as any,
          }).catch(swallow('yozuv yaratish'));
          // Mark notified
          await this.prisma.client.update({
            where: { id: c.id },
            data: { preferences: { ...prefs, departureNotified: true } } as any,
          }).catch(swallow('yangilash'));
        }
      }

      // Callback reminders (nextCallAt in preferences)
      const noContactClients = await this.prisma.client.findMany({
        where: { pipelineStage: 'INTERESTED', status: 'ACTIVE' },
        take: 100,
      });

      for (const c of noContactClients) {
        const prefs: any = (c as any).preferences || {};
        if (!prefs.nextCallAt || !(c as any).assignedAgentId) continue;
        // v12.9: eslatma faqat BIR MARTA yuboriladi — agent yangi urinish
        // qayd etib (recordCallAttempt) yoki bosqichni qayta INTERESTED
        // qilib nextCallAt yangilagunicha qayta yuborilmaydi. Aks holda
        // har soat bir xil eslatma cheksiz takrorlanaverar edi.
        if (prefs.callReminded) continue;
        if (new Date(prefs.nextCallAt) <= now) {
          await this.prisma.notification.create({
            data: {
              tenantId: c.tenantId, userId: (c as any).assignedAgentId,
              type: 'FOLLOWUP_DUE' as any,
              title: `${(c as any).fullName}ga qo'ng'iroq vaqti!`,
              body: `${(prefs.noContactAttempts || 0) + 1}/6 urinish`,
              link: `/clients/${c.id}`, metadata: {},
            } as any,
          }).catch(swallow('bildirishnoma'));
          await this.prisma.client.update({
            where: { id: c.id },
            data: { preferences: { ...prefs, callReminded: true } } as any,
          }).catch(swallow('yangilash'));
        }
      }
      });
}

  // Task deadline reminders (every 5 min)
  @Cron('*/5 * * * *')
  async taskReminders() {
    // v12.7: bir nechta instansda TAKROR bajarilmasin —
    // qulfni birinchi olgan instans bajaradi, qolganlari o'tkazadi.
    await this.cronLock.runOnce('task-reminders', 280, async () => {
      const now = new Date();
      // v12.9: oyna cron chastotasiga (5 daqiqa) TENG qilindi — avval 15
      // daqiqalik oyna bilan bir xil vazifa 3 marta (15/10/5 daqiqa oldin)
      // takroriy bildirishnoma olayotgan edi. Endi har bir vazifa faqat
      // bitta ishga to'g'ri keladi va faqat bitta bildirishnoma yuboriladi.
      const in5 = new Date(now.getTime() + 5 * 60000);
      // v12.8: oyna odatda kichik, lekin ommaviy import qilingan vazifalar
      // bir vaqtga to'g'ri kelsa minglab bo'lishi mumkin. Cheklov qo'yamiz —
      // qolganlari keyingi ishga qoladi.
      const tasks = await this.prisma.task.findMany({
        where: { status: { in: ['TODO', 'IN_PROGRESS'] }, dueAt: { gte: now, lte: in5 } } as any,
        include: { client: { select: { fullName: true } } } as any,
        take: 500,
      });
      for (const t of tasks as any[]) {
        if (!t.assigneeId) continue;
        await this.prisma.notification.create({
          data: {
            tenantId: t.tenantId, userId: t.assigneeId, type: 'TASK_DUE' as any,
            title: `Vazifa: ${t.title}`,
            body: t.client ? `Klient: ${t.client.fullName}` : '5 daqiqa qoldi',
            link: t.clientId ? `/clients/${t.clientId}` : '/tasks', metadata: {},
          } as any,
        }).catch(swallow('bildirishnoma'));
      }
      });
}
}

// ─── Controller ───────────────────────────────────────────────────────────────
@ApiTags('Pipeline')
@ApiBearerAuth('JWT')
@Controller('pipeline')
@UseGuards(JwtAuthGuard)
export class PipelineController {
  constructor(private svc: PipelineService) {}

  @Get('pipelines')
  listPipelines(@CurrentUser() u: any) { return this.svc.listPipelines(u.tenantId); }

  @Post('pipelines')
  createPipeline(@CurrentUser() u: any, @Body() body: any) { return this.svc.createPipeline(u.tenantId, body); }

  @Patch('pipelines/:id')
  updatePipeline(@CurrentUser() u: any, @Param('id') id: string, @Body() body: any) { return this.svc.updatePipeline(u.tenantId, id, body); }

  @Delete('pipelines/:id')
  @UseGuards(RolesGuard) @Roles('TENANT_ADMIN')
  deletePipeline(@CurrentUser() u: any, @Param('id') id: string) { return this.svc.deletePipeline(u.tenantId, id); }

  @Get('board')
  board(@CurrentUser() u: any, @Query('agentId') aid?: string, @Query('pipelineId') pid?: string) {
    return this.svc.getBoard(u.tenantId, u.id || u.sub, u.role, aid, pid);
  }

  @Get('analytics')
  analytics(@CurrentUser() u: any) { return this.svc.analytics(u.tenantId); }

  @Get('lost-leads')
  lostLeads(@CurrentUser() u: any, @Query('agentId') aid?: string) {
    return this.svc.getLostLeads(u.tenantId, u.id || u.sub, u.role, aid);
  }

  @Get('client/:id/history')
  history(@CurrentUser() u: any, @Param('id') id: string) { return this.svc.getHistory(u.tenantId, id); }

  // v34: mijoz profilidagi bosqich tanlagichi endi shu real ro'yxatdan
  // foydalanadi (frontendda qattiq kodlangan eski ro'yxat emas).
  @Get('client/:id/stages')
  clientStages(@CurrentUser() u: any, @Param('id') id: string) { return this.svc.getClientPipelineStages(u.tenantId, id); }

  @Patch('client/:id/stage')
  moveStage(@CurrentUser() u: any, @Param('id') id: string, @Body() body: any) {
    return this.svc.moveStage(u.tenantId, u.id || u.sub, u.role, id, body);
  }

  @Patch('move/:clientId')
  moveClient(@CurrentUser() u: any, @Param('clientId') id: string, @Body() body: any) {
    return this.svc.moveStage(u.tenantId, u.id || u.sub, u.role, id, body);
  }

  @Post('bulk-move')
  bulkMove(@CurrentUser() u: any, @Body() body: { clientIds: string[]; stage: string }) {
    return this.svc.bulkMove(u.tenantId, u.id || u.sub, body.clientIds, body.stage);
  }

  @Post('call-attempt/:clientId')
  callAttempt(@CurrentUser() u: any, @Param('clientId') id: string, @Body() body: any) {
    return this.svc.recordCallAttempt(u.tenantId, u.id || u.sub, id, body);
  }

  @Get('stages')
  getStages(@CurrentUser() u: any, @Query('pipelineId') pid?: string) { return this.svc.getCustomStages(u.tenantId, pid); }

  @Post('stages')
  createStage(@CurrentUser() u: any, @Body() body: any) { return this.svc.createCustomStage(u.tenantId, body); }

  @Patch('stages/:id')
  updateStage(@CurrentUser() u: any, @Param('id') id: string, @Body() body: any) { return this.svc.updateCustomStage(u.tenantId, id, body); }

  @Delete('stages/:id')
  @UseGuards(RolesGuard) @Roles('TENANT_ADMIN', 'MANAGER')
  deleteStage(@CurrentUser() u: any, @Param('id') id: string) { return this.svc.deleteCustomStage(u.tenantId, id); }

  @Post('stages/reorder')
  reorderStages(@CurrentUser() u: any, @Body() body: { orderedIds: string[] }) {
    return this.svc.reorderCustomStages(u.tenantId, body.orderedIds);
  }
}

@Module({
  controllers: [PipelineController],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}