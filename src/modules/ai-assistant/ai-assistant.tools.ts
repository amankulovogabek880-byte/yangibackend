import { PrismaService } from '../../prisma/prisma.service';
import { hasPermission } from '../../common/permissions/permissions.constants';
import { phoneVariants, normalizePhone, generateRef } from '../../common/utils/helpers';

/**
 * ═══════════════════════════════════════════════════════════════
 * v40: AI YORDAMCHI ("JARVIS") — Tool ro'yxati
 * v41: 2-BOSQICH — "yozuvchi" (write) tool'lar qo'shildi
 * ═══════════════════════════════════════════════════════════════
 *
 * MUHIM XAVFSIZLIK QOIDASI: har bir `execute` funksiyasi ICHIDA
 * so'rov albatta `tenantId` bilan cheklanadi. Bu yerda hech qanday
 * Prisma so'rovi `tenantId`siz yuborilmasligi SHART — aks holda
 * boshqa kompaniyaning ma'lumoti oqib chiqishi mumkin.
 *
 * Qo'shimcha: AGENT roli uchun (agar unda `view_all_clients`
 * ruxsati bo'lmasa) ko'p tool'lar natijani FAQAT shu agentga
 * tegishli yozuvlar bilan cheklaydi — bu ADMIN/MANAGER darajasidagi
 * ma'lumotni (masalan boshqa agentning mijozi) Jarvis orqali
 * "aylanma yo'l" bilan ko'rish imkonini bermaydi.
 *
 * v41 YOZUVCHI TOOL'LAR UCHUN QAT'IY QOIDA: AGENT roli faqat O'ZIGA
 * BIRIKTIRILGAN (assignedAgentId === ctx.userId) mijozlar ustida yoza
 * oladi — `agentScope()` (faqat ko'rish uchun, `view_all_clients`
 * ruxsatiga qarab yumshaydi) dan farqli, `requireOwnedClient()` hech
 * qachon yumshamaydi: TENANT_ADMIN/MANAGER uchun cheklov yo'q, lekin
 * AGENT uchun har doim qat'iy — hatto `view_all_clients` ruxsati
 * bo'lsa ham (ko'rish huquqi ≠ yozish huquqi).
 */

export interface AiToolContext {
  tenantId: string;
  userId: string;
  role: string;
}

export interface AiToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  execute: (prisma: PrismaService, ctx: AiToolContext, params: any) => Promise<any>;
}

const PIPELINE_STAGE_LABELS: Record<string, string> = {
  NEW_LEAD: 'Yangi lid', CONTACTED: "Aloqa o'rnatildi",
  INTERESTED: 'Qiziqdi', OFFER_SENT: 'Taklif yuborildi',
  NEGOTIATION: 'Muzokara', DEPOSIT_PAID: 'Avans olindi',
  CONFIRMED: 'Tasdiqlandi', TRAVELING: 'Sayohatda',
  COMPLETED: 'Yakunlandi', LOST: "Yo'qotildi",
};
const PIPELINE_STAGES = Object.keys(PIPELINE_STAGE_LABELS);

/** AGENT roli uchun "faqat o'zining mijozlari" cheklovini qo'shadi (agar ruxsati bo'lmasa) */
function agentScope(ctx: AiToolContext, field = 'assignedAgentId'): Record<string, any> {
  if (ctx.role === 'AGENT' && !hasPermission({ role: ctx.role }, 'view_all_clients')) {
    return { [field]: ctx.userId };
  }
  return {};
}

/**
 * v41: YOZUVCHI tool'lar uchun mijoz egaligini tekshiradi.
 * TENANT_ADMIN/MANAGER/ACCOUNTANT — cheklovsiz (tenant ichida bo'lsa yetarli).
 * AGENT — faqat `assignedAgentId === ctx.userId` bo'lgan mijozga yoza oladi.
 * Topilmasa/ruxsat bo'lmasa `{ error }` obyektini qaytaradi (throw qilmaydi —
 * bu tool natijasi, Claude uni o'qib foydalanuvchiga tushuntiradi).
 */
async function requireOwnedClient(
  prisma: PrismaService,
  ctx: AiToolContext,
  clientId: string,
): Promise<{ client: any } | { error: string }> {
  if (!clientId) return { error: "clientId ko'rsatilmagan" };
  const where: any = { id: clientId, tenantId: ctx.tenantId };
  if (ctx.role === 'AGENT') where.assignedAgentId = ctx.userId;

  const client = await prisma.client.findFirst({ where });
  if (!client) {
    return {
      error:
        ctx.role === 'AGENT'
          ? 'Bu mijoz sizga biriktirilmagan yoki topilmadi.'
          : 'Bu mijoz topilmadi.',
    };
  }
  return { client };
}

function clientSummary(c: any) {
  return {
    id: c.id,
    fullName: c.fullName,
    phone: c.phone,
    phone2: c.phone2 || undefined,
    status: c.status,
    tier: c.tier,
    pipelineStage: c.pipelineStage,
    pipelineStageLabel: PIPELINE_STAGE_LABELS[c.pipelineStage] || c.pipelineStage,
    source: c.source,
    assignedAgent: c.assignedAgent?.name || null,
    totalBookings: c.totalBookings,
    totalRevenue: c.totalRevenue,
    totalSpent: c.totalSpent,
    lifetimeValue: c.lifetimeValue,
    tags: c.tags,
    lastContactAt: c.lastContactAt,
    createdAt: c.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────
// 1) getClientInfo
// ─────────────────────────────────────────────────────────────
const getClientInfo: AiToolDefinition = {
  name: 'getClientInfo',
  description:
    "Mijozni ism yoki telefon raqami bo'yicha qidiradi va uning to'liq holatini qaytaradi: pipeline bosqichi, so'nggi bookinglar, to'lovlar, umumiy statistika. Agar bir nechta mijoz mos kelsa, hammasi ro'yxat sifatida qaytadi.",
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Mijoz ismi yoki telefon raqami (masalan 'Aziz' yoki '901234567')" },
    },
    required: ['query'],
  },
  execute: async (prisma, ctx, params) => {
    const query = String(params?.query || '').trim();
    if (!query) return { error: "Qidiruv so'zi bo'sh" };

    const variants = phoneVariants(query);
    const where: any = {
      tenantId: ctx.tenantId,
      ...agentScope(ctx),
      OR: [
        { fullName: { contains: query, mode: 'insensitive' } },
        ...(variants.length ? [{ phone: { in: variants } }, { phone2: { in: variants } }] : []),
      ],
    };

    const clients = await prisma.client.findMany({
      where,
      select: {
        id: true, fullName: true, phone: true, phone2: true, status: true, tier: true,
        pipelineStage: true, source: true, tags: true, lastContactAt: true, createdAt: true,
        totalBookings: true, totalRevenue: true, totalSpent: true, lifetimeValue: true,
        assignedAgent: { select: { name: true } },
        bookings: {
          select: {
            id: true, bookingRef: true, tourName: true, destination: true, status: true,
            totalPrice: true, paidAmount: true, currency: true, departureDate: true, returnDate: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        payments: {
          select: { amount: true, currency: true, status: true, method: true, paidAt: true },
          orderBy: { paidAt: 'desc' },
          take: 5,
        },
      },
      take: 5,
      orderBy: { updatedAt: 'desc' },
    });

    if (!clients.length) return { found: false, message: 'Bunday mijoz topilmadi.' };

    return {
      found: true,
      count: clients.length,
      clients: clients.map((c) => ({
        ...clientSummary(c),
        recentBookings: c.bookings,
        recentPayments: c.payments,
      })),
    };
  },
};

// ─────────────────────────────────────────────────────────────
// 2) listPipelineByStage
// ─────────────────────────────────────────────────────────────
const listPipelineByStage: AiToolDefinition = {
  name: 'listPipelineByStage',
  description:
    "Pipeline (sotuv voronkasi)ning muayyan bosqichida turgan mijozlar ro'yxatini qaytaradi. Masalan 'NEGOTIATION' bosqichidagi barcha mijozlar.",
  input_schema: {
    type: 'object',
    properties: {
      stage: {
        type: 'string',
        enum: PIPELINE_STAGES,
        description: 'Pipeline bosqichi (ENUM): ' + PIPELINE_STAGES.join(', '),
      },
      limit: { type: 'number', description: "Qaytariladigan mijozlar soni (standart 15, maksimal 30)" },
    },
    required: ['stage'],
  },
  execute: async (prisma, ctx, params) => {
    const stage = String(params?.stage || '').toUpperCase();
    if (!PIPELINE_STAGES.includes(stage)) {
      return { error: `Noto'g'ri bosqich. Ruxsat etilganlar: ${PIPELINE_STAGES.join(', ')}` };
    }
    const limit = Math.min(30, Math.max(1, Number(params?.limit) || 15));

    const clients = await prisma.client.findMany({
      where: { tenantId: ctx.tenantId, pipelineStage: stage as any, ...agentScope(ctx) },
      select: {
        id: true, fullName: true, phone: true, tier: true, source: true,
        pipelineStageAt: true, totalRevenue: true,
        assignedAgent: { select: { name: true } },
      },
      orderBy: { pipelineStageAt: 'desc' },
      take: limit,
    });

    return {
      stage,
      stageLabel: PIPELINE_STAGE_LABELS[stage],
      count: clients.length,
      clients: clients.map((c) => ({
        id: c.id, fullName: c.fullName, phone: c.phone, tier: c.tier, source: c.source,
        assignedAgent: c.assignedAgent?.name || null,
        inStageSince: c.pipelineStageAt,
        totalRevenue: c.totalRevenue,
      })),
    };
  },
};

// ─────────────────────────────────────────────────────────────
// 3) getTodayFollowups
// ─────────────────────────────────────────────────────────────
const getTodayFollowups: AiToolDefinition = {
  name: 'getTodayFollowups',
  description:
    "Bugun (va muddati o'tib ketgan) bog'lanish kerak bo'lgan eslatmalar (follow-up) va vazifalarni qaytaradi. AGENT so'rasa faqat o'zinikini, ADMIN/MANAGER so'rasa butun jamoanikini ko'radi.",
  input_schema: {
    type: 'object',
    properties: {},
  },
  execute: async (prisma, ctx) => {
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const agentFilter = ctx.role === 'AGENT' ? { agentId: ctx.userId } : {};
    const assigneeFilter = ctx.role === 'AGENT' ? { assigneeId: ctx.userId } : {};

    const [followUps, tasks] = await Promise.all([
      prisma.followUp.findMany({
        where: { tenantId: ctx.tenantId, done: false, dueAt: { lte: endOfDay }, ...agentFilter },
        select: {
          id: true, title: true, note: true, dueAt: true,
          client: { select: { fullName: true, phone: true } },
          agent: { select: { name: true } },
        },
        orderBy: { dueAt: 'asc' },
        take: 20,
      }),
      prisma.task.findMany({
        where: { tenantId: ctx.tenantId, status: { not: 'DONE' as any }, dueAt: { lte: endOfDay }, ...assigneeFilter },
        select: {
          id: true, title: true, priority: true, dueAt: true,
          client: { select: { fullName: true, phone: true } },
          assignee: { select: { name: true } },
        },
        orderBy: { dueAt: 'asc' },
        take: 20,
      }),
    ]);

    return {
      followUps: followUps.map((f) => ({
        id: f.id, title: f.title, note: f.note, dueAt: f.dueAt,
        clientName: f.client?.fullName, phone: f.client?.phone,
        overdue: f.dueAt < now,
        agent: ctx.role !== 'AGENT' ? f.agent?.name : undefined,
      })),
      tasks: tasks.map((t) => ({
        id: t.id, title: t.title, priority: t.priority, dueAt: t.dueAt,
        clientName: t.client?.fullName, phone: t.client?.phone,
        overdue: t.dueAt ? t.dueAt < now : false,
        assignee: ctx.role !== 'AGENT' ? t.assignee?.name : undefined,
      })),
    };
  },
};

// ─────────────────────────────────────────────────────────────
// 4) getCallAnalysisSummary
// ─────────────────────────────────────────────────────────────
const getCallAnalysisSummary: AiToolDefinition = {
  name: 'getCallAnalysisSummary',
  description:
    "Muayyan mijoz (ism/telefon) bo'yicha eng so'nggi AI tahlil qilingan qo'ng'iroqlarning xulosasini qaytaradi: nima gaplashildi, e'tirozlar, keyingi qadam, agent bahosi.",
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Mijoz ismi yoki telefon raqami' },
      limit: { type: 'number', description: "Nechta so'nggi qo'ng'iroq (standart 3, maksimal 10)" },
    },
    required: ['query'],
  },
  execute: async (prisma, ctx, params) => {
    const query = String(params?.query || '').trim();
    if (!query) return { error: "Qidiruv so'zi bo'sh" };
    const limit = Math.min(10, Math.max(1, Number(params?.limit) || 3));
    const variants = phoneVariants(query);

    const agentFilter = ctx.role === 'AGENT' && !hasPermission({ role: ctx.role }, 'view_all_clients')
      ? { agentId: ctx.userId } : {};

    const calls = await prisma.call.findMany({
      where: {
        tenantId: ctx.tenantId,
        aiAnalyzedAt: { not: null },
        ...agentFilter,
        client: {
          OR: [
            { fullName: { contains: query, mode: 'insensitive' } },
            ...(variants.length ? [{ phone: { in: variants } }] : []),
          ],
        },
      } as any,
      select: {
        id: true, createdAt: true, duration: true,
        aiSummary: true, aiSentiment: true, aiObjections: true, aiFeedback: true, aiNextAction: true,
        client: { select: { fullName: true, phone: true } },
        agent: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (!calls.length) return { found: false, message: "Bu mijoz uchun AI tahlil qilingan qo'ng'iroq topilmadi." };

    return {
      found: true,
      calls: calls.map((c) => ({
        clientName: (c as any).client?.fullName,
        agent: (c as any).agent?.name,
        date: c.createdAt,
        durationSec: c.duration,
        summary: c.aiSummary,
        sentiment: c.aiSentiment,
        objections: c.aiObjections,
        feedback: c.aiFeedback,
        nextAction: c.aiNextAction,
      })),
    };
  },
};

// ─────────────────────────────────────────────────────────────
// 5) getKpiStats
// ─────────────────────────────────────────────────────────────
function periodRange(period?: string): { start: Date; end: Date } {
  const now = new Date();
  const end = now;
  let start: Date;
  if (period === 'today') {
    start = new Date(now); start.setHours(0, 0, 0, 0);
  } else if (period === 'week') {
    start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  } else {
    // default: shu oy
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return { start, end };
}

const getKpiStats: AiToolDefinition = {
  name: 'getKpiStats',
  description:
    "Agent yoki butun jamoaning davr bo'yicha statistikasini qaytaradi: bookinglar soni, tushum, yangi mijozlar, qo'ng'iroqlar soni. AGENT so'rasa faqat o'zinikini ko'radi.",
  input_schema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month'], description: "Davr (standart 'month')" },
      agentName: { type: 'string', description: "(Faqat ADMIN/MANAGER uchun) muayyan agent ismi — bo'sh bo'lsa butun jamoa" },
    },
  },
  execute: async (prisma, ctx, params) => {
    const { start, end } = periodRange(params?.period);

    let targetAgentId: string | null = null;
    let targetAgentName: string | null = null;

    if (ctx.role === 'AGENT') {
      targetAgentId = ctx.userId;
    } else if (params?.agentName) {
      const agent = await prisma.user.findFirst({
        where: { tenantId: ctx.tenantId, name: { contains: String(params.agentName), mode: 'insensitive' } },
        select: { id: true, name: true },
      });
      if (!agent) return { error: `"${params.agentName}" nomli agent topilmadi.` };
      targetAgentId = agent.id;
      targetAgentName = agent.name;
    }

    const agentBookingFilter = targetAgentId ? { agentId: targetAgentId } : {};
    const agentClientFilter = targetAgentId ? { assignedAgentId: targetAgentId } : {};
    const agentCallFilter = targetAgentId ? { agentId: targetAgentId } : {};

    const [bookingsCount, revenue, newClients, callsCount] = await Promise.all([
      prisma.booking.count({
        where: { tenantId: ctx.tenantId, createdAt: { gte: start, lte: end }, status: { not: 'CANCELLED' as any }, ...agentBookingFilter },
      }),
      prisma.payment.aggregate({
        where: { tenantId: ctx.tenantId, status: 'COMPLETED' as any, paidAt: { gte: start, lte: end }, ...(targetAgentId ? { booking: { agentId: targetAgentId } } : {}) },
        _sum: { amount: true },
      }),
      prisma.client.count({
        where: { tenantId: ctx.tenantId, createdAt: { gte: start, lte: end }, ...agentClientFilter },
      }),
      prisma.call.count({
        where: { tenantId: ctx.tenantId, createdAt: { gte: start, lte: end }, ...agentCallFilter } as any,
      }),
    ]);

    return {
      scope: targetAgentName || (targetAgentId ? 'siz' : 'butun jamoa'),
      periodStart: start,
      periodEnd: end,
      bookingsCount,
      revenue: revenue._sum.amount || 0,
      newClients,
      callsCount,
    };
  },
};

// ─────────────────────────────────────────────────────────────
// 6) getBookingStatus
// ─────────────────────────────────────────────────────────────
const getBookingStatus: AiToolDefinition = {
  name: 'getBookingStatus',
  description:
    "Booking (bron) holatini qaytaradi — booking raqami (bookingRef) yoki mijoz ismi/telefoni bo'yicha qidiradi: to'lov holati, qoldiq, sana, mehmonxona/parvoz ma'lumotlari.",
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Booking raqami (masalan 'BK-2026-0012') yoki mijoz ismi/telefoni" },
    },
    required: ['query'],
  },
  execute: async (prisma, ctx, params) => {
    const query = String(params?.query || '').trim();
    if (!query) return { error: "Qidiruv so'zi bo'sh" };
    const variants = phoneVariants(query);

    const bookings = await prisma.booking.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...agentScope(ctx, 'agentId'),
        OR: [
          { bookingRef: { contains: query, mode: 'insensitive' } },
          { client: { fullName: { contains: query, mode: 'insensitive' } } },
          ...(variants.length ? [{ client: { phone: { in: variants } } }] : []),
        ],
      },
      select: {
        id: true, bookingRef: true, tourName: true, destination: true, status: true,
        totalPrice: true, paidAmount: true, currency: true,
        departureDate: true, returnDate: true,
        hotelName: true, hotelStars: true, roomType: true,
        airline: true, flightNumber: true, departureTime: true,
        client: { select: { fullName: true, phone: true } },
        agent: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    if (!bookings.length) return { found: false, message: 'Bunday booking topilmadi.' };

    return {
      found: true,
      bookings: bookings.map((b) => ({
        bookingRef: b.bookingRef,
        clientName: b.client?.fullName,
        phone: b.client?.phone,
        agent: b.agent?.name,
        status: b.status,
        tourName: b.tourName,
        destination: b.destination,
        totalPrice: b.totalPrice,
        paidAmount: b.paidAmount,
        remainingBalance: Math.max(0, (b.totalPrice || 0) - (b.paidAmount || 0)),
        currency: b.currency,
        departureDate: b.departureDate,
        returnDate: b.returnDate,
        hotel: b.hotelName ? { name: b.hotelName, stars: b.hotelStars, roomType: b.roomType } : null,
        flight: b.airline ? { airline: b.airline, flightNumber: b.flightNumber, departureTime: b.departureTime } : null,
      })),
    };
  },
};

// ─────────────────────────────────────────────────────────────
// 7) searchMarketplaceTours
// ─────────────────────────────────────────────────────────────
const searchMarketplaceTours: AiToolDefinition = {
  name: 'searchMarketplaceTours',
  description:
    "Kompaniyaning tur bozoridagi (marketplace) mavjud tur takliflarini qidiradi — manzil, davlat, narx oralig'i, sana bo'yicha filtrlash mumkin.",
  input_schema: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: "Manzil/shahar (masalan 'Antalya')" },
      country: { type: 'string', description: "Davlat (masalan 'Turkiya')" },
      priceMax: { type: 'number', description: '1 kishi uchun maksimal narx (USD)' },
      onlyAvailable: { type: 'boolean', description: "Faqat bo'sh joyi bor turlar" },
    },
  },
  execute: async (prisma, ctx, params) => {
    const where: any = { tenantId: ctx.tenantId, status: 'PUBLISHED' };
    if (params?.destination) where.destination = { contains: String(params.destination), mode: 'insensitive' };
    if (params?.country) where.country = { contains: String(params.country), mode: 'insensitive' };
    if (params?.priceMax) where.price = { lte: Number(params.priceMax) };

    const and: any[] = [];
    if (params?.onlyAvailable) and.push({ OR: [{ seatsAvailable: null }, { seatsAvailable: { gt: 0 } }] });
    if (and.length) where.AND = and;

    const tours = await prisma.marketplaceTour.findMany({
      where,
      select: {
        id: true, title: true, destination: true, country: true, price: true, currency: true,
        duration: true, departureDate: true, returnDate: true, hotelName: true, hotelStars: true,
        seatsAvailable: true,
        operator: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });

    return {
      count: tours.length,
      tours: tours.map((t) => ({
        title: t.title, destination: t.destination, country: t.country,
        price: t.price, currency: t.currency, duration: t.duration,
        departureDate: t.departureDate, returnDate: t.returnDate,
        hotel: t.hotelName ? `${t.hotelName}${t.hotelStars ? ' ' + t.hotelStars + '*' : ''}` : null,
        seatsAvailable: t.seatsAvailable,
        operator: (t as any).operator?.name,
      })),
    };
  },
};

// ═══════════════════════════════════════════════════════════════
// v41: 2-BOSQICH — YOZUVCHI TOOL'LAR (8-16) + qo'shimcha o'qish (17-18)
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// 8) createTask
// ─────────────────────────────────────────────────────────────
const createTask: AiToolDefinition = {
  name: 'createTask',
  description:
    "Muayyan mijoz uchun vazifa (task) yaratadi — masalan 'ertaga qo'ng'iroq qil'. Vazifa avtomatik SIZGA (buyruq bergan agentga) biriktiriladi.",
  input_schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string', description: 'Mijoz ID (avval getClientInfo orqali toping)' },
      title: { type: 'string', description: "Vazifa nomi, masalan 'Aziz akaga qayta qo'ng'iroq qilish'" },
      dueAt: { type: 'string', description: "Muddat, ISO sana-vaqt formatida (masalan '2026-08-10T09:00:00.000Z')" },
      priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: "Muhimlik darajasi (standart MEDIUM)" },
    },
    required: ['clientId', 'title', 'dueAt'],
  },
  execute: async (prisma, ctx, params) => {
    const title = String(params?.title || '').trim();
    if (!title) return { error: "Vazifa nomi bo'sh bo'lishi mumkin emas" };
    const dueAt = new Date(params?.dueAt);
    if (isNaN(dueAt.getTime())) return { error: "Muddat (dueAt) noto'g'ri formatda" };

    const owned = await requireOwnedClient(prisma, ctx, params?.clientId);
    if ('error' in owned) return owned;

    const priority = ['LOW', 'MEDIUM', 'HIGH'].includes(params?.priority) ? params.priority : 'MEDIUM';

    const task = await prisma.task.create({
      data: {
        tenantId: ctx.tenantId,
        clientId: owned.client.id,
        title,
        dueAt,
        priority: priority as any,
        status: 'TODO' as any,
        creatorId: ctx.userId,
        assigneeId: ctx.userId,
      },
    });

    return { success: true, taskId: task.id, title: task.title, dueAt: task.dueAt };
  },
};

// ─────────────────────────────────────────────────────────────
// 9) draftFollowupMessage
// ─────────────────────────────────────────────────────────────
const draftFollowupMessage: AiToolDefinition = {
  name: 'draftFollowupMessage',
  description:
    "Mijozga yuborish uchun follow-up xabar QORALAMASINI (matnini) tayyorlaydi. HECH NARSANI yubormaydi va bazaga hech narsa yozmaydi — faqat matn taklif qiladi, foydalanuvchi buni ko'rib chiqib, o'zi (tugma orqali) yuborishi kerak.",
  input_schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string', description: 'Mijoz ID' },
      tone: { type: 'string', enum: ['formal', 'friendly'], description: "Ohang (standart 'friendly')" },
      context: { type: 'string', description: "Xabar nima haqida bo'lishi kerak (masalan 'taklifni eslatish')" },
    },
    required: ['clientId'],
  },
  execute: async (prisma, ctx, params) => {
    const owned = await requireOwnedClient(prisma, ctx, params?.clientId);
    if ('error' in owned) return owned;
    const client = owned.client;

    const tone = params?.tone === 'formal' ? 'formal' : 'friendly';
    const context = String(params?.context || '').trim();
    const firstName = String(client.fullName || '').trim().split(/\s+/)[0] || client.fullName;

    const greeting = tone === 'formal' ? `Assalomu alaykum, ${client.fullName}!` : `Salom, ${firstName}! 👋`;
    const closing = tone === 'formal'
      ? "Savolingiz bo'lsa, murojaat qilishingiz mumkin. Hurmat bilan."
      : "Savolingiz bo'lsa, bemalol yozing! 😊";

    const bodyLines: string[] = [];
    if (context) {
      bodyLines.push(context);
    } else {
      bodyLines.push(
        tone === 'formal'
          ? "Sizga taqdim etilgan taklif yuzasidan fikringizni bilishni istardik."
          : "Taklifimiz haqida qanday o'yladingiz? Sizdan xabar kutamiz.",
      );
    }

    const draftMessage = [greeting, '', ...bodyLines, '', closing].join('\n');

    return { draftMessage, clientName: client.fullName };
  },
};

// ─────────────────────────────────────────────────────────────
// 10) updatePipelineStage
// ─────────────────────────────────────────────────────────────
const updatePipelineStage: AiToolDefinition = {
  name: 'updatePipelineStage',
  description:
    "Mijozning pipeline (sotuv voronkasi) bosqichini o'zgartiradi. Yakunlangan (COMPLETED) yoki yo'qotilgan (LOST) mijozni qayta ochib bo'lmaydi.",
  input_schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string', description: 'Mijoz ID' },
      newStage: { type: 'string', enum: PIPELINE_STAGES, description: "Yangi bosqich" },
    },
    required: ['clientId', 'newStage'],
  },
  execute: async (prisma, ctx, params) => {
    const newStage = String(params?.newStage || '').toUpperCase();
    if (!PIPELINE_STAGES.includes(newStage)) {
      return { error: `Noto'g'ri bosqich. Ruxsat etilganlar: ${PIPELINE_STAGES.join(', ')}` };
    }

    const owned = await requireOwnedClient(prisma, ctx, params?.clientId);
    if ('error' in owned) return owned;
    const client = owned.client;

    const oldStage = client.pipelineStage;
    if ((oldStage === 'COMPLETED' || oldStage === 'LOST') && newStage !== oldStage) {
      return { error: "Yakunlangan/yo'qotilgan mijozni qayta ochib bo'lmaydi, buni admin qilishi kerak" };
    }
    if (oldStage === newStage) {
      return { success: true, clientName: client.fullName, oldStage, newStage, note: 'Mijoz allaqachon shu bosqichda edi' };
    }

    await prisma.client.update({
      where: { id: client.id },
      data: { pipelineStage: newStage as any, pipelineStageAt: new Date() },
    });

    await prisma.stageHistory.create({
      data: {
        clientId: client.id,
        userId: ctx.userId,
        fromStage: oldStage as any,
        toStage: newStage as any,
        note: 'Jarvis (AI yordamchi) orqali o\'zgartirildi',
      },
    }).catch(() => {});

    await prisma.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'STAGE_CHANGE' as any,
        entity: 'client',
        entityId: client.id,
        changes: { pipelineStage: { from: oldStage, to: newStage } },
        metadata: { via: 'ai-assistant' },
      },
    }).catch(() => {});

    return { success: true, clientName: client.fullName, oldStage, newStage };
  },
};

// ─────────────────────────────────────────────────────────────
// 11) createOfferDraft
// ─────────────────────────────────────────────────────────────
// ESLATMA: Loyihada alohida "Offer" Prisma modeli YO'Q — takliflar
// Client.preferences.offers JSON massivida saqlanadi (qarang:
// src/modules/offers/offers.module.ts). Shu sababli bu yerda ham xuddi
// shu joyga, xuddi shu minimal shaklda ('DRAFT' status bilan) yoziladi —
// mavjud "Takliflar" ekrani buni to'g'ridan-to'g'ri ko'rsata oladi.
// Valyuta konvertatsiyasi (CBU.uz) BU YERDA QILINMAYDI — agar valyuta
// USD bo'lmasa, taklif "USD emas" ekanini ochiq belgilab qo'yadi va
// narxni original valyutada saqlaydi (foydalanuvchi keyin "Takliflar"
// ekranida to'g'rilashi mumkin).
const createOfferDraft: AiToolDefinition = {
  name: 'createOfferDraft',
  description:
    "Mijoz uchun taklif (offer) QORALAMASINI yaratadi — DRAFT holatida, hali yuborilmagan. Mavjud 'Takliflar' bo'limida ko'rinadi va u yerdan tahrirlab/yuborib bo'ladi.",
  input_schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string', description: 'Mijoz ID' },
      tourId: { type: 'string', description: "(Ixtiyoriy) marketplace tur ID — searchMarketplaceTours natijasidan" },
      description: { type: 'string', description: "Taklif tavsifi/tur nomi, masalan 'Antalya, 7 kecha, Rixos'" },
      price: { type: 'number', description: '1 kishi uchun narx' },
      currency: { type: 'string', enum: ['USD', 'EUR', 'UZS', 'RUB'], description: "Valyuta (standart USD)" },
    },
    required: ['clientId', 'description', 'price'],
  },
  execute: async (prisma, ctx, params) => {
    const owned = await requireOwnedClient(prisma, ctx, params?.clientId);
    if ('error' in owned) return owned;
    const client = owned.client;

    const description = String(params?.description || '').trim();
    if (!description) return { error: "Taklif tavsifi bo'sh bo'lishi mumkin emas" };

    const price = Number(params?.price);
    if (!Number.isFinite(price) || price <= 0) return { error: "Narx noto'g'ri (0 dan katta bo'lishi kerak)" };

    let destination: string | null = null;
    if (params?.tourId) {
      const tour = await prisma.marketplaceTour.findFirst({
        where: { id: params.tourId, tenantId: ctx.tenantId },
      });
      if (!tour) return { error: "Ko'rsatilgan tur (tourId) topilmadi" };
      destination = tour.destination;
      // Narx tur narxidan 3 barobardan ko'p oshib ketsa — mantiqsiz, rad etamiz
      if (tour.price && price > tour.price * 3) {
        return { error: `Narx ($${price}) tanlangan tur narxidan ($${tour.price}) mantiqsiz baland. Iltimos tekshiring.` };
      }
    }

    const currency = ['USD', 'EUR', 'UZS', 'RUB'].includes(params?.currency) ? params.currency : 'USD';
    const prefs: any = (client as any).preferences || {};
    if (!prefs.offers) prefs.offers = [];

    const offer = {
      id: Date.now().toString(),
      agentId: ctx.userId,
      tourName: description,
      destination,
      pax: 1,
      adults: 1,
      children: 0,
      actualPrice: 0,
      markup: currency === 'USD' ? price : 0,
      clientPrice: currency === 'USD' ? price : 0,
      pricePerPerson: currency === 'USD' ? price : 0,
      currency: currency === 'USD' ? 'USD' : currency,
      // v41: agar USD bo'lmasa, konvertatsiya qilinmagan — ochiq belgilaymiz
      needsCurrencyConversion: currency !== 'USD',
      originalCurrency: currency !== 'USD' ? currency : undefined,
      originalAmount: currency !== 'USD' ? price : undefined,
      marketplaceTourId: params?.tourId || undefined,
      status: 'DRAFT',
      createdVia: 'ai-assistant',
      createdAt: new Date().toISOString(),
    };
    prefs.offers.push(offer);

    await prisma.client.update({ where: { id: client.id }, data: { preferences: prefs } });

    await prisma.clientTimeline.create({
      data: {
        clientId: client.id,
        userId: ctx.userId,
        type: 'offer_created',
        title: 'Taklif qoralamasi yaratildi (Jarvis): ' + description,
        description: currency === 'USD' ? `$${price}` : `${price} ${currency}`,
        metadata: { offerId: offer.id, tourName: description },
      } as any,
    }).catch(() => {});

    return {
      success: true,
      offerId: offer.id,
      summary: `${description} — ${currency === 'USD' ? '$' + price : price + ' ' + currency} (DRAFT, hali yuborilmagan)`,
    };
  },
};

// ─────────────────────────────────────────────────────────────
// 12) createBookingDraft
// ─────────────────────────────────────────────────────────────
const createBookingDraft: AiToolDefinition = {
  name: 'createBookingDraft',
  description:
    "Mijoz uchun booking (bron) QORALAMASINI yaratadi — DRAFT holatida. Hech qachon to'lov/tasdiqlash bilan bog'liq maydonlarni to'ldirmaydi — buni faqat inson (agent/admin) qila oladi.",
  input_schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string', description: 'Mijoz ID' },
      tourName: { type: 'string', description: 'Tur nomi' },
      destination: { type: 'string', description: 'Manzil' },
      departureDate: { type: 'string', description: "Jo'nash sanasi, ISO formatda" },
      totalPrice: { type: 'number', description: "Umumiy narx" },
      currency: { type: 'string', enum: ['USD', 'EUR', 'UZS', 'RUB'], description: "Valyuta (standart USD)" },
      marketplaceTourId: { type: 'string', description: "(Ixtiyoriy) marketplace tur ID" },
    },
    required: ['clientId', 'tourName', 'destination', 'departureDate', 'totalPrice'],
  },
  execute: async (prisma, ctx, params) => {
    const owned = await requireOwnedClient(prisma, ctx, params?.clientId);
    if ('error' in owned) return owned;
    const client = owned.client;

    const tourName = String(params?.tourName || '').trim();
    const destination = String(params?.destination || '').trim();
    if (!tourName || !destination) return { error: "Tur nomi va manzil bo'sh bo'lishi mumkin emas" };

    const totalPrice = Number(params?.totalPrice);
    if (!Number.isFinite(totalPrice) || totalPrice <= 0) return { error: "Narx noto'g'ri (0 dan katta bo'lishi kerak)" };

    const departureDate = new Date(params?.departureDate);
    if (isNaN(departureDate.getTime())) return { error: "Jo'nash sanasi noto'g'ri formatda" };

    const currency = ['USD', 'EUR', 'UZS', 'RUB'].includes(params?.currency) ? params.currency : 'USD';

    let warning: string | undefined;
    if (params?.marketplaceTourId) {
      const tour = await prisma.marketplaceTour.findFirst({
        where: { id: params.marketplaceTourId, tenantId: ctx.tenantId },
      });
      if (!tour) return { error: "Ko'rsatilgan tur (marketplaceTourId) topilmadi" };
      const mismatches: string[] = [];
      if (tour.destination && tour.destination.toLowerCase() !== destination.toLowerCase()) {
        mismatches.push(`manzil (tur: ${tour.destination})`);
      }
      if (tour.price && currency === 'USD' && Math.abs(tour.price - totalPrice) > tour.price * 0.5) {
        mismatches.push(`narx (tur bazaviy narxi: $${tour.price})`);
      }
      if (mismatches.length) warning = `Diqqat: kiritilgan ma'lumot tur ma'lumotidan farq qiladi — ${mismatches.join(', ')}.`;
    }

    // Faqat DRAFT — BookingStatus enum'ida "PENDING" yo'q, DRAFT eng yaqin muqobili
    const count = await prisma.booking.count({ where: { tenantId: ctx.tenantId } });
    let bookingRef = generateRef('TRV', count);
    const existingRef = await prisma.booking.findFirst({ where: { bookingRef } });
    if (existingRef) bookingRef = generateRef('TRV', count + Math.floor(Math.random() * 1000) + 1);

    const booking = await prisma.booking.create({
      data: {
        tenantId: ctx.tenantId,
        bookingRef,
        clientId: client.id,
        agentId: ctx.userId,
        tourName,
        destination,
        departureDate,
        totalPrice,
        currency: currency as any,
        paidAmount: 0,
        status: 'DRAFT' as any,
        marketplaceTourId: params?.marketplaceTourId || undefined,
        notes: 'Jarvis (AI yordamchi) orqali qoralama sifatida yaratildi',
      },
    });

    await prisma.clientTimeline.create({
      data: {
        clientId: client.id,
        userId: ctx.userId,
        type: 'booking',
        title: 'Booking qoralamasi yaratildi (Jarvis): ' + booking.bookingRef,
        description: tourName,
        metadata: { bookingId: booking.id, bookingRef: booking.bookingRef },
      } as any,
    }).catch(() => {});

    return { success: true, bookingRef: booking.bookingRef, status: booking.status, warning };
  },
};

// ─────────────────────────────────────────────────────────────
// 13) createClientLead
// ─────────────────────────────────────────────────────────────
const createClientLead: AiToolDefinition = {
  name: 'createClientLead',
  description:
    "Yangi mijoz (lead) yaratadi va uni avtomatik SIZGA (buyruq bergan agentga) biriktiradi. Xuddi shu telefon raqami bilan mijoz allaqachon mavjud bo'lsa, dublikat yaratilmaydi.",
  input_schema: {
    type: 'object',
    properties: {
      fullName: { type: 'string', description: "Mijozning to'liq ismi" },
      phone: { type: 'string', description: "Telefon raqami" },
      source: {
        type: 'string',
        enum: ['TELEGRAM', 'INSTAGRAM', 'WHATSAPP', 'REFERRAL', 'WALKIN', 'WEBSITE', 'CALL', 'FACEBOOK', 'GOOGLE_ADS', 'OTHER'],
        description: "Manba (standart OTHER)",
      },
      note: { type: 'string', description: "(Ixtiyoriy) qisqa izoh" },
    },
    required: ['fullName', 'phone'],
  },
  execute: async (prisma, ctx, params) => {
    const fullName = String(params?.fullName || '').trim();
    if (!fullName) return { error: "To'liq ism bo'sh bo'lishi mumkin emas" };

    const rawPhone = String(params?.phone || '').trim();
    if (!rawPhone) return { error: "Telefon raqam bo'sh bo'lishi mumkin emas" };
    const normalized = normalizePhone(rawPhone) || rawPhone;

    const variants = phoneVariants(rawPhone);
    const existing = await prisma.client.findFirst({
      where: {
        tenantId: ctx.tenantId,
        OR: [{ phone: { in: variants } }, { phone2: { in: variants } }],
      },
      select: { id: true, fullName: true },
    });
    if (existing) {
      return { error: `Bu raqam bilan mijoz allaqachon mavjud: ${existing.fullName}` };
    }

    const source = [
      'TELEGRAM', 'INSTAGRAM', 'WHATSAPP', 'REFERRAL', 'WALKIN', 'WEBSITE', 'CALL', 'FACEBOOK', 'GOOGLE_ADS', 'OTHER',
    ].includes(params?.source) ? params.source : 'OTHER';

    const client = await prisma.client.create({
      data: {
        tenantId: ctx.tenantId,
        fullName,
        phone: normalized,
        source: source as any,
        assignedAgentId: ctx.userId,
        assignedAt: new Date(),
        notes: params?.note ? String(params.note).trim() : undefined,
      },
    });

    await prisma.clientTimeline.create({
      data: {
        clientId: client.id,
        userId: ctx.userId,
        type: 'created',
        title: 'Lead yaratildi (Jarvis orqali)',
        description: params?.note ? String(params.note).trim() : undefined,
        metadata: { source },
      } as any,
    }).catch(() => {});

    return { success: true, clientId: client.id, fullName: client.fullName };
  },
};

// ─────────────────────────────────────────────────────────────
// 14) addClientNote
// ─────────────────────────────────────────────────────────────
const addClientNote: AiToolDefinition = {
  name: 'addClientNote',
  description: "Mijoz tarixiga (timeline) izoh qo'shadi.",
  input_schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string', description: 'Mijoz ID' },
      note: { type: 'string', description: 'Izoh matni' },
    },
    required: ['clientId', 'note'],
  },
  execute: async (prisma, ctx, params) => {
    const note = String(params?.note || '').trim();
    if (!note) return { error: "Izoh matni bo'sh bo'lishi mumkin emas" };

    const owned = await requireOwnedClient(prisma, ctx, params?.clientId);
    if ('error' in owned) return owned;

    const entry = await prisma.clientTimeline.create({
      data: {
        clientId: owned.client.id,
        userId: ctx.userId,
        type: 'note',
        title: 'Izoh (Jarvis orqali)',
        description: note,
        metadata: {},
      } as any,
    });

    return { success: true, noteId: entry.id };
  },
};

// ─────────────────────────────────────────────────────────────
// 15) markTaskDone
// ─────────────────────────────────────────────────────────────
const markTaskDone: AiToolDefinition = {
  name: 'markTaskDone',
  description: "Vazifani (task) yakunlangan deb belgilaydi. Faqat o'ziga biriktirilgan (yoki ADMIN/MANAGER bo'lsa istalgan) vazifani yakunlay oladi.",
  input_schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Vazifa ID' },
    },
    required: ['taskId'],
  },
  execute: async (prisma, ctx, params) => {
    const taskId = String(params?.taskId || '').trim();
    if (!taskId) return { error: "taskId ko'rsatilmagan" };

    const task = await prisma.task.findFirst({ where: { id: taskId, tenantId: ctx.tenantId } });
    if (!task) return { error: 'Bu vazifa topilmadi' };

    const isPrivileged = ctx.role === 'TENANT_ADMIN' || ctx.role === 'MANAGER';
    if (task.assigneeId !== ctx.userId && !isPrivileged) {
      return { error: 'Bu vazifa sizga biriktirilmagan.' };
    }
    if (task.status === 'DONE') {
      return { success: true, title: task.title, note: 'Vazifa allaqachon yakunlangan edi' };
    }

    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'DONE' as any, completedAt: new Date() },
    });

    return { success: true, title: task.title };
  },
};

// ─────────────────────────────────────────────────────────────
// 16) rescheduleFollowup
// ─────────────────────────────────────────────────────────────
const rescheduleFollowup: AiToolDefinition = {
  name: 'rescheduleFollowup',
  description: "O'zining follow-up (eslatma) muddatini boshqa sanaga ko'chiradi. Faqat o'ziga tegishli eslatmani ko'chira oladi.",
  input_schema: {
    type: 'object',
    properties: {
      followUpId: { type: 'string', description: 'Eslatma ID' },
      newDueAt: { type: 'string', description: 'Yangi muddat, ISO sana-vaqt formatida' },
    },
    required: ['followUpId', 'newDueAt'],
  },
  execute: async (prisma, ctx, params) => {
    const followUpId = String(params?.followUpId || '').trim();
    if (!followUpId) return { error: "followUpId ko'rsatilmagan" };
    const newDueAt = new Date(params?.newDueAt);
    if (isNaN(newDueAt.getTime())) return { error: "Yangi muddat (newDueAt) noto'g'ri formatda" };

    const followUp = await prisma.followUp.findFirst({ where: { id: followUpId, tenantId: ctx.tenantId } });
    if (!followUp) return { error: 'Bu eslatma topilmadi' };
    if (followUp.agentId !== ctx.userId) return { error: 'Bu eslatma sizga tegishli emas.' };

    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { dueAt: newDueAt, notifiedAt: null },
    });

    return { success: true, title: followUp.title, newDueAt };
  },
};

// ─────────────────────────────────────────────────────────────
// 17) getInvoiceStatus (read-only)
// ─────────────────────────────────────────────────────────────
const getInvoiceStatus: AiToolDefinition = {
  name: 'getInvoiceStatus',
  description: "Hisob-faktura (invoice) to'lov holatini qaytaradi — booking raqami yoki mijoz ismi/telefoni bo'yicha qidiradi. Faqat o'qiydi, hech qanday moliyaviy amal bajarmaydi.",
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Booking raqami, invoyce raqami yoki mijoz ismi/telefoni" },
    },
    required: ['query'],
  },
  execute: async (prisma, ctx, params) => {
    const query = String(params?.query || '').trim();
    if (!query) return { error: "Qidiruv so'zi bo'sh" };
    const variants = phoneVariants(query);

    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...agentScope(ctx, 'agentId'),
        OR: [
          { invoiceNumber: { contains: query, mode: 'insensitive' } },
          { booking: { bookingRef: { contains: query, mode: 'insensitive' } } },
          { client: { fullName: { contains: query, mode: 'insensitive' } } },
          ...(variants.length ? [{ client: { phone: { in: variants } } }] : []),
        ],
      } as any,
      select: {
        id: true, invoiceNumber: true, status: true, totalAmount: true, paidAmount: true,
        currency: true, dueDate: true, issuedAt: true, paidAt: true,
        client: { select: { fullName: true, phone: true } },
        booking: { select: { bookingRef: true } },
      },
      orderBy: { issuedAt: 'desc' },
      take: 5,
    });

    if (!invoices.length) return { found: false, message: "Bunday hisob-faktura topilmadi." };

    return {
      found: true,
      invoices: invoices.map((i) => ({
        invoiceNumber: i.invoiceNumber,
        bookingRef: i.booking?.bookingRef,
        clientName: i.client?.fullName,
        status: i.status,
        totalAmount: i.totalAmount,
        paidAmount: i.paidAmount,
        remaining: Math.max(0, (i.totalAmount || 0) - (i.paidAmount || 0)),
        currency: i.currency,
        dueDate: i.dueDate,
        paidAt: i.paidAt,
      })),
    };
  },
};

// ─────────────────────────────────────────────────────────────
// 18) getClientTimeline (read-only)
// ─────────────────────────────────────────────────────────────
const getClientTimeline: AiToolDefinition = {
  name: 'getClientTimeline',
  description: "Mijozning to'liq tarixini (qo'ng'iroqlar, xabarlar, izohlar, bosqich o'zgarishlari va h.k.) xronologik tartibda (oxirgi 20 ta yozuv) qaytaradi.",
  input_schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string', description: 'Mijoz ID' },
    },
    required: ['clientId'],
  },
  execute: async (prisma, ctx, params) => {
    const clientId = String(params?.clientId || '').trim();
    if (!clientId) return { error: "clientId ko'rsatilmagan" };

    const client = await prisma.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, ...agentScope(ctx) },
      select: { id: true, fullName: true },
    });
    if (!client) return { error: 'Bu mijoz sizga tegishli emas yoki topilmadi' };

    const events = await prisma.clientTimeline.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { type: true, title: true, description: true, createdAt: true },
    });

    return {
      clientName: client.fullName,
      count: events.length,
      timeline: events.map((e) => ({
        type: e.type,
        title: e.title,
        description: e.description,
        date: e.createdAt,
      })),
    };
  },
};

export const AI_TOOLS: AiToolDefinition[] = [
  // ── O'qish (1-bosqich) ──
  getClientInfo,
  listPipelineByStage,
  getTodayFollowups,
  getCallAnalysisSummary,
  getKpiStats,
  getBookingStatus,
  searchMarketplaceTours,
  // ── Yozuvchi (2-bosqich) ──
  createTask,
  draftFollowupMessage,
  updatePipelineStage,
  createOfferDraft,
  createBookingDraft,
  createClientLead,
  addClientNote,
  markTaskDone,
  rescheduleFollowup,
  // ── Qo'shimcha o'qish (2-bosqich) ──
  getInvoiceStatus,
  getClientTimeline,
];

const AI_TOOLS_BY_NAME: Record<string, AiToolDefinition> = Object.fromEntries(
  AI_TOOLS.map((t) => [t.name, t]),
);

/** Claude API'ga yuboriladigan `tools` massivi (faqat spec, execute yo'q) */
export function getAnthropicToolsSpec() {
  return AI_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/** Bitta tool'ni xavfsiz bajaradi — noma'lum tool yoki xato bo'lsa, Claude'ga tushunarli xato qaytaradi (throw qilmaydi) */
export async function executeAiTool(
  prisma: PrismaService,
  ctx: AiToolContext,
  toolName: string,
  toolInput: any,
): Promise<any> {
  const tool = AI_TOOLS_BY_NAME[toolName];
  if (!tool) return { error: `Noma'lum tool: ${toolName}` };
  try {
    return await tool.execute(prisma, ctx, toolInput || {});
  } catch (e: any) {
    return { error: `Tool xatosi (${toolName}): ${e?.message || 'noma\'lum xato'}` };
  }
}