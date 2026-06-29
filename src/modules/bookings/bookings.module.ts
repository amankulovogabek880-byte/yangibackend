import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Module, Injectable, Controller, Get, Post, Put, Delete, Param, Body, Query,
  UseGuards, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { safeEnum, paginate, meta, generateRef, clean } from '../../common/utils/helpers';
import { ClientsService } from '../clients/clients.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuditService } from '../audit/audit.module';
import { Prisma } from '@prisma/client';
import { BookingStatus, TourType, Currency } from '../../prisma-types';;

const STATUSES: BookingStatus[] = ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const TOUR_TYPES: TourType[] = ['PACKAGE', 'INDIVIDUAL', 'GROUP', 'VISA_SUPPORT', 'HOTEL_ONLY', 'FLIGHT_ONLY', 'CRUISE'];
const CURRENCIES: Currency[] = ['USD', 'UZS', 'EUR', 'RUB'];

@Injectable()
export class BookingsService {
  private readonly logger = new Logger('Bookings');
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private clients: ClientsService,
    private notifications: NotificationsService,
    private realtime: RealtimeGateway,
    private audit: AuditService,
  ) {}

  private where(tenantId: string, userId: string, role: string, extra: any = {}): any {
    const where: any = { tenantId, ...extra };
    if (role === 'AGENT') where.agentId = userId;
    return where;
  }

  async findAll(tenantId: string, userId: string, role: string, params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where = this.where(tenantId, userId, role);
    if (params.status) where.status = params.status;
    if (params.clientId) where.clientId = params.clientId;
    if (params.search?.trim()) {
      where.OR = [
        { bookingRef: { contains: params.search, mode: 'insensitive' } },
        { tourName: { contains: params.search, mode: 'insensitive' } },
        { destination: { contains: params.search, mode: 'insensitive' } },
        { client: { fullName: { contains: params.search, mode: 'insensitive' } } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.booking.findMany({
        where, skip, take,
        include: {
          client: { select: { id: true, fullName: true, phone: true, tier: true } },
          agent: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.booking.count({ where }),
    ]);
    return { data, meta: meta(total, page, limit) };
  }

  async findOne(tenantId: string, id: string, userId: string, role: string) {
    const where = this.where(tenantId, userId, role, { id });
    const booking = await this.prisma.booking.findFirst({
      where,
      include: {
        client: true,
        agent: { select: { id: true, name: true, email: true } },
        payments: { orderBy: { paidAt: 'desc' } },
        tasks: { orderBy: { createdAt: 'desc' } },
        documents: { orderBy: { createdAt: 'desc' } },
        calls: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!booking) throw new NotFoundException('Booking topilmadi');
    // BUG2 FIX: booking.created event
    try {
      this.eventEmitter.emit('booking.created', {
        tenantId: booking.tenantId,
        clientId: booking.clientId,
        bookingId: booking.id,
        assignedAgentId: booking.agentId,
      });
    } catch {}
    return booking;
  }

  async create(tenantId: string, userId: string, role: string, data: any) {
    if (!data.clientId) throw new BadRequestException('clientId majburiy');
    if (!data.tourName?.trim()) throw new BadRequestException('tourName majburiy');
    if (!data.destination?.trim()) throw new BadRequestException('destination majburiy');
    const totalPrice = Number(data.totalPrice);
    if (!Number.isFinite(totalPrice) || totalPrice <= 0) {
      throw new BadRequestException('totalPrice musbat bo\'lishi kerak');
    }

    const client = await this.prisma.client.findFirst({
      where: { id: data.clientId, tenantId },
    });
    if (!client) throw new NotFoundException('Klient topilmadi');

    const count = await this.prisma.booking.count({ where: { tenantId } });
    // Unique bookingRef — race condition yoki duplicate bo'lsa retry
    let bookingRef = generateRef('TRV', count);
    const existingRef = await this.prisma.booking.findFirst({ where: { bookingRef } });
    if (existingRef) {
      bookingRef = generateRef('TRV', count + Math.floor(Math.random() * 1000) + 1);
    }
    const agentId = (role === 'AGENT' ? userId : data.agentId) || userId;

    // ── v5: Profit avtomatik hisoblanadi ──
    // profit = totalPrice - supplierCost - discount
    const supplierCost = Number(data.supplierCost) || 0;
    const discount = Number(data.discount) || 0;
    const autoProfit = Math.max(0, totalPrice - supplierCost - discount);
    const manualProfit = data.profit !== undefined ? Number(data.profit) : autoProfit;

    const booking = await this.prisma.booking.create({
      data: {
        tenantId,
        bookingRef,
        clientId: data.clientId,
        agentId,
        tourName: data.tourName.trim(),
        destination: data.destination.trim(),
        country: data.country,
        tourType: safeEnum(data.tourType, TOUR_TYPES, 'PACKAGE'),
        description: data.description,
        departureDate: data.departureDate ? new Date(data.departureDate) : undefined,
        returnDate: data.returnDate ? new Date(data.returnDate) : undefined,
        duration: data.duration ? Number(data.duration) : undefined,
        adults: Number(data.adults) || 1,
        children: Number(data.children) || 0,
        infants: Number(data.infants) || 0,
        totalPrice,
        currency: safeEnum(data.currency, CURRENCIES, 'USD'),
        discount,
        commissionAmount: Number(data.commission) || 0,
        profit: manualProfit,
        status: safeEnum(data.status, STATUSES, 'DRAFT'),
        statusHistory: [{
          status: data.status || 'DRAFT',
          at: new Date().toISOString(),
          by: userId,
        }] as any,
        includesVisa: !!data.includesVisa,
        includesFlights: !!data.includesFlights,
        includesHotel: !!data.includesHotel,
        includesMeals: !!data.includesMeals,
        includesTransfer: !!data.includesTransfer,
        includesInsurance: !!data.includesInsurance,

        // Hotel
        hotelName: data.hotelName,
        hotelCity: data.hotelCity,
        hotelStars: data.hotelStars ? Number(data.hotelStars) : undefined,
        hotelCheckIn: data.hotelCheckIn ? new Date(data.hotelCheckIn) : undefined,
        hotelCheckOut: data.hotelCheckOut ? new Date(data.hotelCheckOut) : undefined,
        hotelAddress: data.hotelAddress,
        mealPlan: data.mealPlan,
        roomType: data.roomType,

        // Flight (borish)
        airline: data.airline,
        flightNumber: data.flightNumber,
        departureAirport: data.departureAirport,
        arrivalAirport: data.arrivalAirport,
        departureTime: data.departureTime ? new Date(data.departureTime) : undefined,
        arrivalTime: data.arrivalTime ? new Date(data.arrivalTime) : undefined,
        flightClass: data.flightClass,
        pnr: data.pnr,

        // Flight (qaytish)
        returnAirline: data.returnAirline,
        returnFlightNumber: data.returnFlightNumber,
        returnDepartureTime: data.returnDepartureTime ? new Date(data.returnDepartureTime) : undefined,
        returnArrivalTime: data.returnArrivalTime ? new Date(data.returnArrivalTime) : undefined,
        returnPnr: data.returnPnr,

        // Taxi
        taxiPickupAddress: data.taxiPickupAddress,
        taxiDropoffAddress: data.taxiDropoffAddress,
        taxiPickupTime: data.taxiPickupTime ? new Date(data.taxiPickupTime) : undefined,
        taxiDriverName: data.taxiDriverName,
        taxiDriverPhone: data.taxiDriverPhone,
        taxiCompany: data.taxiCompany,

        // Insurance
        insuranceCompany: data.insuranceCompany,
        insurancePolicyNo: data.insurancePolicyNo,
        insuranceStartDate: data.insuranceStartDate ? new Date(data.insuranceStartDate) : undefined,
        insuranceEndDate: data.insuranceEndDate ? new Date(data.insuranceEndDate) : undefined,
        insuranceCoverage: data.insuranceCoverage,

        // Visa
        visaStatus: data.visaStatus,
        visaType: data.visaType,
        visaNumber: data.visaNumber,
        visaIssueDate: data.visaIssueDate ? new Date(data.visaIssueDate) : undefined,
        visaExpiryDate: data.visaExpiryDate ? new Date(data.visaExpiryDate) : undefined,

        // Supplier (faqat agent/admin ko'radi)
        supplierName: data.supplierName,
        supplierContact: data.supplierContact,
        supplierCost,
        supplierRef: data.supplierRef,
        supplierPaid: Number(data.supplierPaid) || 0,
        supplierNotes: data.supplierNotes,

        notes: data.notes,
        internalNotes: data.internalNotes,
      },
    });

    // Update client last contact + stats
    await this.prisma.client.update({
      where: { id: client.id },
      data: { lastContactAt: new Date(), lastBookingAt: new Date() },
    });

    // Timeline
    await this.clients.addTimeline(
      client.id, 'booking_created',
      `Booking yaratildi: ${booking.bookingRef}`,
      `${booking.tourName} • $${booking.totalPrice}`,
      { userId, bookingId: booking.id },
    );

    // Recalc client stats
    await this.clients.recalcStats(client.id);

    // Notify agent
    if (agentId && agentId !== userId) {
      await this.notifications.create({
        tenantId,
        userId: agentId,
        type: 'BOOKING_CREATED',
        title: '✈️ Sizga yangi booking',
        body: `${client.fullName} — ${booking.tourName} • $${booking.totalPrice}`,
        link: `/bookings/${booking.id}`,
        metadata: { bookingId: booking.id, clientId: client.id },
      });
    }

    // v7: WebSocket — dashboard'ni real-time yangilash
    try {
      this.realtime.emitToTenant(tenantId, 'dashboard:update', {
        type: 'booking_created',
        bookingId: booking.id,
        agentId,
        totalPrice: booking.totalPrice,
        profit: booking.profit,
      });
    } catch {}

    // v8: AUDIT LOG
    this.audit.log({
      tenantId, userId,
      action: 'CREATE', entity: 'booking', entityId: booking.id,
      metadata: { bookingRef: booking.bookingRef, totalPrice: booking.totalPrice, clientId: client.id },
    });

    return booking;
  }

  async update(tenantId: string, id: string, userId: string, role: string, data: any) {
    const existing = await this.findOne(tenantId, id, userId, role);
    const {
      id: _, tenantId: _t, bookingRef: _br, createdAt: _c, client: _cl,
      agent: _ag, payments: _p, tasks: _ta, documents: _d, calls: _ca,
      paidAmount: _pa, profit: _pr, ...safe
    } = data;

    if (safe.departureDate) safe.departureDate = new Date(safe.departureDate);
    if (safe.returnDate) safe.returnDate = new Date(safe.returnDate);

    let statusHistory = existing.statusHistory as any;
    if (safe.status && safe.status !== existing.status) {
      safe.status = safeEnum(safe.status, STATUSES, existing.status);
      statusHistory = [
        ...(Array.isArray(statusHistory) ? statusHistory : []),
        { status: safe.status, at: new Date().toISOString(), by: userId },
      ];
      safe.statusHistory = statusHistory;

      // Timeline
      await this.clients.addTimeline(
        existing.clientId, 'booking_status',
        `Booking status: ${safe.status}`,
        `${existing.bookingRef}`,
        { userId, bookingId: id, from: existing.status, to: safe.status },
      );
    }

    if (safe.tourType) safe.tourType = safeEnum(safe.tourType, TOUR_TYPES, existing.tourType);
    if (safe.currency) safe.currency = safeEnum(safe.currency, CURRENCIES, existing.currency);

    // ── v5: Date fields convert ──
    const dateFields = [
      'hotelCheckIn', 'hotelCheckOut', 'departureTime', 'arrivalTime',
      'returnDepartureTime', 'returnArrivalTime', 'taxiPickupTime',
      'insuranceStartDate', 'insuranceEndDate', 'visaIssueDate', 'visaExpiryDate',
    ];
    for (const f of dateFields) {
      if (safe[f]) safe[f] = new Date(safe[f]);
    }

    // ── v5: Profit qayta hisoblash agar supplierCost/totalPrice/discount o'zgarsa ──
    if (
      safe.totalPrice !== undefined ||
      safe.supplierCost !== undefined ||
      safe.discount !== undefined
    ) {
      const total = Number(safe.totalPrice ?? existing.totalPrice);
      const cost = Number(safe.supplierCost ?? existing.supplierCost ?? 0);
      const discount = Number(safe.discount ?? existing.discount ?? 0);
      safe.profit = Math.max(0, total - cost - discount);
    }

    // ── AGENT supplier fieldlarini o'zgartira olmaydi ──
    if (role === 'AGENT') {
      delete safe.supplierName;
      delete safe.supplierContact;
      delete safe.supplierCost;
      delete safe.supplierRef;
      delete safe.supplierPaid;
      delete safe.supplierNotes;
    }

    const updated = await this.prisma.booking.update({ where: { id }, data: clean(safe) });

    // ── Recalc client stats if financial fields changed ──
    if (safe.totalPrice !== undefined || safe.supplierCost !== undefined || safe.discount !== undefined) {
      await this.clients.recalcStats(existing.clientId).catch(() => {});
    }

    // ── Commission auto-create when status → CONFIRMED or COMPLETED ──
    if (safe.status && ['CONFIRMED', 'COMPLETED'].includes(safe.status) &&
        !['CONFIRMED', 'COMPLETED'].includes(existing.status)) {
      const profit = updated.profit || 0;
      if (profit > 0 && updated.agentId) {
        const tenant = await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { agentCommissionPercent: true, managerCommissionPercent: true } as any,
        }) as any;
        const agentPct = tenant?.agentCommissionPercent || 10;
        const agentAmt = +(profit * agentPct / 100).toFixed(2);
        await this.prisma.commission.upsert({
          where: { bookingId: id },
          update: { totalProfit: profit, agentAmount: agentAmt, agentPercent: agentPct },
          create: {
            tenantId, bookingId: id, agentId: updated.agentId!,
            totalProfit: profit, agentPercent: agentPct, managerPercent: 0,
            agentAmount: agentAmt, managerAmount: 0,
            companyAmount: profit - agentAmt,
          },
        }).catch(() => {});
      }

      // Notify agent
      if (updated.agentId && updated.agentId !== userId) {
        await this.notifications.create({
          tenantId, userId: updated.agentId,
          type: 'BOOKING_UPDATED',
          title: `✅ Booking tasdiqlandi`,
          body: `${updated.bookingRef} — ${safe.status}`,
          link: `/bookings/${id}`,
          metadata: { bookingId: id, status: safe.status },
        }).catch(() => {});
      }

      // Realtime
      try { this.realtime.emitToTenant(tenantId, 'booking:confirmed', { bookingId: id, status: safe.status }); } catch {}
    }

    // ── Audit log ──
    this.audit.log({
      tenantId, userId,
      action: 'UPDATE', entity: 'booking', entityId: id,
      changes: { before: { status: existing.status }, after: { status: safe.status || existing.status } },
    });

    return updated;
  }

  async delete(tenantId: string, id: string, userId: string, role: string) {
    if (role === 'AGENT') throw new BadRequestException("Agentlar booking o'chira olmaydi");
    const b = await this.findOne(tenantId, id, userId, role);

    await this.prisma.booking.delete({ where: { id } });
    await this.clients.recalcStats(b.clientId).catch(() => {});

    // Timeline
    await this.clients.addTimeline(
      b.clientId, 'booking_deleted',
      `Booking o'chirildi: ${b.bookingRef}`,
      b.tourName,
      { userId, bookingId: id },
    ).catch(() => {});

    // Notify agent
    if (b.agentId && b.agentId !== userId) {
      await this.notifications.create({
        tenantId, userId: b.agentId,
        type: 'BOOKING_UPDATED',
        title: `🗑 Booking o'chirildi`,
        body: `${b.bookingRef} — ${b.tourName}`,
        metadata: { bookingId: id },
      }).catch(() => {});
    }

    // Audit
    this.audit.log({
      tenantId, userId,
      action: 'DELETE', entity: 'booking', entityId: id,
      metadata: { bookingRef: b.bookingRef, tourName: b.tourName },
    });

    return { ok: true };
  }
}

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private svc: BookingsService) {}

  @Get()
  list(
    @CurrentUser() u: any,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('clientId') clientId?: string,
    @Query('page') page?: any,
    @Query('limit') limit?: any,
  ) {
    return this.svc.findAll(u.tenantId, u.sub, u.role, { search, status, clientId, page, limit });
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.findOne(u.tenantId, id, u.sub, u.role);
  }

  @Post()
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.create(u.tenantId, u.sub, u.role, body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.sub, u.role, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, id, u.sub, u.role);
  }
}

@Module({
  imports: [],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
