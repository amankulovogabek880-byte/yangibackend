import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { TourAdapterRegistry } from './adapters/adapter-registry';
import { RatehawkAdapter } from './adapters/ratehawk.adapter';
import { getCatalog } from '../marketplace/operator-catalog';
import { AuditService } from '../audit/audit.module';
import { ClientsService } from '../clients/clients.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { convertToUSD, safeEnum } from '../../common/utils/helpers';
import { swallow } from '../../common/utils/swallow';
import type { NormalizedSearchResult, RegionSuggestion } from './adapters/tour-adapter.types';

/**
 * ═══════════════════════════════════════════════════════════════
 * TOUR-SEARCH — JONLI QIDIRUV (v14)
 * ═══════════════════════════════════════════════════════════════
 *
 * `marketplace` moduli — STATIK katalog (import qilingan turlar DB'da).
 * Bu modul — JONLI qidiruv: agent sana/yo'nalish kiritadi, biz shu onda
 * ulangan operatorlarga parallel so'rov yuboramiz.
 *
 * v14 DA NIMA QO'SHILDI:
 *
 *   1. `POST /tour-search/book` — ENG MUHIM QO'SHIMCHA.
 *      Ilgari agent qidirardi, narxlarni ko'rardi va... HECH NARSA
 *      QILA OLMASDI. Jonli natijani bron qilib bo'lmasdi, chunki
 *      `marketplace.bookTour()` bazadagi `MarketplaceTour` yozuvini
 *      talab qiladi, jonli natija esa vaqtinchalik.
 *
 *      Endi natijadan to'g'ridan-to'g'ri Booking yaratiladi. Bron
 *      operator saytida qo'lda tasdiqlanadi (Ratehawk prebook/finish
 *      oqimi keyingi bosqichda), CRM esa mijoz, narx, foyda va
 *      hisobotni to'liq yuritadi.
 *
 *   2. `GET /tour-search/suggest` — yo'nalish autocomplete.
 *      Ilgari matn ko'r-ko'rona birinchi region'ga aylantirilardi.
 *
 *   3. NETTO NARX va FOYDA to'g'ri hisoblanadi (pastga qarang).
 * ═══════════════════════════════════════════════════════════════
 */

const BOOKING_STATUSES = [
  'DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED',
] as const;

const CURRENCIES = ['USD', 'UZS', 'EUR', 'RUB'] as const;

/** Booking raqami — `count()` siz, poyga xavfisiz */
function makeBookingRef(): string {
  const year = new Date().getFullYear();
  const ms = Date.now().toString(36).toUpperCase();
  const rnd = Math.floor(Math.random() * 46655).toString(36).toUpperCase().padStart(3, '0');
  return `TRV-${year}-${ms}${rnd}`;
}

@Injectable()
export class TourSearchService {
  private readonly logger = new Logger('TourSearch');

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
    private registry: TourAdapterRegistry,
    private audit: AuditService,
    private clients: ClientsService,
    private realtime: RealtimeGateway,
  ) {}

  private get db(): any {
    return this.prisma;
  }

  // ─────────────────────────────────────────────────────────────
  // OPERATORLAR
  // ─────────────────────────────────────────────────────────────

  async listSearchableOperators(tenantId: string) {
    const catalog = getCatalog();
    const adapterSlugs = new Set(this.registry.registeredSlugs);

    const relevant = catalog.filter((c) => adapterSlugs.has(c.slug));
    if (relevant.length === 0) return { data: [] };

    const connected = await this.db.tourOperator.findMany({
      where: { tenantId, slug: { in: relevant.map((c) => c.slug) } },
      select: { slug: true, status: true, lastSyncError: true },
    });
    const bySlug = new Map(connected.map((c: any) => [c.slug, c]));

    return {
      data: relevant.map((c) => {
        const conn: any = bySlug.get(c.slug);
        return {
          slug: c.slug,
          name: c.name,
          logoUrl: c.logoUrl,
          connected: Boolean(conn),
          status: conn?.status || null,
          lastError: conn?.lastSyncError || null,
        };
      }),
    };
  }

  /** Ulangan operatorning ochilgan kirish ma'lumotlari */
  private async getCreds(
    tenantId: string,
    slug: string,
  ): Promise<{ login: string; password: string; operator: any } | null> {
    const op = await this.db.tourOperator.findFirst({
      where: { tenantId, slug, status: { not: 'INACTIVE' } },
    });
    if (!op) return null;

    const login = op.credLogin ? this.encryption.decrypt(op.credLogin) : '';
    const password = op.credPassword ? this.encryption.decrypt(op.credPassword) : '';
    if (!password) return null;

    return { login: login || '', password, operator: op };
  }

  // ─────────────────────────────────────────────────────────────
  // YO'NALISH AUTOCOMPLETE
  // ─────────────────────────────────────────────────────────────

  /**
   * Foydalanuvchi yo'nalishni ANIQ tanlashi uchun.
   *
   * NEGA KERAK: ilgari "Antalya" matni ko'r-ko'rona birinchi topilgan
   * region'ga aylantirilardi. Ba'zan bu butunlay boshqa joy bo'lib
   * chiqardi va agent natijalar nega noto'g'ri ekanini tushunmasdi.
   */
  async suggest(tenantId: string, query: string, slug?: string) {
    const q = String(query || '').trim();
    if (q.length < 2) return { data: [] };

    const slugs = slug
      ? [String(slug).toLowerCase()]
      : this.registry.registeredSlugs;

    const out: (RegionSuggestion & { operatorSlug: string })[] = [];

    for (const s of slugs) {
      const adapter = this.registry.get(s);
      if (!adapter?.suggestRegions) continue;

      const creds = await this.getCreds(tenantId, s);
      if (!creds) continue;

      try {
        const list = await adapter.suggestRegions(
          { login: creds.login, password: creds.password },
          q,
        );
        for (const r of list) out.push({ ...r, operatorSlug: s });
      } catch (e: any) {
        this.logger.warn(`Autocomplete xatosi [${s}]: ${e?.message}`);
      }
    }

    return { data: out.slice(0, 15) };
  }

  // ─────────────────────────────────────────────────────────────
  // QIDIRUV
  // ─────────────────────────────────────────────────────────────

  async search(tenantId: string, body: any) {
    const destination = String(body?.destination || '').trim();
    const regionId = body?.regionId ?? null;
    const checkin = String(body?.checkin || '').trim();
    const checkout = String(body?.checkout || '').trim();
    const adults = Math.max(1, Number(body?.adults) || 2);
    const childrenAges = Array.isArray(body?.childrenAges)
      ? body.childrenAges.map((n: any) => Number(n)).filter(Number.isFinite)
      : [];
    const currency = String(body?.currency || 'USD').toUpperCase();
    const requestedSlugs: string[] | null = Array.isArray(body?.operatorSlugs)
      ? body.operatorSlugs.map((s: any) => String(s).toLowerCase())
      : null;

    if (!destination) throw new BadRequestException("destination (yo'nalish) kiritilishi shart");
    if (!checkin || !checkout) {
      throw new BadRequestException('checkin va checkout (YYYY-MM-DD) kiritilishi shart');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) {
      throw new BadRequestException('Sana formati: YYYY-MM-DD');
    }
    if (new Date(checkout) <= new Date(checkin)) {
      throw new BadRequestException("Chiqish sanasi kirish sanasidan keyin bo'lishi kerak");
    }

    const adapterSlugs = this.registry.registeredSlugs.filter(
      (s) => !requestedSlugs || requestedSlugs.includes(s),
    );
    if (adapterSlugs.length === 0) {
      return { data: [], errors: [], searchedOperators: [] };
    }

    const operators = await this.db.tourOperator.findMany({
      where: { tenantId, slug: { in: adapterSlugs }, status: { not: 'INACTIVE' } },
    });

    if (operators.length === 0) {
      throw new BadRequestException(
        "Hech qanday operatorga ulanmagansiz. Avval Sozlamalar → Tur operatorlar bo'limida ulaning.",
      );
    }

    const params = { destination, regionId, checkin, checkout, adults, childrenAges, currency };

    const errors: { slug: string; name: string; message: string }[] = [];
    const results: NormalizedSearchResult[] = [];

    await Promise.all(
      operators.map(async (op: any) => {
        const adapter = this.registry.get(op.slug);
        if (!adapter) return;

        const login = op.credLogin ? this.encryption.decrypt(op.credLogin) : '';
        const password = op.credPassword ? this.encryption.decrypt(op.credPassword) : '';
        if (!password) {
          errors.push({
            slug: op.slug,
            name: op.name,
            message: "Kirish ma'lumotlari topilmadi — qaytadan ulang",
          });
          return;
        }

        try {
          const found = await adapter.searchLive({ login: login || '', password }, params);
          for (const item of found) {
            item.operatorName = op.name;
            results.push(item);
          }
        } catch (e: any) {
          this.logger.warn(`Qidiruv xatosi [${op.slug}]: ${e?.message}`);
          errors.push({ slug: op.slug, name: op.name, message: e?.message || "Noma'lum xato" });
          // Operator statusini belgilaymiz — admin Sozlamalarda ko'radi
          this.db.tourOperator
            .update({
              where: { id: op.id },
              data: { lastSyncError: String(e?.message || '').slice(0, 500) },
            })
            .catch(swallow('operator holati'));
        }
      }),
    );

    results.sort((a, b) => a.price - b.price);

    return {
      data: results,
      errors,
      searchedOperators: operators.map((o: any) => o.slug),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // JONLI NATIJADAN BOOKING
  // ─────────────────────────────────────────────────────────────

  /**
   * Netto narxni aniqlaydi.
   *
   * NEGA MUHIM: `profit = totalPrice - supplierCost`. Agar netto noma'lum
   * bo'lsa va biz uni 0 deb qoldirsak, foyda BUTUN SUMMAGA teng bo'lib
   * ketadi. Hisobotlar, agent komissiyasi va KPI pog'onalari shu foydaga
   * tayanadi — ya'ni raqamlar bir necha barobar shishib ketardi.
   *
   * Shuning uchun ehtiyotkor qoida:
   *   - netto ma'lum   → aynan shuni ishlatamiz
   *   - netto noma'lum → supplierCost = sotuv narxi (foyda 0).
   *     Agentlik sozlamada `defaultMarkupPercent` kiritsa, sotuv narxi
   *     shu foizga oshiriladi va foyda ana shu ustama bo'ladi.
   */
  private resolveMoney(
    grossPrice: number,
    netPrice: number | null | undefined,
    markupPercent: number,
    seats: number,
  ): { sale: number; cost: number } {
    const gross = Number(grossPrice) || 0;

    if (netPrice != null && Number.isFinite(Number(netPrice)) && Number(netPrice) > 0) {
      return { sale: gross * seats, cost: Number(netPrice) * seats };
    }

    const markup = Number.isFinite(markupPercent) ? Math.max(0, markupPercent) : 0;
    const sale = gross * (1 + markup / 100);
    return { sale: sale * seats, cost: gross * seats };
  }

  /**
   * Jonli qidiruv natijasidan Booking yaratadi.
   *
   * body: {
   *   clientId, result: <NormalizedSearchResult>, checkin, checkout,
   *   adults?, children?, infants?, totalPrice?, supplierCost?, note?, status?
   * }
   */
  async bookLiveResult(tenantId: string, userId: string, body: any) {
    const result = body?.result;
    if (!result?.title || result?.price === undefined) {
      throw new BadRequestException(
        "Qidiruv natijasi (result) to'liq emas. Sahifani yangilab, qaytadan qidiring.",
      );
    }
    if (!body?.clientId) {
      throw new BadRequestException('clientId kerak — bookingni qaysi mijozga biriktirishni tanlang');
    }

    const client = await this.prisma.client.findFirst({
      where: { id: body.clientId, tenantId },
      select: { id: true, fullName: true },
    });
    if (!client) throw new NotFoundException('Mijoz topilmadi');

    const adults = Math.max(1, Number(body?.adults) || 1);
    const children = Math.max(0, Number(body?.children) || 0);
    const infants = Math.max(0, Number(body?.infants) || 0);
    const seats = Math.max(1, adults + children);

    // Agentlikning standart ustamasi
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const markupPercent = Number((tenant?.settings as any)?.defaultMarkupPercent || 0);

    const enteredCurrency = safeEnum(result.currency, CURRENCIES, 'USD');
    const money = this.resolveMoney(Number(result.price), result.netPrice, markupPercent, seats);

    // Agent qo'lda o'zgartirgan bo'lsa — uniki ustun
    const rawTotal =
      body?.totalPrice !== undefined && body?.totalPrice !== null && body?.totalPrice !== ''
        ? Number(body.totalPrice)
        : money.sale;
    const rawSupplier =
      body?.supplierCost !== undefined && body?.supplierCost !== null && body?.supplierCost !== ''
        ? Number(body.supplierCost)
        : money.cost;

    if (!Number.isFinite(rawTotal) || rawTotal <= 0) {
      throw new BadRequestException("Sotuv narxi musbat bo'lishi kerak");
    }

    // ── USD ga o'girish (bookings moduli bilan bir xil mantiq) ──
    let totalPrice = rawTotal;
    let supplierCost = Number.isFinite(rawSupplier) && rawSupplier > 0 ? rawSupplier : 0;
    let fxRate: number | null = null;

    if (enteredCurrency !== 'USD') {
      // Kurs BIR MARTA olinadi va ikkala summaga ham qo'llanadi —
      // aks holda foyda noto'g'ri chiqadi.
      fxRate = (await convertToUSD(1, enteredCurrency)).rate;
      totalPrice = Math.round((rawTotal / fxRate) * 100) / 100;
      supplierCost = Math.round((supplierCost / fxRate) * 100) / 100;
    }

    const profit = Math.round((totalPrice - supplierCost) * 100) / 100;

    const checkin = body?.checkin ? new Date(body.checkin) : null;
    const checkout = body?.checkout ? new Date(body.checkout) : null;
    const duration =
      checkin && checkout && !isNaN(checkin.getTime()) && !isNaN(checkout.getTime())
        ? Math.max(1, Math.round((checkout.getTime() - checkin.getTime()) / 86400000))
        : null;

    const notes = [
      `Jonli qidiruv — operator: ${result.operatorName || result.operatorSlug || '—'}`,
      result.roomName ? `Xona: ${result.roomName}` : '',
      result.mealPlan ? `Ovqatlanish: ${result.mealPlan}` : '',
      result.cancellationPolicy ? `Bekor qilish: ${result.cancellationPolicy}` : '',
      // Operator saytida bron qilish uchun kerak bo'ladigan identifikator.
      // DIQQAT: bu qiymat qisqa muddat amal qiladi (Ratehawk ~38 daqiqa).
      result.externalId ? `Operator ID: ${result.externalId}` : '',
      body?.note ? `Izoh: ${body.note}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const booking: any = await this.prisma.booking.create({
      data: {
        bookingRef: makeBookingRef(),
        tenantId,
        clientId: client.id,
        agentId: body?.agentId || userId,
        tourName: String(result.title).slice(0, 300),
        destination: String(result.destination || '—').slice(0, 150),
        country: result.country || null,
        tourType: 'HOTEL_ONLY',
        description: notes.slice(0, 5000),
        departureDate: checkin && !isNaN(checkin.getTime()) ? checkin : null,
        returnDate: checkout && !isNaN(checkout.getTime()) ? checkout : null,
        duration,
        adults,
        children,
        infants,
        totalPrice,
        supplierCost,
        profit,
        currency: 'USD',
        originalCurrency: enteredCurrency !== 'USD' ? (enteredCurrency as any) : undefined,
        originalAmount: enteredCurrency !== 'USD' ? rawTotal : undefined,
        exchangeRate: fxRate ?? undefined,
        exchangeRateAt: fxRate ? new Date() : undefined,
        hotelName: String(result.title).slice(0, 200),
        hotelStars: result.hotelStars ?? null,
        hotelCheckIn: checkin && !isNaN(checkin.getTime()) ? checkin : null,
        hotelCheckOut: checkout && !isNaN(checkout.getTime()) ? checkout : null,
        mealPlan: result.mealPlan ? String(result.mealPlan).slice(0, 20) : null,
        roomType: result.roomName ? String(result.roomName).slice(0, 100) : null,
        includesHotel: true,
        status: safeEnum(body?.status, BOOKING_STATUSES, 'DRAFT'),
      } as any,
    });

    await this.clients
      .addTimeline(
        client.id,
        'booking_created',
        `Booking yaratildi: ${booking.bookingRef}`,
        `${booking.tourName} • $${booking.totalPrice}`,
        { userId, bookingId: booking.id, source: 'tour-search' },
      )
      .catch(swallow('mijoz tarixi'));
    await this.clients.recalcStats(client.id).catch(swallow('statistika'));

    this.audit.log({
      tenantId,
      userId,
      action: 'CREATE',
      entity: 'booking',
      entityId: booking.id,
      metadata: {
        bookingRef: booking.bookingRef,
        source: 'tour-search',
        operator: result.operatorSlug,
        externalId: result.externalId,
        totalPrice: booking.totalPrice,
        supplierCost: booking.supplierCost,
        netPriceKnown: result.netPrice != null,
      },
    });

    try {
      this.realtime.emitToTenant(tenantId, 'dashboard:update', {
        type: 'booking_created',
        bookingId: booking.id,
        totalPrice: booking.totalPrice,
        profit: booking.profit,
      });
    } catch {
      /* jim */
    }

    this.logger.log(
      `Jonli qidiruvdan booking: ${booking.bookingRef} — ${result.title} (${client.fullName})`,
    );

    return {
      success: true,
      message: `Booking yaratildi: ${booking.bookingRef}`,
      booking,
      // Netto noma'lum bo'lsa foyda 0 chiqadi — agent buni bilishi kerak
      warning:
        result.netPrice == null
          ? "Operator netto narxni bermadi. Foyda 0 deb yozildi — bookingni ochib, " +
            "'Tannarx' maydonini qo'lda to'ldiring, aks holda hisobotdagi foyda noto'g'ri bo'ladi."
          : null,
    };
  }
}

@Controller('tour-search')
@UseGuards(JwtAuthGuard)
export class TourSearchController {
  constructor(private service: TourSearchService) {}

  @Get('operators')
  operators(@CurrentUser() user: any) {
    return this.service.listSearchableOperators(user.tenantId);
  }

  /** Yo'nalish autocomplete: ?q=Antal&slug=ratehawk */
  @Get('suggest')
  suggest(
    @CurrentUser() user: any,
    @Query('q') q: string,
    @Query('slug') slug?: string,
  ) {
    return this.service.suggest(user.tenantId, q, slug);
  }

  /**
   * body: { destination, regionId?, checkin, checkout, adults, childrenAges?, currency?, operatorSlugs? }
   */
  @Post('search')
  search(@CurrentUser() user: any, @Body() body: any) {
    return this.service.search(user.tenantId, body);
  }

  /**
   * Jonli natijadan booking yaratish.
   * body: { clientId, result, checkin, checkout, adults?, children?, infants?, totalPrice?, supplierCost?, note? }
   */
  @Post('book')
  book(@CurrentUser() user: any, @Body() body: any) {
    return this.service.bookLiveResult(user.tenantId, user.sub || user.id, body);
  }
}

@Module({
  controllers: [TourSearchController],
  providers: [TourSearchService, TourAdapterRegistry, RatehawkAdapter],
  exports: [TourAdapterRegistry],
})
export class TourSearchModule {}