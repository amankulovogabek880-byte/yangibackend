import { Module, Injectable, Controller, Post, UseGuards, Get } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';

@Injectable()
export class LeadScoringService {
  constructor(private prisma: PrismaService) {}

  async calculateScore(clientData: any): Promise<number> {
    let score = 0;
    const now = new Date();
    const createdAt = clientData.createdAt ? new Date(clientData.createdAt) : now;
    const hoursDiff = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
    const daysDiff = hoursDiff / 24;

    // Manba bo'yicha (source)
    const sourceScores: Record<string, number> = {
      'GOOGLE_ADS': 20, 'WEBSITE': 20, // Paid
      'INSTAGRAM': 15, 'TELEGRAM': 15, 'FACEBOOK': 12, // Social
      'REFERRAL': 25, // Eng yaxshi
      'WALKIN': 10, 'CALL': 10,
      'WHATSAPP': 10, 'OTHER': 5,
    };
    score += sourceScores[clientData.source] || 5;

    // Aloqa ma'lumotlari
    if (clientData.phone) score += 10;
    if (clientData.email) score += 5;

    // O'zbek market
    if (clientData.country === 'Uzbekistan' || clientData.country === 'UZ') score += 10;

    // UTM (Targeted)
    if (clientData.utmCampaign) score += 5;

    // Vaqt: yangi lead
    if (hoursDiff <= 1) score += 15;
    else if (daysDiff <= 1) score += 10;

    // Telegram bo'ysa → qaytadigan ehtimoli yuqori
    if (clientData.telegramUsername) score += 20;

    // Max 100
    return Math.min(score, 100);
  }

  async scoreClient(tenantId: string, clientId: string): Promise<number> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: {
        source: true, phone: true, email: true, country: true,
        utmCampaign: true, telegramUsername: true, createdAt: true,
      },
    });

    if (!client) throw new Error('Klient topilmadi');

    const score = await this.calculateScore(client);
    await this.prisma.client.update({
      where: { id: clientId },
      data: { leadScore: score },
    });

    return score;
  }

  // v14 PERF FIX: ilgari HAR BIR client uchun alohida `update()` ketma-ket
  // yuborilardi (1000 ta client = 1000 ta so'rov). Endi avval barcha
  // score'lar (DB'siz, sof JS hisoblash) oldindan chiqariladi, so'ng bir
  // xil score'ga ega client'lar guruhlanib, har bir noyob score uchun
  // BITTA `updateMany` chaqiriladi. Natija (har bir client.leadScore
  // qiymati) AYNAN bir xil qoladi — faqat so'rovlar soni kamayadi.
  async recalculateAll(tenantId: string): Promise<{ updated: number }> {
    const clients = await this.prisma.client.findMany({
      where: { tenantId },
      select: { id: true, source: true, phone: true, email: true, country: true, utmCampaign: true, telegramUsername: true, createdAt: true },
    });

    const idsByScore = new Map<number, string[]>();
    for (const client of clients) {
      const score = await this.calculateScore(client);
      if (!idsByScore.has(score)) idsByScore.set(score, []);
      idsByScore.get(score)!.push(client.id);
    }

    let updated = 0;
    for (const [score, ids] of idsByScore.entries()) {
      const res = await this.prisma.client.updateMany({
        where: { id: { in: ids } },
        data: { leadScore: score },
      });
      updated += res.count;
    }

    return { updated };
  }
}

@Controller('lead-scoring')
@UseGuards(JwtAuthGuard)
export class LeadScoringController {
  constructor(private svc: LeadScoringService) {}

  @Post('recalculate')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  async recalculate(@CurrentUser() u: any) {
    return this.svc.recalculateAll(u.tenantId);
  }
}

@Module({
  controllers: [LeadScoringController],
  providers: [LeadScoringService],
  exports: [LeadScoringService],
})
export class LeadScoringModule {}