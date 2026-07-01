import {
  Module, Injectable, Controller,
  Get, Post, Put, Param, Body, UseGuards, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { convertToUSD } from '../../common/utils/helpers';
import { BookingsModule, BookingsService } from '../bookings/bookings.module';

// Offers stored in Client.preferences.offers JSON array
// No schema migration needed!

const OFFER_CURRENCIES = ['USD', 'EUR', 'UZS', 'RUB'];

@Injectable()
export class OffersService {
  constructor(
    private prisma: PrismaService,
    private bookings: BookingsService,
  ) {}

  async list(tenantId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    return (prefs.offers || []).reverse();
  }

  /**
   * Taklif narx maydonlarini (actualPrice/markup/clientPrice/pricePerPerson)
   * va mehmonxonalar/ovqatlanish ma'lumotlarini tayyorlaydi. create() va
   * update() ikkalasida ham bir xil mantiq ishlatiladi.
   */
  private async buildOfferFields(data: any) {
    // ── v10: Valyuta konvertatsiyasi ──
    // Agent EUR yoki UZS kiritsa, CBU.uz rasmiy kursi bo'yicha USD ga
    // o'giramiz. actualPrice/markup/clientPrice HAR DOIM USD da
    // saqlanadi — shu tufayli agent komissiyasi, hisobotlar va KPI
    // hammasi bitta valyutada (USD) to'g'ri hisoblanadi.
    const enteredCurrency = OFFER_CURRENCIES.includes(data.currency) ? data.currency : 'USD';
    const rawActualPrice = Number(data.actualPrice) || 0;
    const rawMarkup = Number(data.markup) || 0;

    let actualPrice = rawActualPrice;
    let markup = rawMarkup;
    let fx: { rate: number; source: string } | null = null;

    if (enteredCurrency !== 'USD') {
      const rate = (await convertToUSD(1, enteredCurrency)).rate; // kursni 1 marta olamiz
      actualPrice = Math.round((rawActualPrice / rate) * 100) / 100;
      markup = Math.round((rawMarkup / rate) * 100) / 100;
      fx = { rate, source: 'cbu.uz' };
    }

    const pax = Math.max(1, parseInt(String(data.pax)) || 1);
    const clientPriceTotal = actualPrice + markup;
    const pricePerPerson = Math.round((clientPriceTotal / pax) * 100) / 100;

    // ── Mehmonxonalar (2-5 ta variant, har biriga rasmlar) ──
    let hotels: any[] = Array.isArray(data.hotels)
      ? data.hotels
          .slice(0, 5)
          .map((h: any) => ({
            name: (h?.name || '').toString().trim(),
            stars: h?.stars ? Number(h.stars) : null,
            photos: Array.isArray(h?.photos) ? h.photos.filter((p: any) => typeof p === 'string').slice(0, 6) : [],
          }))
          .filter((h: any) => h.name)
      : [];
    // Eski (bitta mehmonxona) formatidan kelgan so'rovlar bilan moslik
    if (!hotels.length && data.hotelName) {
      hotels = [{ name: data.hotelName, stars: data.hotelStars ? Number(data.hotelStars) : null, photos: [] }];
    }
    const mealPlan = ['NONE', 'BREAKFAST', 'FULL_BOARD'].includes(data.mealPlan) ? data.mealPlan : 'NONE';

    return {
      tourName: data.tourName,
      destination: data.destination || null,
      departDate: data.departDate || null,
      returnDate: data.returnDate || null,
      departFlightTime: data.departFlightTime || null,
      returnFlightTime: data.returnFlightTime || null,
      pax,
      actualPrice,
      markup,
      clientPrice: clientPriceTotal,
      pricePerPerson,
      currency: 'USD',
      originalCurrency: enteredCurrency !== 'USD' ? enteredCurrency : undefined,
      originalActualPrice: enteredCurrency !== 'USD' ? rawActualPrice : undefined,
      originalMarkup: enteredCurrency !== 'USD' ? rawMarkup : undefined,
      exchangeRate: fx ? fx.rate : undefined,
      exchangeRateSource: fx ? fx.source : undefined,
      exchangeRateAt: fx ? new Date().toISOString() : undefined,
      hotels,
      hotelName: hotels[0]?.name || null,
      hotelStars: hotels[0]?.stars || null,
      mealPlan,
      includesVisa: data.includesVisa || false,
      includesFlight: data.includesFlight !== false,
      includesHotel: data.includesHotel !== false,
      includesTransfer: data.includesTransfer || false,
      includesInsurance: data.includesInsurance || false,
      notes: data.notes || null,
    };
  }

  async create(tenantId: string, agentId: string, data: any) {
    const client = await this.prisma.client.findFirst({ where: { id: data.clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    if (!prefs.offers) prefs.offers = [];

    const fields = await this.buildOfferFields(data);
    const offer = {
      id: Date.now().toString(),
      agentId,
      ...fields,
      status: 'DRAFT',
      createdAt: new Date().toISOString(),
    };
    prefs.offers.push(offer);

    // Update client: pipeline stage → OFFER_SENT (if not already past that)
    const advanceStages = ['NEW_LEAD', 'CONTACTED', 'INTERESTED'];
    const updateData: any = { preferences: prefs };
    if (advanceStages.includes((client as any).pipelineStage)) {
      updateData.pipelineStage = 'OFFER_SENT';
      updateData.pipelineStageAt = new Date();
    }

    await this.prisma.client.update({ where: { id: data.clientId }, data: updateData });

    // Timeline
    await this.prisma.clientTimeline.create({
      data: {
        clientId: data.clientId,
        userId: agentId,
        type: 'offer_created',
        title: 'Taklif yaratildi: ' + data.tourName,
        description: '$' + offer.clientPrice.toLocaleString(),
        metadata: { offerId: offer.id, tourName: data.tourName },
      } as any,
    }).catch(() => {});

    return offer;
  }

  /**
   * Mavjud (hali sotilmagan) taklifni tahrirlaydi. Narx/valyuta konvertatsiyasi
   * create() bilan bir xil mantiqda qayta hisoblanadi.
   */
  async update(tenantId: string, clientId: string, offerId: string, data: any) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    const list = prefs.offers || [];
    const idx = list.findIndex((o: any) => o.id === offerId);
    if (idx === -1) throw new NotFoundException('Taklif topilmadi');
    const existing = list[idx];
    if (existing.status === 'SOLD') {
      throw new BadRequestException("Sotilgan taklifni tahrirlab bo'lmaydi — buning o'rniga bog'langan bookingni tahrirlang");
    }

    const fields = await this.buildOfferFields({
      tourName: data.tourName ?? existing.tourName,
      destination: data.destination ?? existing.destination,
      departDate: data.departDate ?? existing.departDate,
      returnDate: data.returnDate ?? existing.returnDate,
      departFlightTime: data.departFlightTime ?? existing.departFlightTime,
      returnFlightTime: data.returnFlightTime ?? existing.returnFlightTime,
      pax: data.pax ?? existing.pax,
      actualPrice: data.actualPrice ?? existing.actualPrice,
      markup: data.markup ?? existing.markup,
      currency: data.currency ?? existing.currency,
      hotels: data.hotels ?? existing.hotels,
      hotelName: data.hotelName ?? existing.hotelName,
      hotelStars: data.hotelStars ?? existing.hotelStars,
      mealPlan: data.mealPlan ?? existing.mealPlan,
      includesVisa: data.includesVisa ?? existing.includesVisa,
      includesFlight: data.includesFlight ?? existing.includesFlight,
      includesHotel: data.includesHotel ?? existing.includesHotel,
      includesTransfer: data.includesTransfer ?? existing.includesTransfer,
      includesInsurance: data.includesInsurance ?? existing.includesInsurance,
      notes: data.notes ?? existing.notes,
    });

    const updated = {
      ...existing,
      ...fields,
      updatedAt: new Date().toISOString(),
    };
    list[idx] = updated;
    prefs.offers = list;
    await this.prisma.client.update({ where: { id: clientId }, data: { preferences: prefs } });

    // Timeline
    await this.prisma.clientTimeline.create({
      data: {
        clientId,
        type: 'offer_updated',
        title: 'Taklif tahrirlandi: ' + updated.tourName,
        description: '$' + updated.clientPrice.toLocaleString(),
        metadata: { offerId },
      } as any,
    }).catch(() => {});

    return updated;
  }

  async send(tenantId: string, clientId: string, offerId: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    prefs.offers = (prefs.offers || []).map((o: any) =>
      o.id === offerId ? { ...o, status: 'SENT', sentAt: new Date().toISOString() } : o
    );
    // Move pipeline stage to NEGOTIATION after offer sent
    const updateData: any = { preferences: prefs };
    const curStage = (client as any).pipelineStage;
    if (['OFFER_SENT', 'NEW_LEAD', 'CONTACTED', 'INTERESTED'].includes(curStage)) {
      updateData.pipelineStage = 'NEGOTIATION';
      updateData.pipelineStageAt = new Date();
    }

    await this.prisma.client.update({ where: { id: clientId }, data: updateData });

    // Timeline
    await this.prisma.clientTimeline.create({
      data: {
        clientId,
        type: 'offer_sent',
        title: 'Taklif yuborildi',
        metadata: { offerId },
      } as any,
    }).catch(() => {});

    return { success: true };
  }

  /**
   * v10: Taklif SOTILDI deb belgilanadi va shu ma'lumotlar asosida
   * AVTOMATIK ravishda real Booking yaratiladi (Bookinglar sahifasida
   * ko'rinadi). Qo'lda "Yangi booking" to'ldirish shart emas — narxni
   * qayta kiritish kerak bo'lmaydi, xatoliklarning oldi olinadi.
   */
  async markSold(tenantId: string, userId: string, role: string, clientId: string, offerId: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    const list = prefs.offers || [];
    const idx = list.findIndex((o: any) => o.id === offerId);
    if (idx === -1) throw new NotFoundException('Taklif topilmadi');
    const offer = list[idx];
    if (offer.status === 'SOLD') {
      throw new BadRequestException('Bu taklif allaqachon sotilgan deb belgilangan');
    }

    const hotel = Array.isArray(offer.hotels) && offer.hotels.length ? offer.hotels[0] : null;

    // 1) Booking DRAFT sifatida yaratiladi (offerdagi barcha ma'lumotlar bilan)
    const booking = await this.bookings.create(tenantId, userId, role, {
      clientId,
      tourName: offer.tourName,
      destination: offer.destination || offer.tourName,
      departureDate: offer.departDate || undefined,
      returnDate: offer.returnDate || undefined,
      adults: offer.pax || 1,
      children: 0,
      totalPrice: offer.clientPrice,
      supplierCost: offer.actualPrice,
      discount: 0,
      currency: 'USD', // taklif allaqachon USD da saqlangan
      hotelName: hotel?.name || offer.hotelName || undefined,
      hotelStars: hotel?.stars || offer.hotelStars || undefined,
      mealPlan: offer.mealPlan || undefined,
      includesVisa: !!offer.includesVisa,
      includesFlights: !!offer.includesFlight,
      includesHotel: !!offer.includesHotel,
      includesTransfer: !!offer.includesTransfer,
      includesInsurance: !!offer.includesInsurance,
      notes: offer.notes || undefined,
      status: 'DRAFT',
    });

    // 2) DRAFT -> CONFIRMED — shu bosqichda BookingsService.update() ichidagi
    //    komissiya hisoblash logikasi ishga tushadi (xuddi xodim qo'lda
    //    tasdiqlagandagidek — Commission yozuvi avtomatik yaratiladi)
    const confirmed = await this.bookings.update(tenantId, booking.id, userId, role, { status: 'CONFIRMED' });

    // 3) Taklifni SOTILDI deb belgilaymiz va yaratilgan bookingga bog'laymiz
    list[idx] = { ...offer, status: 'SOLD', soldAt: new Date().toISOString(), bookingId: confirmed.id };
    prefs.offers = list;
    await this.prisma.client.update({ where: { id: clientId }, data: { preferences: prefs } });

    // Timeline
    await this.prisma.clientTimeline.create({
      data: {
        clientId,
        userId,
        type: 'offer_sold',
        title: 'Taklif sotildi: ' + offer.tourName,
        description: '$' + (offer.clientPrice || 0).toLocaleString() + ' • ' + confirmed.bookingRef,
        metadata: { offerId, bookingId: confirmed.id },
      } as any,
    }).catch(() => {});

    return confirmed;
  }
}

@Controller('offers')
@UseGuards(JwtAuthGuard)
export class OffersController {
  constructor(private svc: OffersService) {}

  @Get('client/:clientId')
  list(@CurrentUser() u: any, @Param('clientId') id: string) {
    return this.svc.list(u.tenantId, id);
  }

  @Post()
  create(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.create(u.tenantId, u.id || u.sub, body);
  }

  @Put(':id')
  update(@CurrentUser() u: any, @Param('id') offerId: string, @Body() body: any) {
    return this.svc.update(u.tenantId, body.clientId, offerId, body);
  }

  @Post(':id/send')
  send(@CurrentUser() u: any, @Body() body: any, @Param('id') offerId: string) {
    return this.svc.send(u.tenantId, body.clientId, offerId);
  }

  @Post(':id/mark-sold')
  markSold(@CurrentUser() u: any, @Body() body: any, @Param('id') offerId: string) {
    return this.svc.markSold(u.tenantId, u.id || u.sub, u.role, body.clientId, offerId);
  }
}

@Module({
  imports: [BookingsModule],
  controllers: [OffersController],
  providers: [OffersService],
  exports: [OffersService],
})
export class OffersModule {}