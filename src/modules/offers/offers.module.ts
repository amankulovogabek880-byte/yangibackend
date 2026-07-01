import {
  Module, Injectable, Controller,
  Get, Post, Param, Body, UseGuards, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { convertToUSD } from '../../common/utils/helpers';

// Offers stored in Client.preferences.offers JSON array
// No schema migration needed!

const OFFER_CURRENCIES = ['USD', 'EUR', 'UZS', 'RUB'];

@Injectable()
export class OffersService {
  constructor(private prisma: PrismaService) {}

  async list(tenantId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    return (prefs.offers || []).reverse();
  }

  async create(tenantId: string, agentId: string, data: any) {
    const client = await this.prisma.client.findFirst({ where: { id: data.clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    if (!prefs.offers) prefs.offers = [];

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

    const offer = {
      id: Date.now().toString(),
      agentId,
      tourName: data.tourName,
      destination: data.destination || null,
      departDate: data.departDate || null,
      returnDate: data.returnDate || null,
      departFlightTime: data.departFlightTime || null,
      returnFlightTime: data.returnFlightTime || null,
      pax,
      actualPrice,           // ── har doim USD ──
      markup,                 // ── har doim USD ──
      clientPrice: clientPriceTotal,
      pricePerPerson,
      currency: 'USD',
      // Shaffoflik uchun: agent qaysi valyutada va qanday kursda kiritgani
      originalCurrency: enteredCurrency !== 'USD' ? enteredCurrency : undefined,
      originalActualPrice: enteredCurrency !== 'USD' ? rawActualPrice : undefined,
      originalMarkup: enteredCurrency !== 'USD' ? rawMarkup : undefined,
      exchangeRate: fx ? fx.rate : undefined,
      exchangeRateSource: fx ? fx.source : undefined,
      exchangeRateAt: fx ? new Date().toISOString() : undefined,
      hotels,
      // Eski maydonlar — eski frontend/hisobotlar bilan moslik uchun (birinchi mehmonxona)
      hotelName: hotels[0]?.name || null,
      hotelStars: hotels[0]?.stars || null,
      mealPlan,
      includesVisa: data.includesVisa || false,
      includesFlight: data.includesFlight !== false,
      includesHotel: data.includesHotel !== false,
      includesTransfer: data.includesTransfer || false,
      includesInsurance: data.includesInsurance || false,
      notes: data.notes || null,
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

  @Post(':id/send')
  send(@CurrentUser() u: any, @Body() body: any, @Param('id') offerId: string) {
    return this.svc.send(u.tenantId, body.clientId, offerId);
  }
}

@Module({
  controllers: [OffersController],
  providers: [OffersService],
  exports: [OffersService],
})
export class OffersModule {}