import { PrismaService } from '../../prisma/prisma.service';
import { hasPermission } from '../../common/permissions/permissions.constants';
import { phoneVariants } from '../../common/utils/helpers';

/**
 * ═══════════════════════════════════════════════════════════════
 * v40: AI YORDAMCHI ("JARVIS") — Tool ro'yxati (1-BOSQICH: read-only)
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

export const AI_TOOLS: AiToolDefinition[] = [
  getClientInfo,
  listPipelineByStage,
  getTodayFollowups,
  getCallAnalysisSummary,
  getKpiStats,
  getBookingStatus,
  searchMarketplaceTours,
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