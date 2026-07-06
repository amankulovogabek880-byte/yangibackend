import {
  Module, Injectable, Controller, Get, Post, Param, Body, Query,
  UseGuards, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { safeEnum, paginate, meta } from '../../common/utils/helpers';
import { ClientsService } from '../clients/clients.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuditService } from '../audit/audit.module';
import { CacheService } from '../../common/cache/cache.service';
import { Prisma } from '@prisma/client';
import { PaymentMethod, PaymentStatus, Currency } from '../../prisma-types';;

const METHODS: PaymentMethod[] = ['CASH', 'BANK_TRANSFER', 'CARD', 'PAYME', 'CLICK', 'UZUM', 'CRYPTO', 'OTHER'];
const STATUSES: PaymentStatus[] = ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'];
const CURRENCIES: Currency[] = ['USD', 'UZS', 'EUR', 'RUB'];

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private clients: ClientsService,
    private notifications: NotificationsService,
    private realtime: RealtimeGateway,
    private audit: AuditService,
    private cache: CacheService,
  ) {}

  async findAll(tenantId: string, userId: string, role: string, params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where: any = { tenantId };
    if (params.method) where.method = params.method as PaymentMethod;
    if (params.bookingId) where.bookingId = params.bookingId;
    if (params.clientId) where.clientId = params.clientId;
    if (role === 'AGENT') {
      where.booking = { agentId: userId };
    }
    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where, skip, take,
        include: {
          client: { select: { id: true, fullName: true, phone: true } },
          booking: { select: { id: true, bookingRef: true, tourName: true } },
        },
        orderBy: { paidAt: 'desc' },
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { data, meta: meta(total, page, limit) };
  }

  async stats(tenantId: string, userId: string, role: string) {
    const monthStart = new Date(new Date().setDate(1));
    monthStart.setHours(0, 0, 0, 0);
    const where: any = { tenantId, status: 'COMPLETED', paidAt: { gte: monthStart } };
    if (role === 'AGENT') where.booking = { agentId: userId };

    const [total, byMethod, pendingBookings] = await Promise.all([
      this.prisma.payment.aggregate({ where, _sum: { amount: true }, _count: { id: true } }),
      this.prisma.payment.groupBy({
        by: ['method'], where, _sum: { amount: true }, _count: { id: true },
      }),
      this.prisma.booking.findMany({
        where: {
          tenantId,
          status: { notIn: ['CANCELLED', 'COMPLETED'] },
          ...(role === 'AGENT' ? { agentId: userId } : {}),
        },
        select: {
          id: true, bookingRef: true, totalPrice: true, paidAmount: true,
          client: { select: { fullName: true } },
        },
        take: 20,
      }),
    ]);
    return {
      total, byMethod,
      pendingBookings: pendingBookings.filter((b) => b.paidAmount < b.totalPrice),
    };
  }

  async addManual(tenantId: string, userId: string, role: string, data: any) {
    if (!data.bookingId) throw new BadRequestException('bookingId majburiy');
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount musbat bo\'lishi kerak');
    }

    const booking = await this.prisma.booking.findFirst({
      where: { id: data.bookingId, tenantId },
    });
    if (!booking) throw new NotFoundException('Booking topilmadi');
    if (role === 'AGENT' && booking.agentId !== userId) {
      throw new NotFoundException('Booking topilmadi');
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        bookingId: booking.id,
        clientId: booking.clientId,
        amount,
        currency: safeEnum(data.currency, CURRENCIES, booking.currency),
        method: safeEnum(data.method, METHODS, 'CASH'),
        status: safeEnum(data.status, STATUSES, 'COMPLETED'),
        uzsRate: data.uzsRate ? Number(data.uzsRate) : undefined,
        note: data.note,
        externalRef: data.externalRef,
        receiptUrl: data.receiptUrl,
        paidAt: data.paidAt ? new Date(data.paidAt) : new Date(),
      },
    });

    // Update booking paidAmount
    const newPaid = booking.paidAmount + amount;
    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { paidAmount: newPaid },
    });

    // Recalc client stats
    await this.clients.recalcStats(booking.clientId);

    // Timeline
    await this.clients.addTimeline(
      booking.clientId, 'payment',
      `To'lov: $${amount}`,
      `${booking.bookingRef} • ${data.method || 'CASH'}`,
      { userId, paymentId: payment.id, bookingId: booking.id },
    );

    // Notify
    if (booking.agentId && booking.agentId !== userId) {
      await this.notifications.create({
        tenantId,
        userId: booking.agentId,
        type: 'PAYMENT_RECEIVED',
        title: `💰 To'lov qabul qilindi`,
        body: `${booking.bookingRef}: $${amount}`,
        link: `/bookings/${booking.id}`,
        metadata: { bookingId: booking.id },
      });
    }

    // v7: WebSocket dashboard yangilash
    try {
      this.realtime.emitToTenant(tenantId, 'dashboard:update', {
        type: 'payment_received',
        bookingId: booking.id,
        agentId: booking.agentId,
        amount,
      });
    } catch {}

    // v8: AUDIT LOG
    this.audit.log({
      tenantId, userId,
      action: 'CREATE', entity: 'payment', entityId: payment.id,
      metadata: { amount, bookingId: booking.id, method: payment.method },
    });

    // To'lov daromad/qoldiq raqamlariga ta'sir qiladi → hisobot cache tozalanadi.
    void this.cache.invalidateReports(tenantId);

    return payment;
  }

  async refund(tenantId: string, id: string, userId: string, role: string, reason?: string) {
    if (role === 'AGENT') throw new BadRequestException('Refund qilish uchun ruxsat yo\'q');
    const payment = await this.prisma.payment.findFirst({ where: { id, tenantId } });
    if (!payment) throw new NotFoundException('To\'lov topilmadi');
    if (payment.status === 'REFUNDED') {
      throw new BadRequestException('Bu to\'lov allaqachon qaytarilgan');
    }

    const updated = await this.prisma.payment.update({
      where: { id },
      data: { status: 'REFUNDED', note: reason ? `Qaytarildi: ${reason}` : 'Qaytarildi' },
    });

    // Update booking
    const booking = await this.prisma.booking.findUnique({ where: { id: payment.bookingId } });
    if (booking) {
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: { paidAmount: Math.max(0, booking.paidAmount - payment.amount) },
      });
      await this.clients.recalcStats(booking.clientId);
    }

    // Refund daromad/qoldiqni o'zgartiradi → hisobot cache tozalanadi.
    void this.cache.invalidateReports(tenantId);

    return updated;
  }
}

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private svc: PaymentsService) {}

  @Get()
  list(
    @CurrentUser() u: any,
    @Query('method') method?: string,
    @Query('bookingId') bookingId?: string,
    @Query('clientId') clientId?: string,
    @Query('page') page?: any,
    @Query('limit') limit?: any,
  ) {
    return this.svc.findAll(u.tenantId, u.sub, u.role, { method, bookingId, clientId, page, limit });
  }

  @Get('stats')
  stats(@CurrentUser() u: any) {
    return this.svc.stats(u.tenantId, u.sub, u.role);
  }

  @Post('manual')
  manual(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.addManual(u.tenantId, u.sub, u.role, body);
  }

  @Post(':id/refund')
  refund(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.refund(u.tenantId, id, u.sub, u.role, body?.reason);
  }

  /** v6: Pavmentlarni CSV export qilish */
  @Get('export')
  async export(
    @CurrentUser() u: any,
    @Query('method') method?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const result = await this.svc.findAll(u.tenantId, u.sub, u.role, {
      method, page: 1, limit: 10000,
    });
    const rows = result.data || [];
    const headers = ['Sana', 'Booking', 'Klient', 'Summa', 'Valyuta', 'Usul', 'Holat', 'Izoh'];
    const csv = [
      headers.join(','),
      ...rows.map((p: any) => [
        p.paidAt ? new Date(p.paidAt).toISOString().slice(0, 10) : '',
        p.booking?.bookingRef || '',
        (p.booking?.client?.fullName || '').replace(/,/g, ';'),
        p.amount,
        p.currency,
        p.method,
        p.status,
        (p.note || '').replace(/[\r\n,]/g, ' '),
      ].join(',')),
    ].join('\n');
    return { csv, count: rows.length };
  }
}

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}