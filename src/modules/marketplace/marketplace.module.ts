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
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import {
  paginate,
  meta,
  generateRef,
  clean,
  safeEnum,
  convertToUSD,
} from '../../common/utils/helpers';
import { AuditService } from '../audit/audit.module';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ClientsService } from '../clients/clients.service';
import { CacheService } from '../../common/cache/cache.service';

/**
 * ═══════════════════════════════════════════════════════════════
 * TURLAR BOZORI (MARKETPLACE) — v12.1
 * ═══════════════════════════════════════════════════════════════
 *
 * MAQSAD:
 *   Har bir agentlik (tenant) O'ZI ishlaydigan tur operatorlarni qo'shadi.
 *   Ularning turlari CRM'da ko'rinadi va agent to'g'ridan-to'g'ri
 *   BOOKING qiladi (oraliq "so'rov" bosqichi yo'q).
 *
 * IZOLYATSIYA:
 *   Operatorlar ham, turlar ham TENANTGA bog'langan.
 *   A kompaniyaning operatori B kompaniyaga KO'RINMAYDI.
 *   Har bir so'rovda tenantId filtri majburiy.
 *
 * ROLLAR:
 *   TENANT_ADMIN va yuqorisi → operator qo'shish/o'chirish, turlarni yuklash
 *   Barcha rollar            → turlarni ko'rish va booking qilish
 *
 * VALYUTA:
 *   Booking yaratishda narx USD'ga o'giriladi (mavjud bookings moduli
 *   bilan bir xil mantiq), originalCurrency/exchangeRate saqlanadi —
 *   shunda hisobotlar va KPI to'g'ri hisoblanadi.
 *
 * XAVFSIZLIK:
 *   Operator login/parol/apiKey — EncryptionService orqali shifrlanadi.
 *   API javobida hech qachon ochiq qaytmaydi (faqat "***").
 *
 * MUHIM — ishga tushirishdan oldin:
 *   1) npx prisma generate
 *   2) npx prisma db push
 *   3) .env da ENCRYPTION_KEY sozlangan bo'lsin
 * ═══════════════════════════════════════════════════════════════
 */

const INTEGRATION_TYPES = ['MANUAL', 'EXCEL', 'API'] as const;
const OPERATOR_STATUSES = ['ACTIVE', 'INACTIVE', 'ERROR'] as const;
const TOUR_TYPES = [
  'PACKAGE', 'INDIVIDUAL', 'GROUP', 'VISA_SUPPORT',
  'HOTEL_ONLY', 'FLIGHT_ONLY', 'CRUISE',
] as const;
const CURRENCIES = ['USD', 'UZS', 'EUR', 'RUB'] as const;
// DIQQAT: bu ro'yxat prisma'dagi BookingStatus enum bilan AYNAN mos
// bo'lishi shart (PENDING/PAID kabi mavjud bo'lmagan status yozilmasin).
const BOOKING_STATUSES = [
  'DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED',
] as const;

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
    private audit: AuditService,
    private notifications: NotificationsService,
    private realtime: RealtimeGateway,
    private clients: ClientsService,
    private cache: CacheService,
  ) {}

  /**
   * Prisma cast — yangi modellar `prisma generate` dan keyin paydo bo'ladi.
   * Shu sababli `any` — kod generate'gacha ham kompilyatsiya bo'lsin.
   */
  private get prisma(): any {
    return this._prisma;
  }

  // ─────────────────────────────────────────────────────────────
  // YORDAMCHI FUNKSIYALAR
  // ─────────────────────────────────────────────────────────────

  private makeSlug(name: string): string {
    return String(name || '')
      .toLowerCase()
      .trim()
      .replace(/['`]/g, '')
      .replace(/[^a-z0-9\u0400-\u04FF]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `operator-${Date.now().toString(36)}`;
  }

  /** Maxfiy maydonlarni yashiradi — parol hech qachon ochiq chiqmaydi */
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

  private reveal(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      return this.encryption.decrypt(value);
    } catch {
      this.logger.warn("Maxfiy maydonni ochib bo'lmadi (kalit o'zgargan?)");
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

  /** Butun son (Prisma Int maydonlari uchun) — Excel "10.0" bersa ham ishlaydi */
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
   * bitta standart ko'rinishga keltiradi (uz / ru / en).
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
    if (!title || !destination) return null;

    const price = this.toNum(pick('price', 'cost', 'narx', 'цена', 'amount'));
    if (price === null) return null;

    const departureDate = this.toDate(
      pick('departureDate', 'departure_date', 'startDate', 'start_date', 'sana', 'дата'),
    );
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

    const extId = pick('externalId', 'external_id', 'id', 'tour_id');

    return {
      externalId: extId != null ? String(extId) : null,
      title: String(title).slice(0, 300),
      destination: String(destination).slice(0, 150),
      country: pick('country', 'mamlakat', 'страна')
        ? String(pick('country', 'mamlakat', 'страна')).slice(0, 100) : null,
      city: pick('city', 'shahar') ? String(pick('city', 'shahar')).slice(0, 100) : null,
      tourType: safeEnum(pick('tourType', 'tour_type', 'type'), TOUR_TYPES, 'PACKAGE'),
      description: pick('description', 'desc', 'tavsif', 'описание')
        ? String(pick('description', 'desc', 'tavsif', 'описание')).slice(0, 5000) : null,

      price,
      // NETTO — operatordan sotib olish narxi. Bo'lsa foyda to'g'ri
      // hisoblanadi; bo'lmasa null qoladi va supplierCost 0 bo'ladi.
      netPrice: this.toNum(
        pick('netPrice', 'net_price', 'netto', 'supplierCost', 'supplier_cost',
             'tannarx', 'нетто', 'себестоимость'),
      ),
      currency: safeEnum(pick('currency', 'valyuta', 'валюта'), CURRENCIES, 'USD'),
      priceNote: pick('priceNote', 'price_note')
        ? String(pick('priceNote', 'price_note')).slice(0, 200) : null,

      departureDate,
      returnDate,
      duration: duration ? Math.round(duration) : null,

      seatsTotal: this.toIntOrNull(pick('seatsTotal', 'seats_total', 'seats', 'joylar')),
      seatsAvailable: this.toIntOrNull(
        pick('seatsAvailable', 'seats_available', 'available', 'bosh_joylar'),
      ),

      hotelName: pick('hotelName', 'hotel_name', 'hotel', 'mehmonxona')
        ? String(pick('hotelName', 'hotel_name', 'hotel', 'mehmonxona')).slice(0, 200) : null,
      hotelStars: this.toIntOrNull(pick('hotelStars', 'hotel_stars', 'stars', 'yulduz')),
      mealPlan: pick('mealPlan', 'meal_plan', 'meal', 'ovqat')
        ? String(pick('mealPlan', 'meal_plan', 'meal', 'ovqat')).slice(0, 20) : null,

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
  // OPERATORLAR — hammasi tenantga bog'langan
  // ═══════════════════════════════════════════════════════════

  async listOperators(tenantId: string, params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);

    const where: any = { tenantId };
    if (params.status) where.status = params.status;
    if (params.search) where.name = { contains: params.search, mode: 'insensitive' };

    const [items, total] = await Promise.all([
      this.prisma.tourOperator.findMany({ where, skip, take, orderBy: { name: 'asc' } }),
      this.prisma.tourOperator.count({ where }),
    ]);

    return {
      data: items.map((o: any) => this.maskOperator(o)),
      meta: meta(total, page, limit),
    };
  }

  async getOperator(tenantId: string, id: string) {
    const op = await this.prisma.tourOperator.findFirst({ where: { id, tenantId } });
    if (!op) throw new NotFoundException('Operator topilmadi');
    return this.maskOperator(op);
  }

  async createOperator(tenantId: string, userId: string, data: any) {
    if (!data?.name) throw new BadRequestException('Operator nomi (name) kerak');

    const slug = this.makeSlug(data.slug || data.name);

    // Slug faqat SHU tenant ichida takrorlanmasligi kerak
    const exists = await this.prisma.tourOperator.findFirst({ where: { tenantId, slug } });
    if (exists) {
      throw new BadRequestException(`Bunday nomdagi operator allaqachon bor: ${data.name}`);
    }

    const created = await this.prisma.tourOperator.create({
      data: {
        tenantId,
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

    this.audit.log({
      tenantId, userId,
      action: 'CREATE', entity: 'tour_operator', entityId: created.id,
      metadata: { name: created.name, integrationType: created.integrationType },
    });

    this.logger.log(`Operator yaratildi [${tenantId}]: ${created.name}`);
    return this.maskOperator(created);
  }

  async updateOperator(tenantId: string, userId: string, id: string, data: any) {
    const op = await this.prisma.tourOperator.findFirst({ where: { id, tenantId } });
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
        ? safeEnum(data.integrationType, INTEGRATION_TYPES, 'MANUAL') : undefined,
      status: data.status ? safeEnum(data.status, OPERATOR_STATUSES, 'ACTIVE') : undefined,
    });

    // Maxfiy maydonlar: "***" kelsa tegmaymiz (frontend maskani qaytargan)
    if (data.credLogin !== undefined && data.credLogin !== '***') {
      patch.credLogin = data.credLogin ? this.encryption.encrypt(String(data.credLogin)) : null;
    }
    if (data.credPassword !== undefined && data.credPassword !== '***') {
      patch.credPassword = data.credPassword
        ? this.encryption.encrypt(String(data.credPassword)) : null;
    }
    if (data.apiKey !== undefined && data.apiKey !== '***') {
      patch.apiKey = data.apiKey ? this.encryption.encrypt(String(data.apiKey)) : null;
    }

    if (data.name || data.slug) {
      const slug = this.makeSlug(data.slug || data.name);
      const dup = await this.prisma.tourOperator.findFirst({
        where: { tenantId, slug, id: { not: id } },
      });
      if (dup) throw new BadRequestException('Bunday nomdagi operator allaqachon bor');
      patch.slug = slug;
    }

    // DIQQAT: audit'ga parol/kalit QIYMATI yozilmaydi — faqat
    // o'zgartirilgan-o'zgartirilmagani qayd etiladi.
    const credsTouched = ['credLogin', 'credPassword', 'apiKey'].filter(
      (k) => patch[k] !== undefined,
    );

    const updated = await this.prisma.tourOperator.update({ where: { id }, data: patch });

    this.audit.log({
      tenantId, userId,
      action: 'UPDATE', entity: 'tour_operator', entityId: id,
      metadata: {
        name: updated.name,
        fieldsChanged: Object.keys(patch),
        credentialsChanged: credsTouched.length > 0 ? credsTouched : undefined,
      },
    });

    return this.maskOperator(updated);
  }

  async deleteOperator(tenantId: string, userId: string, id: string) {
    const op = await this.prisma.tourOperator.findFirst({ where: { id, tenantId } });
    if (!op) throw new NotFoundException('Operator topilmadi');

    // Cascade: turlari ham o'chadi (schema'da onDelete: Cascade)
    await this.prisma.tourOperator.delete({ where: { id } });

    this.audit.log({
      tenantId, userId,
      action: 'DELETE', entity: 'tour_operator', entityId: id,
      metadata: { name: op.name, toursDeleted: op.toursCount },
    });

    this.logger.warn(`Operator o'chirildi [${tenantId}]: ${op.name}`);
    return { success: true, message: `"${op.name}" operatori o'chirildi` };
  }

  // ═══════════════════════════════════════════════════════════
  // IMPORT / SINXRONIZATSIYA
  // ═══════════════════════════════════════════════════════════

  async importTours(tenantId: string, userId: string, operatorId: string, tours: any[], replaceAll = false) {
    const op = await this.prisma.tourOperator.findFirst({ where: { id: operatorId, tenantId } });
    if (!op) throw new NotFoundException('Operator topilmadi');

    if (!Array.isArray(tours) || tours.length === 0) {
      throw new BadRequestException("tours — bo'sh bo'lmagan massiv bo'lishi kerak");
    }
    if (tours.length > MAX_IMPORT_BATCH) {
      throw new BadRequestException(
        `Bir martada ko'pi bilan ${MAX_IMPORT_BATCH} ta tur import qilinadi (kelgan: ${tours.length})`,
      );
    }

    // Shu importning belgisi — replaceAll aynan shu bo'yicha ajratadi,
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
        tenantId,
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
            await this.prisma.marketplaceTour.update({ where: { id: existing.id }, data: payload });
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

    // replaceAll: shu importda kelmagan eski turlarni arxivlaymiz
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
      data: { toursCount: total, lastSyncAt: new Date(), lastSyncError: null, status: 'ACTIVE' },
    });

    this.audit.log({
      tenantId, userId,
      action: 'IMPORT', entity: 'marketplace_tour', entityId: operatorId,
      metadata: { operator: op.name, created, updated, archived, skipped: skipped.length },
    });

    this.logger.log(
      `Import [${op.name}]: +${created} yangi, ~${updated} yangilandi, ${skipped.length} o'tkazildi`,
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
   * DIQQAT: har bir operatorning API'si har xil. Bu UMUMIY implementatsiya:
   * apiBaseUrl'ga GET yuboradi va JSON massiv (yoki {data|tours|result: [...]})
   * kutadi. Operator boshqacha format bersa — shu joyni moslash kerak.
   */
  async syncOperator(tenantId: string, userId: string, operatorId: string) {
    const op = await this.prisma.tourOperator.findFirst({ where: { id: operatorId, tenantId } });
    if (!op) throw new NotFoundException('Operator topilmadi');

    if (op.integrationType !== 'API') {
      throw new BadRequestException(
        `Bu operator "${op.integrationType}" rejimida. Avtomatik sinxronizatsiya faqat API rejimida ishlaydi. ` +
        `Excel/CSV uchun "Turlarni yuklash" tugmasidan foydalaning.`,
      );
    }
    if (!op.apiBaseUrl) throw new BadRequestException('apiBaseUrl kiritilmagan');

    const apiKey = this.reveal(op.apiKey);
    const login = this.reveal(op.credLogin);
    const password = this.reveal(op.credPassword);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    else if (login && password) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
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
      const list = Array.isArray(json) ? json
        : Array.isArray(json?.data) ? json.data
          : Array.isArray(json?.tours) ? json.tours
            : Array.isArray(json?.result) ? json.result
              : null;

      if (!list) {
        throw new Error(
          'Javobda turlar massivi topilmadi (kutilgan: massiv yoki {data|tours|result: [...]})',
        );
      }

      return await this.importTours(tenantId, userId, operatorId, list, true);
    } catch (e: any) {
      const message = e?.name === 'AbortError'
        ? "So'rov vaqti tugadi (30s)"
        : (e?.message || "Noma'lum xato");

      await this.prisma.tourOperator.update({
        where: { id: operatorId },
        data: { status: 'ERROR', lastSyncError: message, lastSyncAt: new Date() },
      });

      this.logger.error(`Sync xato [${op.name}]: ${message}`);
      throw new BadRequestException(`Sinxronizatsiya xatosi: ${message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TURLAR — faqat shu tenantning turlari
  // ═══════════════════════════════════════════════════════════

  async listTours(tenantId: string, params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);

    const where: any = { tenantId, status: 'PUBLISHED' };

    if (params.operatorId) where.operatorId = params.operatorId;
    if (params.country) where.country = { equals: params.country, mode: 'insensitive' };
    if (params.tourType) where.tourType = params.tourType;
    if (params.destination) {
      where.destination = { contains: params.destination, mode: 'insensitive' };
    }

    // MUHIM: qidiruv va "faqat bo'sh joylilar" — IKKI ALOHIDA shart.
    // Bitta OR ga qo'shsak mantiq buziladi, shuning uchun AND massivi.
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

    const priceMin = this.toNum(params.priceMin);
    const priceMax = this.toNum(params.priceMax);
    if (priceMin !== null || priceMax !== null) {
      where.price = {};
      if (priceMin !== null) where.price.gte = priceMin;
      if (priceMax !== null) where.price.lte = priceMax;
    }

    const dateFrom = this.toDate(params.dateFrom);
    const dateTo = this.toDate(params.dateTo);
    if (dateFrom || dateTo) {
      where.departureDate = {};
      if (dateFrom) where.departureDate.gte = dateFrom;
      if (dateTo) where.departureDate.lte = dateTo;
    }

    if (this.toBool(params.onlyAvailable)) {
      and.push({ OR: [{ seatsAvailable: null }, { seatsAvailable: { gt: 0 } }] });
    }

    if (and.length > 0) where.AND = and;

    const orderBy: any =
      params.sort === 'price_asc' ? { price: 'asc' }
        : params.sort === 'price_desc' ? { price: 'desc' }
          : params.sort === 'date_asc' ? { departureDate: 'asc' }
            : { createdAt: 'desc' };

    const [items, total] = await Promise.all([
      this.prisma.marketplaceTour.findMany({
        where, skip, take, orderBy,
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

  async getTour(tenantId: string, id: string) {
    const tour = await this.prisma.marketplaceTour.findFirst({
      where: { id, tenantId },
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

    const { raw, ...rest } = tour as any;
    return rest;
  }

  /** Filtr dropdownlari uchun mavjud qiymatlar (shu tenant bo'yicha) */
  async getFilters(tenantId: string) {
    const [countries, destinations, operators, priceAgg] = await Promise.all([
      this.prisma.marketplaceTour.findMany({
        where: { tenantId, status: 'PUBLISHED', country: { not: null } },
        select: { country: true },
        distinct: ['country'],
        take: 200,
      }),
      this.prisma.marketplaceTour.findMany({
        where: { tenantId, status: 'PUBLISHED' },
        select: { destination: true },
        distinct: ['destination'],
        take: 300,
      }),
      this.prisma.tourOperator.findMany({
        where: { tenantId, status: 'ACTIVE' },
        select: { id: true, name: true, slug: true, logoUrl: true, toursCount: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.marketplaceTour.aggregate({
        where: { tenantId, status: 'PUBLISHED' },
        _min: { price: true },
        _max: { price: true },
      }),
    ]);

    return {
      countries: countries.map((c: any) => c.country).filter(Boolean).sort(),
      destinations: destinations.map((d: any) => d.destination).filter(Boolean).sort(),
      operators,
      tourTypes: TOUR_TYPES,
      priceRange: { min: priceAgg?._min?.price ?? 0, max: priceAgg?._max?.price ?? 0 },
    };
  }

  // ═══════════════════════════════════════════════════════════
  // TO'G'RIDAN-TO'G'RI BOOKING
  // ═══════════════════════════════════════════════════════════

  /**
   * Turdan to'g'ridan-to'g'ri Booking yaratadi.
   *
   * Narx USD'ga o'giriladi (mavjud bookings moduli bilan bir xil mantiq):
   * totalPrice — HAR DOIM USD, originalCurrency/originalAmount/exchangeRate
   * saqlanadi. Shunda hisobot, KPI va komissiya to'g'ri ishlaydi.
   */
  async bookTour(tenantId: string, userId: string, tourId: string, data: any) {
    const tour = await this.prisma.marketplaceTour.findFirst({
      where: { id: tourId, tenantId },
      include: { operator: { select: { id: true, name: true } } },
    });
    if (!tour) throw new NotFoundException('Tur topilmadi');
    if (tour.status !== 'PUBLISHED') {
      throw new BadRequestException('Bu tur hozir mavjud emas (arxivlangan)');
    }

    if (!data?.clientId) {
      throw new BadRequestException(
        'clientId kerak — bookingni qaysi mijozga biriktirishni tanlang',
      );
    }

    const client = await this._prisma.client.findFirst({
      where: { id: data.clientId, tenantId },
      select: { id: true, fullName: true },
    });
    if (!client) throw new NotFoundException('Mijoz topilmadi');

    const adults = Math.max(1, Number(data?.adults) || 1);
    const children = Math.max(0, Number(data?.children) || 0);
    const infants = Math.max(0, Number(data?.infants) || 0);

    // Bo'sh joy tekshiruvi (chaqaloqlar joy egallamaydi deb hisoblaymiz)
    const needSeats = adults + children;
    if (tour.seatsAvailable !== null && tour.seatsAvailable !== undefined) {
      if (tour.seatsAvailable < needSeats) {
        throw new BadRequestException(
          `Bo'sh joy yetarli emas. Mavjud: ${tour.seatsAvailable}, kerak: ${needSeats}`,
        );
      }
    }

    // ── Narx: tur valyutasida, keyin USD'ga o'giriladi ──
    const enteredCurrency = safeEnum(tour.currency, CURRENCIES, 'USD');
    const rawTotal =
      data?.totalPrice !== undefined && data?.totalPrice !== null && data?.totalPrice !== ''
        ? Number(data.totalPrice)
        : Number(tour.price) * Math.max(1, needSeats);

    if (!Number.isFinite(rawTotal) || rawTotal <= 0) {
      throw new BadRequestException("totalPrice musbat bo'lishi kerak");
    }

    // NETTO (operatorga to'lanadigan) — supplierCost
    const rawSupplier =
      data?.supplierCost !== undefined && data?.supplierCost !== null && data?.supplierCost !== ''
        ? Number(data.supplierCost)
        : (tour.netPrice != null ? Number(tour.netPrice) * Math.max(1, needSeats) : 0);

    let totalPrice = rawTotal;
    let supplierCost = Number.isFinite(rawSupplier) && rawSupplier > 0 ? rawSupplier : 0;
    let fxRate: number | null = null;

    if (enteredCurrency !== 'USD') {
      // Kursni bir marta olamiz va IKKALA summaga ham qo'llaymiz —
      // aks holda foyda noto'g'ri chiqadi.
      fxRate = (await convertToUSD(1, enteredCurrency)).rate;
      totalPrice = Math.round((rawTotal / fxRate) * 100) / 100;
      supplierCost = Math.round((supplierCost / fxRate) * 100) / 100;
    }

    // Foyda = sotuv narxi - tannarx (bookings moduli bilan bir xil mantiq)
    const profit = Math.max(0, Math.round((totalPrice - supplierCost) * 100) / 100);

    // ── Booking raqami ──
    const count = await this._prisma.booking.count({ where: { tenantId } });
    let bookingRef = generateRef('TRV', count);
    const dup = await this._prisma.booking.findFirst({ where: { bookingRef } });
    if (dup) bookingRef = generateRef('TRV', count + Math.floor(Math.random() * 1000) + 1);

    const notes = [
      `Turlar bozori — operator: ${tour.operator?.name || '—'}`,
      tour.description || '',
      data?.note ? `Izoh: ${data.note}` : '',
    ].filter(Boolean).join('\n\n');

    const booking = await this._prisma.booking.create({
      data: {
        bookingRef,
        tenantId,
        clientId: client.id,
        agentId: data?.agentId || userId,
        tourName: tour.title,
        destination: tour.destination,
        country: tour.country,
        tourType: tour.tourType,
        description: notes.slice(0, 5000),
        departureDate: tour.departureDate,
        returnDate: tour.returnDate,
        duration: tour.duration,
        adults,
        children,
        infants,
        totalPrice,
        supplierCost,
        profit,
        marketplaceTourId: tour.id,
        currency: 'USD',
        originalCurrency: enteredCurrency !== 'USD' ? enteredCurrency : undefined,
        originalAmount: enteredCurrency !== 'USD' ? rawTotal : undefined,
        exchangeRate: fxRate ?? undefined,
        exchangeRateAt: fxRate ? new Date() : undefined,
        hotelName: tour.hotelName,
        hotelStars: tour.hotelStars,
        mealPlan: tour.mealPlan,
        includesVisa: tour.includesVisa,
        includesFlights: tour.includesFlights,
        includesHotel: tour.includesHotel,
        includesMeals: tour.includesMeals,
        includesTransfer: tour.includesTransfer,
        includesInsurance: tour.includesInsurance,
        status: safeEnum(data?.status, BOOKING_STATUSES, 'DRAFT'),
      },
    });

    // Bo'sh joylar sonini kamaytiramiz (agar hisoblanayotgan bo'lsa)
    if (tour.seatsAvailable !== null && tour.seatsAvailable !== undefined) {
      await this.prisma.marketplaceTour.update({
        where: { id: tour.id },
        data: { seatsAvailable: Math.max(0, tour.seatsAvailable - needSeats) },
      });
    }

    // ── Mijoz tarixiga yozamiz + statistikani qayta hisoblaymiz ──
    await this.clients.addTimeline(
      client.id, 'booking_created',
      `Booking yaratildi: ${booking.bookingRef}`,
      `${booking.tourName} • $${booking.totalPrice}`,
      { userId, bookingId: booking.id, source: 'marketplace' },
    ).catch(() => {});
    await this.clients.recalcStats(client.id).catch(() => {});

    // ── Agentga bildirishnoma (agar boshqa odam biriktirgan bo'lsa) ──
    const agentId = booking.agentId;
    if (agentId && agentId !== userId) {
      await this.notifications.create({
        tenantId,
        userId: agentId,
        type: 'BOOKING_CREATED',
        title: '✈️ Sizga yangi booking',
        body: `${client.fullName} — ${booking.tourName} • $${booking.totalPrice}`,
        link: `/bookings/${booking.id}`,
        metadata: { bookingId: booking.id, clientId: client.id, source: 'marketplace' },
      }).catch(() => {});
    }

    // ── Dashboardni real-time yangilash ──
    try {
      this.realtime.emitToTenant(tenantId, 'dashboard:update', {
        type: 'booking_created',
        bookingId: booking.id,
        agentId,
        totalPrice: booking.totalPrice,
        profit: booking.profit,
      });
    } catch {}

    // ── Audit log ──
    this.audit.log({
      tenantId, userId,
      action: 'CREATE', entity: 'booking', entityId: booking.id,
      metadata: {
        bookingRef: booking.bookingRef,
        source: 'marketplace',
        tourId: tour.id,
        operator: tour.operator?.name,
        totalPrice: booking.totalPrice,
        supplierCost: booking.supplierCost,
      },
    });

    // Hisobot raqamlari o'zgardi → cache tozalanadi
    void this.cache.invalidateReports(tenantId);

    this.logger.log(
      `Booking yaratildi [${tenantId}]: ${bookingRef} — ${tour.title} (${client.fullName})`,
    );

    return { success: true, message: `Booking yaratildi: ${bookingRef}`, booking };
  }
}

// ═══════════════════════════════════════════════════════════════
// CONTROLLER 1 — OPERATORLAR
// ═══════════════════════════════════════════════════════════════

@Controller('marketplace/operators')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MarketplaceOperatorsController {
  constructor(private service: MarketplaceService) {}

  /** Ro'yxat — barcha rollar ko'radi (parollar maskalangan) */
  @Get()
  list(@CurrentUser() user: any, @Query() query: any) {
    return this.service.listOperators(user.tenantId, query);
  }

  @Get(':id')
  get(@CurrentUser() user: any, @Param('id') id: string) {
    return this.service.getOperator(user.tenantId, id);
  }

  @Post()
  @Roles('TENANT_ADMIN')
  create(@CurrentUser() user: any, @Body() body: any) {
    return this.service.createOperator(user.tenantId, user.sub || user.id, body);
  }

  @Patch(':id')
  @Roles('TENANT_ADMIN')
  update(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    return this.service.updateOperator(user.tenantId, user.sub || user.id, id, body);
  }

  @Delete(':id')
  @Roles('TENANT_ADMIN')
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.service.deleteOperator(user.tenantId, user.sub || user.id, id);
  }

  /** body: { tours: [...], replaceAll?: boolean } */
  @Post(':id/import')
  @Roles('TENANT_ADMIN')
  import(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    return this.service.importTours(
      user.tenantId, user.sub || user.id, id, body?.tours, Boolean(body?.replaceAll),
    );
  }

  @Post(':id/sync')
  @Roles('TENANT_ADMIN')
  sync(@CurrentUser() user: any, @Param('id') id: string) {
    return this.service.syncOperator(user.tenantId, user.sub || user.id, id);
  }
}

// ═══════════════════════════════════════════════════════════════
// CONTROLLER 2 — TURLAR + BOOKING
// ═══════════════════════════════════════════════════════════════

@Controller('marketplace/tours')
@UseGuards(JwtAuthGuard)
export class MarketplaceToursController {
  constructor(private service: MarketplaceService) {}

  /**
   * ?search= &destination= &country= &tourType= &operatorId=
   * &priceMin= &priceMax= &dateFrom= &dateTo= &onlyAvailable=
   * &sort=price_asc|price_desc|date_asc &page= &limit=
   */
  @Get()
  list(@CurrentUser() user: any, @Query() query: any) {
    return this.service.listTours(user.tenantId, query);
  }

  /** MUHIM: 'filters' — ':id' dan OLDIN turishi shart */
  @Get('filters')
  filters(@CurrentUser() user: any) {
    return this.service.getFilters(user.tenantId);
  }

  @Get(':id')
  get(@CurrentUser() user: any, @Param('id') id: string) {
    return this.service.getTour(user.tenantId, id);
  }

  /**
   * To'g'ridan-to'g'ri booking yaratish.
   * body: { clientId, adults?, children?, infants?, totalPrice?, note?, status? }
   */
  @Post(':id/book')
  book(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    return this.service.bookTour(user.tenantId, user.sub || user.id, id, body);
  }
}

// ═══════════════════════════════════════════════════════════════
// MODULE
// ═══════════════════════════════════════════════════════════════

@Module({
  controllers: [MarketplaceOperatorsController, MarketplaceToursController],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}