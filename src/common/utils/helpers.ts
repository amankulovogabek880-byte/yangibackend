/**
 * Common utility helpers used across services.
 */

export function safeEnum<T extends string>(val: any, list: readonly T[], def: T): T {
  return list.includes(val) ? (val as T) : def;
}

export function toInt(val: any, def: number): number {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export function toFloat(val: any, def = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}

export function paginate(page: any, limit: any, maxLimit = 100) {
  const p = Math.max(1, toInt(page, 1));
  const l = Math.min(maxLimit, toInt(limit, 25));
  return { skip: (p - 1) * l, take: l, page: p, limit: l };
}

export function meta(total: number, page: number, limit: number) {
  return { total, page, limit, totalPages: Math.ceil(total / limit) };
}

/**
 * Calculate lead score (0-100) based on client attributes and activity.
 */
export function calculateLeadScore(client: {
  source?: string;
  totalBookings?: number;
  totalRevenue?: number;
  pipelineStage?: string;
  tier?: string;
  email?: string | null;
  passportNo?: string | null;
  daysSinceContact?: number;
}): number {
  let score = 50;

  const sourceBoost: Record<string, number> = {
    REFERRAL: 25,
    WALKIN: 20,
    WEBSITE: 15,
    TELEGRAM: 10,
    INSTAGRAM: 10,
    CALL: 15,
    WHATSAPP: 10,
    OTHER: 0,
  };
  score += sourceBoost[client.source || ''] || 0;

  if ((client.totalBookings || 0) > 0) score += 15;
  if ((client.totalBookings || 0) >= 3) score += 10;
  if ((client.totalRevenue || 0) > 1000) score += 5;
  if ((client.totalRevenue || 0) > 5000) score += 5;

  const tierBoost: Record<string, number> = {
    VIP: 20, GOLD: 15, SILVER: 10, REGULAR: 0,
  };
  score += tierBoost[client.tier || ''] || 0;

  if (client.email) score += 3;
  if (client.passportNo) score += 5;

  const stageBoost: Record<string, number> = {
    NEW_LEAD: 0,
    CONTACTED: 5,
    INTERESTED: 10,
    OFFER_SENT: 15,
    NEGOTIATION: 20,
    DEPOSIT_PAID: 25,
    CONFIRMED: 30,
  };
  score += stageBoost[client.pipelineStage || ''] || 0;

  const days = client.daysSinceContact ?? 0;
  if (days > 7) score -= 5;
  if (days > 30) score -= 15;
  if (days > 90) score -= 30;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function generateRef(prefix: string, count: number): string {
  // count asosida + millisekund + random — unique kafolatlash uchun
  const year = new Date().getFullYear();
  const ms = Date.now().toString(36).toUpperCase().slice(-4);
  const rnd = Math.floor(Math.random() * 36 * 36).toString(36).toUpperCase().padStart(2, '0');
  return `${prefix}-${year}-${String(count + 1).padStart(4, '0')}-${ms}${rnd}`;
}

export function clean<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: any = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/**
 * ROUND-ROBIN: Keyingi agentni qaytaradi
 * - lastAssignedAt null = hech qachon olmagan = BIRINCHI navbatda
 * - eng eski tayinlangan = keyingi navbat
 * - lastAssignedAt ni avtomatik yangilaydi
 */
export async function pickNextAgent(prisma: any, tenantId: string): Promise<string | null> {
  try {
    // BUG1 FIX: isPausedFromAssignment: false qo'shildi
    // BUG3 FIX: dailyLeadLimit select ga qo'shildi
    const agents = await prisma.user.findMany({
      where: {
        tenantId,
        role: { in: ['AGENT', 'MANAGER', 'TENANT_ADMIN'] },
        status: 'ACTIVE',
        isPausedFromAssignment: false,  // BUG1 FIX
      },
      select: { id: true, lastAssignedAt: true, dailyLeadLimit: true }, // BUG3 FIX
    });

    if (!agents || agents.length === 0) {
      console.warn('[pickNextAgent] No available agents for tenant:', tenantId);
      return null;
    }

    // BUG3 FIX: dailyLeadLimit tekshirish
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const available: any[] = [];
    for (const agent of agents) {
      if (!agent.dailyLeadLimit || agent.dailyLeadLimit === 0) {
        available.push(agent); // 0 = cheksiz
        continue;
      }
      const todayCount = await prisma.client.count({
        where: { assignedAgentId: agent.id, createdAt: { gte: today } },
      });
      if (todayCount < agent.dailyLeadLimit) {
        available.push(agent);
      }
    }

    if (available.length === 0) {
      console.warn('[pickNextAgent] All agents reached daily limit for tenant:', tenantId);
      return null;
    }

    // Round-Robin sort: null=0 = hech qachon olmagan = birinchi
    available.sort((a: any, b: any) => {
      const aT = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
      const bT = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
      return aT - bT;
    });

    const next = available[0];
    console.log('[pickNextAgent] → Agent:', next.id, '| lastAssigned:', next.lastAssignedAt);

    // lastAssignedAt yangilaymiz (xato bo'lsa ham agent ID qaytaramiz)
    try {
      await prisma.user.update({
        where: { id: next.id },
        data: { lastAssignedAt: new Date() },
      });
    } catch (updateErr: any) {
      console.error('[pickNextAgent] lastAssignedAt update FAILED:', updateErr?.message);
      console.error('[pickNextAgent] => Run: npx prisma db push');
    }

    return next.id;

  } catch (e: any) {
    console.error('[pickNextAgent] FATAL error:', e?.message || e);
    return null;
  }
}
