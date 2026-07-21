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
import { Cron } from '@nestjs/schedule';
import {
  getCatalog,
  getCatalogOperator,
  CatalogOperator,
} from './operator-catalog';
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
import { TourAdapterRegistry } from '../tour-search/adapters/adapter-registry';
import { TourSearchModule } from '../tour-search/tour-search.module';

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
    // v13: Ratehawk kabi maxsus-adapterli operatorlar generic REST
    // oqimini aylanib o'tadi — pastga qarang: verifyCredentials/
    // connectCatalogOperator/syncOperator/autoSyncOperators.
    private adapters: TourAdapterRegistry,
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
  // KATALOG: ulanish (v12.4)
  // ═══════════════════════════════════════════════════════════
  //
  // Operator API manzillari SERVERDA (env) turadi — agentlik ularni
  // ko'rmaydi. Agentlik faqat O'Z login/parolini kiritadi.

  /** Katalogni shu tenantning ulanish holati bilan birga qaytaradi */
  async listCatalog(tenantId: string) {
    const catalog = getCatalog();

    const connected = await this.prisma.tourOperator.findMany({
      where: { tenantId, slug: { in: catalog.map((c) => c.slug) } },
      select: {
        id: true, slug: true, status: true, toursCount: true,
        lastSyncAt: true, lastSyncError: true, credLogin: true,
      },
    });

    const bySlug = new Map(connected.map((c: any) => [c.slug, c]));

    return {
      data: catalog.map((c) => {
        const conn: any = bySlug.get(c.slug);
        return {
          slug: c.slug,
          name: c.name,
          logoUrl: c.logoUrl,
          website: c.website,
          description: c.description,
          loginLabel: c.loginLabel,
          passwordLabel: c.passwordLabel,
          helpText: c.helpText,
          authType: c.authType,
          // env'da API manzili bormi
          configured: c.configured,
          // shu agentlik ulanganmi
          connected: Boolean(conn),
          operatorId: conn?.id || null,
          status: conn?.status || null,
          toursCount: conn?.toursCount || 0,
          lastSyncAt: conn?.lastSyncAt || null,
          lastSyncError: conn?.lastSyncError || null,
          // Parol EMAS — faqat login ko'rsatiladi (kim ulanganini bilish uchun)
          maskedLogin: conn?.credLogin ? '•••• ulangan' : null,
        };
      }),
    };
  }

  /**
   * Operator API'siga login/parolni tekshiradi.
   * Muvaffaqiyatli bo'lsa token yoki null (Basic/API-key uchun) qaytaradi.
   */
  private async verifyCredentials(
    op: CatalogOperator,
    login: string,
    password: string,
  ): Promise<{ ok: boolean; token?: string | null; error?: string }> {
    // ── v13: kod-adapterli operator (masalan Ratehawk) bo'lsa,
    // generic REST oqimini butunlay aylanib o'tamiz ──
    if (op.hasAdapter) {
      const adapter = this.adapters.get(op.slug);
      if (!adapter) {
        return {
          ok: false,
          error: `"${op.name}" adapteri topilmadi — TourAdapterRegistry'ga ro'yxatdan o'tkazilmagan`,
        };
      }
      const res = await adapter.verifyCredentials({ login, password });
      return { ok: res.ok, token: null, error: res.error };
    }

    if (!op.apiBaseUrl) {
      return {
        ok: false,
        error:
          `"${op.name}" hali sozlanmagan (API manzili yo'q). ` +
          `Platforma administratori .env dagi MARKETPLACE_OPERATORS_JSON ga qo'shishi kerak.`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      if (op.authType === 'login') {
        // POST {apiBaseUrl}{loginPath}  →  { token } | { access_token } | { data.token }
        const res = await fetch(`${op.apiBaseUrl}${op.loginPath || '/auth/login'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ login, username: login, email: login, password }),
          signal: controller.signal as any,
        });

        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: "Login yoki parol noto'g'ri" };
        }
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          return { ok: false, error: `Operator serveri xato qaytardi (HTTP ${res.status}): ${t.slice(0, 150)}` };
        }

        const j: any = await res.json().catch(() => ({}));
        const token =
          j?.token || j?.access_token || j?.accessToken ||
          j?.data?.token || j?.data?.access_token || null;

        if (!token) {
          return {
            ok: false,
            error:
              "Operator javobida token topilmadi. Integratsiya sozlamasi to'g'rilanishi kerak " +
              '(kutilgan: token | access_token | data.token).',
          };
        }
        return { ok: true, token };
      }

      // basic / apikey — turlar manzilini so'rab tekshiramiz
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (op.authType === 'basic') {
        headers.Authorization =
          'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
      } else {
        // apikey: kalit "password" maydonida keladi
        headers.Authorization = `Bearer ${password}`;
      }

      const res = await fetch(`${op.apiBaseUrl}${op.toursPath || '/tours'}`, {
        method: 'GET',
        headers,
        signal: controller.signal as any,
      });

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          error: op.authType === 'apikey' ? "API kalit noto'g'ri" : "Login yoki parol noto'g'ri",
        };
      }
      if (!res.ok) {
        return { ok: false, error: `Operator serveri xato qaytardi (HTTP ${res.status})` };
      }
      return { ok: true, token: null };
    } catch (e: any) {
      const msg = e?.name === 'AbortError'
        ? "Operator serveri javob bermadi (20 soniya)"
        : `Ulanib bo'lmadi: ${e?.message}`;
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Agentlikni operatorga ulaydi.
   *
   * Login/parol TEKSHIRILADI — noto'g'ri bo'lsa saqlanmaydi.
   * To'g'ri bo'lsa shifrlanib saqlanadi va turlar darhol yuklanadi.
   */
  async connectCatalogOperator(
    tenantId: string,
    userId: string,
    slug: string,
    body: { login?: string; password?: string },
  ) {
    const op = getCatalogOperator(slug);
    if (!op) throw new NotFoundException('Bunday operator katalogda yo\'q');

    const login = String(body?.login || '').trim();
    const password = String(body?.password || '').trim();

    // apikey rejimida faqat kalit kerak
    if (op.authType !== 'apikey' && !login) {
      throw new BadRequestException(`${op.loginLabel || 'Login'} kiriting`);
    }
    if (!password) {
      throw new BadRequestException(`${op.passwordLabel || 'Parol'} kiriting`);
    }

    // ── Haqiqiy tekshiruv ──
    const check = await this.verifyCredentials(op, login, password);
    if (!check.ok) {
      throw new BadRequestException(check.error || "Ulanib bo'lmadi");
    }

    // ── Saqlaymiz (shifrlangan) ──
    const existing = await this.prisma.tourOperator.findFirst({
      where: { tenantId, slug: op.slug },
    });

    const data: any = {
      name: op.name,
      slug: op.slug,
      logoUrl: op.logoUrl,
      website: op.website,
      description: op.description,
      integrationType: 'API',
      apiBaseUrl: op.apiBaseUrl,
      credLogin: login ? this.encryption.encrypt(login) : null,
      credPassword: this.encryption.encrypt(password),
      status: 'ACTIVE',
      lastSyncError: null,
    };

    const operator = existing
      ? await this.prisma.tourOperator.update({ where: { id: existing.id }, data })
      : await this.prisma.tourOperator.create({ data: { ...data, tenantId } });

    this.audit.log({
      tenantId, userId,
      action: existing ? 'UPDATE' : 'CREATE',
      entity: 'tour_operator', entityId: operator.id,
      // Parol QIYMATI yozilmaydi — faqat ulanish fakti
      metadata: { slug: op.slug, name: op.name, action: 'connect' },
    });

    // ── v13: adapter-backed (jonli qidiruv) operatorlar uchun statik
    // import YO'Q — narx/joy doim jonli so'raladi. "Sinxronizatsiya"
    // o'rniga to'g'ridan-to'g'ri /tour-search/search ishlatiladi. ──
    if (op.hasAdapter) {
      return {
        success: true,
        connected: true,
        message: `${op.name}: ulandingiz. Bu operator jonli qidiruv orqali ishlaydi — ` +
          `"Tur qidirish" bo'limida sana va yo'nalish kiritib qidiring.`,
        operatorId: operator.id,
        toursLoaded: 0,
        liveSearch: true,
      };
    }

    // ── Turlarni darhol yuklaymiz (faqat generic REST / statik katalog operatorlar) ──
    let sync: any = null;
    try {
      sync = await this.syncOperator(tenantId, userId, operator.id);
    } catch (e: any) {
      // Ulanish MUVAFFAQIYATLI, faqat turlar yuklanmadi —
      // buni alohida aytamiz, ulanishni bekor qilmaymiz
      this.logger.warn(`Ulandi, lekin turlar yuklanmadi [${op.name}]: ${e?.message}`);
      return {
        success: true,
        connected: true,
        message: `${op.name}: ulandingiz. Turlarni yuklashda muammo: ${e?.message}`,
        operatorId: operator.id,
        toursLoaded: 0,
      };
    }

    return {
      success: true,
      connected: true,
      message: `${op.name}: ulandingiz. ${sync?.created || 0} ta tur yuklandi.`,
      operatorId: operator.id,
      toursLoaded: (sync?.created || 0) + (sync?.updated || 0),
    };
  }

  /** Ulanishni uzadi — operator va uning turlari o'chadi */
  async disconnectCatalogOperator(tenantId: string, userId: string, slug: string) {
    const existing = await this.prisma.tourOperator.findFirst({
      where: { tenantId, slug: String(slug || '').toLowerCase() },
    });
    if (!existing) throw new NotFoundException('Bu operatorga ulanmagansiz');

    await this.prisma.tourOperator.delete({ where: { id: existing.id } });

    this.audit.log({
      tenantId, userId,
      action: 'DELETE', entity: 'tour_operator', entityId: existing.id,
      metadata: { slug, name: existing.name, action: 'disconnect' },
    });

    return { success: true, message: `${existing.name}: ulanish uzildi` };
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

    const cat0 = getCatalogOperator(op.slug);
    if (cat0?.hasAdapter) {
      throw new BadRequestException(
        `${op.name}: bu operator jonli qidiruv orqali ishlaydi, statik sinxronizatsiya yo'q. ` +
        `"Tur qidirish" bo'limidan foydalaning.`,
      );
    }

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

    // Katalogdan integratsiya qoidalarini olamiz (authType, yo'llar).
    // Katalogda bo'lmasa — eski, qo'lda qo'shilgan operator: umumiy
    // usulda ishlaymiz (orqaga moslik).
    const cat = getCatalogOperator(op.slug);

    const headers: Record<string, string> = { Accept: 'application/json' };
    let toursUrl = op.apiBaseUrl;

    if (cat?.apiBaseUrl) {
      toursUrl = `${cat.apiBaseUrl}${cat.toursPath || '/tours'}`;
    }

    if (cat?.authType === 'login' && login && password) {
      // Avval token olamiz, keyin turlarni so'raymiz
      const auth = await this.verifyCredentials(cat, login, password);
      if (!auth.ok) {
        // Parol o'zgargan bo'lishi mumkin — buni aniq aytamiz
        await this.prisma.tourOperator.update({
          where: { id: operatorId },
          data: { status: 'ERROR', lastSyncError: auth.error, lastSyncAt: new Date() },
        });
        throw new BadRequestException(
          `${op.name}: ${auth.error}. Sozlamalar → Tur operatorlar bo'limida qayta ulaning.`,
        );
      }
      if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
    } else if (cat?.authType === 'apikey') {
      headers['Authorization'] = `Bearer ${password || apiKey}`;
    } else if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (login && password) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(toursUrl, {
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
  // AVTOMATIK YANGILASH (v12.3)
  // ═══════════════════════════════════════════════════════════

  /**
   * Har kuni tunda API rejimidagi operatorlarning turlarini yangilaydi.
   *
   * Faqat integrationType = 'API' va status = 'ACTIVE' operatorlar.
   * CSV/MANUAL operatorlarga tegilmaydi — ular qo'lda yuklanadi.
   *
   * Bitta operator xato bersa qolganlari davom etadi (xato o'sha
   * operatorning lastSyncError maydoniga yoziladi va admin ko'radi).
   */
  @Cron('0 3 * * *') // har kuni 03:00
  async autoSyncOperators() {
    // v13: adapter-backed (Ratehawk kabi jonli qidiruv) slug'larni
    // bu yerda o'tkazib yuboramiz — ularda statik "barcha turlar"
    // tushunchasi yo'q, shuning uchun kunlik sync ma'nosiz va xato beradi.
    const liveSearchSlugs = this.adapters.registeredSlugs;

    const operators = await this.prisma.tourOperator.findMany({
      where: {
        integrationType: 'API',
        status: 'ACTIVE',
        ...(liveSearchSlugs.length ? { slug: { notIn: liveSearchSlugs } } : {}),
      },
      select: { id: true, tenantId: true, name: true },
    }).catch(() => [] as any[]);

    if (!operators.length) return;
    this.logger.log(`Avtomatik sinxronizatsiya: ${operators.length} ta operator`);

    let ok = 0;
    let failed = 0;

    for (const op of operators) {
      try {
        // userId = 'system' — audit logda kim ishga tushirgani ko'rinadi
        await this.syncOperator(op.tenantId, 'system', op.id);
        ok++;
      } catch (e: any) {
        failed++;
        this.logger.warn(`Avto-sinx xato [${op.name}]: ${e?.message}`);
      }
      // Operator serverlarini bosmaslik uchun kichik tanaffus
      await new Promise((r) => setTimeout(r, 1500));
    }

    this.logger.log(`Avtomatik sinxronizatsiya tugadi: ${ok} muvaffaqiyatli, ${failed} xato`);
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

    // Bo'sh joy (chaqaloqlar joy egallamaydi deb hisoblaymiz).
    // Bu yerda faqat ERTA xabar beramiz; haqiqiy kafolat quyida —
    // atomik rezervatsiyada (poygadan himoya).
    const needSeats = adults + children;
    if (
      tour.seatsAvailable !== null &&
      tour.seatsAvailable !== undefined &&
      tour.seatsAvailable < needSeats
    ) {
      throw new BadRequestException(
        `Bo'sh joy yetarli emas. Mavjud: ${tour.seatsAvailable}, kerak: ${needSeats}`,
      );
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

    // ═══ ATOMIK REZERVATSIYA (poygadan himoya) ═══
    // Ikki agent bir vaqtda oxirgi joyni bron qilsa, oddiy "o'qi-keyin-yoz"
    // usulida IKKALASI ham o'tib ketardi. Bu yerda shart bitta SQL
    // UPDATE ichida tekshiriladi: joy yetmasa count = 0 qaytadi va
    // hech narsa o'zgarmaydi.
    let seatsReserved = false;
    if (tour.seatsAvailable !== null && tour.seatsAvailable !== undefined) {
      const reserve = await this.prisma.marketplaceTour.updateMany({
        where: { id: tour.id, seatsAvailable: { gte: needSeats } },
        data: { seatsAvailable: { decrement: needSeats } },
      });
      if (!reserve?.count) {
        throw new BadRequestException(
          "Kechirasiz, bu turdagi joylar hozirgina band bo'lib ketdi. " +
          'Sahifani yangilab, qayta urinib ko\'ring.',
        );
      }
      seatsReserved = true;
    }

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

    let booking: any;
    try {
      booking = await this._prisma.booking.create({
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
    } catch (e) {
      // Booking yaratilmadi — band qilingan joylarni QAYTARAMIZ,
      // aks holda joylar "yo'qolib" qolardi.
      if (seatsReserved) {
        await this.prisma.marketplaceTour.updateMany({
          where: { id: tour.id },
          data: { seatsAvailable: { increment: needSeats } },
        }).catch(() => {});
      }
      throw e;
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
// CONTROLLER 3 — KATALOG (Sozlamalar → Tur operatorlar)
// ═══════════════════════════════════════════════════════════════
//
// Faqat TENANT_ADMIN. Agentlar bu bo'limni umuman ko'rmaydi —
// ular tayyor turlar bilan ishlaydi.

@Controller('marketplace/catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TENANT_ADMIN')
export class MarketplaceCatalogController {
  constructor(private service: MarketplaceService) {}

  /** Katalogdagi barcha operatorlar + ulanish holati */
  @Get()
  list(@CurrentUser() user: any) {
    return this.service.listCatalog(user.tenantId);
  }

  /**
   * Operatorga ulanish.
   * body: { login, password }
   *
   * Ma'lumotlar operator API'sida TEKSHIRILADI — noto'g'ri bo'lsa
   * saqlanmaydi va tushunarli xato qaytadi.
   */
  @Post(':slug/connect')
  connect(
    @CurrentUser() user: any,
    @Param('slug') slug: string,
    @Body() body: any,
  ) {
    return this.service.connectCatalogOperator(
      user.tenantId, user.sub || user.id, slug, body,
    );
  }

  /** Ulanishni uzish — operator va uning turlari o'chadi */
  @Post(':slug/disconnect')
  disconnect(@CurrentUser() user: any, @Param('slug') slug: string) {
    return this.service.disconnectCatalogOperator(
      user.tenantId, user.sub || user.id, slug,
    );
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
  imports: [TourSearchModule], // TourAdapterRegistry shu yerdan keladi (v13)
  controllers: [
    MarketplaceOperatorsController,
    MarketplaceToursController,
    MarketplaceCatalogController,
  ],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}