import { Module, Injectable, Controller, Get, Query, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════
// CURRENCY MODULE
// O'zbekiston Markaziy banki (CBU.uz) rasmiy kurslari orqali
// USD / EUR / RUB / UZS o'rtasida konvertatsiya.
//
// Muhim: "kurs muzlatilgan" (snapshot) tamoyili ishlatiladi -
// taklif/booking yaratilgan paytdagi kurs o'sha yozuvda saqlanadi,
// keyinchalik kurs o'zgarsa ham eski yozuvlarning USD qiymati o'zgarmaydi.
// ═══════════════════════════════════════════════════════════════

export type SupportedCurrency = 'USD' | 'EUR' | 'UZS' | 'RUB';

interface CbuRateItem {
  Ccy: string;
  Rate: string;
  Nominal: string;
  Date: string;
}

interface RateSnapshot {
  rates: Record<string, number>; // 1 <valyuta> necha UZS turadi
  date: string;                  // CBU e'lon qilgan sana, masalan "26.06.2026"
  fetchedAt: Date;
  isFallback: boolean;
}

const CBU_URL = 'https://cbu.uz/ru/arkhiv-kursov-valyut/json/';
const SUPPORTED: SupportedCurrency[] = ['USD', 'EUR', 'UZS', 'RUB'];

// Faqat internet umuman ishlamay qolgan va keshda hech narsa bo'lmagan
// eng birinchi holat uchun zaxira qiymatlar (ishlab chiqarishda deyarli
// hech qachon ishlatilmaydi, chunki refreshRates() serverdan boot bo'lishi
// bilanoq chaqiriladi).
const FALLBACK_RATES: Record<string, number> = {
  USD: 12000,
  EUR: 13600,
  RUB: 160,
  UZS: 1,
};

@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);
  private cache: RateSnapshot | null = null;
  private inFlight: Promise<RateSnapshot> | null = null;

  constructor() {
    // Server ishga tushishi bilan darhol haqiqiy kursni olishga urinamiz.
    // Xato bo'lsa ham serverni to'xtatmaymiz.
    this.refreshRates().catch((e) =>
      this.logger.error(`Boshlang'ich kurs olishda xato: ${e.message}`),
    );
  }

  // CBU odatda ish kuni ertalab kursni e'lon qiladi -> har kuni 09:05 da yangilaymiz
  @Cron('5 9 * * *')
  async scheduledRefresh() {
    await this.refreshRates();
  }

  async refreshRates(): Promise<RateSnapshot> {
    // Bir vaqtning o'zida bir nechta so'rov kelsa ham, faqat bitta HTTP so'rov ketsin
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const { data } = await axios.get<CbuRateItem[]>(CBU_URL, { timeout: 8000 });
        const rates: Record<string, number> = { UZS: 1 };

        for (const item of data) {
          if (SUPPORTED.includes(item.Ccy as SupportedCurrency)) {
            const nominal = parseFloat(item.Nominal) || 1;
            const rate = parseFloat(item.Rate);
            if (!isNaN(rate) && rate > 0) {
              rates[item.Ccy] = rate / nominal; // 1 birlik = X UZS
            }
          }
        }

        // Sog'lomlik tekshiruvi: USD kursi doim bo'lishi kerak, aks holda javobga ishonmaymiz
        if (!rates.USD || rates.USD < 1000) {
          throw new Error('CBU javobida USD kursi topilmadi yoki noto\'g\'ri');
        }

        const date = data[0]?.Date || new Date().toLocaleDateString('uz-UZ');
        this.cache = { rates, date, fetchedAt: new Date(), isFallback: false };
        this.logger.log(
          `CBU kurslari yangilandi (${date}): 1 USD=${rates.USD} UZS, 1 EUR=${rates.EUR} UZS, 1 RUB=${rates.RUB} UZS`,
        );
        return this.cache;
      } catch (err: any) {
        this.logger.warn(
          `CBU'dan kurs olib bo'lmadi: ${err.message}. ${
            this.cache ? 'Oldingi keshdagi kurs ishlatilmoqda.' : 'Zaxira (fallback) qiymatlar ishlatilmoqda.'
          }`,
        );
        if (this.cache) return this.cache;
        this.cache = { rates: { ...FALLBACK_RATES }, date: 'fallback', fetchedAt: new Date(), isFallback: true };
        return this.cache;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  async getRates(): Promise<RateSnapshot> {
    if (!this.cache) return this.refreshRates();

    // Kesh 24 soatdan eski bo'lsa - fon rejimida yangilaymiz,
    // lekin foydalanuvchini kutkazmaslik uchun eski qiymatni darhol qaytaramiz
    const ageMs = Date.now() - this.cache.fetchedAt.getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      this.refreshRates().catch(() => {});
    }
    return this.cache;
  }

  /**
   * Istalgan qo'llab-quvvatlanadigan valyutadan istalganiga,
   * HOZIRGI (eng so'nggi CBU) kursi bo'yicha konvertatsiya qiladi.
   * Natijada ishlatilgan kurs va sanani ham qaytaradi - buni chaqiruvchi
   * o'z yozuvida "muzlatib" saqlashi kerak.
   */
  async convert(
    amount: number,
    from: string,
    to: string,
  ): Promise<{ amount: number; rate: number; rateDate: string; isFallback: boolean }> {
    const fromC = (from || 'USD').toUpperCase();
    const toC = (to || 'USD').toUpperCase();

    if (fromC === toC) {
      const snap = await this.getRates();
      return { amount, rate: 1, rateDate: snap.date, isFallback: snap.isFallback };
    }

    const snap = await this.getRates();
    const fromRate = snap.rates[fromC];
    const toRate = snap.rates[toC];
    if (!fromRate || !toRate) {
      throw new Error(`Qo'llab-quvvatlanmaydigan valyuta: ${fromC} yoki ${toC}`);
    }

    const inUzs = amount * fromRate;
    const result = inUzs / toRate;
    return {
      amount: Math.round(result * 100) / 100,
      rate: Math.round((fromRate / toRate) * 1e6) / 1e6,
      rateDate: snap.date,
      isFallback: snap.isFallback,
    };
  }

  async toUSD(amount: number, from: string) {
    return this.convert(amount, from, 'USD');
  }
}

@Controller('currency')
export class CurrencyController {
  constructor(private currency: CurrencyService) {}

  // GET /currency/rates -> joriy kurslar (frontend dropdown/badge uchun)
  @Get('rates')
  async rates() {
    const snap = await this.currency.getRates();
    return { date: snap.date, fetchedAt: snap.fetchedAt, isFallback: snap.isFallback, rates: snap.rates };
  }

  // GET /currency/convert?amount=100&from=EUR&to=USD
  @Get('convert')
  async convert(@Query('amount') amount: string, @Query('from') from: string, @Query('to') to: string) {
    return this.currency.convert(Number(amount) || 0, from, to);
  }
}

@Module({
  controllers: [CurrencyController],
  providers: [CurrencyService],
  exports: [CurrencyService],
})
export class CurrencyModule {}