import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { ClientStatus, ClientTier, LeadSource, Language, PipelineStage } from '../../prisma-types';;
import {
  safeEnum,
  paginate,
  meta,
  calculateLeadScore,
  clean,
  pickNextAgent,
  normalizePhone,
} from '../../common/utils/helpers';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { RoundRobinService } from '../v9/round-robin.module';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { CacheService } from '../../common/cache/cache.service';
import { PipelineService } from '../pipeline/pipeline.module';

const CLIENT_STATUSES: ClientStatus[] = ['ACTIVE', 'INACTIVE', 'BLACKLISTED'];
const TIERS: ClientTier[] = ['REGULAR', 'SILVER', 'GOLD', 'VIP'];
const SOURCES: LeadSource[] = [
  'TELEGRAM', 'INSTAGRAM', 'WHATSAPP', 'REFERRAL',
  'WALKIN', 'WEBSITE', 'CALL', 'FACEBOOK', 'GOOGLE_ADS', 'OTHER',
];
const LANGUAGES: Language[] = ['UZ', 'RU', 'EN'];

// ─── v33: Bulk import (Excel/CSV) — eski tizimdan ko'chirilgan leadlar ───────
// Turfirma CRM'ni o'rnatganda odatda 1000-2000+ eski lead bo'ladi — hammasi
// alohida mijoz sifatida import qilinishi va OLDINGI turgan bosqichi (stage)
// saqlanib qolishi kerak. Fayldagi ustun nomlari turlicha bo'lishi mumkin
// (o'zbekcha/ruscha/inglizcha) — shuning uchun sinonimlar lug'ati orqali
// moslashtiriladi.
const IMPORT_HEADER_ALIASES: Record<string, string[]> = {
  fullName: ["to'liq ism", 'toliq ism', 'ism', 'f.i.o', 'fio', 'name', 'full name', 'client', 'имя', 'фио', 'клиент', 'mijoz', 'mijoz ismi'],
  phone: ['telefon', 'telefon raqami', 'tel', 'raqam', 'phone', 'phone number', 'телефон', 'номер'],
  phone2: ['telefon2', "qo'shimcha telefon", 'qoshimcha telefon', 'phone2', 'телефон2'],
  email: ['email', 'e-mail', 'почта'],
  source: ['manba', 'source', 'источник'],
  stage: ['bosqich', 'stage', 'status', 'holat', 'стадия', 'статус', 'этап'],
  notes: ['izoh', 'izohlar', 'note', 'notes', 'comment', 'комментарий', 'примечание'],
  city: ['shahar', 'city', 'город'],
  country: ['davlat', 'country', 'страна'],
  destination: ["yo'nalish", 'yonalish', 'destination', 'направление'],
  budget: ['byudjet', 'budget', 'бюджет'],
  tags: ['teglar', 'tags', 'метки', 'tegi'],
  agent: ['agent', 'menejer', 'менеджер', 'manager', "mas'ul"],
};

const IMPORT_STAGE_ALIASES: Record<string, string> = {
  'yangi lid': 'NEW_LEAD',
  'yangi': 'NEW_LEAD',
  'aloqa ornatildi': 'CONTACTED',
  'aloqa qilindi': 'CONTACTED',
  'aloqa ornatilmadi': 'INTERESTED',
  'qiziqdi': 'INTERESTED',
  'taklif yuborildi': 'OFFER_SENT',
  'taklif': 'OFFER_SENT',
  'qayta aloqa': 'NEGOTIATION',
  'muzokara': 'NEGOTIATION',
  'offisga chaqirildi': 'DEPOSIT_PAID',
  'keldi': 'CONFIRMED',
  'tasdiqlandi': 'CONFIRMED',
  'kelmadi': 'TRAVELING',
  'sayohatda': 'TRAVELING',
  'avans tolandi': 'DEPOSIT_PAID',
  'avans': 'DEPOSIT_PAID',
  'tolandi': 'COMPLETED',
  "to'liq tolandi": 'COMPLETED',
  'yakunlandi': 'COMPLETED',
  "yoqotildi": 'LOST',
  'bekor qilindi': 'LOST',
  'sayohatga ketuvchilar': 'CONFIRMED',
  'sayohatdagilar': 'TRAVELING',
  'sayohatdan qaytganlar': 'COMPLETED',
};

const IMPORT_SOURCE_ALIASES: Record<string, string> = {
  'telegram': 'TELEGRAM',
  'instagram': 'INSTAGRAM',
  'insta': 'INSTAGRAM',
  'whatsapp': 'WHATSAPP',
  'vatsap': 'WHATSAPP',
  'tavsiya': 'REFERRAL',
  'referral': 'REFERRAL',
  "do'stdan": 'REFERRAL',
  'ofisga keldi': 'WALKIN',
  'ofis': 'WALKIN',
  'walkin': 'WALKIN',
  'sayt': 'WEBSITE',
  'website': 'WEBSITE',
  'veb sayt': 'WEBSITE',
  "qo'ngiroq": 'CALL',
  'qongiroq': 'CALL',
  'call': 'CALL',
  'facebook': 'FACEBOOK',
  'fb': 'FACEBOOK',
  'google': 'GOOGLE_ADS',
  'google ads': 'GOOGLE_ADS',
};

@Injectable()
export class ClientsService {
  private readonly logger = new Logger('Clients');
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private notifications: NotificationsService,
    private encryption: EncryptionService,
    private cache: CacheService,
    @Optional() private roundRobin: RoundRobinService,
    @Optional() private pipeline?: PipelineService,
  ) {}

  /** Pasport va manzilni dekript qilib qaytaradi */
  private decryptClient(client: any): any {
    if (!client) return client;
    return {
      ...client,
      passportNo: client.passportNo ? this.encryption.decrypt(client.passportNo) || client.passportNo : null,
      passportMasked: client.passportNo ? this.encryption.mask(this.encryption.decrypt(client.passportNo) || '') : null,
      address: client.address ? this.encryption.decrypt(client.address) || client.address : null,
    };
  }

  private encryptClientData(data: any): any {
    const out = { ...data };
    if (data.passportNo) out.passportNo = this.encryption.encrypt(data.passportNo);
    if (data.address) out.address = this.encryption.encrypt(data.address);
    return out;
  }

  private where(
    tenantId: string,
    userId: string,
    role: string,
    extra: any = {},
  ): any {
    const base: any = { tenantId, ...extra };
    if (role === 'AGENT') base.assignedAgentId = userId;
    return base;
  }

  async findAll(
    tenantId: string,
    userId: string,
    role: string,
    params: {
      search?: string;
      status?: string;
      tier?: string;
      source?: string;
      stage?: string;
      agentId?: string;
      tag?: string;
      sortBy?: 'recent' | 'name' | 'revenue' | 'score';
      page?: any;
      limit?: any;
    },
  ) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where = this.where(tenantId, userId, role);

    if (params.status && CLIENT_STATUSES.includes(params.status as ClientStatus)) {
      where.status = params.status as ClientStatus;
    }
    if (params.tier && TIERS.includes(params.tier as ClientTier)) {
      where.tier = params.tier as ClientTier;
    }
    if (params.source && SOURCES.includes(params.source as LeadSource)) {
      where.source = params.source as LeadSource;
    }
    if (params.stage) {
      where.pipelineStage = params.stage as PipelineStage;
    } else {
      // Yo'qotilgan (LOST) klientlar asosiy Klientlar dashboardida ko'rinmaydi —
      // ular chalg'itadi va ular bilan hozircha ish yuritilmaydi.
      // Faqat foydalanuvchi maxsus "Yo'qotildi" bosqichini tanlasa ko'rsatiladi.
      where.pipelineStage = { not: 'LOST' as PipelineStage };
    }
    if (params.agentId && role !== 'AGENT') where.assignedAgentId = params.agentId;
    if (params.tag) where.tags = { has: params.tag };

    if (params.search?.trim()) {
      const s = params.search.trim();
      where.OR = [
        { fullName: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s } },
        { email: { contains: s, mode: 'insensitive' } },
        { passportNo: { contains: s } },
        { telegramUsername: { contains: s, mode: 'insensitive' } },
      ];
    }

    // TUZATILDI: ilgari birinchi navbatda `lastContactAt` bo'yicha saralanardi.
    // Yangi lead'larda (hali hech kim bilan bog'lanilmagan) bu maydon har doim
    // bo'sh (null) bo'ladi, va "nulls: last" tufayli ular — qanchalik yangi
    // bo'lishidan qat'iy nazar — doim ro'yxat OXIRIGA tushib qolardi.
    // Endi birinchi navbatda `createdAt` (yaratilgan vaqt) bo'yicha saralanadi,
    // shuning uchun yangi kelgan lead (masalan Facebook'dan) ro'yxat BOSHIDA
    // chiqadi. `lastContactAt` ikkinchi mezon sifatida saqlanadi (bir xil
    // vaqtda yaratilgan yozuvlar orasida tartib berish uchun).
    let orderBy: any = [
      { createdAt: 'desc' },
      { lastContactAt: { sort: 'desc', nulls: 'last' } },
    ];
    if (params.sortBy === 'name') orderBy = { fullName: 'asc' };
    else if (params.sortBy === 'revenue') orderBy = { totalRevenue: 'desc' };
    else if (params.sortBy === 'score') orderBy = { leadScore: 'desc' };

    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        skip,
        take,
        include: {
          assignedAgent: { select: { id: true, name: true, avatarUrl: true } },
          customStage: { select: { id: true, name: true, color: true } },
          _count: { select: { bookings: true } },
        },
        orderBy,
      }),
      this.prisma.client.count({ where }),
    ]);
    return { data, meta: meta(total, page, limit) };
  }

  // ── v12: YO'QOTILGAN LEADLAR (umumiy hovuz) ──────────────────────────
  // Barcha agentlar KO'RADI (agentId bo'yicha BO'LINMAYDI) — istalgan agent
  // yo'qotilgan lead bilan qayta bog'lanishi mumkin.
  async lostLeads(
    tenantId: string,
    params: { search?: string; page?: any; limit?: any } = {},
  ) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where: any = { tenantId, pipelineStage: 'LOST' as PipelineStage };
    if (params.search?.trim()) {
      where.OR = [
        { fullName: { contains: params.search, mode: 'insensitive' } },
        { phone: { contains: params.search } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        skip,
        take,
        orderBy: { pipelineStageAt: 'desc' },
        include: {
          assignedAgent: { select: { id: true, name: true } },
          customStage: { select: { id: true, name: true, color: true } },
          _count: { select: { bookings: true } },
        },
      }),
      this.prisma.client.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(tenantId: string, id: string, userId: string, role: string) {
    // v12: Agent o'z klientini ko'radi; QO'SHIMCHA — YO'QOTILGAN (LOST) leadni
    // ham ko'radi (umumiy hovuz — hamma agent qayta bog'lanishi mumkin).
    const where: any = role === 'AGENT'
      ? { tenantId, id, OR: [{ assignedAgentId: userId }, { pipelineStage: 'LOST' as PipelineStage }] }
      : { tenantId, id };
    const client = await this.prisma.client.findFirst({
      where,
      include: {
        assignedAgent: { select: { id: true, name: true, avatarUrl: true } },
        bookings: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            agent: { select: { id: true, name: true } },
          },
        },
        payments: { orderBy: { paidAt: 'desc' }, take: 10 },
        timeline: { orderBy: { createdAt: 'desc' }, take: 30 },
        followUps: {
          where: { done: false },
          orderBy: { dueAt: 'asc' },
          take: 10,
        },
        documents: { orderBy: { createdAt: 'desc' }, take: 20 },
        _count: {
          select: {
            bookings: true,
            payments: true,
            documents: true,
            calls: true,
            followUps: true,
          },
        },
      },
    });
    if (!client) throw new NotFoundException('Klient topilmadi');
    return this.decryptClient(client);
  }

  async create(tenantId: string, userId: string, data: any) {
    // v9-SECURITY: Phone is OPTIONAL for Telegram/Web leads
    // Required: fullName only
    // Phone is required ONLY for direct booking sources
    
    if (!data.fullName?.trim()) {
      throw new BadRequestException('To\'liq ism majburiy');
    }

    const fullName = String(data.fullName).trim();
    
    // v9-SECURITY: Validate phone format if provided
    let phone = null;
    if (data.phone?.trim()) {
      const entered = String(data.phone).trim();
      // Basic phone validation: at least 5 chars, alphanumeric + symbols
      if (!entered.match(/^[0-9\+\-\(\) ]{5,20}$/)) {
        throw new BadRequestException('Telefon raqam noto\'g\'ri formatda');
      }
      // v12.3: yagona formatga keltiramiz (+998901234567).
      // Shunda "90 123 45 67" va "+998901234567" BIR XIL mijoz bo'ladi
      // va bazada dublikat yig'ilmaydi.
      phone = normalizePhone(entered) || entered;
    }

    // Check duplicate phone ONLY if phone is provided
    if (phone) {
      const dup = await this.prisma.client.findFirst({
        where: { tenantId, phone },
        include: { assignedAgent: { select: { name: true } } },
      });
      if (dup) {
        await this.addTimeline(
          dup.id,
          'duplicate_attempt',
          'Yana lead keldi (duplikat)',
          data.note,
          { source: data.source },
        );
        // Qaysi agentning mijozi ekanini ko'rsatamiz — shunda yangi
        // mijoz yaratmoqchi bo'lgan xodim bu raqam kimning bazasida
        // borligini darhol biladi (agentga tayinlanmagan bo'lsa —
        // shunchaki mijoz nomi bilan xabar beriladi).
        const ownerName = dup.assignedAgent?.name;
        const message = ownerName
          ? `Bu telefon raqam allaqachon mavjud — "${dup.fullName}" nomi bilan ${ownerName} agentning mijozlar ro'yxatida bor`
          : `Bu telefon raqam allaqachon mavjud — "${dup.fullName}" nomi bilan mijozlar ro'yxatida bor`;
        throw new BadRequestException(message);
      }
    }

    // Round-Robin: AVTOMATIK agent tayinlash (strategiya tekshirib)
    let assignedAgentId: string | null = data.assignedAgentId || null;
    if (!assignedAgentId) {
      // Strategiyani tekshir
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { leadAssignmentStrategy: true },
      });
      const strategy = tenant?.leadAssignmentStrategy || 'ROUND_ROBIN';
      if (strategy !== 'MANUAL') {
        if (this.roundRobin) {
          assignedAgentId = await this.roundRobin.getNextAgent(tenantId);
        } else {
          assignedAgentId = await pickNextAgent(this.prisma, tenantId);
        }
        if (assignedAgentId) {
          this.logger.log(`[ROUND ROBIN] Lead → Agent: ${assignedAgentId} | Tenant: ${tenantId}`);
        }
      } else {
        this.logger.log(`[CLIENTS] MANUAL strategiya — agent tayinlanmadi | Tenant: ${tenantId}`);
      }
    }

    const score = calculateLeadScore({
      source: data.source,
      tier: data.tier,
      email: data.email,
      passportNo: data.passportNo,
    });

    // v34 FIX: yangi lead tenantning ANIQLANGAN default (kirish) pipelinesining
    // BIRINCHI bosqichiga to'g'ridan-to'g'ri bog'lanadi (customStageId orqali).
    // Ilgari bu qilinmas edi — lead pipelineStage='NEW_LEAD' bilan "osilib"
    // qolar, agentlik voronkani o'ziga moslab qayta nomlaganda esa hech qaysi
    // ustunda ko'rinmas edi. Endi nomlar/bosqichlar qanday o'zgarsa ham, lead
    // har doim ANIQ birinchi ustunga tushadi.
    let entryStageId: string | null = null;
    try {
      if (this.pipeline) {
        const entry = await this.pipeline.getEntryStage(tenantId);
        entryStageId = entry.stageId;
      }
    } catch (e) {
      this.logger.warn(`[CLIENTS] Pipeline entry-stage aniqlanmadi: ${e}`);
    }

    // v9-SECURITY: Sanitize all string inputs
    const client = await this.prisma.client.create({
      data: {
        tenantId,
        fullName: fullName, // Already sanitized
        customStageId: entryStageId,
        phone: phone || null, // ✅ OPTIONAL: Can be null for Telegram/Web
        phone2: data.phone2?.trim() || null,
        email: data.email?.trim().toLowerCase() || null,
        passportNo: data.passportNo ? this.encryption.encrypt(data.passportNo) : undefined,
        passportExpiry: data.passportExpiry ? new Date(data.passportExpiry) : undefined,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        nationality: data.nationality?.trim() || null,
        country: data.country?.trim() || null,
        gender: data.gender,
        address: data.address ? this.encryption.encrypt(data.address.trim()) : undefined,
        city: data.city?.trim() || null,
        language: safeEnum(data.language, LANGUAGES, 'UZ'),
        source: safeEnum(data.source, SOURCES, 'OTHER'),
        tier: safeEnum(data.tier, TIERS, 'REGULAR'),
        sourceCampaign: data.sourceCampaign?.trim() || null,
        utmSource: data.utmSource?.trim() || null,
        utmMedium: data.utmMedium?.trim() || null,
        utmCampaign: data.utmCampaign?.trim() || null,
        utmTerm: data.utmTerm?.trim() || null,
        utmContent: data.utmContent?.trim() || null,
        referrerUrl: data.referrerUrl?.trim() || null,
        notes: data.notes?.trim() || null,
        tags: Array.isArray(data.tags) ? data.tags.filter((t: any) => t?.trim()) : [],
        assignedAgentId: assignedAgentId,
        telegramId: data.telegramId || null,
        telegramUsername: data.telegramUsername?.trim() || null,
        instagramHandle: data.instagramHandle?.trim() || null,
        familyMembers: data.familyMembers || [],
        preferences: data.preferences || {},
        leadScore: score,
        firstContactAt: new Date(),
        lastContactAt: new Date(),
      },
    });

    await this.addTimeline(client.id, 'created', 'Klient yaratildi', undefined, {
      userId,
      source: client.source,
    });

    // BUG2 FIX: lead.created event emit
    try {
      this.eventEmitter.emit('lead.created', {
        tenantId: client.tenantId,
        clientId: client.id,
        assignedAgentId: client.assignedAgentId,
      });
    } catch {}

    // Notify assigned agent
    if (client.assignedAgentId && client.assignedAgentId !== userId) {
      await this.notifications.create({
        tenantId,
        userId: client.assignedAgentId,
        type: 'LEAD_ASSIGNED',
        title: '🔥 Yangi klient sizga tayinlandi',
        body: `${client.fullName} • ${client.phone}`,
        link: `/clients/${client.id}`,
        metadata: { clientId: client.id },
      });
    }

    // Yangi klient lead/konversiya hisobotlariga ta'sir qiladi → cache tozalanadi.
    void this.cache.invalidateReports(tenantId);

    return client;
  }

  // ─── v33: Bulk import (Excel/CSV) ──────────────────────────────────────────

  /** Matnni solishtirish uchun normallashtiradi: kichik harf, apostroflarsiz, bo'sh joylar yig'ilgan */
  private importNormText(s: any): string {
    return String(s ?? '')
      .trim()
      .toLowerCase()
      .replace(/['`ʼ’‘]/g, '')
      .replace(/\s+/g, ' ');
  }

  /** ExcelJS katak qiymatini oddiy matnga aylantiradi (rich text, formula, sana va h.k.) */
  private importCellText(v: any): string {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
      if (Array.isArray((v as any).richText)) {
        return (v as any).richText.map((t: any) => t.text).join('');
      }
      if ((v as any).text !== undefined) return String((v as any).text);
      if ((v as any).result !== undefined) return String((v as any).result);
      return '';
    }
    return String(v);
  }

  /** Sarlavha qatoridan ustun indekslarini sinonimlar lug'ati orqali topadi */
  private importMatchColumns(headers: string[]): Record<string, number> {
    const map: Record<string, number> = {};
    const normHeaders = headers.map((h) => this.importNormText(h));
    for (const [field, aliases] of Object.entries(IMPORT_HEADER_ALIASES)) {
      const normAliases = aliases.map((a) => this.importNormText(a));
      let foundIdx = normHeaders.findIndex((h) => h && normAliases.includes(h));
      if (foundIdx === -1) {
        foundIdx = normHeaders.findIndex((h) => h && normAliases.some((a) => h.includes(a)));
      }
      if (foundIdx !== -1) map[field] = foundIdx;
    }
    return map;
  }

  private importResolveSource(raw: string): LeadSource {
    const norm = this.importNormText(raw);
    if (!norm) return 'OTHER';
    const upper = raw.trim().toUpperCase();
    if ((SOURCES as string[]).includes(upper)) return upper as LeadSource;
    return (IMPORT_SOURCE_ALIASES[norm] as LeadSource) || 'OTHER';
  }

  /**
   * Faylda ko'rsatilgan bosqich (stage) matnini topadi:
   * 1) enum kaliti (masalan "CONTACTED")
   * 2) standart o'zbekcha nomlar lug'ati
   * 3) tenant'ning mavjud CustomStage'lari (nomi bo'yicha)
   * Topilmasa chaqiruvchi tomon yangi CustomStage yaratadi (createMissingStages).
   */
  /**
   * MUHIM: bu funksiya faqat haqiqiy PipelineStage ENUM qiymatlarini
   * qaytaradi (yoki topilmasa — null). Client.pipelineStage bazada
   * qat'iy enum (10 ta fixed qiymat) — "CUSTOM_<id>" kabi ixtiyoriy
   * satr yozilsa Prisma PrismaClientValidationError beradi va
   * frontendda umumiy "Ma'lumot formati noto'g'ri" xatosi chiqadi.
   * Shu sabab bu yerda CustomStage'larga umuman murojaat qilinmaydi.
   */
  private importResolveKnownStage(raw: string): string | null {
    const norm = this.importNormText(raw);
    if (!norm) return 'NEW_LEAD';

    const upper = raw.trim().toUpperCase().replace(/\s+/g, '_');
    const ENUM_VALUES = [
      'NEW_LEAD', 'CONTACTED', 'INTERESTED', 'OFFER_SENT', 'NEGOTIATION',
      'DEPOSIT_PAID', 'CONFIRMED', 'TRAVELING', 'COMPLETED', 'LOST',
    ];
    if (ENUM_VALUES.includes(upper)) return upper;
    if (IMPORT_STAGE_ALIASES[norm]) return IMPORT_STAGE_ALIASES[norm];
    return null; // topilmadi — NEW_LEAD'ga tushadi, asl nomi notes'ga yoziladi
  }

  /**
   * Excel (.xlsx) yoki CSV fayldan lead'larni o'qib, har birini ALOHIDA
   * mijoz sifatida yaratadi. Har bir lead o'zining oldingi bosqichida
   * (stage) qoladi — fayldagi bosqich nomi mos kelmasa, tenant pipeline'iga
   * yangi bosqich sifatida qo'shiladi (hech qanday tarixiy ma'lumot
   * yo'qolmaydi). Faqat ADMIN/MANAGER chaqira oladi (controller darajasida
   * cheklangan) — bu ommaviy operatsiya.
   */
  async importLeads(tenantId: string, userId: string, file: any) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Fayl bo\'sh yoki yuklanmadi');
    }
    const MAX_ROWS = 10000;
    const ext = (file.originalname || '').split('.').pop()?.toLowerCase();

    // 1) Faylni o'qish (.xlsx yoki .csv)
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    let sheet: any;
    try {
      if (ext === 'csv' || file.mimetype === 'text/csv') {
        const { Readable } = await import('stream');
        sheet = await wb.csv.read(Readable.from(file.buffer));
      } else {
        await wb.xlsx.load(file.buffer);
        sheet = wb.worksheets[0];
      }
    } catch (e) {
      throw new BadRequestException('Faylni o\'qib bo\'lmadi — .xlsx yoki .csv formatida ekanini tekshiring');
    }
    if (!sheet) throw new BadRequestException('Faylda varaq topilmadi');

    const rawRows: string[][] = [];
    sheet.eachRow((row: any) => {
      const vals = (row.values as any[]).slice(1).map((v) => this.importCellText(v));
      rawRows.push(vals);
    });
    if (rawRows.length < 2) {
      throw new BadRequestException('Faylda ma\'lumot topilmadi (sarlavha qatori + kamida 1 ta lead kerak)');
    }
    if (rawRows.length - 1 > MAX_ROWS) {
      throw new BadRequestException(`Bir martada maksimal ${MAX_ROWS} qator import qilish mumkin — faylni bo'lib yuklang`);
    }

    const colMap = this.importMatchColumns(rawRows[0]);
    if (colMap.fullName === undefined) {
      throw new BadRequestException(
        'Fayldan "Ism" (F.I.O / Name) ustuni topilmadi. Birinchi qator ustun sarlavhalari bo\'lishi kerak.',
      );
    }
    const dataRows = rawRows.slice(1).filter((r) => r.some((c) => c && c.trim()));

    // 2) Kerakli ma'lumotlarni oldindan yuklab olamiz (har qatorda so'rov yubormaslik uchun)
    //    ESLATMA (v33.2): Client.pipelineStage bazada qat'iy ENUM (10 ta fixed
    //    qiymat) — unga "CUSTOM_<id>" kabi ixtiyoriy satr yozib bo'lmaydi
    //    (Prisma validatsiya xatosi berardi — shu bug import doim
    //    "Ma'lumot formati noto'g'ri" bilan tugashiga sabab bo'lgan edi).
    //    Endi buning uchun alohida customStageId ustuni bor: fayldagi
    //    noma'lum bosqich nomi tenant pipeline'ida yangi CustomStage
    //    sifatida yaratiladi va mijozga customStageId orqali bog'lanadi;
    //    pipelineStage esa hisobot/filtr moslligi uchun NEW_LEAD'da qoladi.
    const [existingStages, tenantUsers, lastStage] = await Promise.all([
      this.prisma.customStage.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { tenantId }, select: { id: true, name: true, email: true } }),
      this.prisma.customStage.findFirst({
        where: { tenantId },
        orderBy: { order: 'desc' },
        select: { order: true, pipelineId: true },
      }),
    ]);
    const existingStagesByName = new Map<string, string>(); // normText -> CustomStage.id
    for (const s of existingStages) {
      existingStagesByName.set(this.importNormText(s.name), s.id);
    }
    const usersByKey = new Map<string, string>();
    for (const u of tenantUsers) {
      usersByKey.set(this.importNormText(u.email), u.id);
      usersByKey.set(this.importNormText(u.name), u.id);
    }

    // 3) Fayldagi noma'lum bosqich nomlarini yig'ib, tenant pipeline'iga
    //    bitta martada (createMany) yangi CustomStage sifatida qo'shamiz.
    const unknownStageNames = new Map<string, string>(); // normText -> original raw
    if (colMap.stage !== undefined) {
      for (const row of dataRows) {
        const raw = (row[colMap.stage] || '').trim();
        if (!raw) continue;
        const norm = this.importNormText(raw);
        if (
          this.importResolveKnownStage(raw) === null &&
          !existingStagesByName.has(norm) &&
          !unknownStageNames.has(norm)
        ) {
          unknownStageNames.set(norm, raw);
        }
      }
    }
    if (unknownStageNames.size > 0) {
      let pipelineId = lastStage?.pipelineId;
      if (!pipelineId) {
        const pl = await this.prisma.pipeline.findFirst({
          where: { tenantId },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: { id: true },
        });
        pipelineId = pl?.id;
      }
      if (pipelineId) {
        let order = (lastStage?.order ?? 0) + 1;
        const toCreateStages = Array.from(unknownStageNames.entries()).map(([norm, raw]) => ({
          tenantId,
          pipelineId: pipelineId as string,
          name: raw,
          color: '#94a3b8', // import orqali qo'shilgan bosqichlar — neytral rang
          order: order++,
        }));
        await this.prisma.customStage.createMany({ data: toCreateStages });
        const created = await this.prisma.customStage.findMany({
          where: { tenantId, pipelineId, name: { in: toCreateStages.map((t) => t.name) } },
          select: { id: true, name: true },
        });
        for (const s of created) {
          existingStagesByName.set(this.importNormText(s.name), s.id);
        }
      }
    }
    const stagesCreated = Array.from(unknownStageNames.values());

    // 4) Har bir qatorni Client yaratish uchun tayyorlaymiz
    const now = new Date();
    const errors: { row: number; reason: string }[] = [];
    const seenPhonesInFile = new Set<string>();
    const toCreate: any[] = [];

    dataRows.forEach((row, idx) => {
      const rowNum = idx + 2; // 1-qator sarlavha, ma'lumot 2-qatordan boshlanadi
      const get = (field: string) => (colMap[field] !== undefined ? (row[colMap[field]] || '').trim() : '');

      const fullName = get('fullName');
      if (!fullName) {
        errors.push({ row: rowNum, reason: 'Ism (F.I.O) bo\'sh' });
        return;
      }

      let phone: string | null = null;
      const rawPhone = get('phone');
      if (rawPhone) {
        phone = normalizePhone(rawPhone) || null;
        if (phone) {
          if (seenPhonesInFile.has(phone)) {
            errors.push({ row: rowNum, reason: `Telefon takrorlandi faylda (${phone}) — o'tkazib yuborildi` });
            return;
          }
          seenPhonesInFile.add(phone);
        }
      }

      const stageRaw = get('stage');
      let stage = 'NEW_LEAD';
      let customStageId: string | null = null;
      if (stageRaw) {
        const resolved = this.importResolveKnownStage(stageRaw);
        if (resolved) {
          stage = resolved;
        } else {
          // Tanilmagan bosqich — tenant pipeline'iga CustomStage sifatida
          // qo'shilgan (yuqorida), shu yerda faqat id orqali bog'laymiz.
          // pipelineStage NEW_LEAD'da qoladi — hisobot/filtr moslashuvi uchun.
          customStageId = existingStagesByName.get(this.importNormText(stageRaw)) || null;
        }
      }

      const tagsRaw = get('tags');
      const tags = tagsRaw ? tagsRaw.split(/[,;]/).map((t) => t.trim()).filter(Boolean) : [];

      const agentRaw = get('agent');
      const assignedAgentId = agentRaw ? usersByKey.get(this.importNormText(agentRaw)) || null : null;

      const destination = get('destination');
      const budget = get('budget');
      const preferences: any = {};
      if (destination || budget) {
        preferences.keyInfo = { destination: destination || '', budget: budget || '', budgetCurrency: 'USD' };
      }

      toCreate.push({
        tenantId,
        fullName,
        phone,
        phone2: get('phone2') || null,
        email: get('email').toLowerCase() || null,
        city: get('city') || null,
        country: get('country') || null,
        notes: get('notes') || null,
        source: this.importResolveSource(get('source')),
        tier: 'REGULAR',
        language: 'UZ',
        tags,
        assignedAgentId,
        preferences,
        pipelineStage: stage as any,
        pipelineStageAt: now,
        customStageId,
        leadScore: 0,
        firstContactAt: now,
        lastContactAt: now,
      });
    });

    // 4) Ommaviy yozish — 500 tadan bo'laklarga bo'lib (2000+ qator uchun tezkor va ishonchli).
    //    skipDuplicates: true — shu tenant ichida telefon raqami allaqachon
    //    mavjud bo'lgan mijozlar avtomatik o'tkazib yuboriladi (xato bermaydi).
    const CHUNK = 500;
    let imported = 0;
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const chunk = toCreate.slice(i, i + CHUNK);
      const res = await this.prisma.client.createMany({ data: chunk, skipDuplicates: true });
      imported += res.count;
    }
    const duplicatesSkipped = toCreate.length - imported;

    void this.cache.invalidateReports(tenantId);

    this.logger.log(
      `[IMPORT] Tenant: ${tenantId} | Fayl: ${file.originalname} | Jami qator: ${dataRows.length} | Import qilindi: ${imported} | Dublikat: ${duplicatesSkipped} | Xatolar: ${errors.length}`,
    );

    return {
      ok: true,
      totalRows: dataRows.length,
      imported,
      duplicatesSkipped,
      invalidRows: errors.length,
      errors: errors.slice(0, 50), // juda uzun bo'lmasin
      stagesCreated, // yangi qo'shilgan bosqichlar nomi (agar bo'lsa)
    };
  }

  async update(
    tenantId: string,
    id: string,
    userId: string,
    role: string,
    data: any,
  ) {
    await this.findOne(tenantId, id, userId, role);
    const {
      id: _id, tenantId: _t, createdAt: _c, updatedAt: _u,
      totalBookings: _tb, totalRevenue: _tr, totalSpent: _ts,
      leadScore: _ls, pipelineStage: _ps, // Stage changes use separate endpoint
      ...safe
    } = data;

    if (safe.dateOfBirth) safe.dateOfBirth = new Date(safe.dateOfBirth);
    if (safe.passportExpiry) safe.passportExpiry = new Date(safe.passportExpiry);
    if (safe.language) safe.language = safeEnum(safe.language, LANGUAGES, 'UZ');
    if (safe.source) safe.source = safeEnum(safe.source, SOURCES, 'OTHER');
    if (safe.tier) safe.tier = safeEnum(safe.tier, TIERS, 'REGULAR');
    if (safe.status) safe.status = safeEnum(safe.status, CLIENT_STATUSES, 'ACTIVE');
    // Sezgir ma'lumotlarni shifrlash
    if (safe.passportNo) safe.passportNo = this.encryption.encrypt(safe.passportNo);
    if (safe.address) safe.address = this.encryption.encrypt(safe.address);

    const updated = await this.prisma.client.update({
      where: { id },
      data: clean(safe),
    });

    // Klient ma'lumoti (manba/tier/status...) hisobotlarga ta'sir qilishi mumkin.
    void this.cache.invalidateReports(tenantId);

    return updated;
  }

  // v14: mijozga ixtiyoriy "key = value" ma'lumotlar. preferences.customFields
  // ichida saqlanadi. MAVJUD preferences (offers/travelInfo) bilan birlashtiriladi —
  // hech narsa yo'qolmaydi. fields = [{ key, value }, ...]
  //
  // v35: Maydon NOMLARINI (savollarni) faqat ADMIN/MANAGER belgilay oladi va
  // o'zgartira oladi — qo'shish, o'chirish, qayta nomlash shu rollarga xos.
  // AGENT esa faqat MAVJUD maydonlarning QIYMATINI (javobini) to'ldira oladi;
  // uning so'rovida kelgan yangi/o'zgartirilgan `key`lar e'tiborga olinmaydi,
  // shunda frontenddagi cheklov chetlab o'tilsa ham (masalan to'g'ridan-to'g'ri
  // API chaqiruvi orqali) server tomonda himoya saqlanib qoladi.
  async setCustomFields(tenantId: string, id: string, userId: string, role: string, fields: any) {
    await this.findOne(tenantId, id, userId, role);
    const client = await this.prisma.client.findFirst({ where: { id, tenantId } });
    if (!client) throw new NotFoundException('Mijoz topilmadi');
    const prefs: any = (client as any).preferences || {};
    const submitted: { key: string; value: string }[] = Array.isArray(fields)
      ? fields
          .filter((f: any) => f && (f.key || f.value))
          .map((f: any) => ({ key: String(f.key || '').slice(0, 100), value: String(f.value || '').slice(0, 500) }))
          .slice(0, 50)
      : [];

    const isAdmin = role !== 'AGENT';
    if (isAdmin) {
      // Admin/manager: to'liq erkin — maydon qo'shish, o'chirish, nomini
      // o'zgartirish, qiymatini o'zgartirish — hammasi ruxsat etilgan.
      prefs.customFields = submitted;
    } else {
      // Agent: faqat MAVJUD maydonlarning qiymatini to'ldira oladi. Nomlar
      // (savollar) tuzilmasi — soni, tartibi, matni — o'zgarishsiz qoladi.
      const existing: { key: string; value: string }[] = Array.isArray(prefs.customFields) ? prefs.customFields : [];
      const submittedByKey = new Map(submitted.map((f) => [f.key, f.value]));
      prefs.customFields = existing.map((f) => ({
        key: f.key,
        value: submittedByKey.has(f.key) ? (submittedByKey.get(f.key) as string) : f.value,
      }));
    }

    await this.prisma.client.update({ where: { id }, data: { preferences: prefs } });
    return { ok: true, customFields: prefs.customFields };
  }

  // v29: "Nima xohlaydi" — yo'nalish + byudjet. Ilgari bu ma'lumot faqat
  // erkin "Qo'shimcha ma'lumot" (key=value) qutisiga yozilardi — agentlar
  // buni har xil nom bilan yozardi ("Qayerga"/"Yo'nalish"/"Destination"),
  // shuning uchun bir xil ma'noli ma'lumot har xil ko'rinar, ro'yxatda
  // qidirib bo'lmasdi. Endi QAT'IY maydonlar — hamma mijozda bir xil.
  // v36: erkin "Savol/Javob" qutisi (CustomFields) klient sahifasidan
  // butunlay OLIB TASHLANDI — o'rniga AmoCRM uslubidagi sayohat
  // ma'lumotlari (kim bilan, necha kishi, bolalar, sanalar, muddat)
  // shu QAT'IY maydonlar to'plamiga qo'shildi.
  async setKeyInfo(tenantId: string, id: string, userId: string, role: string, body: any) {
    await this.findOne(tenantId, id, userId, role);
    const client = await this.prisma.client.findFirst({ where: { id, tenantId } });
    if (!client) throw new NotFoundException('Mijoz topilmadi');
    const prefs: any = (client as any).preferences || {};
    const prev = prefs.keyInfo || {};
    prefs.keyInfo = {
      destination: String(body?.destination ?? prev.destination ?? '').slice(0, 200),
      companions: String(body?.companions ?? prev.companions ?? '').slice(0, 200),
      peopleCount: String(body?.peopleCount ?? prev.peopleCount ?? '').slice(0, 20),
      kids: String(body?.kids ?? prev.kids ?? '').slice(0, 200),
      dates: String(body?.dates ?? prev.dates ?? '').slice(0, 100),
      duration: String(body?.duration ?? prev.duration ?? '').slice(0, 50),
      budget: String(body?.budget ?? prev.budget ?? '').slice(0, 100),
      budgetCurrency: ['USD', 'UZS', 'EUR'].includes(body?.budgetCurrency) ? body.budgetCurrency : (prev.budgetCurrency || 'USD'),
    };
    await this.prisma.client.update({ where: { id }, data: { preferences: prefs } });
    return { ok: true, keyInfo: prefs.keyInfo };
  }

  async delete(tenantId: string, id: string, userId: string, role: string) {
    // Only ADMIN/MANAGER can delete
    if (role === 'AGENT') {
      throw new BadRequestException("Agentlar klientlarni o'chira olmaydi");
    }
    await this.findOne(tenantId, id, userId, role);

    // BUG FIX: avval to'g'ridan-to'g'ri `prisma.client.delete()` chaqirilardi —
    // lekin Booking/Invoice/Payment kabi moliyaviy yozuvlar Client bilan CASCADE
    // BOG'LANMAGAN (atayin — moliyaviy tarix tasodifan o'chib ketmasligi uchun),
    // shuning uchun bookingi bor har qanday klientni o'chirishga urinish har doim
    // "Foreign key constraint" xatosi bilan tugardi va foydalanuvchiga tushunarsiz
    // ko'rinardi ("ishlamayapti"). Endi buni aniq xabar bilan bloklaymiz.
    const bookingsCount = await this.prisma.booking.count({ where: { clientId: id } });
    if (bookingsCount > 0) {
      throw new BadRequestException(
        `Bu klientda ${bookingsCount} ta booking bor — moliyaviy tarixni yo'qotmaslik uchun bookingi bor klientlarni o'chirib bo'lmaydi. Kerak bo'lsa, klientni "Yo'qotildi" bosqichiga o'tkazing.`,
      );
    }

    // Moliyaviy bo'lmagan bog'liq yozuvlarni (suhbat, vazifa, hujjat, qo'ng'iroq,
    // tarix) klient bilan birga tozalaymiz — bular Client'ga CASCADE bog'lanmagan
    // (chunki clientId ixtiyoriy), shuning uchun qo'lda, bitta tranzaksiyada o'chiramiz.
    await this.prisma.$transaction([
      this.prisma.conversation.deleteMany({ where: { clientId: id } }),
      this.prisma.task.deleteMany({ where: { clientId: id } }),
      this.prisma.document.deleteMany({ where: { clientId: id } }),
      this.prisma.call.deleteMany({ where: { clientId: id } }),
      this.prisma.client.delete({ where: { id } }),
    ]);

    // Klient o'chirildi → hisobot cache tozalanadi.
    void this.cache.invalidateReports(tenantId);

    return { ok: true };
  }

  async getTimeline(tenantId: string, id: string, userId: string, role: string) {
    await this.findOne(tenantId, id, userId, role);
    return this.prisma.clientTimeline.findMany({
      where: { clientId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async addNote(
    tenantId: string,
    id: string,
    userId: string,
    role: string,
    note: string,
  ) {
    if (!note?.trim()) throw new BadRequestException("Izoh bo'sh");
    await this.findOne(tenantId, id, userId, role);
    return this.addTimeline(id, 'note', 'Izoh qoldirildi', note.trim(), { userId });
  }

  async setTier(
    tenantId: string,
    id: string,
    userId: string,
    role: string,
    tier: string,
  ) {
    if (role === 'AGENT') {
      throw new BadRequestException("Agentlar tier o'zgartira olmaydi");
    }
    const t = safeEnum(tier, TIERS, 'REGULAR');
    const client = await this.prisma.client.update({
      where: { id },
      data: { tier: t },
    });
    await this.addTimeline(id, 'tier_changed', `Daraja: ${t}`, undefined, { tier: t, userId });
    return client;
  }

  /**
   * v37: Admin/Manager mijozni (leadni) biror agentga tayinlaydi yoki qayta
   * tayinlaydi. agentId=null — agentdan bo'shatish. `update()` orqali ham
   * assignedAgentId'ni o'zgartirish mumkin edi, lekin u yerda `assignedAt`
   * yangilanmaydi, TIMELINE yozuvi qo'shilmaydi va yangi agentga
   * bildirishnoma yuborilmaydi — shu sabab alohida metod.
   */
  async assignAgent(
    tenantId: string,
    id: string,
    userId: string,
    role: string,
    agentId: string | null,
  ) {
    if (role === 'AGENT') {
      throw new BadRequestException("Agentlar mijozni boshqa agentga tayinlay olmaydi");
    }

    const client = await this.prisma.client.findFirst({ where: { id, tenantId } });
    if (!client) throw new NotFoundException('Mijoz topilmadi');

    let agent: { id: string; name: string } | null = null;
    if (agentId) {
      agent = await this.prisma.user.findFirst({
        where: { id: agentId, tenantId, status: 'ACTIVE' as any },
        select: { id: true, name: true },
      });
      if (!agent) throw new BadRequestException('Agent topilmadi yoki faol emas');
    }

    const updated = await this.prisma.client.update({
      where: { id },
      data: {
        assignedAgentId: agentId || null,
        assignedAt: agentId ? new Date() : null,
      },
      include: { assignedAgent: { select: { id: true, name: true } } },
    });

    await this.addTimeline(
      id,
      'agent_assigned',
      agent ? `Agentga tayinlandi: ${agent.name}` : "Agentdan bo'shatildi",
      undefined,
      { userId, agentId: agentId || null },
    );

    // Yangi tayinlangan agentga bildirishnoma (o'zi-o'ziga tayinlamagan bo'lsa)
    if (agent && agent.id !== userId) {
      await this.notifications.create({
        tenantId,
        userId: agent.id,
        type: 'LEAD_ASSIGNED',
        title: '🔥 Sizga mijoz tayinlandi',
        body: `${client.fullName}${client.phone ? ' • ' + client.phone : ''}`,
        link: `/clients/${client.id}`,
        metadata: { clientId: client.id },
      });
    }

    void this.cache.invalidateReports(tenantId);

    return updated;
  }

  /**
   * v5: Open Chat — klient bilan mavjud suhbatni topadi, yo'q bo'lsa yaratadi.
   * Faqat assigned agent va admin ko'ra oladi.
   */
  async findOrCreateConversation(tenantId: string, clientId: string, userId: string, role: string) {
    const client = await this.prisma.client.findFirst({
      where: this.where(tenantId, userId, role, { id: clientId }),
    });
    if (!client) throw new NotFoundException('Klient topilmadi');

    // Mavjud suhbat (Telegram ustuvor)
    let conv = await this.prisma.conversation.findFirst({
      where: {
        tenantId,
        clientId,
        ...(role === 'AGENT' ? {
          OR: [{ assignedAgentId: userId }, { assignedAgentId: null }],
        } : {}),
      },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
    });

    if (conv) {
      return { conversationId: conv.id, isNew: false };
    }

    // Telegram ma'lumotlari bo'lsa, yangi conversation yaratamiz (manual)
    if (!client.telegramId && !client.telegramUsername && !client.phone) {
      throw new BadRequestException("Klient bilan suhbat boshlash uchun Telegram yoki telefon kerak");
    }

    conv = await this.prisma.conversation.create({
      data: {
        tenantId,
        clientId,
        channel: client.telegramId ? 'TELEGRAM' : 'WHATSAPP',
        externalChatId: client.telegramId || client.phone || `manual-${clientId}`,
        externalUserId: client.telegramId || undefined,
        firstName: client.fullName.split(' ')[0],
        lastName: client.fullName.split(' ').slice(1).join(' ') || undefined,
        username: client.telegramUsername || undefined,
        assignedAgentId: role === 'AGENT' ? userId : client.assignedAgentId,
      },
    });

    return { conversationId: conv.id, isNew: true };
  }

  /**
   * v7: Faqat mavjud suhbatni qaytaradi, yaratmaydi.
   * Frontend: Klient telegramda yozgan bo'lsa "Open Chat" tugmasi ko'rinadi.
   * Yo'q bo'lsa - null qaytadi va frontend tugmani yashiradi.
   */
  async getExistingConversation(tenantId: string, clientId: string, userId: string, role: string) {
    const client = await this.prisma.client.findFirst({
      where: this.where(tenantId, userId, role, { id: clientId }),
    });
    if (!client) throw new NotFoundException('Klient topilmadi');

    const conv = await this.prisma.conversation.findFirst({
      where: {
        tenantId, clientId,
        ...(role === 'AGENT' ? {
          OR: [{ assignedAgentId: userId }, { assignedAgentId: null }],
        } : {}),
      },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      select: {
        id: true, channel: true, lastMessageAt: true, lastMessageText: true,
        unreadCount: true, isResolved: true,
      },
    });

    if (!conv) {
      return { exists: false, conversationId: null };
    }
    return { exists: true, conversationId: conv.id, conversation: conv };
  }

  /**
   * v5: Call — klientga qo'ng'iroq qilish (Twilio orqali)
   */
  /**
   * Legacy endpoint - hozircha simple Call yozuvi yaratadi.
   * Real qo'ng'iroq uchun frontend'dan to'g'ridan-to'g'ri /api/v1/calls/initiate ishlatiladi
   * (phone provider arxitekturasidan o'tadi: STUB/TEL_LINK/OnlinePBX/Twilio).
   */
  async initiateCall(tenantId: string, clientId: string, userId: string, role: string) {
    const client = await this.prisma.client.findFirst({
      where: this.where(tenantId, userId, role, { id: clientId }),
    });
    if (!client) throw new NotFoundException('Klient topilmadi');
    if (!client.phone) throw new BadRequestException("Klientning telefon raqami yo'q");

    const call = await this.prisma.call.create({
      data: {
        tenantId,
        clientId,
        agentId: userId,
        toMasked: client.phone.slice(0, -5) + '***' + client.phone.slice(-2),
        direction: 'OUTBOUND',
        status: 'QUEUED',
      },
    });

    await this.addTimeline(clientId, 'call_initiated', "Qo'ng'iroq qilindi", undefined, {
      callId: call.id, userId,
    });

    return {
      callId: call.id,
      id: call.id,
      phone: client.phone,
      message: "Qo'ng'iroq /api/v1/calls/initiate orqali phone provider'dan o'tkazilishi mumkin",
    };
  }

  async addTimeline(
    clientId: string,
    type: string,
    title: string,
    description?: string,
    metadata?: any,
  ) {
    return this.prisma.clientTimeline.create({
      data: {
        clientId,
        userId: metadata?.userId,
        type,
        title,
        description,
        metadata: (metadata || {}) as any,
      },
    });
  }

  async getStats(tenantId: string, userId: string, role: string) {
    const where = this.where(tenantId, userId, role);
    const monthStart = new Date(new Date().setDate(1));
    monthStart.setHours(0, 0, 0, 0);

    const [total, bySource, byTier, byStage, newThisMonth] = await Promise.all([
      this.prisma.client.count({ where }),
      this.prisma.client.groupBy({ by: ['source'], where, _count: { id: true } }),
      this.prisma.client.groupBy({ by: ['tier'], where, _count: { id: true } }),
      this.prisma.client.groupBy({ by: ['pipelineStage'], where, _count: { id: true } }),
      this.prisma.client.count({ where: { ...where, createdAt: { gte: monthStart } } }),
    ]);

    return { total, newThisMonth, bySource, byTier, byStage };
  }

  /** Update client stats after a booking/payment */
  async recalcStats(clientId: string) {
    const [bookings, payments] = await Promise.all([
      this.prisma.booking.aggregate({
        where: { clientId, status: { not: 'CANCELLED' } },
        _count: { id: true },
        _sum: { totalPrice: true },
      }),
      this.prisma.payment.aggregate({
        where: { clientId, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
    ]);
    const totalBookings = bookings._count.id || 0;
    const totalRevenue = bookings._sum.totalPrice || 0;
    const totalSpent = payments._sum.amount || 0;
    const avg = totalBookings > 0 ? totalRevenue / totalBookings : 0;

    await this.prisma.client.update({
      where: { id: clientId },
      data: {
        totalBookings,
        totalRevenue,
        totalSpent,
        avgBookingValue: avg,
        lifetimeValue: totalSpent,
      },
    });
  }
  /** v6: CSV export */
  async exportCsv(tenantId: string, userId: string, role: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.assignedAgentId = userId;

    const clients = await this.prisma.client.findMany({
      where,
      include: { assignedAgent: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const headers = ['Ism', 'Telefon', 'Email', 'Manba', 'Bosqich', 'Tier', 'Mamlakat', 'Agent', 'Bookings', 'Daromad', 'Yaratilgan'];
    const csv = [
      headers.join(','),
      ...clients.map((c) => [
        (c.fullName || '').replace(/,/g, ';'),
        c.phone || '',
        c.email || '',
        c.source || '',
        c.pipelineStage || '',
        c.tier || '',
        c.country || '',
        (c.assignedAgent?.name || '').replace(/,/g, ';'),
        c.totalBookings || 0,
        c.totalRevenue || 0,
        c.createdAt.toISOString().slice(0, 10),
      ].join(',')),
    ].join('\n');
    return { csv, count: clients.length };
  }

  /** v6: Manba bo'yicha statistika */
  async statsBySource(tenantId: string, userId: string, role: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.assignedAgentId = userId;
    const grouped = await this.prisma.client.groupBy({
      by: ['source'],
      where,
      _count: { id: true },
      _sum: { totalRevenue: true },
    });
    return grouped.map((g) => ({
      source: g.source || 'UNKNOWN',
      count: g._count.id,
      revenue: g._sum.totalRevenue || 0,
    }));
  }

  /** v6: Bosqich bo'yicha statistika */
  async statsByStage(tenantId: string, userId: string, role: string) {
    const where: any = { tenantId };
    if (role === 'AGENT') where.assignedAgentId = userId;
    const grouped = await this.prisma.client.groupBy({
      by: ['pipelineStage'],
      where,
      _count: { id: true },
    });
    return grouped.map((g) => ({
      stage: g.pipelineStage,
      count: g._count.id,
    }));
  }
}