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
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { paginate, meta, generateRef, clean, safeEnum } from '../../common/utils/helpers';

/**
 * ═══════════════════════════════════════════════════════════════
 * TURLAR BOZORI (MARKETPLACE) — v12
 * ═══════════════════════════════════════════════════════════════
 *
 * MAQSAD:
 *   O'zbekistondagi tur operatorlarning turlarini bitta joyga yig'ib,
 *   BARCHA agentliklar (tenantlar) ko'rishi va bron so'rovi yuborishi.
 *
 * ROLLAR:
 *   - PLATFORM_OWNER  → operatorlarni qo'shadi, login/parolini kiritadi,
 *                       turlarni import/sinxron qiladi
 *   - Barcha rollar   → turlarni ko'radi, filtrlaydi, bron so'rovi yuboradi
 *
 * ARXITEKTURA:
 *   TourOperator + MarketplaceTour  → GLOBAL (tenantga bog'liq emas)
 *   TourBookingRequest              → tenantga tegishli (izolyatsiya)
 *
 * XAVFSIZLIK:
 *   Operator login/parol/apiKey — EncryptionService orqali SHIFRLANADI.
 *   API javoblarida hech qachon ochiq qaytmaydi (faqat "***" maskasi).
 *
 * MUHIM — ishga tushirishdan oldin:
 *   1) npx prisma generate
 *   2) npx prisma db push   (yoki migrate dev)
 *   3) .env da ENCRYPTION_KEY sozlangan bo'lsin
 * ═══════════════════════════════════════════════════════════════
 */

const INTEGRATION_TYPES = ['MANUAL', 'EXCEL', 'API'] as const;
const OPERATOR_STATUSES = ['ACTIVE', 'INACTIVE', 'ERROR'] as const;
const TOUR_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
const REQUEST_STATUSES = ['PENDING', 'SENT', 'CONFIRMED', 'REJECTED', 'CANCELLED'] as const;
const TOUR_TYPES = [
  'PACKAGE', 'INDIVIDUAL', 'GROUP', 'VISA_SUPPORT',
  'HOTEL_ONLY', 'FLIGHT_ONLY', 'CRUISE',
] as const;
const CURRENCIES = ['USD', 'UZS', 'EUR', 'RUB'] as const;

/** Bitta import/sinxronizatsiyada maksimal tur soni (himoya) */
const MAX_IMPORT_BATCH = 2000;

// ═══════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger('MarketplaceService');

  constructor(
    private _prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  /**
   * Prisma cast — yangi modellar (TourOperator/MarketplaceTour/
   * TourBookingRequest) `prisma generate` dan keyin paydo bo'ladi.
   * Shu sababli `any` cast — kod generate'gacha ham kompilyatsiya bo'lsin.
   */
  private get prisma(): any {
    return this._prisma;
  }

  // ─────────────────────────────────────────────────────────────
  // YORDAMCHI FUNKSIYALAR
  // ─────────────────────────────────────────────────────────────

  /** Nomdan slug yasaydi: "Asia Luxe Travel" → "asia-luxe-travel" */
  private makeSlug(name: string): string {
    return String(name || '')
      .toLowerCase()
      .trim()
      .replace(/['`]/g, '')
      .replace(/[^a-z0-9\u0400-\u04FF]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `operator-${Date.now().toString(36)}`;
  }

  /**
   * Operatorni tashqariga chiqarishdan oldin maxfiy maydonlarni yashiradi.
   * Login/parol/apiKey HECH QACHON ochiq qaytmaydi.
   */
  private maskOperator(op: any) {
    if (!op) return op;
    const { credLogin, credPassword, apiKey, ...rest } = op;
    return {
      ...rest,
      hasCredentials: Boolean(credLogin || credPassword || apiKey),
      credLogin: credLogin ? '***' : null,
      credPassword: credPassword ? '***' : null,
      apiKey: apiKey ? '***' : null,
    };
  }

  /** Shifrlangan maydonni ochadi (faqat server ichida ishlatiladi) */
  private reveal(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      return this.encryption.decrypt(value);
    } catch {
      this.logger.warn('Maxfiy maydonni ochib bo\'lmadi (kalit o\'zgargan?)');
      return null;
    }
  }

  private toDate(v: any): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  private toNum(v: any): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Butun son (Prisma Int maydonlari uchun).
   * Excel'dan "10.5" yoki "10,0" kelsa ham xato bermaydi.
   */
  private toIntOrNull(v: any): number | null {
    const n = this.toNum(v);
    if (n === null) return null;
    const r = Math.round(n);
    return Number.isSafeInteger(r) ? r : null;
  }

  private toBool(v: any): boolean {
    if (typeof v === 'boolean') return v;
    const s = String(v || '').toLowerCase().trim();
    return ['1', 'true', 'ha', 'yes', 'да', '+'].includes(s);
  }

  /**
   * Har xil operatorlardan kelgan turli nomdagi maydonlarni
   * bitta standart ko'rinishga keltiradi.
   *
   * Masalan: title / name / tour_name / nomi → title
   */
  private normalizeTour(raw: any): any | null {
    if (!raw || typeof raw !== 'object') return null;

    const pick = (...keys: string[]) => {
      for (const k of keys) {
        if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
      }
      return undefined;
    };

    const title = pick('title', 'name', 'tour_name', 'tourName', 'nomi', 'название');
    const destination = pick('destination', 'city', 'shahar', 'yonalish', 'направление', 'город');

    // Nom va yo'nalishsiz tur — foydasiz
    if (!title || !destination) return null;

    const price = this.toNum(pick('price', 'cost', 'narx', 'цена', 'amount'));
    if (price === null) return null;

    const departureDate = this.toDate(pick('departureDate', 'departure_date', 'startDate', 'start_date', 'sana', 'дата'));
    const returnDate = this.toDate(pick('returnDate', 'return_date', 'endDate', 'end_date'));

    let duration = this.toNum(pick('duration', 'days', 'kun', 'ночей', 'nights'));
    if (!duration && departureDate && returnDate) {
      duration = Math.max(
        1,
        Math.round((returnDate.getTime() - departureDate.getTime()) / 86400000),
      );
    }

    const images = pick('images', 'photos', 'rasmlar');
    const imageList = Array.isArray(images)
      ? images.filter((i) => typeof i === 'string')
      : typeof images === 'string' && images
        ? images.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

    return {
      externalId: pick('externalId', 'external_id', 'id', 'tour_id') != null
        ? String(pick('externalId', 'external_id', 'id', 'tour_id'))
        : null,
      title: String(title).slice(0, 300),
      destination: String(destination).slice(0, 150),
      country: pick('country', 'mamlakat', 'страна') ? String(pick('country', 'mamlakat', 'страна')).slice(0, 100) : null,
      city: pick('city', 'shahar') ? String(pick('city', 'shahar')).slice(0, 100) : null,
      tourType: safeEnum(pick('tourType', 'tour_type', 'type'), TOUR_TYPES, 'PACKAGE'),
      description: pick('description', 'desc', 'tavsif', 'описание')
        ? String(pick('description', 'desc', 'tavsif', 'описание')).slice(0, 5000)
        : null,

      price,
      currency: safeEnum(pick('currency', 'valyuta', 'валюта'), CURRENCIES, 'USD'),
      priceNote: pick('priceNote', 'price_note') ? String(pick('priceNote', 'price_note')).slice(0, 200) : null,

      departureDate,
      returnDate,
      duration: duration ? Math.round(duration) : null,

      seatsTotal: this.toIntOrNull(pick('seatsTotal', 'seats_total', 'seats', 'joylar')),
      seatsAvailable: this.toIntOrNull(pick('seatsAvailable', 'seats_available', 'available', 'bosh_joylar')),

      hotelName: pick('hotelName', 'hotel_name', 'hotel', 'mehmonxona')
        ? String(pick('hotelName', 'hotel_name', 'hotel', 'mehmonxona')).slice(0, 200)
        : null,
      hotelStars: this.toIntOrNull(pick('hotelStars', 'hotel_stars', 'stars', 'yulduz')),
      mealPlan: pick('mealPlan', 'meal_plan', 'meal', 'ovqat')
        ? String(pick('mealPlan', 'meal_plan', 'meal', 'ovqat')).slice(0, 20)
        : null,

      includesVisa: this.toBool(pick('includesVisa', 'visa', 'viza')),
      includesFlights: this.toBool(pick('includesFlights', 'flight', 'aviabilet')),
      includesHotel: this.toBool(pick('includesHotel', 'hotel_included')),
      includesMeals: this.toBool(pick('includesMeals', 'meals')),
      includesTransfer: this.toBool(pick('includesTransfer', 'transfer')),
      includesInsurance: this.toBool(pick('includesInsurance', 'insurance', 'sugurta')),

      images: imageList,
      raw,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // OPERATORLAR (faqat PLATFORM_OWNER yozadi)
  // ═══════════════════════════════════════════════════════════

  async listOperators(params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);

    const where: any = {};
    if (params.status) where.status = params.status;
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { slug: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.tourOperator.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
      }),
      this.prisma.tourOperator.count({ where }),
    ]);

    return {
      data: items.map((o: any) => this.maskOperator(o)),
      meta: meta(total, page, limit),
    };
  }

  async getOperator(id: string) {
    const op = await this.prisma.tourOperator.findUnique({ where: { id } });
    if (!op) throw new NotFoundException('Operator topilmadi');
    return this.maskOperator(op);
  }

  async createOperator(data: any) {
    if (!data?.name) throw new BadRequestException('Operator nomi (name) kerak');

    const slug = data.slug ? this.makeSlug(data.slug) : this.makeSlug(data.name);

    const exists = await this.prisma.tourOperator.findUnique({ where: { slug } });
    if (exists) throw new BadRequestException(`Bunday slug band: ${slug}`);

    const created = await this.prisma.tourOperator.create({
      data: {
        name: String(data.name).slice(0, 200),
        slug,
        description: data.description ? String(data.description).slice(0, 2000) : null,
        logoUrl: data.logoUrl || null,
        contactPhone: data.contactPhone || null,
        contactEmail: data.contactEmail || null,
        website: data.website || null,
        integrationType: safeEnum(data.integrationType, INTEGRATION_TYPES, 'MANUAL'),
        apiBaseUrl: data.apiBaseUrl || null,
        // ── SHIFRLASH ──
        credLogin: data.credLogin ? this.encryption.encrypt(String(data.credLogin)) : null,
        credPassword: data.credPassword ? this.encryption.encrypt(String(data.credPassword)) : null,
        apiKey: data.apiKey ? this.encryption.encrypt(String(data.apiKey)) : null,
        status: safeEnum(data.status, OPERATOR_STATUSES, 'ACTIVE'),
      },
    });

    this.logger.log(`Operator yaratildi: ${created.name} (${created.slug})`);
    return this.maskOperator(created);
  }

  async updateOperator(id: string, data: any) {
    const op = await this.prisma.tourOperator.findUnique({ where: { id } });
    if (!op) throw new NotFoundException('Operator topilmadi');

    const patch: any = clean({
      name: data.name ? String(data.name).slice(0, 200) : undefined,
      description: data.description !== undefined ? data.description : undefined,
      logoUrl: data.logoUrl !== undefined ? data.logoUrl : undefined,
      contactPhone: data.contactPhone !== undefined ? data.contactPhone : undefined,
      contactEmail: data.contactEmail !== undefined ? data.contactEmail : undefined,
      website: data.website !== undefined ? data.website : undefined,
      apiBaseUrl: data.apiBaseUrl !== undefined ? data.apiBaseUrl : undefined,
      integrationType: data.integrationType
        ? safeEnum(data.integrationType, INTEGRATION_TYPES, 'MANUAL')
        : undefined,
      status: data.status ? safeEnum(data.status, OPERATOR_STATUSES, 'ACTIVE') : undefined,
    });

    // Maxfiy maydonlar: faqat yangi qiymat kelsa qayta shifrlanadi.
    // "***" kelsa — o'zgartirmaymiz (frontend maskani qaytarib yuborgan).
    if (data.credLogin !== undefined && data.credLogin !== '***') {
      patch.credLogin = data.credLogin ? this.encryption.encrypt(String(data.credLogin)) : null;
    }
    if (data.credPassword !== undefined && data.credPassword !== '***') {
      patch.credPassword = data.credPassword ? this.encryption.encrypt(String(data.credPassword)) : null;
    }
    if (data.apiKey !== undefined && data.apiKey !== '***') {
      patch.apiKey = data.apiKey ? this.encryption.encrypt(String(data.apiKey)) : null;
    }

    if (data.slug) {
      const slug = this.makeSlug(data.slug);
      const dup = await this.prisma.tourOperator.findFirst({
        where: { slug, id: { not: id } },
      });
      if (dup) throw new BadRequestException(`Bunday slug band: ${slug}`);
      patch.slug = slug;
    }

    const updated = await this.prisma.tourOperator.update({
      where: { id },
      data: patch,
    });
    return this.maskOperator(updated);
  }

  async deleteOperator(id: string) {
    const op = await this.prisma.tourOperator.findUnique({ where: { id } });
    if (!op) throw new NotFoundException('Operator topilmadi');

    // Cascade: turlar va so'rovlar ham o'chadi (schema'da onDelete: Cascade)
    await this.prisma.tourOperator.delete({ where: { id } });
    this.logger.warn(`Operator o'chirildi: ${op.name}`);
    return { success: true, message: `"${op.name}" operatori o'chirildi` };
  }

  // ═══════════════════════════════════════════════════════════
  // IMPORT / SINXRONIZATSIYA
  // ═══════════════════════════════════════════════════════════

  /**
   * Turlarni massiv ko'rinishida import qiladi.
   * Excel/CSV frontendda o'qilib, JSON massiv sifatida yuboriladi.
   *
   * externalId bo'lsa — mavjud tur YANGILANADI (upsert),
   * bo'lmasa — yangi yaratiladi.
   */
  async importTours(operatorId: string, tours: any[], replaceAll = false) {
    const op = await this.prisma.tourOperator.findUnique({ where: { id: operatorId } });
    if (!op) throw new NotFoundException('Operator topilmadi');

    if (!Array.isArray(tours) || tours.length === 0) {
      throw new BadRequestException('tours — bo\'sh bo\'lmagan massiv bo\'lishi kerak');
    }
    if (tours.length > MAX_IMPORT_BATCH) {
      throw new BadRequestException(
        `Bir martada ko'pi bilan ${MAX_IMPORT_BATCH} ta tur import qilinadi (kelgan: ${tours.length})`,
      );
    }

    // Shu importning belgisi — barcha yangilangan turlar AYNAN shu vaqtni oladi.
    // replaceAll'da aynan shu belgi bo'yicha ajratamiz (vaqt oynasi emas),
    // shuning uchun import necha daqiqa davom etsa ham xato bo'lmaydi.
    const batchStamp = new Date();

    let created = 0;
    let updated = 0;
    const skipped: any[] = [];

    for (let i = 0; i < tours.length; i++) {
      const normalized = this.normalizeTour(tours[i]);
      if (!normalized) {
        skipped.push({ index: i, reason: 'title / destination / price yetishmayapti' });
        continue;
      }

      const payload = {
        ...normalized,
        operatorId,
        status: 'PUBLISHED',
        syncedAt: batchStamp,
      };

      try {
        if (normalized.externalId) {
          const existing = await this.prisma.marketplaceTour.findFirst({
            where: { operatorId, externalId: normalized.externalId },
          });
          if (existing) {
            await this.prisma.marketplaceTour.update({
              where: { id: existing.id },
              data: payload,
            });
            updated++;
            continue;
          }
        }
        await this.prisma.marketplaceTour.create({ data: payload });
        created++;
      } catch (e: any) {
        skipped.push({ index: i, reason: e?.message || 'saqlashda xato' });
      }
    }

    // replaceAll: importda kelmagan eski turlarni arxivga o'tkazamiz.
    // Shu importda yangilanganlar syncedAt === batchStamp bo'ladi,
    // qolganlari (eski yoki umuman sinxronlanmaganlar) arxivlanadi.
    let archived = 0;
    if (replaceAll) {
      const res = await this.prisma.marketplaceTour.updateMany({
        where: {
          operatorId,
          status: 'PUBLISHED',
          OR: [{ syncedAt: null }, { syncedAt: { lt: batchStamp } }],
        },
        data: { status: 'ARCHIVED' },
      });
      archived = res?.count || 0;
    }

    const total = await this.prisma.marketplaceTour.count({
      where: { operatorId, status: 'PUBLISHED' },
    });

    await this.prisma.tourOperator.update({
      where: { id: operatorId },
      data: {
        toursCount: total,
        lastSyncAt: new Date(),
        lastSyncError: null,
        status: 'ACTIVE',
      },
    });

    this.logger.log(
      `Import [${op.name}]: +${created} yangi, ~${updated} yangilandi, ${skipped.length} o'tkazib yuborildi`,
    );

    return {
      success: true,
      operator: op.name,
      created,
      updated,
      archived,
      skipped: skipped.slice(0, 50),
      skippedCount: skipped.length,
      totalPublished: total,
    };
  }

  /**
   * Operator API'sidan turlarni tortib oladi (integrationType = API).
   *
   * DIQQAT: har bir operatorning API'si har xil. Bu — UMUMIY
   * implementatsiya: apiBaseUrl'ga GET so'rov yuboradi va JSON massiv
   * (yoki {data: [...]} / {tours: [...]}) kutadi.
   * Operator boshqacha format bersa — shu joyni moslash kerak.
   */
  async syncOperator(operatorId: string) {
    const op = await this.prisma.tourOperator.findUnique({ where: { id: operatorId } });
    if (!op) throw new NotFoundException('Operator topilmadi');

    if (op.integrationType !== 'API') {
      throw new BadRequestException(
        `Bu operator "${op.integrationType}" rejimida. Avtomatik sinxronizatsiya faqat API rejimida ishlaydi. ` +
        `Excel/qo'lda kiritish uchun /import endpointidan foydalaning.`,
      );
    }
    if (!op.apiBaseUrl) {
      throw new BadRequestException('apiBaseUrl kiritilmagan');
    }

    const apiKey = this.reveal(op.apiKey);
    const login = this.reveal(op.credLogin);
    const password = this.reveal(op.credPassword);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    else if (login && password) {
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(op.apiBaseUrl, {
        method: 'GET',
        headers,
        signal: controller.signal as any,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json: any = await res.json();
      const list = Array.isArray(json)
        ? json
        : Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json?.tours)
            ? json.tours
            : Array.isArray(json?.result)
              ? json.result
              : null;

      if (!list) {
        throw new Error(
          'Javobda turlar massivi topilmadi (kutilgan: massiv yoki {data|tours|result: [...]})',
        );
      }

      return await this.importTours(operatorId, list, true);
    } catch (e: any) {
      const message = e?.name === 'AbortError'
        ? 'So\'rov vaqti tugadi (30s)'
        : (e?.message || 'Noma\'lum xato');

      await this.prisma.tourOperator.update({
        where: { id: operatorId },
        data: { status: 'ERROR', lastSyncError: message, lastSyncAt: new Date() },
      });

      this.logger.error(`Sync xato [${op.name}]: ${message}`);
      throw new BadRequestException(`Sinxronizatsiya xatosi: ${message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TURLAR (barcha agentlar ko'radi)
  // ═══════════════════════════════════════════════════════════

  async listTours(params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);

    const where: any = { status: 'PUBLISHED' };

    if (params.operatorId) where.operatorId = params.operatorId;
    if (params.country) where.country = { equals: params.country, mode: 'insensitive' };
    if (params.tourType) where.tourType = params.tourType;

    if (params.destination) {
      where.destination = { contains: params.destination, mode: 'insensitive' };
    }

    // MUHIM: qidiruv va "faqat bo'sh joylilar" — IKKI ALOHIDA shart.
    // Ikkalasini bitta OR ga qo'shsak, mantiq buziladi (0 joyli tur ham
    // qidiruvga tushib qolardi). Shuning uchun AND massividan foydalanamiz.
    const and: any[] = [];

    if (params.search) {
      and.push({
        OR: [
          { title: { contains: params.search, mode: 'insensitive' } },
          { destination: { contains: params.search, mode: 'insensitive' } },
          { country: { contains: params.search, mode: 'insensitive' } },
          { hotelName: { contains: params.search, mode: 'insensitive' } },
        ],
      });
    }

    // Narx oralig'i
    const priceMin = this.toNum(params.priceMin);
    const priceMax = this.toNum(params.priceMax);
    if (priceMin !== null || priceMax !== null) {
      where.price = {};
      if (priceMin !== null) where.price.gte = priceMin;
      if (priceMax !== null) where.price.lte = priceMax;
    }

    // Jo'nash sanasi oralig'i
    const dateFrom = this.toDate(params.dateFrom);
    const dateTo = this.toDate(params.dateTo);
    if (dateFrom || dateTo) {
      where.departureDate = {};
      if (dateFrom) where.departureDate.gte = dateFrom;
      if (dateTo) where.departureDate.lte = dateTo;
    }

    // Faqat bo'sh joyi borlar (seatsAvailable null = cheklanmagan)
    if (this.toBool(params.onlyAvailable)) {
      and.push({
        OR: [
          { seatsAvailable: null },
          { seatsAvailable: { gt: 0 } },
        ],
      });
    }

    if (and.length > 0) where.AND = and;

    const orderBy: any =
      params.sort === 'price_asc' ? { price: 'asc' }
        : params.sort === 'price_desc' ? { price: 'desc' }
          : params.sort === 'date_asc' ? { departureDate: 'asc' }
            : { createdAt: 'desc' };

    const [items, total] = await Promise.all([
      this.prisma.marketplaceTour.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          operator: {
            select: { id: true, name: true, slug: true, logoUrl: true, contactPhone: true },
          },
        },
      }),
      this.prisma.marketplaceTour.count({ where }),
    ]);

    // `raw` — ichki debug maydoni, agentga kerak emas
    const data = items.map(({ raw, ...t }: any) => t);

    return { data, meta: meta(total, page, limit) };
  }

  async getTour(id: string) {
    const tour = await this.prisma.marketplaceTour.findUnique({
      where: { id },
      include: {
        operator: {
          select: {
            id: true, name: true, slug: true, logoUrl: true,
            contactPhone: true, contactEmail: true, website: true,
          },
        },
      },
    });
    if (!tour) throw new NotFoundException('Tur topilmadi');

    const { raw, ...clean_ } = tour as any;
    return clean_;
  }

  /** Filtr uchun mavjud qiymatlar (frontend dropdownlari uchun) */
  async getFilters() {
    const [countries, destinations, operators, priceAgg] = await Promise.all([
      this.prisma.marketplaceTour.findMany({
        where: { status: 'PUBLISHED', country: { not: null } },
        select: { country: true },
        distinct: ['country'],
        take: 200,
      }),
      this.prisma.marketplaceTour.findMany({
        where: { status: 'PUBLISHED' },
        select: { destination: true },
        distinct: ['destination'],
        take: 300,
      }),
      this.prisma.tourOperator.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, slug: true, logoUrl: true, toursCount: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.marketplaceTour.aggregate({
        where: { status: 'PUBLISHED' },
        _min: { price: true },
        _max: { price: true },
      }),
    ]);

    return {
      countries: countries.map((c: any) => c.country).filter(Boolean).sort(),
      destinations: destinations.map((d: any) => d.destination).filter(Boolean).sort(),
      operators,
      tourTypes: TOUR_TYPES,
      priceRange: {
        min: priceAgg?._min?.price ?? 0,
        max: priceAgg?._max?.price ?? 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════
  // BRON SO'ROVLARI
  // ═══════════════════════════════════════════════════════════

  async createRequest(tenantId: string, userId: string, tourId: string, data: any) {
    const tour = await this.prisma.marketplaceTour.findUnique({
      where: { id: tourId },
      include: { operator: { select: { id: true, name: true } } },
    });
    if (!tour) throw new NotFoundException('Tur topilmadi');
    if (tour.status !== 'PUBLISHED') {
      throw new BadRequestException('Bu tur hozir mavjud emas (arxivlangan)');
    }

    const adults = Math.max(1, Number(data?.adults) || 1);
    const children = Math.max(0, Number(data?.children) || 0);
    const infants = Math.max(0, Number(data?.infants) || 0);

    // Joy yetarliligini tekshirish
    if (tour.seatsAvailable !== null && tour.seatsAvailable !== undefined) {
      const need = adults + children;
      if (tour.seatsAvailable < need) {
        throw new BadRequestException(
          `Bo'sh joy yetarli emas. Mavjud: ${tour.seatsAvailable}, kerak: ${need}`,
        );
      }
    }

    // Mijoz ko'rsatilgan bo'lsa — u shu tenantga tegishli ekanini tekshiramiz
    if (data?.clientId) {
      const client = await this._prisma.client.findFirst({
        where: { id: data.clientId, tenantId },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Mijoz topilmadi');
    }

    const count = await this.prisma.tourBookingRequest.count({ where: { tenantId } });
    let requestRef = generateRef('REQ', count);
    const dup = await this.prisma.tourBookingRequest.findFirst({ where: { requestRef } });
    if (dup) requestRef = generateRef('REQ', count + Math.floor(Math.random() * 1000) + 1);

    const created = await this.prisma.tourBookingRequest.create({
      data: {
        requestRef,
        tenantId,
        agentId: userId,
        clientId: data?.clientId || null,
        tourId,
        operatorId: tour.operatorId,
        adults,
        children,
        infants,
        contactName: data?.contactName ? String(data.contactName).slice(0, 150) : null,
        contactPhone: data?.contactPhone ? String(data.contactPhone).slice(0, 50) : null,
        note: data?.note ? String(data.note).slice(0, 2000) : null,
        status: 'PENDING',
      },
      include: {
        tour: { select: { id: true, title: true, destination: true, price: true, currency: true } },
        operator: { select: { id: true, name: true, contactPhone: true, contactEmail: true } },
      },
    });

    this.logger.log(`Bron so'rovi: ${requestRef} → ${tour.operator?.name} (${tour.title})`);
    return created;
  }

  async listRequests(tenantId: string, userId: string, role: string, params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);

    const where: any = { tenantId };
    // AGENT faqat o'zining so'rovlarini ko'radi
    if (role === 'AGENT') where.agentId = userId;
    if (params.status) where.status = params.status;
    if (params.operatorId) where.operatorId = params.operatorId;

    const [items, total] = await Promise.all([
      this.prisma.tourBookingRequest.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          tour: {
            select: {
              id: true, title: true, destination: true, country: true,
              price: true, currency: true, departureDate: true, returnDate: true,
            },
          },
          operator: { select: { id: true, name: true, logoUrl: true, contactPhone: true } },
        },
      }),
      this.prisma.tourBookingRequest.count({ where }),
    ]);

    return { data: items, meta: meta(total, page, limit) };
  }

  async getRequest(tenantId: string, userId: string, role: string, id: string) {
    const where: any = { id, tenantId };
    if (role === 'AGENT') where.agentId = userId;

    const req = await this.prisma.tourBookingRequest.findFirst({
      where,
      include: {
        tour: true,
        operator: {
          select: {
            id: true, name: true, logoUrl: true,
            contactPhone: true, contactEmail: true, website: true,
          },
        },
      },
    });
    if (!req) throw new NotFoundException('So\'rov topilmadi');
    return req;
  }

  async updateRequestStatus(
    tenantId: string,
    userId: string,
    role: string,
    id: string,
    status: string,
    operatorResponse?: string,
  ) {
    const where: any = { id, tenantId };
    if (role === 'AGENT') where.agentId = userId;

    const req = await this.prisma.tourBookingRequest.findFirst({ where });
    if (!req) throw new NotFoundException('So\'rov topilmadi');

    const newStatus = safeEnum(status, REQUEST_STATUSES, 'PENDING');

    // AGENT faqat bekor qila oladi; tasdiqlash — MANAGER va yuqorisi
    if (role === 'AGENT' && newStatus !== 'CANCELLED') {
      throw new ForbiddenException(
        'Agent faqat so\'rovni bekor qila oladi. Tasdiqlash uchun menejerga murojaat qiling.',
      );
    }

    const updated = await this.prisma.tourBookingRequest.update({
      where: { id },
      data: {
        status: newStatus,
        operatorResponse: operatorResponse
          ? String(operatorResponse).slice(0, 2000)
          : req.operatorResponse,
      },
      include: {
        tour: { select: { id: true, title: true, destination: true } },
        operator: { select: { id: true, name: true } },
      },
    });

    return updated;
  }

  /**
   * Tasdiqlangan so'rovni haqiqiy Booking'ga aylantiradi.
   * Mavjud `bookings` moduliga ulanadi — mijoz, narx, sanalar ko'chiriladi.
   */
  async convertToBooking(
    tenantId: string,
    userId: string,
    role: string,
    id: string,
    data: any,
  ) {
    // AGENT faqat O'ZINING so'rovini bookingga aylantira oladi
    const where: any = { id, tenantId };
    if (role === 'AGENT') where.agentId = userId;

    const req = await this.prisma.tourBookingRequest.findFirst({
      where,
      include: { tour: true, operator: { select: { name: true } } },
    });
    if (!req) throw new NotFoundException('So\'rov topilmadi');

    if (req.bookingId) {
      throw new BadRequestException('Bu so\'rov allaqachon bookingga aylantirilgan');
    }
    if (req.status !== 'CONFIRMED') {
      throw new BadRequestException(
        'Faqat CONFIRMED (tasdiqlangan) so\'rovni bookingga aylantirish mumkin',
      );
    }

    const clientId = data?.clientId || req.clientId;
    if (!clientId) {
      throw new BadRequestException(
        'clientId kerak — bookingni qaysi mijozga biriktirishni ko\'rsating',
      );
    }

    const client = await this._prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Mijoz topilmadi');

    const tour = req.tour;
    const pax = req.adults + req.children;
    const totalPrice = Number(tour.price) * Math.max(1, pax);

    const count = await this._prisma.booking.count({ where: { tenantId } });
    let bookingRef = generateRef('TRV', count);
    const dup = await this._prisma.booking.findFirst({ where: { bookingRef } });
    if (dup) bookingRef = generateRef('TRV', count + Math.floor(Math.random() * 1000) + 1);

    const booking = await this._prisma.booking.create({
      data: {
        bookingRef,
        tenantId,
        clientId,
        agentId: req.agentId || userId,
        tourName: tour.title,
        destination: tour.destination,
        country: tour.country,
        tourType: tour.tourType,
        description:
          `Marketplace: ${req.operator?.name || 'operator'} | So'rov: ${req.requestRef}` +
          (tour.description ? `\n\n${tour.description}` : ''),
        departureDate: tour.departureDate,
        returnDate: tour.returnDate,
        duration: tour.duration,
        adults: req.adults,
        children: req.children,
        infants: req.infants,
        totalPrice,
        currency: tour.currency,
        hotelName: tour.hotelName,
        hotelStars: tour.hotelStars,
        mealPlan: tour.mealPlan,
        includesVisa: tour.includesVisa,
        includesFlights: tour.includesFlights,
        includesHotel: tour.includesHotel,
        includesMeals: tour.includesMeals,
        includesTransfer: tour.includesTransfer,
        includesInsurance: tour.includesInsurance,
        status: 'DRAFT',
      },
    });

    await this.prisma.tourBookingRequest.update({
      where: { id },
      data: { bookingId: booking.id },
    });

    this.logger.log(`So'rov → Booking: ${req.requestRef} → ${booking.bookingRef}`);

    return {
      success: true,
      message: `Booking yaratildi: ${booking.bookingRef}`,
      booking,
      requestRef: req.requestRef,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// CONTROLLER 1 — OPERATORLAR (faqat PLATFORM_OWNER)
// ═══════════════════════════════════════════════════════════════

@Controller('marketplace/operators')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MarketplaceOperatorsController {
  constructor(private service: MarketplaceService) {}

  /** Operatorlar ro'yxati — barcha rollar ko'radi (parollar maskalangan) */
  @Get()
  list(@Query() query: any) {
    return this.service.listOperators(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getOperator(id);
  }

  @Post()
  @Roles('PLATFORM_OWNER')
  create(@Body() body: any) {
    return this.service.createOperator(body);
  }

  @Patch(':id')
  @Roles('PLATFORM_OWNER')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.updateOperator(id, body);
  }

  @Delete(':id')
  @Roles('PLATFORM_OWNER')
  remove(@Param('id') id: string) {
    return this.service.deleteOperator(id);
  }

  /**
   * Turlarni import qilish (Excel/CSV frontendda o'qilib, JSON yuboriladi)
   * body: { tours: [...], replaceAll?: boolean }
   */
  @Post(':id/import')
  @Roles('PLATFORM_OWNER')
  import(@Param('id') id: string, @Body() body: any) {
    return this.service.importTours(id, body?.tours, Boolean(body?.replaceAll));
  }

  /** Operator API'sidan avtomatik tortib olish */
  @Post(':id/sync')
  @Roles('PLATFORM_OWNER')
  sync(@Param('id') id: string) {
    return this.service.syncOperator(id);
  }
}

// ═══════════════════════════════════════════════════════════════
// CONTROLLER 2 — TURLAR (barcha agentlar)
// ═══════════════════════════════════════════════════════════════

@Controller('marketplace/tours')
@UseGuards(JwtAuthGuard)
export class MarketplaceToursController {
  constructor(private service: MarketplaceService) {}

  /**
   * Turlar ro'yxati — filtrlar bilan.
   * ?search= &destination= &country= &tourType= &operatorId=
   * &priceMin= &priceMax= &dateFrom= &dateTo= &onlyAvailable=
   * &sort=price_asc|price_desc|date_asc &page= &limit=
   */
  @Get()
  list(@Query() query: any) {
    return this.service.listTours(query);
  }

  /** Filtr dropdownlari uchun mavjud qiymatlar */
  @Get('filters')
  filters() {
    return this.service.getFilters();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getTour(id);
  }

  /** Shu turga bron so'rovi yuborish */
  @Post(':id/request')
  createRequest(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.service.createRequest(user.tenantId, user.sub || user.id, id, body);
  }
}

// ═══════════════════════════════════════════════════════════════
// CONTROLLER 3 — BRON SO'ROVLARI
// ═══════════════════════════════════════════════════════════════

@Controller('marketplace/requests')
@UseGuards(JwtAuthGuard)
export class MarketplaceRequestsController {
  constructor(private service: MarketplaceService) {}

  @Get()
  list(@CurrentUser() user: any, @Query() query: any) {
    return this.service.listRequests(
      user.tenantId,
      user.sub || user.id,
      user.role,
      query,
    );
  }

  @Get(':id')
  get(@CurrentUser() user: any, @Param('id') id: string) {
    return this.service.getRequest(user.tenantId, user.sub || user.id, user.role, id);
  }

  /** body: { status: 'SENT'|'CONFIRMED'|'REJECTED'|'CANCELLED', operatorResponse?: string } */
  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.service.updateRequestStatus(
      user.tenantId,
      user.sub || user.id,
      user.role,
      id,
      body?.status,
      body?.operatorResponse,
    );
  }

  /** Tasdiqlangan so'rovni haqiqiy Booking'ga aylantirish. body: { clientId } */
  @Post(':id/convert')
  convert(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.service.convertToBooking(
      user.tenantId,
      user.sub || user.id,
      user.role,
      id,
      body,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// MODULE
// ═══════════════════════════════════════════════════════════════

@Module({
  controllers: [
    MarketplaceOperatorsController,
    MarketplaceToursController,
    MarketplaceRequestsController,
  ],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}