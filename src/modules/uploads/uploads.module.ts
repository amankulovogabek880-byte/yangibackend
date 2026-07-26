import {
  Module, Injectable, Controller, Post, Get, Delete, UseGuards,
  UploadedFile, UseInterceptors, BadRequestException,
  UploadedFiles, Query, Param, NotFoundException, Logger,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentCategory } from '@prisma/client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { swallow } from '../../common/utils/swallow';

// ─── Supabase Storage konfiguratsiyasi ──────────────────────────────
// .env da SUPABASE_URL va SUPABASE_SERVICE_KEY bo'lishi shart.
//
// XAVFSIZLIK TUZATISH (muhim!):
//   Ilgari bucket "public" deb belgilanishi kerak edi va biz doim
//   getPublicUrl() bilan MUDDATSIZ ochiq havola qaytarardik. Bu
//   /uploads route'idagi tenant-tekshiruvini butunlay chetlab
//   o'tardi — havolani bilgan/topgan HAR KIM (login'siz ham) pasport,
//   viza, shartnoma kabi hujjatlarni ko'ra olardi.
//
//   ENDI: Supabase dashboard'da bucket **PRIVATE** qilib qo'yilishi
//   kerak (Storage > Bucket > Public bucket ❌ o'chirilgan bo'lsin).
//   Backend har safar MUDDATLI (signed) havola generatsiya qiladi —
//   standart 1 soat (SUPABASE_SIGNED_URL_TTL bilan sozlanadi) — va
//   har bir so'rovda tenant tekshiruvidan keyingina beriladi.
//
//   ESLATMA: agar avval bucket public bo'lgan va u yerda eski fayllar
//   bo'lsa, ularni ham private bucket'ga migratsiya qilish yoki eski
//   havolalarni bekor qilish (rotate) tavsiya etiladi — aks holda eski
//   public URL'lar hamon ishlab turadi.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'documents';
const SIGNED_URL_TTL = parseInt(process.env.SUPABASE_SIGNED_URL_TTL || '3600', 10); // sekund, standart 1 soat

let supabase: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// XAVFSIZLIK: 'image/svg+xml' ATAYLAB ro'yxatda YO'Q va prefiks bo'yicha
// ham qabul qilinmaydi (pastda tekshiriladi) — SVG ichiga <script> yozib
// qo'yish mumkin, brauzerda ochilganda bu Stored XSS bo'ladi.
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm',
  // v14 FIX: ovozli xabar (inboxdan mikrofonda yozilgan) — brauzer 'audio/webm'
  // yoki 'audio/ogg' beradi. Avval bu turlar ro'yxatda YO'Q edi, shu sabab
  // yuklashning o'zi "Fayl turi qollab-quvvatlanmaydi: audio/webm" xatosi
  // bilan rad etilar, ovozli xabar hatto Telegramga yetib ham bormasdi.
  'audio/webm', 'audio/ogg', 'audio/oga', 'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/3gpp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const EXPLICITLY_BLOCKED_MIME = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/x-msdownload',
  'application/x-sh',
  'application/javascript',
  'text/javascript',
]);

// v14 FIX (davomi): brauzer ba'zan `audio/webm;codecs=opus` kabi codecs
// qo'shimchasi bilan mimetype yuboradi — bu YUQORIDAGI aniq ro'yxatga
// mos kelmasdi va ovozli xabar baribir rad etilardi. Endi (1) codecs/params
// qismini olib tashlaymiz, (2) har qanday audio/image/video ni prefiks
// bo'yicha ham qabul qilamiz (SVG va boshqa xavfli turlar bundan mustasno).
function isAllowedMime(mimetype?: string): boolean {
  if (!mimetype) return false;
  const base = mimetype.split(';')[0].trim().toLowerCase();
  if (EXPLICITLY_BLOCKED_MIME.has(base)) return false;
  if (ALLOWED_MIME.has(base)) return true;
  return base.startsWith('image/') || base.startsWith('audio/') || base.startsWith('video/');
}

// ─────────────────────────────────────────────────────────────
// XAVFSIZLIK TUZATISH: haqiqiy fayl tarkibini (magic bytes/signature)
// tekshiramiz. Ilgari faqat brauzer/klient yuborgan `Content-Type`
// header'iga ishonilardi — bu esa klient tomonidan ERKIN o'zgartirilishi
// mumkin (masalan zararli faylni "image/png" deb belgilab yuborish).
// Bu funksiya eng ko'p ishlatiladigan formatlar uchun fayl boshidagi
// baytlarni haqiqiy formatga mosligini tekshiradi. Mos kelmasa — rad.
//
// Eslatma: bu 100% mukammal himoya emas (polyglot fayllar nazariyasi
// mavjud), lekin eng oddiy va eng ko'p uchraydigan spoofing usulini
// (Content-Type'ni shunchaki o'zgartirib yuborish) to'xtatadi va
// qo'shimcha npm paket talab qilmaydi.
// ─────────────────────────────────────────────────────────────
function matchesFileSignature(buffer: Buffer, mimetype: string): boolean {
  if (!buffer || buffer.length < 4) return false;
  const base = mimetype.split(';')[0].trim().toLowerCase();
  const b = buffer;

  const startsWith = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => b[offset + i] === byte);

  switch (base) {
    case 'image/jpeg':
      return startsWith([0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/gif':
      return startsWith([0x47, 0x49, 0x46, 0x38]);
    case 'image/webp':
      return startsWith([0x52, 0x49, 0x46, 0x46]) && b.slice(8, 12).toString('ascii') === 'WEBP';
    case 'application/pdf':
      return startsWith([0x25, 0x50, 0x44, 0x46]); // %PDF
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      // .docx/.xlsx — ZIP konteyner (PK\x03\x04)
      return startsWith([0x50, 0x4b, 0x03, 0x04]);
    case 'application/msword':
    case 'application/vnd.ms-excel':
      // Eski OLE formatlar
      return startsWith([0xd0, 0xcf, 0x11, 0xe0]);
    case 'video/mp4':
      return b.slice(4, 8).toString('ascii') === 'ftyp';
    case 'video/webm':
      return startsWith([0x1a, 0x45, 0xdf, 0xa3]);
    case 'audio/mpeg':
    case 'audio/mp3':
      return startsWith([0x49, 0x44, 0x33]) || startsWith([0xff, 0xfb]) || startsWith([0xff, 0xf3]);
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return startsWith([0x52, 0x49, 0x46, 0x46]);
    case 'audio/ogg':
    case 'audio/oga':
      return startsWith([0x4f, 0x67, 0x67, 0x53]);
    default:
      // audio/webm (opus), audio/mp4/m4a/aac, video/3gpp va h.k. — turli
      // konteyner variantlari ko'p, qattiq signature tekshiruvi yolg'on-
      // musbat berish xavfi yuqori. Bunday hollarda faqat ro'yxat/prefiks
      // tekshiruvi (isAllowedMime) bilan cheklanamiz.
      return true;
  }
}

function safeFileName(original: string): string {
  const safe = (original || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger('Uploads');

  constructor(private prisma: PrismaService) {}

  private mapEntity(entityType?: string, entityId?: string) {
    const t = (entityType || '').toLowerCase();
    if (t === 'booking') return { bookingId: entityId };
    if (t === 'client')  return { clientId: entityId };
    return {};
  }

  /** Yuklashdan oldingi to'liq validatsiya: MIME ro'yxati + haqiqiy fayl signature'i */
  validateFile(file: Express.Multer.File): void {
    if (!isAllowedMime(file.mimetype)) {
      throw new BadRequestException(`Fayl turi qo'llab-quvvatlanmaydi: ${file.mimetype}`);
    }
    if (!matchesFileSignature(file.buffer, file.mimetype)) {
      this.logger.warn(
        `Fayl tarkibi e'lon qilingan turga mos kelmadi: ${file.originalname} (${file.mimetype})`,
      );
      throw new BadRequestException(
        "Fayl tarkibi e'lon qilingan turga mos kelmadi (buzilgan yoki soxta fayl bo'lishi mumkin)",
      );
    }
  }

  /**
   * Faylni Supabase Storage'ga (PRIVATE bucket) yuklaydi va MUDDATLI
   * (signed) havola qaytaradi. Render'dagi diskdan farqli o'laroq,
   * fayl deploy/restart bo'lganda ham o'chmaydi, lekin ochiq/doimiy
   * public URL emas — har safar tenant tekshiruvidan keyin generatsiya
   * qilinadi (pastdagi `signedUrl` metodiga qarang).
   */
  async uploadToSupabase(file: Express.Multer.File): Promise<{ url: string; path: string }> {
    if (!supabase) {
      throw new BadRequestException(
        'Fayl saqlash xizmati sozlanmagan (SUPABASE_URL / SUPABASE_SERVICE_KEY yoq)',
      );
    }
    const path = safeFileName(file.originalname);
    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });
    if (error) {
      this.logger.error(`Supabase upload xatosi: ${error.message}`);
      throw new BadRequestException(`Fayl yuklanmadi: ${error.message}`);
    }
    const url = await this.signedUrl(path);
    return { url, path };
  }

  /** Berilgan storage path uchun muddatli (signed) havola generatsiya qiladi */
  async signedUrl(path: string): Promise<string> {
    if (!supabase) return '';
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) {
      this.logger.error(`Signed URL yaratib bo'lmadi (${path}): ${error?.message}`);
      return '';
    }
    return data.signedUrl;
  }

  async deleteFromSupabase(path: string) {
    if (!supabase) return;
    await supabase.storage.from(SUPABASE_BUCKET).remove([path]).catch(swallow('yon amal'));
  }

  async saveRecord(
    tenantId: string, uploadedById: string,
    file: Express.Multer.File,
    url: string, storagePath: string,
    entityType?: string, entityId?: string,
  ) {
    const link = this.mapEntity(entityType, entityId);
    return this.prisma.document.create({
      data: {
        tenantId,
        uploadedById,
        name: file.originalname,
        fileName: storagePath,
        // Diqqat: bu yerda saqlanadigan `fileUrl` vaqt o'tishi bilan
        // MUDDATI TUGAYDI (signed URL). Har doim `list()`/`getUrl()`
        // orqali TAZA havola oling — bevosita bazadagi eski qiymatga
        // tayanmang.
        fileUrl: url,
        fileMimeType: file.mimetype,
        fileSize: file.size,
        category: 'OTHER' as DocumentCategory,
        ...link,
      },
    });
  }

  async list(tenantId: string, entityType?: string, entityId?: string) {
    const where: any = { tenantId };
    if (entityType === 'booking' && entityId) where.bookingId = entityId;
    else if (entityType === 'client' && entityId) where.clientId = entityId;
    else if (entityId) {
      where.OR = [{ bookingId: entityId }, { clientId: entityId }];
    }
    // v12.8: cheklov qo'yildi. Bitta mijoz/booking'da hujjat soni
    // ko'payib ketsa (skanerlar, pasport nusxalari), cheksiz ro'yxat
    // javobni og'irlashtiradi. 200 ta amalda yetarlidan ko'p.
    const docs = await this.prisma.document.findMany({
      where, orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // XAVFSIZLIK: har bir hujjat uchun TAZA signed URL generatsiya
    // qilamiz (eskisi muddati o'tgan bo'lishi mumkin). Bu yerga
    // kelguncha `where: { tenantId }` orqali tenant tekshiruvi
    // allaqachon bajarilgan.
    const withFreshUrls = await Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        url: (await this.signedUrl(d.fileName)) || d.fileUrl,
        filename: d.fileName,
        originalName: d.name,
        mimeType: d.fileMimeType,
        size: d.fileSize,
        createdAt: d.createdAt,
      })),
    );
    return withFreshUrls;
  }

  /** Bitta hujjat uchun taza havola — tenant tekshiruvi bilan */
  async getFreshUrl(tenantId: string, id: string) {
    const doc = await this.prisma.document.findFirst({ where: { id, tenantId } });
    if (!doc) throw new NotFoundException('Hujjat topilmadi');
    const url = (await this.signedUrl(doc.fileName)) || doc.fileUrl;
    return { id: doc.id, url };
  }

  async remove(tenantId: string, id: string) {
    const doc = await this.prisma.document.findFirst({ where: { id, tenantId } });
    if (!doc) throw new NotFoundException('Hujjat topilmadi');
    await this.deleteFromSupabase(doc.fileName);
    await this.prisma.document.delete({ where: { id } });
    return { ok: true };
  }
}

@Controller('uploads')
export class UploadsController {
  constructor(private svc: UploadsService) {}

  /**
   * Bitta fayl yuklash — Supabase Storage'ga (private bucket) saqlanadi,
   * DB'ga ham yoziladi (Document jadvali). Qaytariladigan `url` —
   * muddatli (signed) havola, birmuncha vaqtdan keyin GET /uploads yoki
   * GET /uploads/:id/url orqali yangisini olish kerak bo'ladi.
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    fileFilter: (_req, file, cb) => {
      if (!isAllowedMime(file.mimetype)) {
        cb(new BadRequestException(`Fayl turi qollab-quvvatlanmaydi: ${file.mimetype}`), false);
        return;
      }
      cb(null, true);
    },
  }))
  async uploadOne(
    @UploadedFile() file: Express.Multer.File,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @CurrentUser() u: any,
  ) {
    if (!file) throw new BadRequestException('Fayl yuklanmadi');
    // XAVFSIZLIK: haqiqiy fayl tarkibi (magic bytes) e'lon qilingan
    // Content-Type'ga mosligini tekshiramiz — fileFilter faqat header'ga
    // qaraydi, buni klient soxtalashtira oladi.
    this.svc.validateFile(file);

    const isImage = file.mimetype.startsWith('image/');
    const isVideo = file.mimetype.startsWith('video/');

    const { url, path } = await this.svc.uploadToSupabase(file);

    let docId: string | undefined;
    if (entityType && entityId) {
      const doc = await this.svc.saveRecord(u.tenantId, u.sub, file, url, path, entityType, entityId);
      docId = doc.id;
    }

    return {
      id: docId,
      url,
      filename: path,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      type: isImage ? 'image' : isVideo ? 'video' : 'document',
    };
  }

  /**
   * Bir nechta fayl (mehmonxona galereya kabi)
   */
  @Post('batch')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 10, {
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!isAllowedMime(file.mimetype)) {
        cb(new BadRequestException(`Fayl turi: ${file.mimetype} qollab-quvvatlanmaydi`), false);
        return;
      }
      cb(null, true);
    },
  }))
  async uploadBatch(
    @UploadedFiles() files: Express.Multer.File[],
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @CurrentUser() u: any,
  ) {
    if (!files?.length) throw new BadRequestException('Fayllar yoq');

    const results = [];
    for (const f of files) {
      // XAVFSIZLIK: har bir fayl uchun ham haqiqiy tarkib tekshiruvi
      this.svc.validateFile(f);

      const isImage = f.mimetype.startsWith('image/');
      const isVideo = f.mimetype.startsWith('video/');
      const { url, path } = await this.svc.uploadToSupabase(f);

      let docId: string | undefined;
      if (entityType && entityId) {
        const doc = await this.svc.saveRecord(u.tenantId, u.sub, f, url, path, entityType, entityId);
        docId = doc.id;
      }

      results.push({
        id: docId,
        url,
        filename: path,
        originalName: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
        type: isImage ? 'image' : isVideo ? 'video' : 'document',
      });
    }

    return { count: results.length, files: results };
  }

  /**
   * Hujjatlar royxati — entityType + entityId boyicha
   * Misol: GET /uploads?entityType=booking&entityId=xxx
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  list(
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @CurrentUser() u: any,
  ) {
    return this.svc.list(u.tenantId, entityType, entityId);
  }

  /**
   * Bitta hujjat uchun TAZA (muddati tugamagan) havola olish.
   * Signed URL bir muncha vaqtdan keyin ishlamay qolgani uchun
   * frontend buni chaqirib yangilashi mumkin.
   */
  @Get(':id/url')
  @UseGuards(JwtAuthGuard)
  getUrl(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.getFreshUrl(u.tenantId, id);
  }

  /**
   * Hujjatni ochirish (Supabase'dan ham, DB'dan ham)
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.remove(u.tenantId, id);
  }
}

@Module({
  controllers: [UploadsController],
  // v12.7 TUZATISH: PrismaService bu yerdan OLIB TASHLANDI.
  //
  // PrismaModule allaqachon @Global — bu yerda qayta e'lon qilinsa,
  // Nest IKKINCHI PrismaClient nusxasini yaratardi, ya'ni IKKITA
  // alohida baza ulanish havzasi. Bu:
  //   - baza ulanishlari sonini ikki barobar oshiradi
  //     (Render/Supabase limitiga tez uriladi)
  //   - tenant-guard middleware'ini ikki marta o'rnatadi
  providers: [UploadsService],
})
export class UploadsModule {}