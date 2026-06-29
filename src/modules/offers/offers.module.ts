import {
  Module, Injectable, Controller,
  Get, Post, Param, Body, UseGuards, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

// Offers stored in Client.preferences.offers JSON array
// No schema migration needed!

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
    const offer = {
      id: Date.now().toString(),
      agentId,
      tourName: data.tourName,
      destination: data.destination || null,
      departDate: data.departDate || null,
      returnDate: data.returnDate || null,
      pax: data.pax || 1,
      actualPrice: Number(data.actualPrice),
      markup: Number(data.markup) || 0,
      clientPrice: Number(data.actualPrice) + (Number(data.markup) || 0),
      currency: data.currency || 'USD',
      hotelName: data.hotelName || null,
      hotelStars: data.hotelStars || null,
      includesVisa: data.includesVisa || false,
      includesFlight: data.includesFlight !== false,
      includesHotel: data.includesHotel !== false,
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
        description: '$' + (Number(data.actualPrice) + Number(data.markup || 0)).toLocaleString(),
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
