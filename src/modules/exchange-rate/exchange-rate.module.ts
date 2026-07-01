import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { getExchangeRates, getUsdRate } from '../../common/utils/helpers';

// ═══════════════════════════════════════════════════════════════
// EXCHANGE RATE — CBU.uz (O'zbekiston Markaziy banki) rasmiy kursi
// ═══════════════════════════════════════════════════════════════
// Frontend taklif/booking formalarida EUR yoki UZS tanlanganda
// "≈ $X" live preview ko'rsatishi uchun ishlatiladi. Haqiqiy
// konvertatsiya (saqlash) har doim backendda (offers/bookings
// service) amalga oshiriladi — bu endpoint faqat ko'rsatish uchun.

@Controller('exchange-rate')
@UseGuards(JwtAuthGuard)
export class ExchangeRateController {
  // GET /api/v1/exchange-rate — barcha kurslar (UZS bazasida)
  @Get()
  async all() {
    const rates = await getExchangeRates();
    return {
      base: 'UZS',
      rates: { USD: rates.USD, EUR: rates.EUR, RUB: rates.RUB },
      source: rates.source,
      fetchedAt: rates.fetchedAt,
    };
  }

  // GET /api/v1/exchange-rate/usd?currency=EUR — 1 USD = necha `currency`
  @Get('usd')
  async usd(@Query('currency') currency?: string) {
    const cur = (currency || 'USD').toUpperCase();
    const info = await getUsdRate(cur);
    return { currency: cur, ...info };
  }
}

@Module({
  controllers: [ExchangeRateController],
})
export class ExchangeRateModule {}