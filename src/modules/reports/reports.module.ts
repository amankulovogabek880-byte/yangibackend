import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards, NotFoundException, Res, Logger } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, Roles, RequirePermission } from '../../common/decorators';
import { CacheService } from '../../common/cache/cache.service';
import { CACHE_TTL, reportsKey } from '../../common/cache/cache.constants';
import { clampDateRange, MAX_REPORT_RANGE_DAYS } from '../../common/utils/helpers';
import { OBJECTION_CATEGORIES, OBJECTION_PLAYBOOK } from '../calls/calls.module';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger('Reports');
  constructor(private prisma: PrismaService) {}

  // ── SAFE VALUE HELPERS ──

  // ═══════════════════════════════════════════════════════════════
  // KALENDAR HISOBOTI — kunlik va oraliq
  // ═══════════════════════════════════════════════════════════════
  // ─── v10.2: Oylik kalendar eventlari ────────────────────────────────────
  // Tour CRM kalendari: parvozlar (ketish/qaytish), viza muddati,
  // invoice to'lov muddati, vazifalar va follow-uplar — bitta gridda.
  async calendarMonth(tenantId: string, userId: string, role: string, year: number, month: number) {
    const agentFilter: any       = role === 'AGENT' ? { agentId: userId } : {};
    const clientAgentFilter: any = role === 'AGENT' ? { assignedAgentId: userId } : {};

    const start = new Date(year, month - 1, 1, 0, 0, 0);
    const end   = new Date(year, month, 0, 23, 59, 59); // oyning oxirgi kuni
    const df = { gte: start, lte: end };

    const [departures, returns, visas, tasks, followups, invoices] = await Promise.all([
      this.prisma.booking.findMany({
        where: { tenantId, ...agentFilter, departureDate: df, status: { not: 'CANCELLED' } },
        select: {
          id: true, bookingRef: true, tourName: true, destination: true,
          departureDate: true, airline: true, flightNumber: true,
          client: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.booking.findMany({
        where: { tenantId, ...agentFilter, returnDate: df, status: { not: 'CANCELLED' } },
        select: {
          id: true, bookingRef: true, tourName: true, returnDate: true,
          client: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.booking.findMany({
        where: { tenantId, ...agentFilter, visaExpiryDate: df, status: { not: 'CANCELLED' } },
        select: {
          id: true, bookingRef: true, visaExpiryDate: true, visaType: true,
          client: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.task.findMany({
        where: {
          tenantId, dueAt: df, status: { not: 'DONE' },
          ...(role === 'AGENT' ? { assigneeId: userId } : {}),
        },
        select: { id: true, title: true, dueAt: true, priority: true, clientId: true },
      }).catch(() => [] as any[]),
      this.prisma.followUp.findMany({
        where: {
          tenantId, dueAt: df, done: false,
          ...(role === 'AGENT' ? { agentId: userId } : {}),
        },
        select: { id: true, note: true, dueAt: true, clientId: true },
      }).catch(() => [] as any[]),
      this.prisma.invoice.findMany({
        where: { tenantId, dueDate: df, status: { notIn: ['PAID', 'CANCELLED'] as any } },
        select: {
          id: true, invoiceNumber: true, totalAmount: true, currency: true, dueDate: true,
          client: { select: { id: true, fullName: true } },
        },
      }).catch(() => [] as any[]),
    ]);

    const events: any[] = [];
    const day = (d: any) => new Date(d).toISOString().slice(0, 10);

    for (const b of departures) events.push({
      type: 'departure', date: day(b.departureDate),
      title: (b.client?.fullName || b.bookingRef) + ' — ' + (b.destination || b.tourName),
      sub: [b.airline, b.flightNumber].filter(Boolean).join(' '),
      link: '/bookings/' + b.id,
    });
    for (const b of returns) events.push({
      type: 'return', date: day(b.returnDate),
      title: (b.client?.fullName || b.bookingRef) + ' — qaytish',
      sub: b.tourName, link: '/bookings/' + b.id,
    });
    for (const b of visas) events.push({
      type: 'visa', date: day(b.visaExpiryDate),
      title: (b.client?.fullName || b.bookingRef) + ' — viza tugaydi',
      sub: b.visaType || '', link: '/bookings/' + b.id,
    });
    for (const t of tasks as any[]) events.push({
      type: 'task', date: day(t.dueAt),
      title: t.title, sub: t.priority,
      link: t.clientId ? '/clients/' + t.clientId : '/tasks',
    });
    for (const f of followups as any[]) events.push({
      type: 'followup', date: day(f.dueAt),
      title: f.note || 'Follow-up', sub: '',
      link: f.clientId ? '/clients/' + f.clientId : '/followups',
    });
    for (const inv of invoices as any[]) events.push({
      type: 'payment', date: day(inv.dueDate),
      title: (inv.client?.fullName || inv.invoiceNumber) + " — to'lov muddati",
      sub: '$' + Number(inv.totalAmount || 0).toLocaleString(),
      link: '/invoices/' + inv.id,
    });

    // Kun bo'yicha guruhlash
    const byDate: Record<string, any[]> = {};
    for (const e of events) (byDate[e.date] = byDate[e.date] || []).push(e);

    return { year, month, events, byDate, counts: {
      departure: departures.length, return: returns.length, visa: visas.length,
      task: (tasks as any[]).length, followup: (followups as any[]).length, payment: (invoices as any[]).length,
    } };
  }

  async calendarReport(tenantId: string, userId: string, role: string, date?: string, from?: string, to?: string) {
    const agentFilter: any       = role === 'AGENT' ? { agentId: userId } : {};
    const clientAgentFilter: any = role === 'AGENT' ? { assignedAgentId: userId } : {};

    let start: Date, end: Date, isSingleDay: boolean;
    if (date) {
      const [y, m, d] = date.split('-').map(Number);
      start = new Date(y, m - 1, d, 0, 0, 0);
      end   = new Date(y, m - 1, d, 23, 59, 59);
      isSingleDay = true;
    } else if (from && to) {
      const [fy, fm, fd] = from.split('-').map(Number);
      const [ty, tm, td] = to.split('-').map(Number);
      start = new Date(fy, fm - 1, fd, 0, 0, 0);
      end   = new Date(ty, tm - 1, td, 23, 59, 59);
      isSingleDay = false;
    } else {
      const n = new Date();
      start = new Date(n.getFullYear(), n.getMonth(), n.getDate());
      end   = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59);
      isSingleDay = true;
    }

    // v12.6: oraliqni xavfsiz chegaraga keltiramiz.
    // `from`/`to` foydalanuvchidan keladi va cheklanmagan edi — juda
    // uzun oraliq butun bazani tortib, serverni sekinlashtirardi.
    const clampedRange = clampDateRange(start, end);
    if (clampedRange.clamped) {
      this.logger.warn(
        `Hisobot oralig'i qisqartirildi (maks. ${MAX_REPORT_RANGE_DAYS} kun): ` +
        `${start.toISOString().slice(0, 10)} → ${clampedRange.start.toISOString().slice(0, 10)}`,
      );
    }
    start = clampedRange.start;
    end = clampedRange.end;
    const df = { gte: start, lte: end };

    // ═══════════════════════════════════════════════════════════
    // v12.6 OPTIMALLASHTIRISH
    // ═══════════════════════════════════════════════════════════
    // ILGARI: barcha mijoz, booking va to'lov TO'LIQ tortilardi, keyin
    // JavaScript'da .reduce() bilan yig'ilardi. Bandroq agentlikda bu
    // o'n minglab qator degani — server xotirasi va sekinlik.
    //
    // ENDI: yig'indilar BAZADA hisoblanadi (aggregate/count), ro'yxatlar
    // esa faqat ko'rsatish uchun va CHEKLANGAN holda olinadi.
    //
    // MUHIM: statistikaga limit QO'YILMAYDI — aks holda daromad/foyda
    // jimgina noto'g'ri chiqardi. Limit faqat ko'rinadigan ro'yxatlarda.
    const TIMELINE_LIMIT = 300;

    const [
      leads, bookings, payments,
      bookingAgg, paymentAgg, leadsCount, bookingsCount,
    ] = await Promise.all([
      // ── Ko'rsatish uchun ro'yxatlar (cheklangan) ──
      (this.prisma as any).client.findMany({
        where: { tenantId, ...clientAgentFilter, createdAt: df },
        select: { id: true, fullName: true, phone: true, source: true, pipelineStage: true, createdAt: true, assignedAgent: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        take: TIMELINE_LIMIT,
      }),
      (this.prisma as any).booking.findMany({
        where: { tenantId, ...agentFilter, createdAt: df },
        include: { client: { select: { fullName: true } }, agent: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: TIMELINE_LIMIT,
      }),
      (this.prisma as any).payment.findMany({
        where: { tenantId, paidAt: df },
        select: { amount: true, currency: true, method: true, paidAt: true },
        orderBy: { paidAt: 'desc' },
        take: TIMELINE_LIMIT,
      }),

      // ── Statistika: BAZADA hisoblanadi, LIMITSIZ (to'g'ri bo'lishi shart) ──
      (this.prisma as any).booking.aggregate({
        where: { tenantId, ...agentFilter, createdAt: df, status: { in: ['CONFIRMED', 'COMPLETED'] } },
        _sum: { totalPrice: true, profit: true },
        _count: { _all: true },
      }),
      (this.prisma as any).payment.aggregate({
        where: { tenantId, paidAt: df },
        _sum: { amount: true },
      }),
      (this.prisma as any).client.count({
        where: { tenantId, ...clientAgentFilter, createdAt: df },
      }),
      (this.prisma as any).booking.count({
        where: { tenantId, ...agentFilter, createdAt: df },
      }),
    ]);

    const stats = {
      revenue: bookingAgg?._sum?.totalPrice || 0,
      profit:  bookingAgg?._sum?.profit || 0,
      paid:    paymentAgg?._sum?.amount || 0,
      newLeads: leadsCount,
      newClients: leadsCount,
      bookingsCount,
      confirmedBookings: bookingAgg?._count?._all || 0,
    };


    // Timeline
    const [tlRows] = await Promise.all([
      // XAVFSIZLIK (v12.6): bu yerda tenantId FILTRI YO'Q edi —
      // ya'ni hisobotga BOSHQA agentliklarning mijoz faoliyati ham
      // tushardi (cross-tenant sizish). ClientTimeline'da tenantId
      // ustuni yo'q, shuning uchun bog'langan Client orqali filtrlaymiz.
      (this.prisma as any).clientTimeline.findMany({
        where: { createdAt: df, client: { tenantId } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }).catch(() => []),
    ]);
    const payEvents = payments.map((p: any) => ({ type: 'payment', title: `💰 To\'lov: ${p.currency} ${p.amount}`, createdAt: p.paidAt, metadata: { method: p.method } }));
    const bkEvents  = bookings.map((b: any) => ({ type: 'booking', title: `✈️ Booking: ${b.client?.fullName || ''} — ${b.tourName}`, createdAt: b.createdAt, metadata: { status: b.status, amount: b.totalPrice } }));
    const timeline  = [...tlRows, ...payEvents, ...bkEvents].sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Agent faolligi
    // BUG3 FIX: N+1 o'rniga 3 ta parallel groupBy (agent soni qancha bo'lsa ham 3 so'rov)
    const agents = await (this.prisma as any).user.findMany({
      where: { tenantId, role: { in: ['AGENT','MANAGER','TENANT_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    const agentIds = agents.map((a: any) => a.id);

    const [agentLeads, agentBookings, agentCalls] = await Promise.all([
      (this.prisma as any).client.groupBy({
        by: ['assignedAgentId'],
        where: { tenantId, assignedAgentId: { in: agentIds }, createdAt: df },
        _count: { id: true },
      }).catch(() => []),
      (this.prisma as any).booking.groupBy({
        by: ['agentId'],
        where: { tenantId, agentId: { in: agentIds }, createdAt: df },
        _count: { id: true },
      }).catch(() => []),
      (this.prisma as any).call.groupBy({
        by: ['agentId'],
        where: { tenantId, agentId: { in: agentIds }, createdAt: df },
        _count: { id: true },
      }).catch(() => []),
    ]);

    const agentActivity = agents.map((a: any) => ({
      agent: a,
      leads:    ((agentLeads as any[]).find((r: any) => r.assignedAgentId === a.id) as any)?._count?.id || 0,
      bookings: ((agentBookings as any[]).find((r: any) => r.agentId === a.id) as any)?._count?.id || 0,
      calls:    ((agentCalls as any[]).find((r: any) => r.agentId === a.id) as any)?._count?.id || 0,
    }));

    // Manba taqsimoti
    const srcMap: Record<string, number> = {};
    leads.forEach((c: any) => { srcMap[c.source || 'OTHER'] = (srcMap[c.source || 'OTHER'] || 0) + 1; });
    const sourceBreakdown = Object.entries(srcMap).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);

    // Daily breakdown (faqat oraliqda)
    let dailyBreakdown: any[] = [];
    let bestDay: any = null;
    if (!isSingleDay) {
      // BUG4 FIX: 60 so'rov o'rniga 2 ta parallel so'rov, keyin JS da guruhla
      const [allLeadsInRange, allBookingsInRange] = await Promise.all([
        (this.prisma as any).client.findMany({
          where: { tenantId, ...clientAgentFilter, createdAt: { gte: start, lte: end } },
          select: { createdAt: true },
        }).catch(() => []),
        (this.prisma as any).booking.findMany({
          where: { tenantId, ...agentFilter, createdAt: { gte: start, lte: end } },
          select: { createdAt: true, totalPrice: true, profit: true, status: true },
        }).catch(() => []),
      ]);

      // JS da kunlar bo'yicha guruhla
      const totalDays = Math.min(Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1, 366);
      const dayMap: Record<string, { leads: number; bookings: number; revenue: number; profit: number }> = {};
      for (let i = 0; i < totalDays; i++) {
        const d = new Date(start); d.setDate(d.getDate() + i);
        dayMap[d.toISOString().slice(0, 10)] = { leads: 0, bookings: 0, revenue: 0, profit: 0 };
      }
      for (const c of allLeadsInRange as any[]) {
        const key = new Date(c.createdAt).toISOString().slice(0, 10);
        if (dayMap[key]) dayMap[key].leads++;
      }
      for (const b of allBookingsInRange as any[]) {
        const key = new Date(b.createdAt).toISOString().slice(0, 10);
        if (dayMap[key]) {
          dayMap[key].bookings++;
          if (['CONFIRMED','COMPLETED'].includes(b.status)) {
            dayMap[key].revenue += b.totalPrice || 0;
            dayMap[key].profit  += b.profit || 0;
          }
        }
      }
      dailyBreakdown = Object.entries(dayMap).map(([date, v]) => ({ date, ...v }));
      bestDay = dailyBreakdown.reduce(
        (a, b) => ((b.revenue + b.leads * 10) > (a.revenue + a.leads * 10) ? b : a),
        dailyBreakdown[0] || {}
      );
    }

    return { isSingleDay, stats, leads, timeline, bookings, payments, agentActivity, sourceBreakdown, dailyBreakdown, bestDay };
  }

  private safeNumber(val: any): number {
    const num = Number(val);
    return isNaN(num) || val === null || val === undefined ? 0 : num;
  }

  // Pul summalarini 2 xona (tiyin) gacha dumaloqlaydi — floating-point
  // arifmetika (masalan profit * kpiPercent / 100) natijasida $57,374.852
  // kabi 3+ xonali "chiroyli bo'lmagan" summalar chiqib qolmasligi uchun.
  private round2(val: any): number {
    const num = this.safeNumber(val);
    return Math.round(num * 100) / 100;
  }

  private safePercent(val: any, max = 100): number {
    const num = this.safeNumber(val);
    return Math.min(Math.max(num, 0), max);
  }

  async dashboard(tenantId: string, userId: string, role: string, from?: string, to?: string) {
    try {
      const now = new Date();
      // from/to berilsa — u davr, aks holda bu oy
      const monthStart = from
        ? (() => { const [y,m,d] = from.split('-').map(Number); return new Date(y, m-1, d, 0,0,0); })()
        : new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = to
        ? (() => { const [y,m,d] = to.split('-').map(Number); return new Date(y, m-1, d, 23,59,59); })()
        : now;
      const prevMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
      const prevMonthEnd   = new Date(monthStart.getFullYear(), monthStart.getMonth(), 0, 23, 59, 59);
      const todayStart     = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Agent filterlari
      const bookingAgentFilter = role === 'AGENT' ? { agentId: userId } : {};
      const clientAgentFilter  = role === 'AGENT' ? { assignedAgentId: userId } : {};

      // ── BOOKING WHERE UCHUN STATUS ──
      // v10 FIX: avval "Bookinglar" soni activeStatuses (DRAFT+CONFIRMED+COMPLETED)
      // bilan, lekin "Jami daromad/Operator narxi/Sof foyda" faqat
      // confirmedStatuses (CONFIRMED+COMPLETED) bilan hisoblanardi — shu
      // nomuvofiqlik tufayli booking DRAFT holatida turganda dashboard
      // butunlay $0 ko'rsatardi, garchi klient sahifasida "Jami xarid"
      // to'g'ri chiqsa ham (u ham DRAFT'ni hisobga oladi). Endi hammasi
      // BITTA ta'rif — activeStatuses — bilan hisoblanadi.
      const activeStatuses = { status: { in: ['CONFIRMED', 'COMPLETED', 'DRAFT'] as any[] } };

      // ── BARCHA SO'ROVLAR PARALLEL ──
      const [
        totalClients, newClientsMonth, totalLeads,
        totalBookings, bookingsMonth, pendingBookings,
        clientsWithBookings, // BUG4: conversion rate uchun
        newLeadsMonth, // BUG5: pipeline boshidagi yangi leadlar
        // Bu oygi booking stats (BOOKING dan - bir xil manba!)
        thisMonthBookings, prevMonthBookings,
        // Agent performance (BOOKING dan)
        agentPerformance,
        // Tenant sozlamalari
        tenant,
        // Conversations
        activeConversations,
      ] = await Promise.all([
        // Klientlar
        this.prisma.client.count({ where: { tenantId, ...clientAgentFilter } }).catch(() => 0),
        this.prisma.client.count({ where: { tenantId, ...clientAgentFilter, createdAt: { gte: monthStart } } }).catch(() => 0),
        // BUG1 FIX: totalLeads = faqat pipeline boshidagilar
        this.prisma.client.count({ where: { tenantId, ...clientAgentFilter, pipelineStage: { in: ['NEW_LEAD','CONTACTED','INTERESTED'] as any[] } } }).catch(() => 0),

        // Bookinglar
        this.prisma.booking.count({ where: { tenantId, ...bookingAgentFilter, ...activeStatuses } }).catch(() => 0),
        this.prisma.booking.count({ where: { tenantId, ...bookingAgentFilter, ...activeStatuses, createdAt: { gte: monthStart } } }).catch(() => 0),
        this.prisma.booking.count({ where: { tenantId, ...bookingAgentFilter, status: { in: ['DRAFT', 'CONFIRMED'] as any[] } } }).catch(() => 0),

        // BUG4 FIX: Conversion = booking qilgan klientlar / yangi klientlar
        this.prisma.client.count({
          where: { tenantId, ...clientAgentFilter, createdAt: { gte: monthStart, lte: monthEnd }, bookings: { some: { status: { not: 'CANCELLED' as any } } } },
        }).catch(() => 0),
        // BUG5 FIX: leads.newThisMonth = pipeline boshidagilar bu oy
        this.prisma.client.count({
          where: { tenantId, ...clientAgentFilter, pipelineStage: { in: ['NEW_LEAD','CONTACTED','INTERESTED'] as any[] }, createdAt: { gte: monthStart, lte: monthEnd } },
        }).catch(() => 0),
        // Bu oygi moliya (BOOKING.totalPrice, supplierCost, profit)
        this.prisma.booking.aggregate({
          where: { tenantId, ...bookingAgentFilter, ...activeStatuses, createdAt: { gte: monthStart, lte: monthEnd } },
          _sum: { totalPrice: true, supplierCost: true, profit: true },
          _count: { id: true },
        }).catch(() => ({ _sum: { totalPrice: 0, supplierCost: 0, profit: 0 }, _count: { id: 0 } })),

        // O'tgan oygi moliya
        this.prisma.booking.aggregate({
          where: { tenantId, ...bookingAgentFilter, ...activeStatuses, createdAt: { gte: prevMonthStart, lte: prevMonthEnd } },
          _sum: { totalPrice: true, supplierCost: true, profit: true },
          _count: { id: true },
        }).catch(() => ({ _sum: { totalPrice: 0, supplierCost: 0, profit: 0 }, _count: { id: 0 } })),

        // Agentlar performance (faqat admin/manager uchun)
        role !== 'AGENT'
          ? this.prisma.booking.groupBy({
              by: ['agentId'],
              where: { tenantId, ...activeStatuses, createdAt: { gte: monthStart }, agentId: { not: null } },
              _sum: { totalPrice: true, profit: true, commissionAmount: true },
              _count: { id: true },
            }).catch(() => [])
          : Promise.resolve([]),

        // Tenant KPI sozlamalari
        this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { agentCommissionPercent: true, currency: true } as any,
        }).catch(() => null),

        // Faol suhbatlar
        this.prisma.conversation.count({
          where: { tenantId, isResolved: false, ...(role === 'AGENT' ? { OR: [{ assignedAgentId: userId }, { assignedAgentId: null }] } : {}) },
        }).catch(() => 0),
      ]);

      // ── HIOBLAR ──
      const kpiPercent = (tenant as any)?.agentCommissionPercent ?? 10;

      // Bu oy
      const revMonth    = this.round2(this.safeNumber((thisMonthBookings._sum as any)?.totalPrice));
      const costMonth   = this.round2(this.safeNumber((thisMonthBookings._sum as any)?.supplierCost));
      const profitMonth = this.round2(this.safeNumber((thisMonthBookings._sum as any)?.profit));
      const booksMonth  = (thisMonthBookings._count as any)?.id ?? 0;

      // O'tgan oy
      const revPrev = this.safeNumber((prevMonthBookings._sum as any)?.totalPrice);

      // O'sish foizi
      const growth = revPrev > 0 ? Math.round(((revMonth - revPrev) / revPrev) * 100) : 0;

      // Agent maoshi (faqat agent uchun)
      const mySalaryThisMonth = role === 'AGENT'
        ? Math.round(profitMonth * kpiPercent / 100)
        : 0;

      // Jami agent maoshi (admin uchun)
      const totalAgentSalaries = this.round2(role !== 'AGENT'
        ? (agentPerformance as any[]).reduce((sum: number, a: any) => {
            const stored = this.safeNumber((a._sum as any)?.commissionAmount);
            const calculated = this.safeNumber((a._sum as any)?.profit) * kpiPercent / 100;
            return sum + (stored > 0 ? stored : calculated);
          }, 0)
        : 0);

      // BUG4 FIX: Conversion = booking qilgan klientlar / yangi klientlar (max 100%)
      const conversionRate = newClientsMonth > 0
        ? Math.min(100, Math.round((this.safeNumber(clientsWithBookings) / newClientsMonth) * 100))
        : 0;

      // Net foyda = profit - agent maoshlari
      const netProfit = this.round2(Math.max(0, profitMonth - totalAgentSalaries));

      // v12 FIX: "Bugun" (newToday) qiymatlari ilgari QATTIQ 0 edi — shuning
      // uchun bugun lead tushса ham dashboard "Bugun: +0" ko'rsatardi. Endi
      // haqiqiy hisoblanadi (bu oygi hisoblar bilan bir xil filtrlar bilan).
      const [newClientsToday, newLeadsToday] = await Promise.all([
        this.prisma.client.count({
          where: { tenantId, ...clientAgentFilter, createdAt: { gte: todayStart } },
        }).catch(() => 0),
        this.prisma.client.count({
          where: {
            tenantId, ...clientAgentFilter,
            pipelineStage: { in: ['NEW_LEAD', 'CONTACTED', 'INTERESTED'] as any[] },
            createdAt: { gte: todayStart },
          },
        }).catch(() => 0),
      ]);

      return {
        clients:  { total: totalClients, newThisMonth: newClientsMonth, newToday: this.safeNumber(newClientsToday) },
        leads:    { total: totalLeads, newThisMonth: this.safeNumber(newLeadsMonth), newToday: this.safeNumber(newLeadsToday) }, // BUG5 FIX
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
        // Frontend uchun qulaylik
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
    } catch (e: any) {
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

  async revenue(tenantId: string, role: string, userId: string, from?: string, to?: string) {
    // Booking dan hisoblash - bir xil manba
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth() - 5, 1);
    const toDate   = to   ? new Date(to)   : new Date();

    const where: any = {
      tenantId,
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      createdAt: { gte: fromDate, lte: toDate },
    };
    if (role === 'AGENT') where.agentId = userId;

    const bookings = await this.prisma.booking.findMany({
      where,
      select: { totalPrice: true, supplierCost: true, profit: true, createdAt: true, currency: true },
      orderBy: { createdAt: 'asc' },
    });

    // Group by month
    const byMonth: Record<string, { revenue: number; cost: number; profit: number; count: number }> = {};
    bookings.forEach((b) => {
      const k = `${b.createdAt.getFullYear()}-${String(b.createdAt.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth[k]) byMonth[k] = { revenue: 0, cost: 0, profit: 0, count: 0 };
      byMonth[k].revenue += b.totalPrice || 0;
      byMonth[k].cost    += b.supplierCost || 0;
      byMonth[k].profit  += b.profit || 0;
      byMonth[k].count   += 1;
    });

    const totalRevenue = bookings.reduce((s, b) => s + (b.totalPrice || 0), 0);
    const totalCost    = bookings.reduce((s, b) => s + (b.supplierCost || 0), 0);
    const totalProfit  = bookings.reduce((s, b) => s + (b.profit || 0), 0);

    return {
      total: totalRevenue,
      totalCost,
      totalProfit,
      byMonth: Object.entries(byMonth)
        .map(([month, v]) => ({ month, ...v }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      byMethod: [], // payment method uchun alohida endpoint bor
    };
  }

  async agents(tenantId: string, from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const toDate = to ? new Date(to) : new Date();

    const agents = await this.prisma.user.findMany({
      where: { tenantId, role: { in: ['AGENT', 'MANAGER'] }, status: 'ACTIVE' },
      select: {
        id: true, name: true, role: true, avatarUrl: true,
        _count: { select: { bookings: true, assignedClients: true } },
      },
    });

    if (agents.length === 0) return [];
    const agentIds = agents.map((a) => a.id);

    // N+1 o'rniga bitta groupBy query — optimallashtirish
    const [bookingStats, leadsStats, convertedStats] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['agentId'],
        where: { tenantId, agentId: { in: agentIds }, createdAt: { gte: fromDate, lte: toDate }, status: { not: 'CANCELLED' } },
        _count: { id: true },
        _sum: { totalPrice: true, profit: true },
      }),
      // BUG5 FIX: Leads ham davr bilan filtrlanadi
      this.prisma.client.groupBy({
        by: ['assignedAgentId'],
        where: { tenantId, assignedAgentId: { in: agentIds }, createdAt: { gte: fromDate, lte: toDate } },
        _count: { id: true },
      }),
      // Konversiya uchun: booking QILGAN unikal mijozlar (jami davr) — agent kartasi bilan bir xil ta'rif
      this.prisma.client.groupBy({
        by: ['assignedAgentId'],
        where: { tenantId, assignedAgentId: { in: agentIds }, bookings: { some: { status: { not: 'CANCELLED' } } } },
        _count: { id: true },
      }),
    ]);

    const bookingCountMap = new Map(bookingStats.map((b: any) => [b.agentId, b._count.id as number]));
    const leadCountMap = new Map(leadsStats.map((l: any) => [l.assignedAgentId, l._count.id as number]));
    const convertedMap = new Map(convertedStats.map((c: any) => [c.assignedAgentId, c._count.id as number]));

    return agents.map((a) => {
      const bookingsInPeriod: number = (bookingCountMap.get(a.id) as number) || 0;
      const leadsInPeriod: number = (leadCountMap.get(a.id) as number) || 0;
      // Konversiya = booking qilgan mijozlar / jami mijozlar (jami davr) — agent
      // kartasidagi bilan AYNAN bir xil. 100% dan oshmaydi.
      const convertedClients: number = (convertedMap.get(a.id) as number) || 0;
      const totalClients: number = a._count.assignedClients || 0;
      const conversion = totalClients > 0 ? Math.round((convertedClients / totalClients) * 100) : 0;
      // Agent booking stats
      const agentBookingStat = bookingStats.find((b: any) => b.agentId === a.id) as any;
      const agentRevenue = agentBookingStat?._sum?.totalPrice || 0;
      const agentProfit  = agentBookingStat?._sum?.profit || 0;

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

  async bookings(tenantId: string, role: string, userId: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.agentId = userId;

    const [byStatus, byMonth] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['status'], where, _count: { id: true }, _sum: { totalPrice: true } }),
      this.prisma.booking.findMany({
        where, select: { createdAt: true, totalPrice: true, status: true },
        orderBy: { createdAt: 'desc' }, take: 500,
      }),
    ]);

    const monthly: Record<string, { count: number; revenue: number }> = {};
    byMonth.forEach((b) => {
      const k = `${b.createdAt.getFullYear()}-${String(b.createdAt.getMonth() + 1).padStart(2, '0')}`;
      if (!monthly[k]) monthly[k] = { count: 0, revenue: 0 };
      monthly[k].count++;
      if (b.status !== 'CANCELLED') monthly[k].revenue += b.totalPrice;
    });
    return {
      byStatus,
      // BUG6 FIX: localeCompare ile to'g'ri sana tartibida
      byMonth: Object.entries(monthly).map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month)),
    };
  }

  /** v6: Klient manbaalari bo'yicha (Telegram/Instagram/WhatsApp/Referral) */
  async bySource(tenantId: string, role: string, userId: string) {
    try {
      const where: any = { tenantId };
      if (role === 'AGENT') where.assignedAgentId = userId;

      const grouped = await this.prisma.client.groupBy({
        by: ['source'],
        where,
        _count: { id: true },
        _sum: { totalRevenue: true },
      }).catch(() => []);

      return (grouped || []).map((g: any) => ({
        source: g.source || 'UNKNOWN',
        clients: this.safeNumber(g._count?.id),
        revenue: this.safeNumber(g._sum?.totalRevenue),
      })).sort((a: any, b: any) => b.clients - a.clients);
    } catch (e) {
      this.logger.warn('bySource error: ' + e?.message);
      return [];
    }
  }

  /** v6: Destinatsiya bo'yicha (qaysi davlatga ko'p sotyapmiz) */
  async byDestination(tenantId: string, role: string, userId: string, from?: string, to?: string) {
    const where: any = { tenantId, status: { not: 'CANCELLED' } };
    if (role === 'AGENT') where.agentId = userId;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
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

  /** v6: Konversiya voronkasi — bosqichlar bo'yicha klientlar */
  async conversionFunnel(tenantId: string, role: string, userId: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.assignedAgentId = userId;

    const stages: any[] = ['NEW_LEAD', 'CONTACTED', 'INTERESTED', 'OFFER_SENT', 'NEGOTIATION', 'DEPOSIT_PAID', 'CONFIRMED', 'TRAVELING', 'COMPLETED', 'LOST'];
    const grouped = await this.prisma.client.groupBy({
      by: ['pipelineStage'],
      where,
      _count: { id: true },
    });

    const counts: Record<string, number> = {};
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

  /** v6: Daromad grafigi — kunlik/oylik */
  async revenueChart(tenantId: string, role: string, userId: string, period: 'day' | 'month' = 'month') {
    const where: any = { tenantId, status: { not: 'CANCELLED' } };
    if (role === 'AGENT') where.agentId = userId;

    // Oxirgi 12 oy yoki 30 kun
    const since = new Date();
    if (period === 'day') since.setDate(since.getDate() - 30);
    else since.setMonth(since.getMonth() - 12);
    where.createdAt = { gte: since };

    const bookings = await this.prisma.booking.findMany({
      where,
      select: { createdAt: true, totalPrice: true, supplierCost: true, profit: true },
    }).catch(() => []);

    const buckets: Record<string, { revenue: number; cost: number; profit: number; count: number }> = {};
    (bookings || []).forEach((b: any) => {
      const d = b.createdAt;
      const key = period === 'day'
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!buckets[key]) buckets[key] = { revenue: 0, cost: 0, profit: 0, count: 0 };
      buckets[key].revenue += this.safeNumber(b.totalPrice);
      buckets[key].cost += this.safeNumber(b.supplierCost);
      buckets[key].profit += this.safeNumber(b.profit);
      buckets[key].count++;
    });

    return Object.entries(buckets)
      .map(([period_key, v]) => ({ period: period_key, ...v }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  /** v6: To'lov usullari bo'yicha */
  async byPaymentMethod(tenantId: string, role: string, userId: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.agentId = userId;

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

  /**
   * v7: AGENT'NING SHAXSIY STATISTIKASI
   * Agent o'z ishini ko'rishi uchun (admin ko'rmaydi global metrika)
   * Bu ma'lumotlar AGENT'ga ko'rinadi: o'z leadlari, o'z bookinglari, o'z foydasi
   */
  async myStats(tenantId: string, userId: string, _offset = 0, from?: string, to?: string) {
    const now = new Date();
    const monthStart    = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd      = to   ? new Date(to + 'T23:59:59') : now;
    const prevMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);
    const _ = monthEnd; // used in date filters

    const [
      // Leadlar (mijozlar)
      totalLeads, leadsThisMonth, leadsThisWeek, leadsToday,
      // Bookinglar
      totalBookings, bookingsThisMonth, bookingsToday,
      wonBookings, // qabul qilingan (CONFIRMED/COMPLETED)
      // Foyda
      profitThisMonth, profitPrevMonth, profitToday,
      // Qo'ng'iroqlar
      callsThisMonth, callsAnswered,
      // Active suhbatlar
      activeChats,
      kpiTenantFromPA, // BUG9: parallel so'rov
      // Konversiya uchun: booking QILGAN mijozlar soni (unikal mijoz, jami)
      convertedLeads,
    ] = await Promise.all([
      // Leadlar
      this.prisma.client.count({ where: { tenantId, assignedAgentId: userId } }),
      this.prisma.client.count({ where: { tenantId, assignedAgentId: userId, createdAt: { gte: monthStart } } }),
      this.prisma.client.count({ where: { tenantId, assignedAgentId: userId, createdAt: { gte: weekStart } } }),
      this.prisma.client.count({ where: { tenantId, assignedAgentId: userId, createdAt: { gte: todayStart } } }),
      // Bookinglar
      this.prisma.booking.count({ where: { tenantId, agentId: userId, status: { not: 'CANCELLED' } } }),
      this.prisma.booking.count({ where: { tenantId, agentId: userId, status: { not: 'CANCELLED' }, createdAt: { gte: monthStart } } }),
      this.prisma.booking.count({ where: { tenantId, agentId: userId, status: { not: 'CANCELLED' }, createdAt: { gte: todayStart } } }),
      this.prisma.booking.count({ where: { tenantId, agentId: userId, status: { in: ['CONFIRMED', 'COMPLETED'] } } }),
      // Foyda (o'zining bookinglaridan)
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
      // Qo'ng'iroqlar
      this.prisma.call.count({ where: { tenantId, agentId: userId, createdAt: { gte: monthStart } } }),
      this.prisma.call.count({ where: { tenantId, agentId: userId, status: 'COMPLETED', createdAt: { gte: monthStart } } }),
      // Suhbatlar
      this.prisma.conversation.count({ where: { tenantId, assignedAgentId: userId, isResolved: false } }),
      // BUG9 FIX: tenant so'rovini Promise.all ga qo'shamiz (alohida await emas)
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { agentCommissionPercent: true, kpiTiers: true } as any }).catch(() => null),
      // Konversiya = booking qilgan UNIKAL mijozlar / jami mijozlar (jami davr)
      this.prisma.client.count({
        where: { tenantId, assignedAgentId: userId, bookings: { some: { status: { not: 'CANCELLED' } } } },
      }),
    ]);

    // Konversiya foizi: booking qilgan mijozlar / jami mijozlar (100% dan oshmaydi).
    // Bu ta'rif admin "Agentlar reytingi"dagi bilan BIR XIL — raqamlar mos keladi.
    const myConversion = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;

    const profitMonth = profitThisMonth._sum.profit || 0;
    const profitPrev = profitPrevMonth._sum.profit || 0;
    const profitGrowth = profitPrev > 0 ? Math.round(((profitMonth - profitPrev) / profitPrev) * 100) : null;

    // O'rtacha booking summasi
    const avgBookingValue = bookingsThisMonth > 0
      ? Math.round((profitThisMonth._sum.totalPrice || 0) / bookingsThisMonth)
      : 0;

    const revenueMonth = profitThisMonth._sum?.totalPrice || 0;
    const costMonth    = revenueMonth - profitMonth;
    // BUG9 FIX: alohida await o'rniga Promise.all natijasidan
    const kpiTenant = kpiTenantFromPA as any;
    const basePercent = kpiTenant?.agentCommissionPercent ?? 10;
    // v12 FIX: komissiya foizi admin belgilagan KPI tier'laridan (daromad
    // oralig'i bo'yicha) olinadi — flat foiz emas. Shu tufayli dashboarddagi
    // "Mening oyligim", uning foiz yorlig'i va "Kompaniyaga" (netProfit)
    // /reports/my-salary bilan bir xil bo'ladi (ilgari bu yer flat 8%,
    // my-salary esa tier 12% ishlatib, raqamlar mos kelmasdi).
    let kpiTiers: any[] = [];
    try {
      kpiTiers = Array.isArray(kpiTenant?.kpiTiers)
        ? kpiTenant.kpiTiers
        : JSON.parse((kpiTenant?.kpiTiers as string) || '[]');
      if (!Array.isArray(kpiTiers)) kpiTiers = [];
    } catch { kpiTiers = []; }
    let kpi = basePercent;
    let appliedTier: string | null = null;
    if (kpiTiers.length > 0) {
      // v13 FIX: tier daromad (revenue) emas, markup/foyda (profitMonth)
      // bo'yicha tanlanadi — agent qancha markup qo'ygani asosida.
      const sortedTiers = [...kpiTiers].sort((a: any, b: any) => (a.minRevenue || 0) - (b.minRevenue || 0));
      for (const tier of sortedTiers) {
        if (
          profitMonth >= (tier.minRevenue || 0) &&
          (tier.maxRevenue == null || profitMonth < tier.maxRevenue)
        ) {
          kpi = tier.commissionPercent || basePercent;
          appliedTier = tier.name || null;
          break;
        }
      }
      // Hech bir oraliqqa tushmasa — eng yuqori tier
      if (!appliedTier) {
        kpi = sortedTiers[sortedTiers.length - 1].commissionPercent || basePercent;
        appliedTier = sortedTiers[sortedTiers.length - 1].name || null;
      }
    }
    const salaryMonth = Math.round(profitMonth * kpi / 100);

    return {
      // Leadlar
      leads: { total: totalLeads, thisMonth: leadsThisMonth, thisWeek: leadsThisWeek, today: leadsToday },
      // Bookinglar
      bookings: { total: totalBookings, thisMonth: bookingsThisMonth, today: bookingsToday, won: wonBookings },
      // Konversiya (booking qilgan mijozlar / jami mijozlar)
      conversion: { rate: myConversion, won: convertedLeads, total: totalLeads },
      // Foyda
      profit: {
        thisMonth: profitMonth,
        prevMonth: profitPrev,
        today: profitToday._sum.profit || 0,
        growth: profitGrowth,
        avgPerBooking: avgBookingValue,
      },
      // Maosh
      salary: { kpiPercent: kpi, mySalaryThisMonth: salaryMonth, appliedTier, formula: `Foyda × ${kpi}% / 100` },
      // Revenue (dashboard uchun bir xil interfeys)
      revenue: { thisMonth: revenueMonth, prevMonth: 0, today: 0, growth: 0 },
      cost:    { thisMonth: costMonth },
      netProfit: { thisMonth: Math.max(0, profitMonth - salaryMonth) },
      // Dashboard uchun
      thisMonth: {
        revenue: revenueMonth,
        cost: costMonth,
        profit: profitMonth,
        netProfit: Math.max(0, profitMonth - salaryMonth),
        bookings: bookingsThisMonth,
        newClients: leadsThisMonth,
      },
      // Qo'ng'iroqlar
      calls: {
        thisMonth: callsThisMonth,
        answered: callsAnswered,
        answerRate: callsThisMonth > 0 ? Math.round((callsAnswered / callsThisMonth) * 100) : 0,
      },
      activeChats,
    };
  }

  /**
   * v8: AGENT MAOSH KALKULYATORI
   *
   * Tenant'da belgilangan komissiya foiziga ko'ra agent oylik maoshini hisoblaydi.
   *
   * Hisoblash:
   *   - Bu oy uchun agent yopgan bookinglarning foydasi
   *   - Tenant.agentCommissionPercent ga ko'ra agent ulushi
   *   - Bonus: agar agent ma'lum miqdordan ko'p sotsa (kelajakda)
   */
  // ── Shared salary calculator (used by dashboard + mySalary) ──────────────
  private async calcSalary(tenantId: string, userId: string, monthStart: Date, monthEnd: Date) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { agentCommissionPercent: true, kpiTiers: true } as any,
    }) as any;

    const commissionPercent = tenant?.agentCommissionPercent ?? 10;
    const kpiTiers = Array.isArray(tenant?.kpiTiers)
      ? tenant.kpiTiers
      : JSON.parse((tenant?.kpiTiers as string) || '[]');

    const bookings = await this.prisma.booking.findMany({
      where: { tenantId, agentId: userId, status: { in: ['DRAFT', 'CONFIRMED', 'COMPLETED'] }, createdAt: { gte: monthStart, lt: monthEnd } },
      select: { totalPrice: true, profit: true, commissionAmount: true },
    });

    const revenue = bookings.reduce((s: number, b: any) => s + this.safeNumber(b.totalPrice), 0);
    const profit  = bookings.reduce((s: number, b: any) => s + this.safeNumber(b.profit), 0);

    // KPI tiers override base percent
    let appliedPercent = commissionPercent;
    let appliedTier = null;
    if (kpiTiers.length > 0) {
      // BUG3 FIX: ASC sort (mySalary bilan bir xil)
      // v13 FIX: tier daromad (revenue) emas, markup/foyda (profit)
      // bo'yicha tanlanadi.
    const sorted = [...kpiTiers].sort((a: any, b: any) => a.minRevenue - b.minRevenue);
      for (const tier of sorted) {
        // BUG1 FIX: maxRevenue ham tekshiriladi
        if (
          profit >= (tier.minRevenue || 0) &&
          (tier.maxRevenue === null || profit < tier.maxRevenue)
        ) {
          appliedPercent = tier.commissionPercent || commissionPercent;
          appliedTier = tier.name || null;
          break;
        }
      }
      // BUG1 FIX: Hech bir tier mos kelmasa — eng yuqori tier
      if (!appliedTier && sorted.length > 0) {
        appliedPercent = sorted[sorted.length - 1].commissionPercent || commissionPercent;
        appliedTier = sorted[sorted.length - 1].name || null;
      }
    }

    const grossSalary = Math.round(profit * appliedPercent / 100);
    const pending = Math.max(0, grossSalary - bookings.reduce((s: number, b: any) => s + this.safeNumber(b.commissionAmount), 0));

    return { grossSalary, pending, myCommissionPercent: appliedPercent, appliedTier, revenue, profit, bookingCount: bookings.length };
  }

  // ─── v10.3: Agentlar oyma-oy tarixi ─────────────────────────────────────
  // Admin: hamma agentning oxirgi N oy bo'yicha leadlari, bookinglari,
  // conversion, daromadi, foydasi va maoshi (KPI tier hisobga olinadi).
  // Agent: faqat o'zining tarixini oladi (boshqalar ko'rinmaydi).
  async agentsMonthly(tenantId: string, userId: string, role: string, months = 6, agentIdFilter?: string) {
    const isAgent = role === 'AGENT';
    const targetAgentId = isAgent ? userId : (agentIdFilter || undefined);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { agentCommissionPercent: true, kpiTiers: true, currency: true } as any,
    });
    const basePercent = Number((tenant as any)?.agentCommissionPercent ?? 10);
    let kpiTiers: any[] = [];
    try {
      kpiTiers = Array.isArray((tenant as any)?.kpiTiers)
        ? (tenant as any).kpiTiers
        : JSON.parse(((tenant as any)?.kpiTiers as string) || '[]');
      if (!Array.isArray(kpiTiers)) kpiTiers = [];
    } catch { kpiTiers = []; }

    // v13 FIX: tier daromad (revenue) emas, markup/foyda (profit) bo'yicha tanlanadi.
    const pickPercent = (markupAmount: number) => {
      let percent = basePercent;
      if (kpiTiers.length > 0) {
        const sorted = [...kpiTiers].sort((a: any, b: any) => a.minRevenue - b.minRevenue);
        let applied: any = null;
        for (const tier of sorted) {
          if (markupAmount >= tier.minRevenue && (tier.maxRevenue === null || markupAmount < tier.maxRevenue)) {
            applied = tier; break;
          }
        }
        if (!applied && sorted.length > 0) applied = sorted[sorted.length - 1];
        if (applied) percent = applied.commissionPercent;
      }
      return percent;
    };

    // Agentlar ro'yxati
    const agents = await this.prisma.user.findMany({
      where: {
        tenantId, status: 'ACTIVE',
        role: { in: ['AGENT', 'MANAGER'] },
        ...(targetAgentId ? { id: targetAgentId } : {}),
      },
      select: { id: true, name: true, role: true, avatarUrl: true },
    });
    if (agents.length === 0) return { months: [], agents: [] };
    const agentIds = agents.map((a) => a.id);

    const now = new Date();
    const n = Math.min(Math.max(months, 1), 24);
    const rangeStart = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);

    // Bitta so'rovda hamma bookinglar va leadlar — keyin oylarga taqsimlaymiz
    const [bookings, leads] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          tenantId, agentId: { in: agentIds },
          status: { in: ['DRAFT', 'CONFIRMED', 'COMPLETED'] },
          createdAt: { gte: rangeStart },
        },
        select: { agentId: true, totalPrice: true, profit: true, createdAt: true },
      }),
      this.prisma.client.findMany({
        where: { tenantId, assignedAgentId: { in: agentIds }, createdAt: { gte: rangeStart } },
        select: { assignedAgentId: true, createdAt: true },
      }),
    ]);

    const monthKey = (d: Date | string) => {
      const x = new Date(d);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
    };

    const monthKeys: string[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthKeys.push(monthKey(d));
    }

    const result = agents.map((agent) => {
      const rows = monthKeys.map((mk) => {
        const bks = bookings.filter((b) => b.agentId === agent.id && monthKey(b.createdAt) === mk);
        const lds = leads.filter((l) => l.assignedAgentId === agent.id && monthKey(l.createdAt) === mk);
        const revenue = bks.reduce((s, b) => s + (b.totalPrice || 0), 0);
        const profit = bks.reduce((s, b) => s + (b.profit || 0), 0);
        const percent = pickPercent(profit);
        const salary = +(profit * percent / 100).toFixed(2);
        const conversion = lds.length > 0 ? Math.round((bks.length / lds.length) * 100) : 0;
        return {
          month: mk,
          leads: lds.length,
          bookings: bks.length,
          conversion,
          revenue: Math.round(revenue),
          profit: Math.round(profit),
          commissionPercent: percent,
          salary,
        };
      });
      const totals = rows.reduce((t, r) => ({
        leads: t.leads + r.leads, bookings: t.bookings + r.bookings,
        revenue: t.revenue + r.revenue, profit: t.profit + r.profit, salary: t.salary + r.salary,
      }), { leads: 0, bookings: 0, revenue: 0, profit: 0, salary: 0 });
      return { agent, rows, totals: { ...totals, salary: +totals.salary.toFixed(2) } };
    });

    return { months: monthKeys, currency: (tenant as any)?.currency || 'USD', agents: result };
  }

  async mySalary(tenantId: string, userId: string, monthOffset = 0) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);

    // BUG2 FIX: bitta so'rovda hamma kerakli fieldlar
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        agentCommissionPercent: true,
        managerCommissionPercent: true,
        currency: true,
        kpiTiers: true,
        settings: true, // salaryNotes shu yerda
      } as any,
    });
    if (!tenant) return null;

    // Bu oy uchun agentning bookinglari — dashboarddagi "activeStatuses"
    // (DRAFT, CONFIRMED, COMPLETED) bilan bir xil ta'rif, aks holda DRAFT
    // holatidagi bookinglar bu yerda hisobga olinmay, admin "Agentlar"
    // jadvalida Daromad/Maosh $0 ko'rinib, umumiy dashboard bilan mos
    // kelmay qolardi.
    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId, agentId: userId,
        status: { in: ['DRAFT', 'CONFIRMED', 'COMPLETED'] },
        createdAt: { gte: monthStart, lt: monthEnd },
      },
      select: {
        id: true, bookingRef: true, totalPrice: true, profit: true,
        status: true, currency: true, createdAt: true,
        client: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Komissiyalar bo'yicha
    const totalProfit = bookings.reduce((s, b) => s + (b.profit || 0), 0);
    const totalRevenue = bookings.reduce((s, b) => s + (b.totalPrice || 0), 0);
    
    // v13 FIX: KPI TIERS - komissiya foizi DAROMAD (revenue) emas,
    // MARKUP/FOYDA (totalProfit = totalPrice - supplierCost) bo'yicha
    // tanlanadi. Ya'ni agent qancha ustama (markup) qo'ygan bo'lsa,
    // shunga qarab tier aniqlanadi va o'sha foiz totalProfit'ga qo'llanadi.
    let commissionPercent = Number(tenant?.agentCommissionPercent ?? 10);  
    let appliedTier = null;
    
    try {
      const kpiTiers = Array.isArray(tenant.kpiTiers) 
        ? tenant.kpiTiers 
        : JSON.parse((tenant.kpiTiers as string) || '[]');
      
      if (Array.isArray(kpiTiers) && kpiTiers.length > 0) {
        const sorted = [...kpiTiers].sort((a: any, b: any) => a.minRevenue - b.minRevenue);
        for (const tier of sorted) {
          if (totalProfit >= tier.minRevenue && (tier.maxRevenue === null || totalProfit < tier.maxRevenue)) {
            commissionPercent = tier.commissionPercent;
            appliedTier = tier;
            break;
          }
        }
        // Agar markup barcha tierlardan oshsa — oxirgi tier qo'llanadi
        if (!appliedTier && sorted.length > 0) {
          commissionPercent = sorted[sorted.length - 1].commissionPercent;
          appliedTier = sorted[sorted.length - 1];
        }
      }
    } catch (e) {
      // Fall back to default percent
    }

    const grossSalary = +(totalProfit * commissionPercent / 100).toFixed(2);

    // Allaqachon paid commissionlar
    const paidCommissions = await this.prisma.commission.aggregate({
      where: {
        tenantId, agentId: userId, isPaid: true,
        paidAt: { gte: monthStart, lt: monthEnd },
      },
      _sum: { agentAmount: true },
    });
    const alreadyPaid = paidCommissions._sum.agentAmount || 0;
    const pending = Math.max(0, grossSalary - alreadyPaid);

    // BUG2 FIX: alohida findUnique o'rniga birinchi so'rov natijasidan
    const salaryNotes: any = ((tenant as any).settings as any)?.salaryNotes || {};
    const agentSalaryNote = salaryNotes[userId] || {};

    // v10: Jamoadagi reytingni aniqlaymiz — agentSalaries() dagi bir xil
    // mantiq (KPI tier, oy oralig'i) qayta ishlatiladi, shunda ikkalasi
    // har doim bir-biriga mos keladi. Boshqa agentlarning ismi yoki aniq
    // summasi bu yerga QAYTARILMAYDI — faqat o'rin raqami va jami son.
    let myRank: number | null = null;
    let totalAgents = 0;
    try {
      const allAgentSalaries = await this.agentSalaries(tenantId, monthOffset);
      totalAgents = allAgentSalaries.length;
      const idx = allAgentSalaries.findIndex((a: any) => a.id === userId);
      myRank = idx === -1 ? null : idx + 1; // 1-o'rin = eng yuqori oylik
    } catch {
      // Reyting hisoblanmasa ham asosiy maosh ma'lumoti qaytishi kerak
    }

    return {
      monthStart, monthEnd,
      currency: tenant.currency,
      myCommissionPercent: commissionPercent,
      isPaid: agentSalaryNote.isPaid || false,
      adminNote: agentSalaryNote.note || '',
      paidAt: agentSalaryNote.paidAt || null,
      appliedTier, // v9: Show which tier was applied
      bookingsCount: bookings.length,
      totalRevenue,
      totalProfit,
      grossSalary,
      alreadyPaid,
      pending,
      myRank,       // v10: masalan 2 — jamoada 2-o'rinda
      totalAgents,  // v10: masalan 5 — jami nechta faol agent bor
      bookings: bookings.slice(0, 20),
      breakdown: bookings.map((b: any) => ({
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

  /**
   * v8: ADMIN UCHUN — barcha agentlar maoshlari
   */
  async agentSalaries(tenantId: string, monthOffset = 0) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);

    // BUG2+BUG8 FIX: kpiTiers ham olamiz + N+1 ni groupBy bilan hal qilamiz
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { agentCommissionPercent: true, currency: true, kpiTiers: true } as any,
    });
    if (!tenant) return [];

    const agents = await this.prisma.user.findMany({
      where: { tenantId, status: 'ACTIVE', role: 'AGENT' },
      select: { id: true, name: true, email: true, avatarUrl: true },
    });
    if (!agents.length) return [];

    const agentIds = agents.map((a: any) => a.id);

    // BUG8 FIX: N+1 o'rniga 2 ta parallel groupBy so'rov
    const [bookingStats, commissionStats] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['agentId'],
        where: { tenantId, agentId: { in: agentIds }, status: { in: ['CONFIRMED','COMPLETED'] as any[] }, createdAt: { gte: monthStart, lt: monthEnd } },
        _count: { id: true },
        _sum: { totalPrice: true, profit: true },
      }),
      this.prisma.commission.groupBy({
        by: ['agentId'],
        where: { tenantId, agentId: { in: agentIds }, isPaid: true, paidAt: { gte: monthStart, lt: monthEnd } },
        _sum: { agentAmount: true },
      }).catch(() => []),
    ]);

    // BUG2 FIX: KPI tiers bilan hisoblash
    const kpiTiersRaw = (tenant as any).kpiTiers;
    let kpiTiers: any[] = [];
    try { kpiTiers = Array.isArray(kpiTiersRaw) ? kpiTiersRaw : JSON.parse(kpiTiersRaw || '[]'); } catch {}

    const results = agents.map((a: any) => {
      const bStat = (bookingStats as any[]).find((b: any) => b.agentId === a.id) as any;
      const cStat = (commissionStats as any[]).find((c: any) => c.agentId === a.id) as any;
      const totalRevenue = bStat?._sum?.totalPrice || 0;
      const totalProfit  = bStat?._sum?.profit || 0;

      // BUG2 FIX: KPI tier foizini aniqlash (ASC sort — BUG3 bilan mos)
      // v13 FIX: tier daromad (totalRevenue) emas, markup/foyda (totalProfit) bo'yicha tanlanadi.
      let commissionPercent = (tenant as any).agentCommissionPercent || 10;
      if (kpiTiers.length > 0) {
        const sorted = [...kpiTiers].sort((a: any, b: any) => a.minRevenue - b.minRevenue);
        for (const tier of sorted) {
          if (totalProfit >= tier.minRevenue && (tier.maxRevenue === null || totalProfit < tier.maxRevenue)) {
            commissionPercent = tier.commissionPercent;
            break;
          }
        }
      }

      const salary = +(totalProfit * commissionPercent / 100).toFixed(2);
      const paid   = cStat?._sum?.agentAmount || 0;
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

    return results.sort((a: any, b: any) => b.salary - a.salary);
  }

  /**
   * v9-FINAL: KLIENTNING TO'LIQ MOLIYAVIY PROFILI
   *
   * Klient kartasida ko'rsatiladi:
   *   - Jami bookinglar (booking ro'yxati)
   *   - Total Revenue (mijoz to'lagan summa)
   *   - Total Cost (provayderga ketgan)
   *   - Total Profit (foyda)
   *   - To'langan / Qoldiq
   *   - Birinchi va oxirgi sana
   *
   * Permissions:
   *   - Admin/Manager: hamma ko'radi
   *   - Agent: faqat o'z klientini ko'radi
   */
  async getClientFinancial(
    tenantId: string,
    clientId: string,
    userId: string,
    role: string,
  ) {
    // Klient ruxsatini tekshirish
    const whereClient: any = { id: clientId, tenantId };
    if (role === 'AGENT') whereClient.assignedAgentId = userId;
    const client = await this.prisma.client.findFirst({
      where: whereClient,
      include: {
        assignedAgent: { select: { id: true, name: true } },
      },
    });
    if (!client) {
      throw new NotFoundException("Klient topilmadi yoki sizning ruxsatingiz yo'q");
    }

    // Klientning barcha bookinglari
    const bookings = await this.prisma.booking.findMany({
      where: { clientId, tenantId },
      orderBy: { createdAt: 'desc' },
      include: {
        agent: { select: { id: true, name: true } },
        payments: { select: { amount: true, paidAt: true, method: true, status: true } },
      },
    });

    // Statistik hisob-kitob
    let totalRevenue = 0;
    let totalCost = 0;
    let totalProfit = 0;
    let totalPaid = 0;
    let totalDue = 0;

    const bookingSummaries = bookings.map((b: any) => {
      // BUG7 FIX: NaN xavfini oldini olish
      const cost     = this.safeNumber(b.supplierCost || b.providerCost);
      const discount = this.safeNumber((b as any).discount);
      const profit   = b.profit != null
        ? this.safeNumber(b.profit)
        : this.safeNumber(b.totalPrice) - cost - discount;
      const paid = (b.payments || [])
        .filter((p: any) => p.status === 'COMPLETED' || p.status === 'PAID')
        .reduce((s: number, p: any) => s + (p.amount || 0), 0);

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
        // Klient ko'radigan
        totalPrice: b.totalPrice,
        // Admin/Agent ko'radigan (klientga ko'rinmaydi)
        supplierCost: cost,
        profit,
        // To'lov
        paidAmount: paid,
        dueAmount: Math.max(0, due),
        // Sayohat sanalari
        departureDate: b.departureDate,
        returnDate: b.returnDate,
        // Agent
        agent: b.agent,
        createdAt: b.createdAt,
      };
    });

    // Birinchi va oxirgi sana
    const dates = bookings.map((b: any) => new Date(b.createdAt).getTime()).filter(Boolean);
    const firstBookingAt = dates.length ? new Date(Math.min(...dates)) : null;
    const lastBookingAt = dates.length ? new Date(Math.max(...dates)) : null;

    return {
      // Klient asosiy
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
      // Moliyaviy
      financial: {
        totalRevenue,         // mijoz to'lagan summa
        totalCost,            // provayderga ketgan
        totalProfit,          // foyda
        totalPaid,            // to'langan
        totalDue,             // qoldiq
        bookingsCount: bookings.length,
        avgBookingValue: bookings.length ? totalRevenue / bookings.length : 0,
        firstBookingAt,
        lastBookingAt,
        // LTV (Lifetime Value)
        ltv: totalRevenue,
      },
      // Booking ro'yxati
      bookings: bookingSummaries,
    };
  }

  /**
   * v9-FINAL: LEAD SOURCE ANALYTICS
   *
   * Manba bo'yicha tahlil:
   *   - Lead'lar soni (klient yaratilgan)
   *   - Conversion rate (lead → kamida 1 booking)
   *   - Daromad (har bir manbadan keladigan jami summa)
   *   - O'rtacha booking qiymati
   *   - Tarixiy timeline (kunlik)
   */
  async getCallAnalytics(tenantId: string, days: number, agentId?: string) {
    const from = new Date(Date.now() - days * 86400000);
    const where: any = { tenantId, createdAt: { gte: from } };
    if (agentId) where.agentId = agentId;
    const total = await this.prisma.call.count({ where });
    const byStatus = await this.prisma.call.groupBy({ by: ['status'], where, _count: { id: true } });
    const answered = (byStatus.find((r: any) => r.status === 'COMPLETED') as any)?._count?.id || 0;
    const daily = await this.prisma.call.findMany({ where, select: { createdAt: true, status: true }, orderBy: { createdAt: 'asc' } });
    const byDayMap: Record<string, {date: string; total: number; answered: number}> = {};
    for (const c of daily) {
      const date = c.createdAt.toISOString().slice(0, 10);
      if (!byDayMap[date]) byDayMap[date] = { date, total: 0, answered: 0 };
      byDayMap[date].total++;
      if ((c as any).status === 'COMPLETED') byDayMap[date].answered++;
    }

    // v17: har bir agent qancha VAQT gaplashgani (jami suhbat davomiyligi),
    // nechta qo'ng'iroqda YOZUV borligi VA endi — AI tahlil natijalari ham
    // AGENT KESIMIDA (o'rtacha bahosi, eng ko'p uchragan e'tirozi, kayfiyat
    // taqsimoti). Foydalanuvchi so'ragan "qaysi hodim qanchalik ishlayotgani,
    // nega sotolmayapti" — aynan shu agent-darajasidagi AI tahlil.
    //
    // v23 TUZATISH: ilgari bu FAQAT `agentId` berilmaganda (ya'ni admin
    // BARCHA agentlarni ko'rayotganda) hisoblanardi — agar bitta agentga
    // filtr qilingan bo'lsa (masalan agent o'zining "Qo'ng'iroqlarim"
    // sahifasini ochsa, backend uni avtomatik o'z ID'siga filtrlaydi),
    // `byAgent` UMUMAN QAYTMASDI — shu sabab agent o'zining yozuvlari va
    // koching (AI feedback) xulosasini HECH QACHON ko'RA OLMASDI. Endi
    // har doim hisoblanadi — `where` allaqachon to'g'ri agentga filtrlangan
    // bo'lsa, natijada shunchaki 1 ta agent chiqadi.
    const rows = await this.prisma.call.findMany({
      where,
      select: {
        agentId: true, status: true, duration: true, recordingUrl: true,
        aiAnalyzedAt: true, aiObjections: true, aiSentiment: true, aiFeedback: true,
        agent: { select: { id: true, name: true } },
      },
    });
    const agentMap: Record<string, {
      agentId: string; agentName: string; totalCalls: number; answered: number;
      totalDurationSec: number; recordingsCount: number;
      aiAnalyzedCount: number; aiScoreSum: number; aiScoreN: number;
      aiSaleReadinessSum: number; aiSaleReadinessN: number;
      aiObjectionCounts: Record<string, { category: string; label: string; count: number }>;
      aiSentiment: { positive: number; neutral: number; negative: number };
      aiBestPhrases: string[]; aiMissedInfos: string[]; aiImprovements: string[]; aiWhatWouldClose: string[];
    }> = {};
    for (const c of rows) {
      const aId = c.agentId || 'unassigned';
      const aName = c.agent?.name || "Agentsiz";
      if (!agentMap[aId]) {
        agentMap[aId] = {
          agentId: aId, agentName: aName, totalCalls: 0, answered: 0,
          totalDurationSec: 0, recordingsCount: 0,
          aiAnalyzedCount: 0, aiScoreSum: 0, aiScoreN: 0,
          aiSaleReadinessSum: 0, aiSaleReadinessN: 0,
          aiObjectionCounts: {},
          aiSentiment: { positive: 0, neutral: 0, negative: 0 },
          aiBestPhrases: [], aiMissedInfos: [], aiImprovements: [], aiWhatWouldClose: [],
        };
      }
      const entry = agentMap[aId];
      entry.totalCalls++;
      if (c.status === 'COMPLETED') entry.answered++;
      entry.totalDurationSec += c.duration || 0;
      if (c.recordingUrl) entry.recordingsCount++;

      if ((c as any).aiAnalyzedAt) {
        entry.aiAnalyzedCount++;
        const fb = (c as any).aiFeedback as any;
        if (fb?.score) { entry.aiScoreSum += Number(fb.score); entry.aiScoreN++; }
        if (fb?.saleReadiness?.score) { entry.aiSaleReadinessSum += Number(fb.saleReadiness.score); entry.aiSaleReadinessN++; }
        if (fb?.bestPhrase && entry.aiBestPhrases.length < 5) entry.aiBestPhrases.push(fb.bestPhrase);
        if (fb?.saleReadiness?.missedInfo && entry.aiMissedInfos.length < 5) entry.aiMissedInfos.push(fb.saleReadiness.missedInfo);
        if (fb?.saleReadiness?.whatWouldClose && entry.aiWhatWouldClose.length < 5) entry.aiWhatWouldClose.push(fb.saleReadiness.whatWouldClose);
        if (Array.isArray(fb?.improvements)) {
          for (const imp of fb.improvements) {
            if (imp && entry.aiImprovements.length < 5) entry.aiImprovements.push(imp);
          }
        }
        const sentiment = (c as any).aiSentiment as string | null;
        if (sentiment && sentiment in entry.aiSentiment) (entry.aiSentiment as any)[sentiment]++;
        const objList = (c as any).aiObjections as any[] | null;
        if (Array.isArray(objList)) {
          for (const o of objList) {
            if (!o?.category) continue;
            if (!entry.aiObjectionCounts[o.category]) {
              entry.aiObjectionCounts[o.category] = { category: o.category, label: OBJECTION_CATEGORIES[o.category] || o.category, count: 0 };
            }
            entry.aiObjectionCounts[o.category].count++;
          }
        }
      }
    }
    const byAgent = Object.values(agentMap)
      .map((a) => {
        const sortedObj = Object.values(a.aiObjectionCounts).sort((x, y) => y.count - x.count);
        return {
          agentId: a.agentId,
          agentName: a.agentName,
          totalCalls: a.totalCalls,
          answered: a.answered,
          totalDurationSec: a.totalDurationSec,
          recordingsCount: a.recordingsCount,
          aiAnalyzedCount: a.aiAnalyzedCount,
          aiAvgScore: a.aiScoreN > 0 ? Math.round((a.aiScoreSum / a.aiScoreN) * 10) / 10 : null,
          aiAvgSaleReadiness: a.aiSaleReadinessN > 0 ? Math.round((a.aiSaleReadinessSum / a.aiSaleReadinessN) * 10) / 10 : null,
          aiTopObjection: sortedObj[0] || null,
          aiSentiment: a.aiSentiment,
          aiBestPhrases: a.aiBestPhrases,
          aiMissedInfos: a.aiMissedInfos,
          aiImprovements: a.aiImprovements,
          aiWhatWouldClose: a.aiWhatWouldClose,
        };
      })
      .sort((a, b) => b.totalDurationSec - a.totalDurationSec);

    // v15: AI tahlil qilingan qo'ng'iroqlar — e'tirozlar va agent baholari
    const analyzed = await this.prisma.call.findMany({
      where: { ...where, aiAnalyzedAt: { not: null } },
      select: { aiObjections: true, aiSentiment: true, aiFeedback: true },
    });
    const objectionCounts: Record<string, { category: string; label: string; count: number }> = {};
    let sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    let scoreSum = 0, scoreN = 0;
    for (const c of analyzed) {
      const list = (c as any).aiObjections as any[] | null;
      if (Array.isArray(list)) {
        for (const o of list) {
          if (!o?.category) continue;
          if (!objectionCounts[o.category]) {
            objectionCounts[o.category] = { category: o.category, label: OBJECTION_CATEGORIES[o.category] || o.category, count: 0 };
          }
          objectionCounts[o.category].count++;
        }
      }
      const sentiment = (c as any).aiSentiment as string | null;
      if (sentiment && sentiment in sentimentCounts) (sentimentCounts as any)[sentiment]++;
      const fb = (c as any).aiFeedback as any;
      if (fb?.score) { scoreSum += Number(fb.score); scoreN++; }
    }

    const sortedObjections = Object.values(objectionCounts).sort((a, b) => b.count - a.count);
    // v16: eng ko'p uchragan e'tirozga tayyor tavsiya (Hisobotlar/Dashboard uchun)
    const topRecommendation = sortedObjections.length
      ? { category: sortedObjections[0].category, label: sortedObjections[0].label, tip: OBJECTION_PLAYBOOK[sortedObjections[0].category] || OBJECTION_PLAYBOOK.other }
      : null;

    return {
      summary: { total, answered, noAnswer: total - answered, conversionRate: total > 0 ? Math.round(answered / total * 100) : 0 },
      byDay: Object.values(byDayMap),
      byAgent,
      aiAnalytics: {
        analyzedCount: analyzed.length,
        objections: sortedObjections,
        sentiment: sentimentCounts,
        avgAgentScore: scoreN > 0 ? Math.round((scoreSum / scoreN) * 10) / 10 : null,
        topRecommendation,
      },
    };
  }

  async getLeadAnalytics(tenantId: string, days: number) {
    try {
      const since = new Date();
      since.setDate(since.getDate() - days);

      // Barcha klientlarni manba bo'yicha guruhlash
      const clients: any[] = await this.prisma.client.findMany({
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

      // Manba bo'yicha statistik
      const sourceMap: Record<string, any> = {};
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
          sourceMap[src].revenue += c.bookings.reduce((s: number, b: any) => s + this.safeNumber(b.totalPrice), 0);
          sourceMap[src].profit += c.bookings.reduce((s: number, b: any) => s + this.safeNumber(b.profit), 0);
        }
      }

      // Conversion rate hisoblash + sortlash
      const bySource = Object.values(sourceMap)
        .map((s: any) => ({
          ...s,
          conversionRate: s.leads > 0 ? (s.conversions / s.leads) * 100 : 0,
          avgBookingValue: s.bookings > 0 ? s.revenue / s.bookings : 0,
          avgProfitPerLead: s.leads > 0 ? s.profit / s.leads : 0,
        }))
        .sort((a: any, b: any) => b.revenue - a.revenue);

      // Eng yaxshi manba (revenue bo'yicha)
      const topSource = bySource[0]?.source || null;
      const topByConversion = [...bySource].sort((a: any, b: any) => b.conversionRate - a.conversionRate)[0]?.source || null;

      // Jami statistik
      const totalLeads = (clients || []).length;
      const totalBookings = (clients || []).reduce((s, c) => s + (c.bookings?.length || 0), 0);
      const totalRevenue = (clients || []).reduce(
        (s, c) => s + ((c.bookings || []).reduce((bs: number, b: any) => bs + this.safeNumber(b.totalPrice), 0)),
        0,
      );
      const totalProfit = (clients || []).reduce(
        (s, c) => s + ((c.bookings || []).reduce((bs: number, b: any) => bs + this.safeNumber(b.profit), 0)),
        0,
      );

      // Kunlik timeline (oxirgi N kun)
      const timeline: Record<string, number> = {};
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        timeline[key] = 0;
      }
      for (const c of (clients || [])) {
        const key = new Date(c.createdAt).toISOString().split('T')[0];
        if (timeline[key] !== undefined) timeline[key] += 1;
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
    } catch (e) {
      this.logger.warn('getLeadAnalytics error: ' + e?.message);
      return {
        period: { days, since: new Date() },
        summary: { totalLeads: 0, totalBookings: 0, totalRevenue: 0, totalProfit: 0, avgConversionRate: 0, topSource: null, topByConversion: null },
        bySource: [],
        timeline: [],
      };
    }
  }

  // ─── EXPORT: Excel ────────────────────────────────────────────────────────
  /**
   * v17: Eksport uchun umumiy ma'lumot tayyorlash — CSV, XLSX va PDF
   * uchastkalari BIR XIL ma'lumotdan foydalanadi (dublikatni oldini olish).
   */
  private async getExportData(tenantId: string, role: string, userId: string, type: string, from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().setMonth(new Date().getMonth() - 1));
    const toDate = to ? new Date(to) : new Date();

    let rows: any[] = [];
    let headers: string[] = [];

    if (type === 'bookings') {
      const items = await this.prisma.booking.findMany({
        where: { tenantId, createdAt: { gte: fromDate, lte: toDate }, ...(role === 'AGENT' ? { agentId: userId } : {}) },
        include: { client: { select: { fullName: true, phone: true } }, agent: { select: { name: true } } },
        orderBy: { createdAt: 'desc' }, take: 1000,
      });
      headers = ['#', 'Ref', 'Klient', 'Telefon', 'Tur', 'Yonalish', 'Sana', 'Narxi', 'Foyda', 'Status', 'Agent'];
      rows = items.map((b, i) => [
        i+1, b.bookingRef, b.client?.fullName, b.client?.phone, b.tourName, b.destination,
        b.createdAt.toLocaleDateString('uz-UZ'), b.totalPrice, b.profit || 0, b.status, b.agent?.name,
      ]);
    } else if (type === 'clients') {
      // v41 FIX: ilgari BU YERDA ikkita muammo bor edi:
      //  1) `createdAt: { gte: fromDate, lte: toDate }` — from/to berilmasa
      //     standart oxirgi 1 oy bilan chegaralanardi, shu sabab eski
      //     mijozlar "hammasi"ni yuklab olishda tushib qolardi.
      //  2) `take: 1000` — 1000 dan ortiq mijozi bor tenant'lar uchun
      //     qolganlari kesilib qolardi.
      //  3) faqat `c.pipelineStage` (xom ENUM) chiqarilardi — maxsus
      //     (Kanban) bosqichdagi mijozlar har doim "NEW_LEAD" bo'lib
      //     ko'rinardi, chunki haqiqiy bosqich nomi customStageId orqali
      //     saqlanadi (pipelineStage import paytida ataylab NEW_LEAD'da
      //     qoldiriladi — clients.service.ts izohiga qarang).
      // Endi: mijozlar uchun sana oralig'i FAQAT foydalanuvchi aniq
      // from/to bergandagina qo'llanadi (masalan hisobot ekranida oy
      // tanlansa); "Mijozlar" turini standart holida yuklab olishda —
      // hammasi (10 000 tagacha) tushadi. Bosqich ustuni ham avval
      // customStage nomini, topilmasa pipelineStage enumini ko'rsatadi.
      const clientsWhere: any = { tenantId };
      if (from || to) clientsWhere.createdAt = { gte: fromDate, lte: toDate };
      const items = await this.prisma.client.findMany({
        where: clientsWhere,
        include: { assignedAgent: { select: { name: true } }, customStage: { select: { name: true } } },
        orderBy: { createdAt: 'desc' }, take: 10000,
      });
      headers = ['#', 'Ism', 'Telefon', 'Email', 'Manba', 'Stage', 'Tier', 'Agent', 'Sana'];
      rows = items.map((c, i) => [
        i+1, (c as any).fullName, c.phone, c.email, c.source,
        (c as any).customStage?.name || c.pipelineStage, c.tier,
        (c as any).assignedAgent?.name, c.createdAt.toLocaleDateString('uz-UZ'),
      ]);
    } else if (type === 'payments') {
      const items = await this.prisma.payment.findMany({
        where: { tenantId, paidAt: { gte: fromDate, lte: toDate } },
        include: { booking: { include: { client: { select: { fullName: true } } } } },
        orderBy: { paidAt: 'desc' }, take: 1000,
      });
      headers = ['#', 'Sana', 'Klient', 'Miqdor', 'Valyuta', 'Usul', 'Status', 'Booking Ref'];
      rows = items.map((p, i) => [
        i+1, p.paidAt?.toLocaleDateString('uz-UZ'), p.booking?.client?.fullName,
        p.amount, p.currency, p.method, p.status, p.booking?.bookingRef,
      ]);
    } else if (type === 'calls') {
      const items = await this.prisma.call.findMany({
        where: { tenantId, createdAt: { gte: fromDate, lte: toDate }, ...(role === 'AGENT' ? { agentId: userId } : {}) },
        include: { agent: { select: { name: true } }, client: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' }, take: 1000,
      });
      headers = ['#', 'Sana', 'Agent', 'Klient', 'Yonalish', 'Status', 'Davomiylik (sek)', 'Raqam'];
      rows = items.map((c, i) => [
        i+1, c.createdAt.toLocaleDateString('uz-UZ'), c.agent?.name, c.client?.fullName,
        c.direction, c.status, c.duration, c.toMasked || c.fromMasked,
      ]);
    }

    return { headers, rows };
  }

  async exportExcel(tenantId: string, role: string, userId: string, type: string, from?: string, to?: string) {
    const { headers, rows } = await this.getExportData(tenantId, role, userId, type, from, to);

    // Build CSV (simpler than Excel, works universally)
    const csvLines = [
      headers.join(','),
      ...rows.map(row => row.map((v: any) => {
        const s = String(v ?? '').replace(/"/g, '""');
        const needsQuote = s.includes(',') || s.includes('"') || s.indexOf('\n') >= 0;
        return needsQuote ? `"${s}"` : s;
      }).join(','))
    ];
    const newline = '\n';
    const csv = '\uFEFF' + csvLines.join(newline); // BOM for Excel UTF-8

    return { csv, filename: `${type}-${new Date().toISOString().slice(0,10)}.csv`, rows: rows.length };
  }

  /**
   * v17: HAQIQIY .xlsx fayl (formatlash, ustun kengligi, sarlavha rangi
   * bilan) — oldingi CSV'dan farqli, Excel'da to'g'ridan-to'g'ri chiroyli
   * ochiladi.
   */
  async exportXlsx(tenantId: string, role: string, userId: string, type: string, from?: string, to?: string) {
    const { headers, rows } = await this.getExportData(tenantId, role, userId, type, from, to);
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Omon CRM';
    workbook.created = new Date();

    const TITLES: Record<string, string> = {
      bookings: 'Bookinglar', clients: 'Mijozlar', payments: "To'lovlar", calls: "Qo'ng'iroqlar",
    };
    const sheet = workbook.addWorksheet(TITLES[type] || 'Hisobot');

    sheet.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 4) }));
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3D7EFF' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 22;

    for (const row of rows) sheet.addRow(row);

    // Juft-toq qatorlarni farqlash (o'qishni osonlashtirish uchun)
    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      if (idx % 2 === 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FC' } };
      }
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), filename: `${type}-${new Date().toISOString().slice(0,10)}.xlsx`, rows: rows.length };
  }

  /**
   * v17: Oddiy, o'qish uchun qulay PDF hisobot (jadval ko'rinishida) —
   * pdfkit orqali, tashqi brauzer/Chromium kerak emas (Render'da yengil
   * ishlaydi).
   */
  async exportPdf(tenantId: string, role: string, userId: string, type: string, from?: string, to?: string) {
    const { headers, rows } = await this.getExportData(tenantId, role, userId, type, from, to);
    const PDFDocument = (await import('pdfkit')).default;

    const TITLES: Record<string, string> = {
      bookings: 'Bookinglar hisoboti', clients: 'Mijozlar hisoboti',
      payments: "To'lovlar hisoboti", calls: "Qo'ng'iroqlar hisoboti",
    };

    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    doc.fontSize(16).text(TITLES[type] || 'Hisobot', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#666').text(`Yaratilgan sana: ${new Date().toLocaleString('uz-UZ')}`, { align: 'center' });
    doc.moveDown(1);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = pageWidth / headers.length;
    const startX = doc.page.margins.left;
    let y = doc.y;

    function drawRow(cells: any[], opts: { header?: boolean } = {}) {
      const rowHeight = 20;
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      if (opts.header) {
        doc.rect(startX, y, pageWidth, rowHeight).fill('#3d7eff');
        doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
      } else {
        doc.fillColor('#111111').fontSize(8).font('Helvetica');
      }
      cells.forEach((cell, i) => {
        doc.text(String(cell ?? ''), startX + i * colWidth + 4, y + 5, { width: colWidth - 8, ellipsis: true });
      });
      y += rowHeight;
    }

    drawRow(headers, { header: true });
    for (const row of rows.slice(0, 2000)) drawRow(row);

    doc.end();
    const buffer = await done;
    return { buffer, filename: `${type}-${new Date().toISOString().slice(0,10)}.pdf`, rows: rows.length };
  }

  // ─── EXPORT: Summary stats ────────────────────────────────────────────────
  async exportSummary(tenantId: string, role: string, userId: string, from?: string, to?: string) {
    const [dash, agents, bookings] = await Promise.all([
      this.dashboard(tenantId, userId, role),
      this.agents(tenantId, from, to),
      this.bookings(tenantId, role, userId),
    ]);
    return { dashboard: dash, agents, bookings, exportedAt: new Date() };
  }

}

@ApiTags('Reports & Statistika')
@ApiBearerAuth('JWT')
@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private svc: ReportsService,
    private cache: CacheService,
  ) {}

  @Get('dashboard')
  dashboard(@CurrentUser() u: any, @Query('from') from?: string, @Query('to') to?: string) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'dashboard', u.role, u.sub, from, to),
      CACHE_TTL.SHORT,
      () => this.svc.dashboard(u.tenantId, u.sub, u.role, from, to),
    );
  }

  @Get('revenue')
  revenue(@CurrentUser() u: any, @Query('from') from?: string, @Query('to') to?: string) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'revenue', u.role, u.sub, from, to),
      CACHE_TTL.SHORT,
      () => this.svc.revenue(u.tenantId, u.role, u.sub, from, to),
    );
  }

  @Get('agents')
  agents(@CurrentUser() u: any, @Query('from') from?: string, @Query('to') to?: string) {
    // tenant-wide (role/user'ga bog'liq emas)
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'agents', from, to),
      CACHE_TTL.SHORT,
      () => this.svc.agents(u.tenantId, from, to),
    );
  }

  @Get('bookings')
  bookings(@CurrentUser() u: any) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'bookings', u.role, u.sub),
      CACHE_TTL.SHORT,
      () => this.svc.bookings(u.tenantId, u.role, u.sub),
    );
  }

  /** v6: Manba (Telegram/Instagram/WhatsApp) bo'yicha */
  @Get('by-source')
  bySource(@CurrentUser() u: any) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'by-source', u.role, u.sub),
      CACHE_TTL.SHORT,
      () => this.svc.bySource(u.tenantId, u.role, u.sub),
    );
  }

  /** v6: Destinatsiya bo'yicha */
  @Get('by-destination')
  byDestination(@CurrentUser() u: any, @Query('from') from?: string, @Query('to') to?: string) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'by-destination', u.role, u.sub, from, to),
      CACHE_TTL.SHORT,
      () => this.svc.byDestination(u.tenantId, u.role, u.sub, from, to),
    );
  }

  /** v6: Konversiya voronkasi */
  @Get('conversion-funnel')
  conversionFunnel(@CurrentUser() u: any) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'conversion-funnel', u.role, u.sub),
      CACHE_TTL.SHORT,
      () => this.svc.conversionFunnel(u.tenantId, u.role, u.sub),
    );
  }

  /** v6: Daromad grafigi (kunlik/oylik) */
  @Get('revenue-chart')
  revenueChart(@CurrentUser() u: any, @Query('period') period?: 'day' | 'month') {
    const p = period || 'month';
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'revenue-chart', u.role, u.sub, p),
      CACHE_TTL.SHORT,
      () => this.svc.revenueChart(u.tenantId, u.role, u.sub, p),
    );
  }

  /** v6: To'lov usullari bo'yicha */
  @Get('by-payment-method')
  byPaymentMethod(@CurrentUser() u: any) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'by-payment-method', u.role, u.sub),
      CACHE_TTL.SHORT,
      () => this.svc.byPaymentMethod(u.tenantId, u.role, u.sub),
    );
  }

  /**
   * v7: AGENT'NING SHAXSIY STATISTIKASI
   * Faqat o'zining ma'lumotlari — global metrika emas
   * Agent uchun mo'ljallangan: o'z leadlari, bookinglari, foydasi, konversiyasi
   */
  @Get('my-stats')
  myStats(@CurrentUser() u: any, @Query('from') from?: string, @Query('to') to?: string) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'my-stats', u.sub, from, to),
      CACHE_TTL.SHORT,
      () => this.svc.myStats(u.tenantId, u.sub, 0, from, to),
    );
  }

  /**
   * v8: AGENT MAOSH KALKULYATORI
   * Agent o'z oyligini ko'radi (komissiya foiziga ko'ra)
   *
   * Query param: ?month=0 (bu oy), -1 (o'tgan oy), -2 (oldingi oy)
   */
  @Get('my-salary')
  async mySalary(
    @CurrentUser() u: any,
    @Query('month') month?: string,
    @Query('agentId') agentId?: string,
  ) {
    const offset = month ? parseInt(month) : 0;
    // Admin can view any agent's salary
    let targetId = u.sub || u.id;
    if ((u.role === 'TENANT_ADMIN' || u.role === 'MANAGER') && agentId) {
      // Verify agentId belongs to same tenant (prevent cross-tenant IDOR)
      const agent = await this.svc['prisma'].user.findFirst({
        where: { id: agentId, tenantId: u.tenantId },
        select: { id: true },
      });
      if (!agent) throw new Error('Agent topilmadi');
      targetId = agentId;
    }
    // Maosh — oylik/og'ir hisob, sekinroq o'zgaradi → MEDIUM (300s).
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'my-salary', targetId, offset),
      CACHE_TTL.MEDIUM,
      () => this.svc.mySalary(u.tenantId, targetId, offset),
    );
  }

  /**
   * v8: ADMIN UCHUN — barcha agentlar oyliklari
   * Faqat TENANT_ADMIN va MANAGER ko'radi
   */
  @Get('agent-salaries')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  agentSalaries(@CurrentUser() u: any, @Query('month') month?: string) {
    const offset = month ? parseInt(month) : 0;
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'agent-salaries', offset),
      CACHE_TTL.MEDIUM,
      () => this.svc.agentSalaries(u.tenantId, offset),
    );
  }

  /**
   * v9-FINAL: KLIENTNING TO'LIQ FINANS PROFILI
   *
   * Klient kartasida ko'rsatiladi:
   *   - Jami bookinglar soni
   *   - Jami sotuv summasi (totalPrice)
   *   - Jami xarajat (supplierCost)
   *   - Jami foyda (profit)
   *   - To'langan / Qoldiq summa
   *   - LTV (Lifetime Value)
   *   - Birinchi va oxirgi booking sanasi
   *   - Booking ro'yxati (qachon, qayerga, qancha foyda)
   */
  @Get('client/:id/financial')
  clientFinancial(@Param('id') id: string, @CurrentUser() u: any) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'client-financial', id, u.role, u.sub),
      CACHE_TTL.SHORT,
      () => this.svc.getClientFinancial(u.tenantId, id, u.sub, u.role),
    );
  }

  /**
   * v9-FINAL: LEAD SOURCE ANALYTICS
   * Manba bo'yicha lead'lar tahlili:
   *   - Har bir manbada nechta lead
   *   - Conversion rate (lead → booking)
   *   - Har bir manbadan kelgan daromad
   *   - Eng yaxshi manba
   */
  @Get('lead-analytics')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  leadAnalytics(
    @CurrentUser() u: any,
    @Query('days') days?: string,
  ) {
    const period = Math.min(Number(days) || 30, 365);
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'lead-analytics', period),
      CACHE_TTL.MEDIUM,
      () => this.svc.getLeadAnalytics(u.tenantId, period),
    );
  }

  @Get('calendar')
  calendar(
    @CurrentUser() u: any,
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'calendar', u.role, u.sub, date, from, to),
      CACHE_TTL.SHORT,
      () => this.svc.calendarReport(u.tenantId, u.sub, u.role, date, from, to),
    );
  }

  // v10.2: Oylik kalendar (parvoz/viza/to'lov/vazifa eventlari)
  @Get('calendar-month')
  calendarMonth(
    @CurrentUser() u: any,
    @Query('year') year?: string,
    @Query('month') month?: string,
  ) {
    const now = new Date();
    const y = Math.min(Math.max(Number(year) || now.getFullYear(), 2020), 2100);
    const m = Math.min(Math.max(Number(month) || (now.getMonth() + 1), 1), 12);
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'calendar-month', u.role, u.sub, y, m),
      CACHE_TTL.SHORT,
      () => this.svc.calendarMonth(u.tenantId, u.sub, u.role, y, m),
    );
  }

  // v10.3: Agentlar oyma-oy tarixi (admin — hammasi, agent — faqat o'ziniki)
  @Get('agents-monthly')
  agentsMonthly(
    @CurrentUser() u: any,
    @Query('months') months?: string,
    @Query('agentId') agentId?: string,
  ) {
    const m = Number(months) || 6;
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'agents-monthly', u.role, u.sub, m, agentId),
      CACHE_TTL.MEDIUM,
      () => this.svc.agentsMonthly(u.tenantId, u.sub, u.role, m, agentId),
    );
  }

  @Get('call-analytics')
  callAnalytics(@CurrentUser() u: any, @Query('days') days?: string, @Query('agentId') aid?: string) {
    const d = Math.min(Number(days) || 30, 365);
    const agentId = u.role === 'AGENT' ? (u.id || u.sub) : (aid || undefined);
    return this.cache.getOrSet(
      reportsKey(u.tenantId, 'call-analytics', d, agentId),
      CACHE_TTL.SHORT,
      () => this.svc.getCallAnalytics(u.tenantId, d, agentId),
    );
  }

  @Get('export')
  @UseGuards(PermissionsGuard)
  @RequirePermission('export_data')
  async exportData(
    @CurrentUser() u: any,
    @Query('type') type = 'bookings',
    @Res() res: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const result = await this.svc.exportExcel(u.tenantId, u.role, u.sub, type, from, to);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
  }

  /** v17: haqiqiy .xlsx fayl (Excel'da formatlangan holda ochiladi) */
  @Get('export-xlsx')
  @UseGuards(PermissionsGuard)
  @RequirePermission('export_data')
  async exportXlsx(
    @CurrentUser() u: any,
    @Query('type') type = 'bookings',
    @Res() res: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const result = await this.svc.exportXlsx(u.tenantId, u.role, u.sub, type, from, to);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.buffer);
  }

  /** v17: PDF hisobot (jadval ko'rinishida, chop etish/ulashish uchun qulay) */
  @Get('export-pdf')
  @UseGuards(PermissionsGuard)
  @RequirePermission('export_data')
  async exportPdf(
    @CurrentUser() u: any,
    @Query('type') type = 'bookings',
    @Res() res: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const result = await this.svc.exportPdf(u.tenantId, u.role, u.sub, type, from, to);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.buffer);
  }

  @Get('export-json')
  exportJSON(
    @CurrentUser() u: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.exportSummary(u.tenantId, u.role, u.sub, from, to);
  }

  @Post('mark-salary-paid')
  @UseGuards(JwtAuthGuard)
  async markSalaryPaid(@CurrentUser() u: any, @Body() body: any) {
    if (u.role === 'AGENT') return { error: 'Ruxsat yoq' };
    const prisma = (this.svc as any).prisma;
    const tenant = await prisma.tenant.findUnique({
      where: { id: u.tenantId }, select: { settings: true },
    });
    const settings: any = (tenant?.settings as any) || {};
    const salaryNotes: any = settings.salaryNotes || {};
    salaryNotes[body.agentId] = {
      isPaid: !!body.isPaid,
      note: body.note || '',
      paidAt: body.isPaid ? new Date().toISOString() : null,
    };
    await prisma.tenant.update({
      where: { id: u.tenantId },
      data: { settings: { ...settings, salaryNotes } as any },
    });
    return { success: true };
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}