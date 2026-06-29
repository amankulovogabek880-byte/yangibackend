"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportsModule = exports.ReportsController = exports.ReportsService = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
let ReportsService = class ReportsService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger('Reports');
    }
    async calendarReport(tenantId, userId, role, date, from, to) {
        const agentFilter = role === 'AGENT' ? { agentId: userId } : {};
        const clientAgentFilter = role === 'AGENT' ? { assignedAgentId: userId } : {};
        let start, end, isSingleDay;
        if (date) {
            const [y, m, d] = date.split('-').map(Number);
            start = new Date(y, m - 1, d, 0, 0, 0);
            end = new Date(y, m - 1, d, 23, 59, 59);
            isSingleDay = true;
        }
        else if (from && to) {
            const [fy, fm, fd] = from.split('-').map(Number);
            const [ty, tm, td] = to.split('-').map(Number);
            start = new Date(fy, fm - 1, fd, 0, 0, 0);
            end = new Date(ty, tm - 1, td, 23, 59, 59);
            isSingleDay = false;
        }
        else {
            const n = new Date();
            start = new Date(n.getFullYear(), n.getMonth(), n.getDate());
            end = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59);
            isSingleDay = true;
        }
        const df = { gte: start, lte: end };
        const [leads, bookings, payments] = await Promise.all([
            this.prisma.client.findMany({
                where: { tenantId, ...clientAgentFilter, createdAt: df },
                select: { id: true, fullName: true, phone: true, source: true, pipelineStage: true, createdAt: true, assignedAgent: { select: { name: true } } },
                orderBy: { createdAt: 'asc' },
            }),
            this.prisma.booking.findMany({
                where: { tenantId, ...agentFilter, createdAt: df },
                include: { client: { select: { fullName: true } }, agent: { select: { name: true } } },
                orderBy: { createdAt: 'desc' },
            }),
            this.prisma.payment.findMany({
                where: { tenantId, paidAt: df },
                select: { amount: true, currency: true, method: true, paidAt: true },
            }),
        ]);
        const confirmed = bookings.filter((b) => ['CONFIRMED', 'COMPLETED'].includes(b.status));
        const stats = {
            revenue: confirmed.reduce((s, b) => s + (b.totalPrice || 0), 0),
            profit: confirmed.reduce((s, b) => s + (b.profit || 0), 0),
            paid: payments.reduce((s, p) => s + (p.amount || 0), 0),
            newLeads: leads.length,
            newClients: leads.length,
            bookingsCount: bookings.length,
            confirmedBookings: confirmed.length,
        };
        const [tlRows] = await Promise.all([
            this.prisma.clientTimeline.findMany({ where: { createdAt: df }, orderBy: { createdAt: 'asc' }, take: 200 }).catch(() => []),
        ]);
        const payEvents = payments.map((p) => ({ type: 'payment', title: `💰 To\'lov: ${p.currency} ${p.amount}`, createdAt: p.paidAt, metadata: { method: p.method } }));
        const bkEvents = bookings.map((b) => ({ type: 'booking', title: `✈️ Booking: ${b.client?.fullName || ''} — ${b.tourName}`, createdAt: b.createdAt, metadata: { status: b.status, amount: b.totalPrice } }));
        const timeline = [...tlRows, ...payEvents, ...bkEvents].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const agents = await this.prisma.user.findMany({
            where: { tenantId, role: { in: ['AGENT', 'MANAGER', 'TENANT_ADMIN'] }, status: 'ACTIVE' },
            select: { id: true, name: true },
        });
        const agentIds = agents.map((a) => a.id);
        const [agentLeads, agentBookings, agentCalls] = await Promise.all([
            this.prisma.client.groupBy({
                by: ['assignedAgentId'],
                where: { tenantId, assignedAgentId: { in: agentIds }, createdAt: df },
                _count: { id: true },
            }).catch(() => []),
            this.prisma.booking.groupBy({
                by: ['agentId'],
                where: { tenantId, agentId: { in: agentIds }, createdAt: df },
                _count: { id: true },
            }).catch(() => []),
            this.prisma.call.groupBy({
                by: ['agentId'],
                where: { tenantId, agentId: { in: agentIds }, createdAt: df },
                _count: { id: true },
            }).catch(() => []),
        ]);
        const agentActivity = agents.map((a) => ({
            agent: a,
            leads: agentLeads.find((r) => r.assignedAgentId === a.id)?._count?.id || 0,
            bookings: agentBookings.find((r) => r.agentId === a.id)?._count?.id || 0,
            calls: agentCalls.find((r) => r.agentId === a.id)?._count?.id || 0,
        }));
        const srcMap = {};
        leads.forEach((c) => { srcMap[c.source || 'OTHER'] = (srcMap[c.source || 'OTHER'] || 0) + 1; });
        const sourceBreakdown = Object.entries(srcMap).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
        let dailyBreakdown = [];
        let bestDay = null;
        if (!isSingleDay) {
            const [allLeadsInRange, allBookingsInRange] = await Promise.all([
                this.prisma.client.findMany({
                    where: { tenantId, ...clientAgentFilter, createdAt: { gte: start, lte: end } },
                    select: { createdAt: true },
                }).catch(() => []),
                this.prisma.booking.findMany({
                    where: { tenantId, ...agentFilter, createdAt: { gte: start, lte: end } },
                    select: { createdAt: true, totalPrice: true, profit: true, status: true },
                }).catch(() => []),
            ]);
            const totalDays = Math.min(Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1, 366);
            const dayMap = {};
            for (let i = 0; i < totalDays; i++) {
                const d = new Date(start);
                d.setDate(d.getDate() + i);
                dayMap[d.toISOString().slice(0, 10)] = { leads: 0, bookings: 0, revenue: 0, profit: 0 };
            }
            for (const c of allLeadsInRange) {
                const key = new Date(c.createdAt).toISOString().slice(0, 10);
                if (dayMap[key])
                    dayMap[key].leads++;
            }
            for (const b of allBookingsInRange) {
                const key = new Date(b.createdAt).toISOString().slice(0, 10);
                if (dayMap[key]) {
                    dayMap[key].bookings++;
                    if (['CONFIRMED', 'COMPLETED'].includes(b.status)) {
                        dayMap[key].revenue += b.totalPrice || 0;
                        dayMap[key].profit += b.profit || 0;
                    }
                }
            }
            dailyBreakdown = Object.entries(dayMap).map(([date, v]) => ({ date, ...v }));
            bestDay = dailyBreakdown.reduce((a, b) => ((b.revenue + b.leads * 10) > (a.revenue + a.leads * 10) ? b : a), dailyBreakdown[0] || {});
        }
        return { isSingleDay, stats, leads, timeline, bookings, payments, agentActivity, sourceBreakdown, dailyBreakdown, bestDay };
    }
    safeNumber(val) {
        const num = Number(val);
        return isNaN(num) || val === null || val === undefined ? 0 : num;
    }
    safePercent(val, max = 100) {
        const num = this.safeNumber(val);
        return Math.min(Math.max(num, 0), max);
    }
    async dashboard(tenantId, userId, role, from, to) {
        try {
            const now = new Date();
            const monthStart = from
                ? (() => { const [y, m, d] = from.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0); })()
                : new Date(now.getFullYear(), now.getMonth(), 1);
            const monthEnd = to
                ? (() => { const [y, m, d] = to.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59); })()
                : now;
            const prevMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
            const prevMonthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth(), 0, 23, 59, 59);
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const bookingAgentFilter = role === 'AGENT' ? { agentId: userId } : {};
            const clientAgentFilter = role === 'AGENT' ? { assignedAgentId: userId } : {};
            const activeStatuses = { status: { in: ['CONFIRMED', 'COMPLETED', 'DRAFT'] } };
            const confirmedStatuses = { status: { in: ['CONFIRMED', 'COMPLETED'] } };
            const [totalClients, newClientsMonth, totalLeads, totalBookings, bookingsMonth, pendingBookings, clientsWithBookings, newLeadsMonth, thisMonthBookings, prevMonthBookings, agentPerformance, tenant, activeConversations,] = await Promise.all([
                this.prisma.client.count({ where: { tenantId, ...clientAgentFilter } }).catch(() => 0),
                this.prisma.client.count({ where: { tenantId, ...clientAgentFilter, createdAt: { gte: monthStart } } }).catch(() => 0),
                this.prisma.client.count({ where: { tenantId, ...clientAgentFilter, pipelineStage: { in: ['NEW_LEAD', 'CONTACTED', 'INTERESTED'] } } }).catch(() => 0),
                this.prisma.booking.count({ where: { tenantId, ...bookingAgentFilter, ...activeStatuses } }).catch(() => 0),
                this.prisma.booking.count({ where: { tenantId, ...bookingAgentFilter, ...activeStatuses, createdAt: { gte: monthStart } } }).catch(() => 0),
                this.prisma.booking.count({ where: { tenantId, ...bookingAgentFilter, status: { in: ['DRAFT', 'CONFIRMED'] } } }).catch(() => 0),
                this.prisma.client.count({
                    where: { tenantId, ...clientAgentFilter, createdAt: { gte: monthStart, lte: monthEnd }, bookings: { some: { status: { not: 'CANCELLED' } } } },
                }).catch(() => 0),
                this.prisma.client.count({
                    where: { tenantId, ...clientAgentFilter, pipelineStage: { in: ['NEW_LEAD', 'CONTACTED', 'INTERESTED'] }, createdAt: { gte: monthStart, lte: monthEnd } },
                }).catch(() => 0),
                this.prisma.booking.aggregate({
                    where: { tenantId, ...bookingAgentFilter, ...confirmedStatuses, createdAt: { gte: monthStart, lte: monthEnd } },
                    _sum: { totalPrice: true, supplierCost: true, profit: true },
                    _count: { id: true },
                }).catch(() => ({ _sum: { totalPrice: 0, supplierCost: 0, profit: 0 }, _count: { id: 0 } })),
                this.prisma.booking.aggregate({
                    where: { tenantId, ...bookingAgentFilter, ...confirmedStatuses, createdAt: { gte: prevMonthStart, lte: prevMonthEnd } },
                    _sum: { totalPrice: true, supplierCost: true, profit: true },
                    _count: { id: true },
                }).catch(() => ({ _sum: { totalPrice: 0, supplierCost: 0, profit: 0 }, _count: { id: 0 } })),
                role !== 'AGENT'
                    ? this.prisma.booking.groupBy({
                        by: ['agentId'],
                        where: { tenantId, ...confirmedStatuses, createdAt: { gte: monthStart }, agentId: { not: null } },
                        _sum: { totalPrice: true, profit: true, commissionAmount: true },
                        _count: { id: true },
                    }).catch(() => [])
                    : Promise.resolve([]),
                this.prisma.tenant.findUnique({
                    where: { id: tenantId },
                    select: { agentCommissionPercent: true, currency: true },
                }).catch(() => null),
                this.prisma.conversation.count({
                    where: { tenantId, isResolved: false, ...(role === 'AGENT' ? { OR: [{ assignedAgentId: userId }, { assignedAgentId: null }] } : {}) },
                }).catch(() => 0),
            ]);
            const kpiPercent = tenant?.agentCommissionPercent ?? 10;
            const revMonth = this.safeNumber(thisMonthBookings._sum?.totalPrice);
            const costMonth = this.safeNumber(thisMonthBookings._sum?.supplierCost);
            const profitMonth = this.safeNumber(thisMonthBookings._sum?.profit);
            const booksMonth = thisMonthBookings._count?.id ?? 0;
            const revPrev = this.safeNumber(prevMonthBookings._sum?.totalPrice);
            const growth = revPrev > 0 ? Math.round(((revMonth - revPrev) / revPrev) * 100) : 0;
            const mySalaryThisMonth = role === 'AGENT'
                ? Math.round(profitMonth * kpiPercent / 100)
                : 0;
            const totalAgentSalaries = role !== 'AGENT'
                ? agentPerformance.reduce((sum, a) => {
                    const stored = this.safeNumber(a._sum?.commissionAmount);
                    const calculated = this.safeNumber(a._sum?.profit) * kpiPercent / 100;
                    return sum + (stored > 0 ? stored : calculated);
                }, 0)
                : 0;
            const conversionRate = newClientsMonth > 0
                ? Math.min(100, Math.round((this.safeNumber(clientsWithBookings) / newClientsMonth) * 100))
                : 0;
            const netProfit = Math.max(0, profitMonth - totalAgentSalaries);
            return {
                clients: { total: totalClients, newThisMonth: newClientsMonth, newToday: 0 },
                leads: { total: totalLeads, newThisMonth: this.safeNumber(newLeadsMonth), newToday: 0 },
                bookings: { total: totalBookings, thisMonth: booksMonth, today: 0, pending: pendingBookings },
                revenue: {
                    thisMonth: revMonth,
                    prevMonth: revPrev,
                    today: 0,
                    growth,
                },
                cost: {
                    thisMonth: costMonth,
                    totalSales: revMonth,
                },
                profit: {
                    thisMonth: profitMonth,
                    today: 0,
                },
                netProfit: {
                    thisMonth: netProfit,
                },
                salary: {
                    kpiPercent,
                    mySalaryThisMonth,
                    totalAgentSalariesThisMonth: totalAgentSalaries,
                    formula: `Foyda × ${kpiPercent}% / 100`,
                },
                commission: { thisMonth: totalAgentSalaries },
                conversion: { rate: conversionRate },
                conversations: { active: this.safeNumber(activeConversations) },
                role,
                thisMonth: {
                    revenue: revMonth,
                    bookings: booksMonth,
                    newClients: newClientsMonth,
                    profit: profitMonth,
                    cost: costMonth,
                    netProfit,
                    bookingsChange: 0,
                },
                lastMonth: { revenue: revPrev },
            };
        }
        catch (e) {
            this.logger.warn('Dashboard error: ' + e?.message);
            return {
                leads: { total: 0, newThisMonth: 0, newToday: 0 },
                clients: { total: 0, newThisMonth: 0, newToday: 0 },
                bookings: { total: 0, thisMonth: 0, today: 0, pending: 0 },
                revenue: { thisMonth: 0, prevMonth: 0, today: 0, growth: 0 },
                cost: { thisMonth: 0, totalSales: 0 },
                profit: { thisMonth: 0, today: 0 },
                netProfit: { thisMonth: 0 },
                salary: { kpiPercent: 10, mySalaryThisMonth: 0, totalAgentSalariesThisMonth: 0, formula: '' },
                commission: { thisMonth: 0 },
                conversion: { rate: 0 },
                conversations: { active: 0 },
                role,
                thisMonth: { revenue: 0, bookings: 0, newClients: 0, profit: 0, cost: 0, netProfit: 0, bookingsChange: 0 },
                lastMonth: { revenue: 0 },
            };
        }
    }
    async revenue(tenantId, role, userId, from, to) {
        const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth() - 5, 1);
        const toDate = to ? new Date(to) : new Date();
        const where = {
            tenantId,
            status: { in: ['CONFIRMED', 'COMPLETED'] },
            createdAt: { gte: fromDate, lte: toDate },
        };
        if (role === 'AGENT')
            where.agentId = userId;
        const bookings = await this.prisma.booking.findMany({
            where,
            select: { totalPrice: true, supplierCost: true, profit: true, createdAt: true, currency: true },
            orderBy: { createdAt: 'asc' },
        });
        const byMonth = {};
        bookings.forEach((b) => {
            const k = `${b.createdAt.getFullYear()}-${String(b.createdAt.getMonth() + 1).padStart(2, '0')}`;
            if (!byMonth[k])
                byMonth[k] = { revenue: 0, cost: 0, profit: 0, count: 0 };
            byMonth[k].revenue += b.totalPrice || 0;
            byMonth[k].cost += b.supplierCost || 0;
            byMonth[k].profit += b.profit || 0;
            byMonth[k].count += 1;
        });
        const totalRevenue = bookings.reduce((s, b) => s + (b.totalPrice || 0), 0);
        const totalCost = bookings.reduce((s, b) => s + (b.supplierCost || 0), 0);
        const totalProfit = bookings.reduce((s, b) => s + (b.profit || 0), 0);
        return {
            total: totalRevenue,
            totalCost,
            totalProfit,
            byMonth: Object.entries(byMonth)
                .map(([month, v]) => ({ month, ...v }))
                .sort((a, b) => a.month.localeCompare(b.month)),
            byMethod: [],
        };
    }
    async agents(tenantId, from, to) {
        const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const toDate = to ? new Date(to) : new Date();
        const agents = await this.prisma.user.findMany({
            where: { tenantId, role: { in: ['AGENT', 'MANAGER'] }, status: 'ACTIVE' },
            select: {
                id: true, name: true, role: true, avatarUrl: true,
                _count: { select: { bookings: true, assignedClients: true } },
            },
        });
        if (agents.length === 0)
            return [];
        const agentIds = agents.map((a) => a.id);
        const [bookingStats, leadsStats] = await Promise.all([
            this.prisma.booking.groupBy({
                by: ['agentId'],
                where: { tenantId, agentId: { in: agentIds }, createdAt: { gte: fromDate, lte: toDate }, status: { not: 'CANCELLED' } },
                _count: { id: true },
                _sum: { totalPrice: true, profit: true },
            }),
            this.prisma.client.groupBy({
                by: ['assignedAgentId'],
                where: { tenantId, assignedAgentId: { in: agentIds }, createdAt: { gte: fromDate, lte: toDate } },
                _count: { id: true },
            }),
        ]);
        const bookingCountMap = new Map(bookingStats.map((b) => [b.agentId, b._count.id]));
        const leadCountMap = new Map(leadsStats.map((l) => [l.assignedAgentId, l._count.id]));
        return agents.map((a) => {
            const bookingsInPeriod = bookingCountMap.get(a.id) || 0;
            const leadsInPeriod = leadCountMap.get(a.id) || 0;
            const conversion = leadsInPeriod > 0 ? Math.round((bookingsInPeriod / leadsInPeriod) * 100) : 0;
            const agentBookingStat = bookingStats.find((b) => b.agentId === a.id);
            const agentRevenue = agentBookingStat?._sum?.totalPrice || 0;
            const agentProfit = agentBookingStat?._sum?.profit || 0;
            return {
                agent: a,
                bookings: a._count.bookings,
                clients: a._count.assignedClients,
                leadsInPeriod, bookingsInPeriod, conversion,
                revenue: agentRevenue,
                profit: agentProfit,
                closedDeals: bookingsInPeriod,
            };
        });
    }
    async bookings(tenantId, role, userId) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.agentId = userId;
        const [byStatus, byMonth] = await Promise.all([
            this.prisma.booking.groupBy({ by: ['status'], where, _count: { id: true }, _sum: { totalPrice: true } }),
            this.prisma.booking.findMany({
                where, select: { createdAt: true, totalPrice: true, status: true },
                orderBy: { createdAt: 'desc' }, take: 500,
            }),
        ]);
        const monthly = {};
        byMonth.forEach((b) => {
            const k = `${b.createdAt.getFullYear()}-${String(b.createdAt.getMonth() + 1).padStart(2, '0')}`;
            if (!monthly[k])
                monthly[k] = { count: 0, revenue: 0 };
            monthly[k].count++;
            if (b.status !== 'CANCELLED')
                monthly[k].revenue += b.totalPrice;
        });
        return {
            byStatus,
            byMonth: Object.entries(monthly).map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month)),
        };
    }
    async bySource(tenantId, role, userId) {
        try {
            const where = { tenantId };
            if (role === 'AGENT')
                where.assignedAgentId = userId;
            const grouped = await this.prisma.client.groupBy({
                by: ['source'],
                where,
                _count: { id: true },
                _sum: { totalRevenue: true },
            }).catch(() => []);
            return (grouped || []).map((g) => ({
                source: g.source || 'UNKNOWN',
                clients: this.safeNumber(g._count?.id),
                revenue: this.safeNumber(g._sum?.totalRevenue),
            })).sort((a, b) => b.clients - a.clients);
        }
        catch (e) {
            this.logger.warn('bySource error: ' + e?.message);
            return [];
        }
    }
    async byDestination(tenantId, role, userId, from, to) {
        const where = { tenantId, status: { not: 'CANCELLED' } };
        if (role === 'AGENT')
            where.agentId = userId;
        if (from || to) {
            where.createdAt = {};
            if (from)
                where.createdAt.gte = new Date(from);
            if (to)
                where.createdAt.lte = new Date(to);
        }
        const grouped = await this.prisma.booking.groupBy({
            by: ['destination'],
            where,
            _count: { id: true },
            _sum: { totalPrice: true, profit: true },
        });
        return grouped.map((g) => ({
            destination: g.destination || 'Noma\'lum',
            bookings: g._count.id,
            revenue: g._sum.totalPrice || 0,
            profit: g._sum.profit || 0,
        })).sort((a, b) => b.revenue - a.revenue).slice(0, 20);
    }
    async conversionFunnel(tenantId, role, userId) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.assignedAgentId = userId;
        const stages = ['NEW_LEAD', 'CONTACTED', 'INTERESTED', 'OFFER_SENT', 'NEGOTIATION', 'DEPOSIT_PAID', 'CONFIRMED', 'TRAVELING', 'COMPLETED', 'LOST'];
        const grouped = await this.prisma.client.groupBy({
            by: ['pipelineStage'],
            where,
            _count: { id: true },
        });
        const counts = {};
        stages.forEach((s) => (counts[s] = 0));
        grouped.forEach((g) => {
            counts[g.pipelineStage] = g._count.id;
        });
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        return stages.map((stage) => ({
            stage,
            count: counts[stage],
            percent: total > 0 ? Math.round((counts[stage] / total) * 100) : 0,
        }));
    }
    async revenueChart(tenantId, role, userId, period = 'month') {
        const where = { tenantId, status: { not: 'CANCELLED' } };
        if (role === 'AGENT')
            where.agentId = userId;
        const since = new Date();
        if (period === 'day')
            since.setDate(since.getDate() - 30);
        else
            since.setMonth(since.getMonth() - 12);
        where.createdAt = { gte: since };
        const bookings = await this.prisma.booking.findMany({
            where,
            select: { createdAt: true, totalPrice: true, supplierCost: true, profit: true },
        }).catch(() => []);
        const buckets = {};
        (bookings || []).forEach((b) => {
            const d = b.createdAt;
            const key = period === 'day'
                ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (!buckets[key])
                buckets[key] = { revenue: 0, cost: 0, profit: 0, count: 0 };
            buckets[key].revenue += this.safeNumber(b.totalPrice);
            buckets[key].cost += this.safeNumber(b.supplierCost);
            buckets[key].profit += this.safeNumber(b.profit);
            buckets[key].count++;
        });
        return Object.entries(buckets)
            .map(([period_key, v]) => ({ period: period_key, ...v }))
            .sort((a, b) => a.period.localeCompare(b.period));
    }
    async byPaymentMethod(tenantId, role, userId) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.agentId = userId;
        const grouped = await this.prisma.payment.groupBy({
            by: ['method'],
            where,
            _count: { id: true },
            _sum: { amount: true },
        });
        return grouped.map((g) => ({
            method: g.method,
            count: g._count.id,
            total: g._sum.amount || 0,
        })).sort((a, b) => b.total - a.total);
    }
    async myStats(tenantId, userId, _offset = 0, from, to) {
        const now = new Date();
        const monthStart = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = to ? new Date(to + 'T23:59:59') : now;
        const prevMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - 7);
        const _ = monthEnd;
        const [totalLeads, leadsThisMonth, leadsThisWeek, leadsToday, totalBookings, bookingsThisMonth, bookingsToday, wonBookings, profitThisMonth, profitPrevMonth, profitToday, callsThisMonth, callsAnswered, activeChats, kpiTenantFromPA,] = await Promise.all([
            this.prisma.client.count({ where: { tenantId, assignedAgentId: userId } }),
            this.prisma.client.count({ where: { tenantId, assignedAgentId: userId, createdAt: { gte: monthStart } } }),
            this.prisma.client.count({ where: { tenantId, assignedAgentId: userId, createdAt: { gte: weekStart } } }),
            this.prisma.client.count({ where: { tenantId, assignedAgentId: userId, createdAt: { gte: todayStart } } }),
            this.prisma.booking.count({ where: { tenantId, agentId: userId, status: { not: 'CANCELLED' } } }),
            this.prisma.booking.count({ where: { tenantId, agentId: userId, status: { not: 'CANCELLED' }, createdAt: { gte: monthStart } } }),
            this.prisma.booking.count({ where: { tenantId, agentId: userId, status: { not: 'CANCELLED' }, createdAt: { gte: todayStart } } }),
            this.prisma.booking.count({ where: { tenantId, agentId: userId, status: { in: ['CONFIRMED', 'COMPLETED'] } } }),
            this.prisma.booking.aggregate({
                where: { tenantId, agentId: userId, status: { not: 'CANCELLED' }, createdAt: { gte: monthStart } },
                _sum: { profit: true, totalPrice: true },
            }),
            this.prisma.booking.aggregate({
                where: { tenantId, agentId: userId, status: { not: 'CANCELLED' }, createdAt: { gte: prevMonthStart, lt: monthStart } },
                _sum: { profit: true },
            }),
            this.prisma.booking.aggregate({
                where: { tenantId, agentId: userId, status: { not: 'CANCELLED' }, createdAt: { gte: todayStart } },
                _sum: { profit: true },
            }),
            this.prisma.call.count({ where: { tenantId, agentId: userId, createdAt: { gte: monthStart } } }),
            this.prisma.call.count({ where: { tenantId, agentId: userId, status: 'COMPLETED', createdAt: { gte: monthStart } } }),
            this.prisma.conversation.count({ where: { tenantId, assignedAgentId: userId, isResolved: false } }),
            this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { agentCommissionPercent: true, kpiTiers: true } }).catch(() => null),
        ]);
        const myConversion = totalLeads > 0 ? Math.round((totalBookings / totalLeads) * 100) : 0;
        const profitMonth = profitThisMonth._sum.profit || 0;
        const profitPrev = profitPrevMonth._sum.profit || 0;
        const profitGrowth = profitPrev > 0 ? Math.round(((profitMonth - profitPrev) / profitPrev) * 100) : null;
        const avgBookingValue = bookingsThisMonth > 0
            ? Math.round((profitThisMonth._sum.totalPrice || 0) / bookingsThisMonth)
            : 0;
        const revenueMonth = profitThisMonth._sum?.totalPrice || 0;
        const costMonth = revenueMonth - profitMonth;
        const kpiTenant = kpiTenantFromPA;
        const kpi = kpiTenant?.agentCommissionPercent ?? 10;
        const salaryMonth = Math.round(profitMonth * kpi / 100);
        return {
            leads: { total: totalLeads, thisMonth: leadsThisMonth, thisWeek: leadsThisWeek, today: leadsToday },
            bookings: { total: totalBookings, thisMonth: bookingsThisMonth, today: bookingsToday, won: wonBookings },
            conversion: { rate: myConversion, won: wonBookings, total: totalLeads },
            profit: {
                thisMonth: profitMonth,
                prevMonth: profitPrev,
                today: profitToday._sum.profit || 0,
                growth: profitGrowth,
                avgPerBooking: avgBookingValue,
            },
            salary: { kpiPercent: kpi, mySalaryThisMonth: salaryMonth, formula: `Foyda × ${kpi}% / 100` },
            revenue: { thisMonth: revenueMonth, prevMonth: 0, today: 0, growth: 0 },
            cost: { thisMonth: costMonth },
            netProfit: { thisMonth: Math.max(0, profitMonth - salaryMonth) },
            thisMonth: {
                revenue: revenueMonth,
                cost: costMonth,
                profit: profitMonth,
                netProfit: Math.max(0, profitMonth - salaryMonth),
                bookings: bookingsThisMonth,
                newClients: leadsThisMonth,
            },
            calls: {
                thisMonth: callsThisMonth,
                answered: callsAnswered,
                answerRate: callsThisMonth > 0 ? Math.round((callsAnswered / callsThisMonth) * 100) : 0,
            },
            activeChats,
        };
    }
    async calcSalary(tenantId, userId, monthStart, monthEnd) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { agentCommissionPercent: true, kpiTiers: true },
        });
        const commissionPercent = tenant?.agentCommissionPercent ?? 10;
        const kpiTiers = Array.isArray(tenant?.kpiTiers)
            ? tenant.kpiTiers
            : JSON.parse(tenant?.kpiTiers || '[]');
        const bookings = await this.prisma.booking.findMany({
            where: { tenantId, agentId: userId, status: { not: 'CANCELLED' }, createdAt: { gte: monthStart, lt: monthEnd } },
            select: { totalPrice: true, profit: true, commissionAmount: true },
        });
        const revenue = bookings.reduce((s, b) => s + this.safeNumber(b.totalPrice), 0);
        const profit = bookings.reduce((s, b) => s + this.safeNumber(b.profit), 0);
        let appliedPercent = commissionPercent;
        let appliedTier = null;
        if (kpiTiers.length > 0) {
            const sorted = [...kpiTiers].sort((a, b) => a.minRevenue - b.minRevenue);
            for (const tier of sorted) {
                if (revenue >= (tier.minRevenue || 0) &&
                    (tier.maxRevenue === null || revenue < tier.maxRevenue)) {
                    appliedPercent = tier.commissionPercent || commissionPercent;
                    appliedTier = tier.name || null;
                    break;
                }
            }
            if (!appliedTier && sorted.length > 0) {
                appliedPercent = sorted[sorted.length - 1].commissionPercent || commissionPercent;
                appliedTier = sorted[sorted.length - 1].name || null;
            }
        }
        const grossSalary = Math.round(profit * appliedPercent / 100);
        const pending = Math.max(0, grossSalary - bookings.reduce((s, b) => s + this.safeNumber(b.commissionAmount), 0));
        return { grossSalary, pending, myCommissionPercent: appliedPercent, appliedTier, revenue, profit, bookingCount: bookings.length };
    }
    async mySalary(tenantId, userId, monthOffset = 0) {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: {
                agentCommissionPercent: true,
                managerCommissionPercent: true,
                currency: true,
                kpiTiers: true,
                settings: true,
            },
        });
        if (!tenant)
            return null;
        const bookings = await this.prisma.booking.findMany({
            where: {
                tenantId, agentId: userId,
                status: { in: ['CONFIRMED', 'COMPLETED'] },
                createdAt: { gte: monthStart, lt: monthEnd },
            },
            select: {
                id: true, bookingRef: true, totalPrice: true, profit: true,
                status: true, currency: true, createdAt: true,
                client: { select: { fullName: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        const totalProfit = bookings.reduce((s, b) => s + (b.profit || 0), 0);
        const totalRevenue = bookings.reduce((s, b) => s + (b.totalPrice || 0), 0);
        let commissionPercent = Number(tenant?.agentCommissionPercent ?? 10);
        let appliedTier = null;
        try {
            const kpiTiers = Array.isArray(tenant.kpiTiers)
                ? tenant.kpiTiers
                : JSON.parse(tenant.kpiTiers || '[]');
            if (Array.isArray(kpiTiers) && kpiTiers.length > 0) {
                const sorted = [...kpiTiers].sort((a, b) => a.minRevenue - b.minRevenue);
                for (const tier of sorted) {
                    if (totalRevenue >= tier.minRevenue && (tier.maxRevenue === null || totalRevenue < tier.maxRevenue)) {
                        commissionPercent = tier.commissionPercent;
                        appliedTier = tier;
                        break;
                    }
                }
                if (!appliedTier && sorted.length > 0) {
                    commissionPercent = sorted[sorted.length - 1].commissionPercent;
                    appliedTier = sorted[sorted.length - 1];
                }
            }
        }
        catch (e) {
        }
        const grossSalary = +(totalProfit * commissionPercent / 100).toFixed(2);
        const paidCommissions = await this.prisma.commission.aggregate({
            where: {
                tenantId, agentId: userId, isPaid: true,
                paidAt: { gte: monthStart, lt: monthEnd },
            },
            _sum: { agentAmount: true },
        });
        const alreadyPaid = paidCommissions._sum.agentAmount || 0;
        const pending = Math.max(0, grossSalary - alreadyPaid);
        const salaryNotes = tenant.settings?.salaryNotes || {};
        const agentSalaryNote = salaryNotes[userId] || {};
        return {
            monthStart, monthEnd,
            currency: tenant.currency,
            myCommissionPercent: commissionPercent,
            isPaid: agentSalaryNote.isPaid || false,
            adminNote: agentSalaryNote.note || '',
            paidAt: agentSalaryNote.paidAt || null,
            appliedTier,
            bookingsCount: bookings.length,
            totalRevenue,
            totalProfit,
            grossSalary,
            alreadyPaid,
            pending,
            bookings: bookings.slice(0, 20),
            breakdown: bookings.map((b) => ({
                id: b.id,
                bookingRef: b.bookingRef,
                clientName: b.client?.fullName,
                totalPrice: b.totalPrice,
                profit: b.profit,
                myShare: +((b.profit || 0) * commissionPercent / 100).toFixed(2),
                date: b.createdAt,
            })),
        };
    }
    async agentSalaries(tenantId, monthOffset = 0) {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { agentCommissionPercent: true, currency: true, kpiTiers: true },
        });
        if (!tenant)
            return [];
        const agents = await this.prisma.user.findMany({
            where: { tenantId, status: 'ACTIVE', role: 'AGENT' },
            select: { id: true, name: true, email: true, avatarUrl: true },
        });
        if (!agents.length)
            return [];
        const agentIds = agents.map((a) => a.id);
        const [bookingStats, commissionStats] = await Promise.all([
            this.prisma.booking.groupBy({
                by: ['agentId'],
                where: { tenantId, agentId: { in: agentIds }, status: { in: ['CONFIRMED', 'COMPLETED'] }, createdAt: { gte: monthStart, lt: monthEnd } },
                _count: { id: true },
                _sum: { totalPrice: true, profit: true },
            }),
            this.prisma.commission.groupBy({
                by: ['agentId'],
                where: { tenantId, agentId: { in: agentIds }, isPaid: true, paidAt: { gte: monthStart, lt: monthEnd } },
                _sum: { agentAmount: true },
            }).catch(() => []),
        ]);
        const kpiTiersRaw = tenant.kpiTiers;
        let kpiTiers = [];
        try {
            kpiTiers = Array.isArray(kpiTiersRaw) ? kpiTiersRaw : JSON.parse(kpiTiersRaw || '[]');
        }
        catch { }
        const results = agents.map((a) => {
            const bStat = bookingStats.find((b) => b.agentId === a.id);
            const cStat = commissionStats.find((c) => c.agentId === a.id);
            const totalRevenue = bStat?._sum?.totalPrice || 0;
            const totalProfit = bStat?._sum?.profit || 0;
            let commissionPercent = tenant.agentCommissionPercent || 10;
            if (kpiTiers.length > 0) {
                const sorted = [...kpiTiers].sort((a, b) => a.minRevenue - b.minRevenue);
                for (const tier of sorted) {
                    if (totalRevenue >= tier.minRevenue && (tier.maxRevenue === null || totalRevenue < tier.maxRevenue)) {
                        commissionPercent = tier.commissionPercent;
                        break;
                    }
                }
            }
            const salary = +(totalProfit * commissionPercent / 100).toFixed(2);
            const paid = cStat?._sum?.agentAmount || 0;
            return {
                ...a,
                bookingsCount: bStat?._count?.id || 0,
                totalRevenue, totalProfit,
                commissionPercent,
                salary,
                paid,
                pending: Math.max(0, salary - paid),
            };
        });
        return results.sort((a, b) => b.salary - a.salary);
    }
    async getClientFinancial(tenantId, clientId, userId, role) {
        const whereClient = { id: clientId, tenantId };
        if (role === 'AGENT')
            whereClient.assignedAgentId = userId;
        const client = await this.prisma.client.findFirst({
            where: whereClient,
            include: {
                assignedAgent: { select: { id: true, name: true } },
            },
        });
        if (!client) {
            throw new common_1.NotFoundException("Klient topilmadi yoki sizning ruxsatingiz yo'q");
        }
        const bookings = await this.prisma.booking.findMany({
            where: { clientId, tenantId },
            orderBy: { createdAt: 'desc' },
            include: {
                agent: { select: { id: true, name: true } },
                payments: { select: { amount: true, paidAt: true, method: true, status: true } },
            },
        });
        let totalRevenue = 0;
        let totalCost = 0;
        let totalProfit = 0;
        let totalPaid = 0;
        let totalDue = 0;
        const bookingSummaries = bookings.map((b) => {
            const cost = this.safeNumber(b.supplierCost || b.providerCost);
            const discount = this.safeNumber(b.discount);
            const profit = b.profit != null
                ? this.safeNumber(b.profit)
                : this.safeNumber(b.totalPrice) - cost - discount;
            const paid = (b.payments || [])
                .filter((p) => p.status === 'COMPLETED' || p.status === 'PAID')
                .reduce((s, p) => s + (p.amount || 0), 0);
            totalRevenue += b.totalPrice || 0;
            totalCost += cost;
            totalProfit += profit;
            totalPaid += paid;
            const due = (b.totalPrice || 0) - paid;
            totalDue += Math.max(0, due);
            return {
                id: b.id,
                bookingRef: b.bookingRef,
                tourName: b.tourName,
                destination: b.destination,
                status: b.status,
                currency: b.currency,
                totalPrice: b.totalPrice,
                supplierCost: cost,
                profit,
                paidAmount: paid,
                dueAmount: Math.max(0, due),
                departureDate: b.departureDate,
                returnDate: b.returnDate,
                agent: b.agent,
                createdAt: b.createdAt,
            };
        });
        const dates = bookings.map((b) => new Date(b.createdAt).getTime()).filter(Boolean);
        const firstBookingAt = dates.length ? new Date(Math.min(...dates)) : null;
        const lastBookingAt = dates.length ? new Date(Math.max(...dates)) : null;
        return {
            client: {
                id: client.id,
                fullName: client.fullName,
                phone: client.phone,
                email: client.email,
                telegramUsername: client.telegramUsername,
                tier: client.tier,
                pipelineStage: client.pipelineStage,
                source: client.source,
                country: client.country,
                city: client.city,
                assignedAgent: client.assignedAgent,
                createdAt: client.createdAt,
            },
            financial: {
                totalRevenue,
                totalCost,
                totalProfit,
                totalPaid,
                totalDue,
                bookingsCount: bookings.length,
                avgBookingValue: bookings.length ? totalRevenue / bookings.length : 0,
                firstBookingAt,
                lastBookingAt,
                ltv: totalRevenue,
            },
            bookings: bookingSummaries,
        };
    }
    async getCallAnalytics(tenantId, days, agentId) {
        const from = new Date(Date.now() - days * 86400000);
        const where = { tenantId, createdAt: { gte: from } };
        if (agentId)
            where.agentId = agentId;
        const total = await this.prisma.call.count({ where });
        const byStatus = await this.prisma.call.groupBy({ by: ['status'], where, _count: { id: true } });
        const answered = byStatus.find((r) => r.status === 'COMPLETED')?._count?.id || 0;
        const daily = await this.prisma.call.findMany({ where, select: { createdAt: true, status: true }, orderBy: { createdAt: 'asc' } });
        const byDayMap = {};
        for (const c of daily) {
            const date = c.createdAt.toISOString().slice(0, 10);
            if (!byDayMap[date])
                byDayMap[date] = { date, total: 0, answered: 0 };
            byDayMap[date].total++;
            if (c.status === 'COMPLETED')
                byDayMap[date].answered++;
        }
        return {
            summary: { total, answered, noAnswer: total - answered, conversionRate: total > 0 ? Math.round(answered / total * 100) : 0 },
            byDay: Object.values(byDayMap),
        };
    }
    async getLeadAnalytics(tenantId, days) {
        try {
            const since = new Date();
            since.setDate(since.getDate() - days);
            const clients = await this.prisma.client.findMany({
                where: {
                    tenantId,
                    createdAt: { gte: since },
                },
                select: {
                    id: true,
                    source: true,
                    createdAt: true,
                    bookings: {
                        where: { status: { not: 'CANCELLED' } },
                        select: {
                            id: true,
                            totalPrice: true,
                            profit: true,
                            status: true,
                        },
                    },
                },
            }).catch(() => []);
            const sourceMap = {};
            for (const c of (clients || [])) {
                const src = c.source || 'OTHER';
                if (!sourceMap[src]) {
                    sourceMap[src] = {
                        source: src,
                        leads: 0,
                        conversions: 0,
                        bookings: 0,
                        revenue: 0,
                        profit: 0,
                    };
                }
                sourceMap[src].leads += 1;
                if (c.bookings && c.bookings.length > 0) {
                    sourceMap[src].conversions += 1;
                    sourceMap[src].bookings += c.bookings.length;
                    sourceMap[src].revenue += c.bookings.reduce((s, b) => s + this.safeNumber(b.totalPrice), 0);
                    sourceMap[src].profit += c.bookings.reduce((s, b) => s + this.safeNumber(b.profit), 0);
                }
            }
            const bySource = Object.values(sourceMap)
                .map((s) => ({
                ...s,
                conversionRate: s.leads > 0 ? (s.conversions / s.leads) * 100 : 0,
                avgBookingValue: s.bookings > 0 ? s.revenue / s.bookings : 0,
                avgProfitPerLead: s.leads > 0 ? s.profit / s.leads : 0,
            }))
                .sort((a, b) => b.revenue - a.revenue);
            const topSource = bySource[0]?.source || null;
            const topByConversion = [...bySource].sort((a, b) => b.conversionRate - a.conversionRate)[0]?.source || null;
            const totalLeads = (clients || []).length;
            const totalBookings = (clients || []).reduce((s, c) => s + (c.bookings?.length || 0), 0);
            const totalRevenue = (clients || []).reduce((s, c) => s + ((c.bookings || []).reduce((bs, b) => bs + this.safeNumber(b.totalPrice), 0)), 0);
            const totalProfit = (clients || []).reduce((s, c) => s + ((c.bookings || []).reduce((bs, b) => bs + this.safeNumber(b.profit), 0)), 0);
            const timeline = {};
            for (let i = days - 1; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const key = d.toISOString().split('T')[0];
                timeline[key] = 0;
            }
            for (const c of (clients || [])) {
                const key = new Date(c.createdAt).toISOString().split('T')[0];
                if (timeline[key] !== undefined)
                    timeline[key] += 1;
            }
            const timelineArray = Object.entries(timeline).map(([date, count]) => ({ date, count }));
            return {
                period: { days, since },
                summary: {
                    totalLeads: this.safeNumber(totalLeads),
                    totalBookings: this.safeNumber(totalBookings),
                    totalRevenue: this.safeNumber(totalRevenue),
                    totalProfit: this.safeNumber(totalProfit),
                    avgConversionRate: totalLeads > 0 ? ((clients || []).filter((c) => (c.bookings?.length || 0) > 0).length / totalLeads) * 100 : 0,
                    topSource,
                    topByConversion,
                },
                bySource,
                timeline: timelineArray,
            };
        }
        catch (e) {
            this.logger.warn('getLeadAnalytics error: ' + e?.message);
            return {
                period: { days, since: new Date() },
                summary: { totalLeads: 0, totalBookings: 0, totalRevenue: 0, totalProfit: 0, avgConversionRate: 0, topSource: null, topByConversion: null },
                bySource: [],
                timeline: [],
            };
        }
    }
    async exportExcel(tenantId, role, userId, type, from, to) {
        const fromDate = from ? new Date(from) : new Date(new Date().setMonth(new Date().getMonth() - 1));
        const toDate = to ? new Date(to) : new Date();
        const where = { tenantId, createdAt: { gte: fromDate, lte: toDate } };
        if (role === 'AGENT')
            where.agentId = userId;
        let rows = [];
        let headers = [];
        if (type === 'bookings') {
            const items = await this.prisma.booking.findMany({
                where: { tenantId, createdAt: { gte: fromDate, lte: toDate }, ...(role === 'AGENT' ? { agentId: userId } : {}) },
                include: { client: { select: { fullName: true, phone: true } }, agent: { select: { name: true } } },
                orderBy: { createdAt: 'desc' }, take: 1000,
            });
            headers = ['#', 'Ref', 'Klient', 'Telefon', 'Tur', 'Yonalish', 'Sana', 'Narxi', 'Foyda', 'Status', 'Agent'];
            rows = items.map((b, i) => [
                i + 1, b.bookingRef, b.client?.fullName, b.client?.phone, b.tourName, b.destination,
                b.createdAt.toLocaleDateString('uz-UZ'), b.totalPrice, b.profit || 0, b.status, b.agent?.name,
            ]);
        }
        else if (type === 'clients') {
            const items = await this.prisma.client.findMany({
                where: { tenantId, createdAt: { gte: fromDate, lte: toDate } },
                include: { assignedAgent: { select: { name: true } } },
                orderBy: { createdAt: 'desc' }, take: 1000,
            });
            headers = ['#', 'Ism', 'Telefon', 'Email', 'Manba', 'Stage', 'Tier', 'Agent', 'Sana'];
            rows = items.map((c, i) => [
                i + 1, c.fullName, c.phone, c.email, c.source, c.pipelineStage, c.tier,
                c.assignedAgent?.name, c.createdAt.toLocaleDateString('uz-UZ'),
            ]);
        }
        else if (type === 'payments') {
            const items = await this.prisma.payment.findMany({
                where: { tenantId, paidAt: { gte: fromDate, lte: toDate } },
                include: { booking: { include: { client: { select: { fullName: true } } } } },
                orderBy: { paidAt: 'desc' }, take: 1000,
            });
            headers = ['#', 'Sana', 'Klient', 'Miqdor', 'Valyuta', 'Usul', 'Status', 'Booking Ref'];
            rows = items.map((p, i) => [
                i + 1, p.paidAt?.toLocaleDateString('uz-UZ'), p.booking?.client?.fullName,
                p.amount, p.currency, p.method, p.status, p.booking?.bookingRef,
            ]);
        }
        else if (type === 'calls') {
            const items = await this.prisma.call.findMany({
                where: { tenantId, createdAt: { gte: fromDate, lte: toDate }, ...(role === 'AGENT' ? { agentId: userId } : {}) },
                include: { agent: { select: { name: true } }, client: { select: { fullName: true } } },
                orderBy: { createdAt: 'desc' }, take: 1000,
            });
            headers = ['#', 'Sana', 'Agent', 'Klient', 'Yonalish', 'Status', 'Davomiylik (sek)', 'Raqam'];
            rows = items.map((c, i) => [
                i + 1, c.createdAt.toLocaleDateString('uz-UZ'), c.agent?.name, c.client?.fullName,
                c.direction, c.status, c.duration, c.toMasked || c.fromMasked,
            ]);
        }
        const csvLines = [
            headers.join(','),
            ...rows.map(row => row.map((v) => {
                const s = String(v ?? '').replace(/"/g, '""');
                const needsQuote = s.includes(',') || s.includes('"') || s.indexOf('\n') >= 0;
                return needsQuote ? `"${s}"` : s;
            }).join(','))
        ];
        const newline = '\n';
        const csv = '\uFEFF' + csvLines.join(newline);
        return { csv, filename: `${type}-${new Date().toISOString().slice(0, 10)}.csv`, rows: rows.length };
    }
    async exportSummary(tenantId, role, userId, from, to) {
        const [dash, agents, bookings] = await Promise.all([
            this.dashboard(tenantId, userId, role),
            this.agents(tenantId, from, to),
            this.bookings(tenantId, role, userId),
        ]);
        return { dashboard: dash, agents, bookings, exportedAt: new Date() };
    }
};
exports.ReportsService = ReportsService;
exports.ReportsService = ReportsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ReportsService);
let ReportsController = class ReportsController {
    constructor(svc) {
        this.svc = svc;
    }
    dashboard(u, from, to) {
        return this.svc.dashboard(u.tenantId, u.sub, u.role, from, to);
    }
    revenue(u, from, to) {
        return this.svc.revenue(u.tenantId, u.role, u.sub, from, to);
    }
    agents(u, from, to) {
        return this.svc.agents(u.tenantId, from, to);
    }
    bookings(u) {
        return this.svc.bookings(u.tenantId, u.role, u.sub);
    }
    bySource(u) {
        return this.svc.bySource(u.tenantId, u.role, u.sub);
    }
    byDestination(u, from, to) {
        return this.svc.byDestination(u.tenantId, u.role, u.sub, from, to);
    }
    conversionFunnel(u) {
        return this.svc.conversionFunnel(u.tenantId, u.role, u.sub);
    }
    revenueChart(u, period) {
        return this.svc.revenueChart(u.tenantId, u.role, u.sub, period || 'month');
    }
    byPaymentMethod(u) {
        return this.svc.byPaymentMethod(u.tenantId, u.role, u.sub);
    }
    myStats(u, from, to) {
        return this.svc.myStats(u.tenantId, u.sub, 0, from, to);
    }
    async mySalary(u, month, agentId) {
        const offset = month ? parseInt(month) : 0;
        let targetId = u.sub || u.id;
        if ((u.role === 'TENANT_ADMIN' || u.role === 'MANAGER') && agentId) {
            const agent = await this.svc['prisma'].user.findFirst({
                where: { id: agentId, tenantId: u.tenantId },
                select: { id: true },
            });
            if (!agent)
                throw new Error('Agent topilmadi');
            targetId = agentId;
        }
        return this.svc.mySalary(u.tenantId, targetId, offset);
    }
    agentSalaries(u, month) {
        const offset = month ? parseInt(month) : 0;
        return this.svc.agentSalaries(u.tenantId, offset);
    }
    clientFinancial(id, u) {
        return this.svc.getClientFinancial(u.tenantId, id, u.sub, u.role);
    }
    leadAnalytics(u, days) {
        const period = Math.min(Number(days) || 30, 365);
        return this.svc.getLeadAnalytics(u.tenantId, period);
    }
    calendar(u, date, from, to) {
        return this.svc.calendarReport(u.tenantId, u.sub, u.role, date, from, to);
    }
    callAnalytics(u, days, aid) {
        const d = Math.min(Number(days) || 30, 365);
        const agentId = u.role === 'AGENT' ? (u.id || u.sub) : (aid || undefined);
        return this.svc.getCallAnalytics(u.tenantId, d, agentId);
    }
    async exportData(u, type = 'bookings', res, from, to) {
        const result = await this.svc.exportExcel(u.tenantId, u.role, u.sub, type, from, to);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.csv);
    }
    exportJSON(u, from, to) {
        return this.svc.exportSummary(u.tenantId, u.role, u.sub, from, to);
    }
    async markSalaryPaid(u, body) {
        if (u.role === 'AGENT')
            return { error: 'Ruxsat yoq' };
        const prisma = this.svc.prisma;
        const tenant = await prisma.tenant.findUnique({
            where: { id: u.tenantId }, select: { settings: true },
        });
        const settings = tenant?.settings || {};
        const salaryNotes = settings.salaryNotes || {};
        salaryNotes[body.agentId] = {
            isPaid: !!body.isPaid,
            note: body.note || '',
            paidAt: body.isPaid ? new Date().toISOString() : null,
        };
        await prisma.tenant.update({
            where: { id: u.tenantId },
            data: { settings: { ...settings, salaryNotes } },
        });
        return { success: true };
    }
};
exports.ReportsController = ReportsController;
__decorate([
    (0, common_1.Get)('dashboard'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('from')),
    __param(2, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "dashboard", null);
__decorate([
    (0, common_1.Get)('revenue'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('from')),
    __param(2, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "revenue", null);
__decorate([
    (0, common_1.Get)('agents'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('from')),
    __param(2, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "agents", null);
__decorate([
    (0, common_1.Get)('bookings'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "bookings", null);
__decorate([
    (0, common_1.Get)('by-source'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "bySource", null);
__decorate([
    (0, common_1.Get)('by-destination'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('from')),
    __param(2, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "byDestination", null);
__decorate([
    (0, common_1.Get)('conversion-funnel'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "conversionFunnel", null);
__decorate([
    (0, common_1.Get)('revenue-chart'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('period')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "revenueChart", null);
__decorate([
    (0, common_1.Get)('by-payment-method'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "byPaymentMethod", null);
__decorate([
    (0, common_1.Get)('my-stats'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('from')),
    __param(2, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "myStats", null);
__decorate([
    (0, common_1.Get)('my-salary'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('month')),
    __param(2, (0, common_1.Query)('agentId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "mySalary", null);
__decorate([
    (0, common_1.Get)('agent-salaries'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('month')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "agentSalaries", null);
__decorate([
    (0, common_1.Get)('client/:id/financial'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "clientFinancial", null);
__decorate([
    (0, common_1.Get)('lead-analytics'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('days')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "leadAnalytics", null);
__decorate([
    (0, common_1.Get)('calendar'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('date')),
    __param(2, (0, common_1.Query)('from')),
    __param(3, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "calendar", null);
__decorate([
    (0, common_1.Get)('call-analytics'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('days')),
    __param(2, (0, common_1.Query)('agentId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "callAnalytics", null);
__decorate([
    (0, common_1.Get)('export'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('type')),
    __param(2, (0, common_1.Res)()),
    __param(3, (0, common_1.Query)('from')),
    __param(4, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, String, String]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "exportData", null);
__decorate([
    (0, common_1.Get)('export-json'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('from')),
    __param(2, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "exportJSON", null);
__decorate([
    (0, common_1.Post)('mark-salary-paid'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "markSalaryPaid", null);
exports.ReportsController = ReportsController = __decorate([
    (0, swagger_1.ApiTags)('Reports & Statistika'),
    (0, swagger_1.ApiBearerAuth)('JWT'),
    (0, common_1.Controller)('reports'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [ReportsService])
], ReportsController);
let ReportsModule = class ReportsModule {
};
exports.ReportsModule = ReportsModule;
exports.ReportsModule = ReportsModule = __decorate([
    (0, common_1.Module)({
        controllers: [ReportsController],
        providers: [ReportsService],
    })
], ReportsModule);
//# sourceMappingURL=reports.module.js.map