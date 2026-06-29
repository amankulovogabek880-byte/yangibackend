"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeEnum = safeEnum;
exports.toInt = toInt;
exports.toFloat = toFloat;
exports.paginate = paginate;
exports.meta = meta;
exports.calculateLeadScore = calculateLeadScore;
exports.generateRef = generateRef;
exports.clean = clean;
exports.pickNextAgent = pickNextAgent;
function safeEnum(val, list, def) {
    return list.includes(val) ? val : def;
}
function toInt(val, def) {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function toFloat(val, def = 0) {
    const n = Number(val);
    return Number.isFinite(n) ? n : def;
}
function paginate(page, limit, maxLimit = 100) {
    const p = Math.max(1, toInt(page, 1));
    const l = Math.min(maxLimit, toInt(limit, 25));
    return { skip: (p - 1) * l, take: l, page: p, limit: l };
}
function meta(total, page, limit) {
    return { total, page, limit, totalPages: Math.ceil(total / limit) };
}
function calculateLeadScore(client) {
    let score = 50;
    const sourceBoost = {
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
    if ((client.totalBookings || 0) > 0)
        score += 15;
    if ((client.totalBookings || 0) >= 3)
        score += 10;
    if ((client.totalRevenue || 0) > 1000)
        score += 5;
    if ((client.totalRevenue || 0) > 5000)
        score += 5;
    const tierBoost = {
        VIP: 20, GOLD: 15, SILVER: 10, REGULAR: 0,
    };
    score += tierBoost[client.tier || ''] || 0;
    if (client.email)
        score += 3;
    if (client.passportNo)
        score += 5;
    const stageBoost = {
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
    if (days > 7)
        score -= 5;
    if (days > 30)
        score -= 15;
    if (days > 90)
        score -= 30;
    return Math.max(0, Math.min(100, Math.round(score)));
}
function generateRef(prefix, count) {
    const year = new Date().getFullYear();
    const ms = Date.now().toString(36).toUpperCase().slice(-4);
    const rnd = Math.floor(Math.random() * 36 * 36).toString(36).toUpperCase().padStart(2, '0');
    return `${prefix}-${year}-${String(count + 1).padStart(4, '0')}-${ms}${rnd}`;
}
function clean(obj) {
    const out = {};
    for (const k of Object.keys(obj)) {
        if (obj[k] !== undefined)
            out[k] = obj[k];
    }
    return out;
}
async function pickNextAgent(prisma, tenantId) {
    try {
        const agents = await prisma.user.findMany({
            where: {
                tenantId,
                role: { in: ['AGENT', 'MANAGER', 'TENANT_ADMIN'] },
                status: 'ACTIVE',
                isPausedFromAssignment: false,
            },
            select: { id: true, lastAssignedAt: true, dailyLeadLimit: true },
        });
        if (!agents || agents.length === 0) {
            console.warn('[pickNextAgent] No available agents for tenant:', tenantId);
            return null;
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const available = [];
        for (const agent of agents) {
            if (!agent.dailyLeadLimit || agent.dailyLeadLimit === 0) {
                available.push(agent);
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
        available.sort((a, b) => {
            const aT = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
            const bT = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
            return aT - bT;
        });
        const next = available[0];
        console.log('[pickNextAgent] → Agent:', next.id, '| lastAssigned:', next.lastAssignedAt);
        try {
            await prisma.user.update({
                where: { id: next.id },
                data: { lastAssignedAt: new Date() },
            });
        }
        catch (updateErr) {
            console.error('[pickNextAgent] lastAssignedAt update FAILED:', updateErr?.message);
            console.error('[pickNextAgent] => Run: npx prisma db push');
        }
        return next.id;
    }
    catch (e) {
        console.error('[pickNextAgent] FATAL error:', e?.message || e);
        return null;
    }
}
//# sourceMappingURL=helpers.js.map