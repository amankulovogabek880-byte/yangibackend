import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

/**
 * v9: BOOKING SERVICES (Final Polish)
 *
 * Bir bookingga bir nechta xizmat qo'shish:
 *   - Taxi, Transfer, Insurance, Visa, SIM Card, VIP Meet, Guide,
 *     Hotel Upgrade, Tour Guide, Excursion, Restaurant, Other
 *
 * Har bir xizmat: type, name, price, quantity, status, from/to, date/time, notes
 *
 * MUHIM: Bu modul ishlashi uchun:
 *   1. `npx prisma generate` ishga tushirilgan bo'lsin
 *   2. `npx prisma db push` migration qilingan bo'lsin
 */

// To'g'ri ServiceType enum qiymatlari (schema bilan bir xil)
const VALID_TYPES = [
  'TAXI', 'TRANSFER', 'INSURANCE', 'VISA', 'SIM_CARD',
  'VIP_MEET', 'GUIDE', 'HOTEL_UPGRADE', 'TOUR_GUIDE',
  'EXCURSION', 'RESTAURANT', 'OTHER',
] as const;

const VALID_STATUSES = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const;

@Injectable()
export class ServicesService {
  private readonly logger = new Logger('ServicesService');

  constructor(
    private _prisma: PrismaService,
  ) {}

  // v9: Prisma cast — yangi BookingService model uchun
  // (Prisma generate qilingan bo'lsa to'g'ridan-to'g'ri ishlaydi)
  private get prisma(): any { return this._prisma; }

  /**
   * Booking egasi va ruxsatni tekshirish
   */
  private async verifyBookingAccess(
    tenantId: string,
    bookingId: string,
    userId: string,
    role: string,
  ) {
    if (!bookingId) {
      throw new BadRequestException('bookingId kerak');
    }

    const where: any = { id: bookingId, tenantId };
    if (role === 'AGENT') where.agentId = userId;

    const booking = await this._prisma.booking.findFirst({ where });
    if (!booking) {
      throw new NotFoundException('Booking topilmadi yoki sizning ruxsatingiz yo\'q');
    }
    return booking;
  }

  /**
   * Ma'lumotlarni tekshirish (validatsiya)
   */
  private validateData(data: any, isUpdate: boolean = false) {
    const errors: string[] = [];

    // Type
    if (!isUpdate || data.type !== undefined) {
      if (!isUpdate && !data.type) errors.push('Xizmat turi (type) kerak');
      if (data.type && !VALID_TYPES.includes(data.type)) {
        errors.push(`Type noto'g'ri. Ruxsat etilgan: ${VALID_TYPES.join(', ')}`);
      }
    }

    // Name
    if (!isUpdate || data.name !== undefined) {
      if (!isUpdate && !data.name?.trim()) errors.push('Xizmat nomi kerak');
      if (data.name !== undefined && (typeof data.name !== 'string' || !data.name.trim())) {
        errors.push("Xizmat nomi bo'sh bo'lishi mumkin emas");
      }
    }

    // Price
    if (!isUpdate || data.price !== undefined) {
      const price = Number(data.price);
      if (!isUpdate && (data.price === undefined || data.price === null)) {
        errors.push('Narx kerak');
      } else if (data.price !== undefined && (isNaN(price) || price < 0)) {
        errors.push("Narx noto'g'ri (manfiy bo'lmasligi kerak)");
      }
    }

    // Quantity
    if (data.quantity !== undefined && data.quantity !== null) {
      const qty = Number(data.quantity);
      if (isNaN(qty) || qty < 1) {
        errors.push("Miqdor 1 dan kichik bo'lmasligi kerak");
      }
    }

    // Status
    if (data.status && !VALID_STATUSES.includes(data.status)) {
      errors.push(`Status noto'g'ri. Ruxsat: ${VALID_STATUSES.join(', ')}`);
    }

    // Date
    if (data.date) {
      const d = new Date(data.date);
      if (isNaN(d.getTime())) {
        errors.push("Sana noto'g'ri formatda");
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException(errors.join('; '));
    }
  }

  async list(tenantId: string, bookingId: string, userId: string, role: string) {
    await this.verifyBookingAccess(tenantId, bookingId, userId, role);

    try {
      return await this.prisma.bookingService.findMany({
        where: { bookingId, tenantId },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      });
    } catch (e: any) {
      this.logger.error(`Services list error: ${e.message}`);
      // Migration qilinmagan bo'lishi mumkin
      if (e.message?.includes('booking_services') || e.code === 'P2021') {
        throw new BadRequestException(
          "Database jadval topilmadi. Backend admin'iga ayting: `npx prisma db push` ishga tushirsin"
        );
      }
      throw e;
    }
  }

  async create(
    tenantId: string,
    bookingId: string,
    userId: string,
    role: string,
    data: any,
  ) {
    await this.verifyBookingAccess(tenantId, bookingId, userId, role);
    this.validateData(data, false);

    const price = Number(data.price);
    const quantity = Number(data.quantity) || 1;
    const totalAmount = price * quantity;

    try {
      const service = await this.prisma.bookingService.create({
        data: {
          tenantId,
          bookingId,
          type: data.type,
          name: data.name.trim(),
          description: data.description?.trim() || null,
          fromLocation: data.fromLocation?.trim() || null,
          toLocation: data.toLocation?.trim() || null,
          date: data.date ? new Date(data.date) : null,
          time: data.time?.trim() || null,
          price,
          quantity,
          totalAmount,
          status: data.status || 'PENDING',
          notes: data.notes?.trim() || null,
          providerName: data.providerName?.trim() || null,
          providerPhone: data.providerPhone?.trim() || null,
        },
      });

      // Booking timeline'ga yozish (xato bo'lsa create'ni buzmasin)
      try {
        const booking = await this._prisma.booking.findUnique({
          where: { id: bookingId },
          select: { clientId: true },
        });
        if (booking?.clientId) {
          await this._prisma.clientTimeline.create({
            data: {
              clientId: booking.clientId,
              userId,
              type: 'service_added',
              title: `🛎 Xizmat qo'shildi: ${data.name}`,
              description: `${data.type} • ${totalAmount}`,
              metadata: {
                bookingId,
                serviceId: service.id,
                type: data.type,
                totalAmount,
              },
            },
          });
        }
      } catch (timelineErr: any) {
        this.logger.warn(`Timeline yozilmadi: ${timelineErr.message}`);
        // Timeline xato bo'lsa ham service yaratildi
      }

      this.logger.log(`Service yaratildi: ${service.id} (${data.type}) — ${totalAmount}`);
      return service;
    } catch (e: any) {
      this.logger.error(`Service yaratilmadi: ${e.message}`, e.stack);

      // Aniqroq xato xabarlari
      if (e.code === 'P2002') {
        throw new BadRequestException("Bu xizmat allaqachon mavjud");
      }
      if (e.code === 'P2003') {
        throw new BadRequestException("Booking topilmadi yoki o'chirilgan");
      }
      if (e.code === 'P2021' || e.message?.includes('booking_services')) {
        throw new BadRequestException(
          "Database jadval topilmadi. `npx prisma db push` ishga tushiring"
        );
      }
      if (e.code === 'P2025') {
        throw new NotFoundException("Booking topilmadi");
      }

      throw new BadRequestException(`Xizmat yaratilmadi: ${e.message}`);
    }
  }

  async update(
    tenantId: string,
    id: string,
    userId: string,
    role: string,
    data: any,
  ) {
    if (!id) throw new BadRequestException('id kerak');

    const existing = await this.prisma.bookingService.findFirst({
      where: { id, tenantId },
    });
    if (!existing) {
      throw new NotFoundException("Xizmat topilmadi");
    }

    await this.verifyBookingAccess(tenantId, existing.bookingId, userId, role);
    this.validateData(data, true);

    const safe: any = {};
    if (data.type !== undefined) safe.type = data.type;
    if (data.name !== undefined) safe.name = data.name.trim();
    if (data.description !== undefined) safe.description = data.description?.trim() || null;
    if (data.fromLocation !== undefined) safe.fromLocation = data.fromLocation?.trim() || null;
    if (data.toLocation !== undefined) safe.toLocation = data.toLocation?.trim() || null;
    if (data.date !== undefined) safe.date = data.date ? new Date(data.date) : null;
    if (data.time !== undefined) safe.time = data.time?.trim() || null;
    if (data.price !== undefined) safe.price = Number(data.price);
    if (data.quantity !== undefined) safe.quantity = Number(data.quantity);
    if (data.status !== undefined) safe.status = data.status;
    if (data.notes !== undefined) safe.notes = data.notes?.trim() || null;
    if (data.providerName !== undefined) safe.providerName = data.providerName?.trim() || null;
    if (data.providerPhone !== undefined) safe.providerPhone = data.providerPhone?.trim() || null;

    // totalAmount qayta hisoblash
    if (safe.price !== undefined || safe.quantity !== undefined) {
      const newPrice = safe.price !== undefined ? safe.price : existing.price;
      const newQty = safe.quantity !== undefined ? safe.quantity : existing.quantity;
      safe.totalAmount = newPrice * newQty;
    }

    try {
      const updated = await this.prisma.bookingService.update({
        where: { id },
        data: safe,
      });
      this.logger.log(`Service yangilandi: ${id}`);
      return updated;
    } catch (e: any) {
      this.logger.error(`Service yangilanmadi: ${e.message}`);
      throw new BadRequestException(`Xizmat yangilanmadi: ${e.message}`);
    }
  }

  async delete(tenantId: string, id: string, userId: string, role: string) {
    if (!id) throw new BadRequestException('id kerak');

    const existing = await this.prisma.bookingService.findFirst({
      where: { id, tenantId },
    });
    if (!existing) {
      throw new NotFoundException("Xizmat topilmadi");
    }

    await this.verifyBookingAccess(tenantId, existing.bookingId, userId, role);

    try {
      await this.prisma.bookingService.delete({ where: { id } });
      this.logger.log(`Service o'chirildi: ${id}`);
      return { ok: true, deletedId: id };
    } catch (e: any) {
      this.logger.error(`Service o'chirilmadi: ${e.message}`);
      throw new BadRequestException(`Xizmat o'chirilmadi: ${e.message}`);
    }
  }

  /**
   * Booking'dagi barcha xizmatlar jami summasi
   */
  async getTotalForBooking(
    tenantId: string,
    bookingId: string,
    userId: string,
    role: string,
  ) {
    await this.verifyBookingAccess(tenantId, bookingId, userId, role);

    try {
      const result = await this.prisma.bookingService.aggregate({
        where: { bookingId, tenantId, status: { not: 'CANCELLED' } },
        _sum: { totalAmount: true },
        _count: { id: true },
      });

      // Statuslar bo'yicha guruhlash
      const byStatus = await this.prisma.bookingService.groupBy({
        by: ['status'],
        where: { bookingId, tenantId },
        _count: { id: true },
        _sum: { totalAmount: true },
      });

      return {
        totalAmount: result._sum.totalAmount || 0,
        count: result._count.id,
        byStatus: byStatus.reduce((acc: any, s: any) => {
          acc[s.status] = {
            count: s._count.id,
            totalAmount: s._sum.totalAmount || 0,
          };
          return acc;
        }, {}),
      };
    } catch (e: any) {
      this.logger.error(`Total hisoblanmadi: ${e.message}`);
      // Database xatosini ushlash
      if (e.code === 'P2021' || e.message?.includes('booking_services')) {
        return { totalAmount: 0, count: 0, byStatus: {} };
      }
      throw e;
    }
  }
}

@Controller('services')
@UseGuards(JwtAuthGuard)
export class ServicesController {
  constructor(private svc: ServicesService) {}

  @Get('booking/:bookingId')
  list(@Param('bookingId') bookingId: string, @CurrentUser() u: any) {
    return this.svc.list(u.tenantId, bookingId, u.sub, u.role);
  }

  @Get('booking/:bookingId/total')
  total(@Param('bookingId') bookingId: string, @CurrentUser() u: any) {
    return this.svc.getTotalForBooking(u.tenantId, bookingId, u.sub, u.role);
  }

  @Post('booking/:bookingId')
  create(
    @Param('bookingId') bookingId: string,
    @Body() body: any,
    @CurrentUser() u: any,
  ) {
    return this.svc.create(u.tenantId, bookingId, u.sub, u.role, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.sub, u.role, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, id, u.sub, u.role);
  }
}

@Module({
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
