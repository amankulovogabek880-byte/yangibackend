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
// Bucket nomi: "documents" (public bo'lishi kerak — Supabase dashboard'da
// Storage > New bucket > Public bucket ✅ yoqilgan bo'lishi kerak)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'documents';

let supabase: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

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

// v14 FIX (davomi): brauzer ba'zan `audio/webm;codecs=opus` kabi codecs
// qo'shimchasi bilan mimetype yuboradi — bu YUQORIDAGI aniq ro'yxatga
// mos kelmasdi va ovozli xabar baribir rad etilardi. Endi (1) codecs/params
// qismini olib tashlaymiz, (2) har qanday audio/image/video ni prefiks
// bo'yicha ham qabul qilamiz. Hujjatlar esa oldingidek ro'yxat bo'yicha.
function isAllowedMime(mimetype?: string): boolean {
  if (!mimetype) return false;
  const base = mimetype.split(';')[0].trim().toLowerCase();
  if (ALLOWED_MIME.has(base)) return true;
  return base.startsWith('image/') || base.startsWith('audio/') || base.startsWith('video/');
}

function safeFileName(original: string): string {
  const safe = original.replace(/[^a-zA-Z0-9.\-_]/g, '_');
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

  /**
   * Faylni Supabase Storage'ga yuklaydi va public URL qaytaradi.
   * Render'dagi diskdan farqli o'laroq, bu URL doimiy — deploy/restart
   * bo'lganda ham fayl o'chmaydi.
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
    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
    return { url: pub.publicUrl, path };
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
    return docs.map((d) => ({
      id: d.id,
      url: d.fileUrl,
      filename: d.fileName,
      originalName: d.name,
      mimeType: d.fileMimeType,
      size: d.fileSize,
      createdAt: d.createdAt,
    }));
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
   * Bitta fayl yuklash — Supabase Storage'ga saqlanadi (doimiy, Render
   * restart bo'lsa ham o'chmaydi). DB'ga ham yoziladi (Document jadvali).
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