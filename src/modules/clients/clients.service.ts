import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { ClientStatus, ClientTier, LeadSource, Language, PipelineStage } from '../../prisma-types';;
import {
  safeEnum,
  paginate,
  meta,
  calculateLeadScore,
  clean,
  pickNextAgent,
} from '../../common/utils/helpers';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { RoundRobinService } from '../v9/round-robin.module';
import { EncryptionService } from '../../common/encryption/encryption.service';

const CLIENT_STATUSES: ClientStatus[] = ['ACTIVE', 'INACTIVE', 'BLACKLISTED'];
const TIERS: ClientTier[] = ['REGULAR', 'SILVER', 'GOLD', 'VIP'];
const SOURCES: LeadSource[] = [
  'TELEGRAM', 'INSTAGRAM', 'WHATSAPP', 'REFERRAL',
  'WALKIN', 'WEBSITE', 'CALL', 'FACEBOOK', 'GOOGLE_ADS', 'OTHER',
];
const LANGUAGES: Language[] = ['UZ', 'RU', 'EN'];

@Injectable()
export class ClientsService {
  private readonly logger = new Logger('Clients');
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private notifications: NotificationsService,
    private encryption: EncryptionService,
    @Optional() private roundRobin: RoundRobinService,
  ) {}

  /** Pasport va manzilni dekript qilib qaytaradi */
  private decryptClient(client: any): any {
    if (!client) return client;
    return {
      ...client,
      passportNo: client.passportNo ? this.encryption.decrypt(client.passportNo) || client.passportNo : null,
      passportMasked: client.passportNo ? this.encryption.mask(this.encryption.decrypt(client.passportNo) || '') : null,
      address: client.address ? this.encryption.decrypt(client.address) || client.address : null,
    };
  }

  private encryptClientData(data: any): any {
    const out = { ...data };
    if (data.passportNo) out.passportNo = this.encryption.encrypt(data.passportNo);
    if (data.address) out.address = this.encryption.encrypt(data.address);
    return out;
  }

  private where(
    tenantId: string,
    userId: string,
    role: string,
    extra: any = {},
  ): any {
    const base: any = { tenantId, ...extra };
    if (role === 'AGENT') base.assignedAgentId = userId;
    return base;
  }

  async findAll(
    tenantId: string,
    userId: string,
    role: string,
    params: {
      search?: string;
      status?: string;
      tier?: string;
      source?: string;
      stage?: string;
      agentId?: string;
      tag?: string;
      sortBy?: 'recent' | 'name' | 'revenue' | 'score';
      page?: any;
      limit?: any;
    },
  ) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where = this.where(tenantId, userId, role);

    if (params.status && CLIENT_STATUSES.includes(params.status as ClientStatus)) {
      where.status = params.status as ClientStatus;
    }
    if (params.tier && TIERS.includes(params.tier as ClientTier)) {
      where.tier = params.tier as ClientTier;
    }
    if (params.source && SOURCES.includes(params.source as LeadSource)) {
      where.source = params.source as LeadSource;
    }
    if (params.stage) {
      where.pipelineStage = params.stage as PipelineStage;
    } else {
      // Yo'qotilgan (LOST) klientlar asosiy Klientlar dashboardida ko'rinmaydi —
      // ular chalg'itadi va ular bilan hozircha ish yuritilmaydi.
      // Faqat foydalanuvchi maxsus "Yo'qotildi" bosqichini tanlasa ko'rsatiladi.
      where.pipelineStage = { not: 'LOST' as PipelineStage };
    }
    if (params.agentId && role !== 'AGENT') where.assignedAgentId = params.agentId;
    if (params.tag) where.tags = { has: params.tag };

    if (params.search?.trim()) {
      const s = params.search.trim();
      where.OR = [
        { fullName: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s } },
        { email: { contains: s, mode: 'insensitive' } },
        { passportNo: { contains: s } },
        { telegramUsername: { contains: s, mode: 'insensitive' } },
      ];
    }

    let orderBy: any = [
      { lastContactAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
    ];
    if (params.sortBy === 'name') orderBy = { fullName: 'asc' };
    else if (params.sortBy === 'revenue') orderBy = { totalRevenue: 'desc' };
    else if (params.sortBy === 'score') orderBy = { leadScore: 'desc' };

    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        skip,
        take,
        include: {
          assignedAgent: { select: { id: true, name: true, avatarUrl: true } },
          _count: { select: { bookings: true } },
        },
        orderBy,
      }),
      this.prisma.client.count({ where }),
    ]);
    return { data, meta: meta(total, page, limit) };
  }

  // ── v12: YO'QOTILGAN LEADLAR (umumiy hovuz) ──────────────────────────
  // Barcha agentlar KO'RADI (agentId bo'yicha BO'LINMAYDI) — istalgan agent
  // yo'qotilgan lead bilan qayta bog'lanishi mumkin.
  async lostLeads(
    tenantId: string,
    params: { search?: string; page?: any; limit?: any } = {},
  ) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where: any = { tenantId, pipelineStage: 'LOST' as PipelineStage };
    if (params.search?.trim()) {
      where.OR = [
        { fullName: { contains: params.search, mode: 'insensitive' } },
        { phone: { contains: params.search } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        skip,
        take,
        orderBy: { pipelineStageAt: 'desc' },
        include: {
          assignedAgent: { select: { id: true, name: true } },
          _count: { select: { bookings: true } },
        },
      }),
      this.prisma.client.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(tenantId: string, id: string, userId: string, role: string) {
    // v12: Agent o'z klientini ko'radi; QO'SHIMCHA — YO'QOTILGAN (LOST) leadni
    // ham ko'radi (umumiy hovuz — hamma agent qayta bog'lanishi mumkin).
    const where: any = role === 'AGENT'
      ? { tenantId, id, OR: [{ assignedAgentId: userId }, { pipelineStage: 'LOST' as PipelineStage }] }
      : { tenantId, id };
    const client = await this.prisma.client.findFirst({
      where,
      include: {
        assignedAgent: { select: { id: true, name: true, avatarUrl: true } },
        bookings: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            agent: { select: { id: true, name: true } },
          },
        },
        payments: { orderBy: { paidAt: 'desc' }, take: 10 },
        timeline: { orderBy: { createdAt: 'desc' }, take: 30 },
        followUps: {
          where: { done: false },
          orderBy: { dueAt: 'asc' },
          take: 10,
        },
        documents: { orderBy: { createdAt: 'desc' }, take: 20 },
        _count: {
          select: {
            bookings: true,
            payments: true,
            documents: true,
            calls: true,
            followUps: true,
          },
        },
      },
    });
    if (!client) throw new NotFoundException('Klient topilmadi');
    return this.decryptClient(client);
  }

  async create(tenantId: string, userId: string, data: any) {
    // v9-SECURITY: Phone is OPTIONAL for Telegram/Web leads
    // Required: fullName only
    // Phone is required ONLY for direct booking sources
    
    if (!data.fullName?.trim()) {
      throw new BadRequestException('To\'liq ism majburiy');
    }

    const fullName = String(data.fullName).trim();
    
    // v9-SECURITY: Validate phone format if provided
    let phone = null;
    if (data.phone?.trim()) {
      phone = String(data.phone).trim();
      // Basic phone validation: at least 5 chars, alphanumeric + symbols
      if (!phone.match(/^[0-9\+\-\(\) ]{5,20}$/)) {
        throw new BadRequestException('Telefon raqam noto\'g\'ri formatda');
      }
    }

    // Check duplicate phone ONLY if phone is provided
    if (phone) {
      const dup = await this.prisma.client.findFirst({
        where: { tenantId, phone },
      });
      if (dup) {
        await this.addTimeline(
          dup.id,
          'duplicate_attempt',
          'Yana lead keldi (duplikat)',
          data.note,
          { source: data.source },
        );
        throw new BadRequestException("Bu telefon raqam allaqachon mavjud");
      }
    }

    // Round-Robin: AVTOMATIK agent tayinlash (strategiya tekshirib)
    let assignedAgentId: string | null = data.assignedAgentId || null;
    if (!assignedAgentId) {
      // Strategiyani tekshir
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { leadAssignmentStrategy: true },
      });
      const strategy = tenant?.leadAssignmentStrategy || 'ROUND_ROBIN';
      if (strategy !== 'MANUAL') {
        if (this.roundRobin) {
          assignedAgentId = await this.roundRobin.getNextAgent(tenantId);
        } else {
          assignedAgentId = await pickNextAgent(this.prisma, tenantId);
        }
        if (assignedAgentId) {
          this.logger.log(`[ROUND ROBIN] Lead → Agent: ${assignedAgentId} | Tenant: ${tenantId}`);
        }
      } else {
        this.logger.log(`[CLIENTS] MANUAL strategiya — agent tayinlanmadi | Tenant: ${tenantId}`);
      }
    }

    const score = calculateLeadScore({
      source: data.source,
      tier: data.tier,
      email: data.email,
      passportNo: data.passportNo,
    });

    // v9-SECURITY: Sanitize all string inputs
    const client = await this.prisma.client.create({
      data: {
        tenantId,
        fullName: fullName, // Already sanitized
        phone: phone || null, // ✅ OPTIONAL: Can be null for Telegram/Web
        phone2: data.phone2?.trim() || null,
        email: data.email?.trim().toLowerCase() || null,
        passportNo: data.passportNo ? this.encryption.encrypt(data.passportNo) : undefined,
        passportExpiry: data.passportExpiry ? new Date(data.passportExpiry) : undefined,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        nationality: data.nationality?.trim() || null,
        country: data.country?.trim() || null,
        gender: data.gender,
        address: data.address ? this.encryption.encrypt(data.address.trim()) : undefined,
        city: data.city?.trim() || null,
        language: safeEnum(data.language, LANGUAGES, 'UZ'),
        source: safeEnum(data.source, SOURCES, 'OTHER'),
        tier: safeEnum(data.tier, TIERS, 'REGULAR'),
        sourceCampaign: data.sourceCampaign?.trim() || null,
        utmSource: data.utmSource?.trim() || null,
        utmMedium: data.utmMedium?.trim() || null,
        utmCampaign: data.utmCampaign?.trim() || null,
        utmTerm: data.utmTerm?.trim() || null,
        utmContent: data.utmContent?.trim() || null,
        referrerUrl: data.referrerUrl?.trim() || null,
        notes: data.notes?.trim() || null,
        tags: Array.isArray(data.tags) ? data.tags.filter((t: any) => t?.trim()) : [],
        assignedAgentId: assignedAgentId,
        telegramId: data.telegramId || null,
        telegramUsername: data.telegramUsername?.trim() || null,
        instagramHandle: data.instagramHandle?.trim() || null,
        familyMembers: data.familyMembers || [],
        preferences: data.preferences || {},
        leadScore: score,
        firstContactAt: new Date(),
        lastContactAt: new Date(),
      },
    });

    await this.addTimeline(client.id, 'created', 'Klient yaratildi', undefined, {
      userId,
      source: client.source,
    });

    // BUG2 FIX: lead.created event emit
    try {
      this.eventEmitter.emit('lead.created', {
        tenantId: client.tenantId,
        clientId: client.id,
        assignedAgentId: client.assignedAgentId,
      });
    } catch {}

    // Notify assigned agent
    if (client.assignedAgentId && client.assignedAgentId !== userId) {
      await this.notifications.create({
        tenantId,
        userId: client.assignedAgentId,
        type: 'LEAD_ASSIGNED',
        title: '🔥 Yangi klient sizga tayinlandi',
        body: `${client.fullName} • ${client.phone}`,
        link: `/clients/${client.id}`,
        metadata: { clientId: client.id },
      });
    }

    return client;
  }

  async update(
    tenantId: string,
    id: string,
    userId: string,
    role: string,
    data: any,
  ) {
    await this.findOne(tenantId, id, userId, role);
    const {
      id: _id, tenantId: _t, createdAt: _c, updatedAt: _u,
      totalBookings: _tb, totalRevenue: _tr, totalSpent: _ts,
      leadScore: _ls, pipelineStage: _ps, // Stage changes use separate endpoint
      ...safe
    } = data;

    if (safe.dateOfBirth) safe.dateOfBirth = new Date(safe.dateOfBirth);
    if (safe.passportExpiry) safe.passportExpiry = new Date(safe.passportExpiry);
    if (safe.language) safe.language = safeEnum(safe.language, LANGUAGES, 'UZ');
    if (safe.source) safe.source = safeEnum(safe.source, SOURCES, 'OTHER');
    if (safe.tier) safe.tier = safeEnum(safe.tier, TIERS, 'REGULAR');
    if (safe.status) safe.status = safeEnum(safe.status, CLIENT_STATUSES, 'ACTIVE');
    // Sezgir ma'lumotlarni shifrlash
    if (safe.passportNo) safe.passportNo = this.encryption.encrypt(safe.passportNo);
    if (safe.address) safe.address = this.encryption.encrypt(safe.address);

    return this.prisma.client.update({
      where: { id },
      data: clean(safe),
    });
  }

  async delete(tenantId: string, id: string, userId: string, role: string) {
    // Only ADMIN/MANAGER can delete
    if (role === 'AGENT') {
      throw new BadRequestException("Agentlar klientlarni o'chira olmaydi");
    }
    await this.findOne(tenantId, id, userId, role);

    // BUG FIX: avval to'g'ridan-to'g'ri `prisma.client.delete()` chaqirilardi —
    // lekin Booking/Invoice/Payment kabi moliyaviy yozuvlar Client bilan CASCADE
    // BOG'LANMAGAN (atayin — moliyaviy tarix tasodifan o'chib ketmasligi uchun),
    // shuning uchun bookingi bor har qanday klientni o'chirishga urinish har doim
    // "Foreign key constraint" xatosi bilan tugardi va foydalanuvchiga tushunarsiz
    // ko'rinardi ("ishlamayapti"). Endi buni aniq xabar bilan bloklaymiz.
    const bookingsCount = await this.prisma.booking.count({ where: { clientId: id } });
    if (bookingsCount > 0) {
      throw new BadRequestException(
        `Bu klientda ${bookingsCount} ta booking bor — moliyaviy tarixni yo'qotmaslik uchun bookingi bor klientlarni o'chirib bo'lmaydi. Kerak bo'lsa, klientni "Yo'qotildi" bosqichiga o'tkazing.`,
      );
    }

    // Moliyaviy bo'lmagan bog'liq yozuvlarni (suhbat, vazifa, hujjat, qo'ng'iroq,
    // tarix) klient bilan birga tozalaymiz — bular Client'ga CASCADE bog'lanmagan
    // (chunki clientId ixtiyoriy), shuning uchun qo'lda, bitta tranzaksiyada o'chiramiz.
    await this.prisma.$transaction([
      this.prisma.conversation.deleteMany({ where: { clientId: id } }),
      this.prisma.task.deleteMany({ where: { clientId: id } }),
      this.prisma.document.deleteMany({ where: { clientId: id } }),
      this.prisma.call.deleteMany({ where: { clientId: id } }),
      this.prisma.client.delete({ where: { id } }),
    ]);
    return { ok: true };
  }

  async getTimeline(tenantId: string, id: string, userId: string, role: string) {
    await this.findOne(tenantId, id, userId, role);
    return this.prisma.clientTimeline.findMany({
      where: { clientId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async addNote(
    tenantId: string,
    id: string,
    userId: string,
    role: string,
    note: string,
  ) {
    if (!note?.trim()) throw new BadRequestException("Izoh bo'sh");
    await this.findOne(tenantId, id, userId, role);
    return this.addTimeline(id, 'note', 'Izoh qoldirildi', note.trim(), { userId });
  }

  async setTier(
    tenantId: string,
    id: string,
    userId: string,
    role: string,
    tier: string,
  ) {
    if (role === 'AGENT') {
      throw new BadRequestException("Agentlar tier o'zgartira olmaydi");
    }
    const t = safeEnum(tier, TIERS, 'REGULAR');
    const client = await this.prisma.client.update({
      where: { id },
      data: { tier: t },
    });
    await this.addTimeline(id, 'tier_changed', `Daraja: ${t}`, undefined, { tier: t, userId });
    return client;
  }

  /**
   * v5: Open Chat — klient bilan mavjud suhbatni topadi, yo'q bo'lsa yaratadi.
   * Faqat assigned agent va admin ko'ra oladi.
   */
  async findOrCreateConversation(tenantId: string, clientId: string, userId: string, role: string) {
    const client = await this.prisma.client.findFirst({
      where: this.where(tenantId, userId, role, { id: clientId }),
    });
    if (!client) throw new NotFoundException('Klient topilmadi');

    // Mavjud suhbat (Telegram ustuvor)
    let conv = await this.prisma.conversation.findFirst({
      where: {
        tenantId,
        clientId,
        ...(role === 'AGENT' ? {
          OR: [{ assignedAgentId: userId }, { assignedAgentId: null }],
        } : {}),
      },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
    });

    if (conv) {
      return { conversationId: conv.id, isNew: false };
    }

    // Telegram ma'lumotlari bo'lsa, yangi conversation yaratamiz (manual)
    if (!client.telegramId && !client.telegramUsername && !client.phone) {
      throw new BadRequestException("Klient bilan suhbat boshlash uchun Telegram yoki telefon kerak");
    }

    conv = await this.prisma.conversation.create({
      data: {
        tenantId,
        clientId,
        channel: client.telegramId ? 'TELEGRAM' : 'WHATSAPP',
        externalChatId: client.telegramId || client.phone || `manual-${clientId}`,
        externalUserId: client.telegramId || undefined,
        firstName: client.fullName.split(' ')[0],
        lastName: client.fullName.split(' ').slice(1).join(' ') || undefined,
        username: client.telegramUsername || undefined,
        assignedAgentId: role === 'AGENT' ? userId : client.assignedAgentId,
      },
    });

    return { conversationId: conv.id, isNew: true };
  }

  /**
   * v7: Faqat mavjud suhbatni qaytaradi, yaratmaydi.
   * Frontend: Klient telegramda yozgan bo'lsa "Open Chat" tugmasi ko'rinadi.
   * Yo'q bo'lsa - null qaytadi va frontend tugmani yashiradi.
   */
  async getExistingConversation(tenantId: string, clientId: string, userId: string, role: string) {
    const client = await this.prisma.client.findFirst({
      where: this.where(tenantId, userId, role, { id: clientId }),
    });
    if (!client) throw new NotFoundException('Klient topilmadi');

    const conv = await this.prisma.conversation.findFirst({
      where: {
        tenantId, clientId,
        ...(role === 'AGENT' ? {
          OR: [{ assignedAgentId: userId }, { assignedAgentId: null }],
        } : {}),
      },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      select: {
        id: true, channel: true, lastMessageAt: true, lastMessageText: true,
        unreadCount: true, isResolved: true,
      },
    });

    if (!conv) {
      return { exists: false, conversationId: null };
    }
    return { exists: true, conversationId: conv.id, conversation: conv };
  }

  /**
   * v5: Call — klientga qo'ng'iroq qilish (Twilio orqali)
   */
  /**
   * Legacy endpoint - hozircha simple Call yozuvi yaratadi.
   * Real qo'ng'iroq uchun frontend'dan to'g'ridan-to'g'ri /api/v1/calls/initiate ishlatiladi
   * (phone provider arxitekturasidan o'tadi: STUB/TEL_LINK/OnlinePBX/Twilio).
   */
  async initiateCall(tenantId: string, clientId: string, userId: string, role: string) {
    const client = await this.prisma.client.findFirst({
      where: this.where(tenantId, userId, role, { id: clientId }),
    });
    if (!client) throw new NotFoundException('Klient topilmadi');
    if (!client.phone) throw new BadRequestException("Klientning telefon raqami yo'q");

    const call = await this.prisma.call.create({
      data: {
        tenantId,
        clientId,
        agentId: userId,
        toMasked: client.phone.slice(0, -5) + '***' + client.phone.slice(-2),
        direction: 'OUTBOUND',
        status: 'QUEUED',
      },
    });

    await this.addTimeline(clientId, 'call_initiated', "Qo'ng'iroq qilindi", undefined, {
      callId: call.id, userId,
    });

    return {
      callId: call.id,
      id: call.id,
      phone: client.phone,
      message: "Qo'ng'iroq /api/v1/calls/initiate orqali phone provider'dan o'tkazilishi mumkin",
    };
  }

  async addTimeline(
    clientId: string,
    type: string,
    title: string,
    description?: string,
    metadata?: any,
  ) {
    return this.prisma.clientTimeline.create({
      data: {
        clientId,
        userId: metadata?.userId,
        type,
        title,
        description,
        metadata: (metadata || {}) as any,
      },
    });
  }

  async getStats(tenantId: string, userId: string, role: string) {
    const where = this.where(tenantId, userId, role);
    const monthStart = new Date(new Date().setDate(1));
    monthStart.setHours(0, 0, 0, 0);

    const [total, bySource, byTier, byStage, newThisMonth] = await Promise.all([
      this.prisma.client.count({ where }),
      this.prisma.client.groupBy({ by: ['source'], where, _count: { id: true } }),
      this.prisma.client.groupBy({ by: ['tier'], where, _count: { id: true } }),
      this.prisma.client.groupBy({ by: ['pipelineStage'], where, _count: { id: true } }),
      this.prisma.client.count({ where: { ...where, createdAt: { gte: monthStart } } }),
    ]);

    return { total, newThisMonth, bySource, byTier, byStage };
  }

  /** Update client stats after a booking/payment */
  async recalcStats(clientId: string) {
    const [bookings, payments] = await Promise.all([
      this.prisma.booking.aggregate({
        where: { clientId, status: { not: 'CANCELLED' } },
        _count: { id: true },
        _sum: { totalPrice: true },
      }),
      this.prisma.payment.aggregate({
        where: { clientId, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
    ]);
    const totalBookings = bookings._count.id || 0;
    const totalRevenue = bookings._sum.totalPrice || 0;
    const totalSpent = payments._sum.amount || 0;
    const avg = totalBookings > 0 ? totalRevenue / totalBookings : 0;

    await this.prisma.client.update({
      where: { id: clientId },
      data: {
        totalBookings,
        totalRevenue,
        totalSpent,
        avgBookingValue: avg,
        lifetimeValue: totalSpent,
      },
    });
  }
  /** v6: CSV export */
  async exportCsv(tenantId: string, userId: string, role: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.assignedAgentId = userId;

    const clients = await this.prisma.client.findMany({
      where,
      include: { assignedAgent: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const headers = ['Ism', 'Telefon', 'Email', 'Manba', 'Bosqich', 'Tier', 'Mamlakat', 'Agent', 'Bookings', 'Daromad', 'Yaratilgan'];
    const csv = [
      headers.join(','),
      ...clients.map((c) => [
        (c.fullName || '').replace(/,/g, ';'),
        c.phone || '',
        c.email || '',
        c.source || '',
        c.pipelineStage || '',
        c.tier || '',
        c.country || '',
        (c.assignedAgent?.name || '').replace(/,/g, ';'),
        c.totalBookings || 0,
        c.totalRevenue || 0,
        c.createdAt.toISOString().slice(0, 10),
      ].join(',')),
    ].join('\n');
    return { csv, count: clients.length };
  }

  /** v6: Manba bo'yicha statistika */
  async statsBySource(tenantId: string, userId: string, role: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.assignedAgentId = userId;
    const grouped = await this.prisma.client.groupBy({
      by: ['source'],
      where,
      _count: { id: true },
      _sum: { totalRevenue: true },
    });
    return grouped.map((g) => ({
      source: g.source || 'UNKNOWN',
      count: g._count.id,
      revenue: g._sum.totalRevenue || 0,
    }));
  }

  /** v6: Bosqich bo'yicha statistika */
  async statsByStage(tenantId: string, userId: string, role: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.assignedAgentId = userId;
    const grouped = await this.prisma.client.groupBy({
      by: ['pipelineStage'],
      where,
      _count: { id: true },
    });
    return grouped.map((g) => ({
      stage: g.pipelineStage,
      count: g._count.id,
    }));
  }
}