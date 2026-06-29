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
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

/**
 * v9: PASSENGER MANAGEMENT
 *
 * Bir bookingda bir nechta yo'lovchi bo'lishi mumkin.
 * Masalan: oilam (er, xotin, 2 bola), do'stlar guruhi.
 *
 * Har bir yo'lovchi uchun:
 * - To'liq ism, tug'ilgan sana, jinsi
 * - Pasport ma'lumotlari
 * - Maxsus xizmatlar (taom, o'rindiq)
 * - Alohida narx (ixtiyoriy)
 */
@Injectable()
export class PassengersService {
  constructor(
    private _prisma: PrismaService,
  ) {}
  // v9: cast — yangi modellar uchun (Prisma generate kerak)
  private get prisma(): any { return this._prisma; }

  /**
   * Booking egasi va ruxsatni tekshirish
   */
  private async verifyBookingAccess(tenantId: string, bookingId: string, userId: string, role: string) {
    const where: any = { id: bookingId, tenantId };
    if (role === 'AGENT') where.agentId = userId;
    const booking = await this.prisma.booking.findFirst({ where });
    if (!booking) throw new NotFoundException('Booking topilmadi');
    return booking;
  }

  async list(tenantId: string, bookingId: string, userId: string, role: string) {
    await this.verifyBookingAccess(tenantId, bookingId, userId, role);
    return this.prisma.passenger.findMany({
      where: { bookingId, tenantId },
      orderBy: [{ passengerType: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(tenantId: string, bookingId: string, userId: string, role: string, data: any) {
    await this.verifyBookingAccess(tenantId, bookingId, userId, role);
    if (!data.fullName?.trim()) {
      throw new BadRequestException("To'liq ism kerak");
    }

    return this.prisma.passenger.create({
      data: {
        tenantId,
        bookingId,
        fullName: data.fullName.trim(),
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        gender: data.gender,
        passengerType: data.passengerType || 'ADULT',
        passportNo: data.passportNo,
        passportCountry: data.passportCountry,
        passportExpiry: data.passportExpiry ? new Date(data.passportExpiry) : null,
        nationality: data.nationality,
        phone: data.phone,
        email: data.email,
        mealPreference: data.mealPreference,
        seatPreference: data.seatPreference,
        specialRequest: data.specialRequest,
        pricePerPerson: data.pricePerPerson,
      },
    });
  }

  async update(tenantId: string, passengerId: string, userId: string, role: string, data: any) {
    const passenger = await this.prisma.passenger.findFirst({
      where: { id: passengerId, tenantId },
    });
    if (!passenger) throw new NotFoundException('Yo\'lovchi topilmadi');

    await this.verifyBookingAccess(tenantId, passenger.bookingId, userId, role);

    const safe: any = {};
    if (typeof data.fullName === 'string') safe.fullName = data.fullName.trim();
    if (data.dateOfBirth !== undefined) safe.dateOfBirth = data.dateOfBirth ? new Date(data.dateOfBirth) : null;
    if (typeof data.gender === 'string') safe.gender = data.gender;
    if (typeof data.passengerType === 'string') safe.passengerType = data.passengerType;
    if (typeof data.passportNo === 'string') safe.passportNo = data.passportNo;
    if (typeof data.passportCountry === 'string') safe.passportCountry = data.passportCountry;
    if (data.passportExpiry !== undefined) safe.passportExpiry = data.passportExpiry ? new Date(data.passportExpiry) : null;
    if (typeof data.nationality === 'string') safe.nationality = data.nationality;
    if (typeof data.phone === 'string') safe.phone = data.phone;
    if (typeof data.email === 'string') safe.email = data.email;
    if (typeof data.mealPreference === 'string') safe.mealPreference = data.mealPreference;
    if (typeof data.seatPreference === 'string') safe.seatPreference = data.seatPreference;
    if (typeof data.specialRequest === 'string') safe.specialRequest = data.specialRequest;
    if (typeof data.pricePerPerson === 'number') safe.pricePerPerson = data.pricePerPerson;

    return this.prisma.passenger.update({
      where: { id: passengerId },
      data: safe,
    });
  }

  async delete(tenantId: string, passengerId: string, userId: string, role: string) {
    const passenger = await this.prisma.passenger.findFirst({
      where: { id: passengerId, tenantId },
    });
    if (!passenger) throw new NotFoundException();
    await this.verifyBookingAccess(tenantId, passenger.bookingId, userId, role);

    await this.prisma.passenger.delete({ where: { id: passengerId } });
    return { ok: true };
  }

  /**
   * Booking'dan o'tgan yo'lovchilar sonini tahlil qilish
   */
  async stats(tenantId: string, bookingId: string, userId: string, role: string) {
    await this.verifyBookingAccess(tenantId, bookingId, userId, role);
    const passengers = await this.prisma.passenger.findMany({
      where: { bookingId, tenantId },
      select: { passengerType: true, pricePerPerson: true },
    });
    return {
      total: passengers.length,
      adults: passengers.filter((p) => p.passengerType === 'ADULT').length,
      children: passengers.filter((p) => p.passengerType === 'CHILD').length,
      infants: passengers.filter((p) => p.passengerType === 'INFANT').length,
      seniors: passengers.filter((p) => p.passengerType === 'SENIOR').length,
      totalIndividualPrices: passengers.reduce((s, p) => s + (p.pricePerPerson || 0), 0),
    };
  }
}

@Controller('passengers')
@UseGuards(JwtAuthGuard)
export class PassengersController {
  constructor(private svc: PassengersService) {}

  @Get('booking/:bookingId')
  list(@Param('bookingId') bookingId: string, @CurrentUser() u: any) {
    return this.svc.list(u.tenantId, bookingId, u.sub, u.role);
  }

  @Get('booking/:bookingId/stats')
  stats(@Param('bookingId') bookingId: string, @CurrentUser() u: any) {
    return this.svc.stats(u.tenantId, bookingId, u.sub, u.role);
  }

  @Post('booking/:bookingId')
  create(@Param('bookingId') bookingId: string, @Body() body: any, @CurrentUser() u: any) {
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
  controllers: [PassengersController],
  providers: [PassengersService],
  exports: [PassengersService],
})
export class PassengersModule {}
