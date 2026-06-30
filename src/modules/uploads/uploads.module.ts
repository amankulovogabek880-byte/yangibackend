import {
  Module, Injectable, Controller, Post, Get, Delete, UseGuards,
  UploadedFile, UseInterceptors, BadRequestException,
  UploadedFiles, Query, Param, NotFoundException,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentCategory } from '@prisma/client';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const BASE_URL = process.env.PUBLIC_URL || 'http://localhost:3000';

// Telegramga ham yaroqli URL formati
function publicUrl(filename: string): string {
  return `${BASE_URL}/uploads/${filename}`;
}

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

@Injectable()
export class UploadsService {
  constructor(private prisma: PrismaService) {}

  // Entity turi → DocumentCategory + qaysi FK ustunga yozish
  private mapEntity(entityType?: string, entityId?: string) {
    const t = (entityType || '').toLowerCase();
    if (t === 'booking') return { bookingId: entityId };
    if (t === 'client')  return { clientId: entityId };
    return {};
  }

  async saveRecord(
    tenantId: string, uploadedById: string,
    file: Express.Multer.File,
    entityType?: string, entityId?: string,
  ) {
    const link = this.mapEntity(entityType, entityId);
    return this.prisma.document.create({
      data: {
        tenantId,
        uploadedById,
        name: file.originalname,
        fileName: file.filename,
        fileUrl: publicUrl(file.filename),
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
      // entityType berilmagan — ikkalasidan ham qidiramiz
      where.OR = [{ bookingId: entityId }, { clientId: entityId }];
    }
    const docs = await this.prisma.document.findMany({
      where, orderBy: { createdAt: 'desc' },
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
    await this.prisma.document.delete({ where: { id } });
    return { ok: true };
  }
}

@Controller('uploads')
export class UploadsController {
  constructor(private svc: UploadsService) {}

  /**
   * v6: Bitta fayl yuklash (inbox, template, klient hujjati uchun)
   * v10: DB ga ham yoziladi (Document jadvali) — Render restart bo'lganda
   * fayl o'chib ketsa ham metadata saqlanib qoladi va xato bermaydi.
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: UPLOAD_DIR,
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${Date.now()}-${safe}`);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        cb(new BadRequestException(`Fayl turi qo'llab-quvvatlanmaydi: ${file.mimetype}`), false);
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

    // DB ga yozamiz (agar entityType/entityId berilgan bo'lsa)
    let docId: string | undefined;
    if (entityType && entityId) {
      const doc = await this.svc.saveRecord(u.tenantId, u.sub, file, entityType, entityId);
      docId = doc.id;
    }

    return {
      id: docId,
      url: publicUrl(file.filename),
      filename: file.filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      type: isImage ? 'image' : isVideo ? 'video' : 'document',
    };
  }

  /**
   * v10: Hujjatlar ro'yxati — entityType + entityId bo'yicha
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
   * v10: Hujjatni o'chirish
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.remove(u.tenantId, id);
  }

  /**
   * v6: Bir nechta fayl (mehmonxona galereya — bir vaqtning o'zida 5-10 ta rasm)
   */
  @Post('batch')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 10, {
    storage: diskStorage({
      destination: UPLOAD_DIR,
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        cb(new BadRequestException(`Fayl turi: ${file.mimetype} qo'llab-quvvatlanmaydi`), false);
        return;
      }
      cb(null, true);
    },
  }))
  uploadBatch(@UploadedFiles() files: Express.Multer.File[], @CurrentUser() u: any) {
    if (!files?.length) throw new BadRequestException('Fayllar yo\'q');
    return {
      count: files.length,
      files: files.map((f) => {
        const isImage = f.mimetype.startsWith('image/');
        const isVideo = f.mimetype.startsWith('video/');
        return {
          url: publicUrl(f.filename),
          filename: f.filename,
          originalName: f.originalname,
          mimeType: f.mimetype,
          size: f.size,
          type: isImage ? 'image' : isVideo ? 'video' : 'document',
        };
      }),
    };
  }
}

@Module({
  controllers: [UploadsController],
  providers: [UploadsService, PrismaService],
})
export class UploadsModule {}