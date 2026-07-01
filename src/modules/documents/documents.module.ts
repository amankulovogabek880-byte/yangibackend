import {
  Module, Injectable, Controller, Get, Post, Delete, Param, Body, Query,
  UseGuards, UseInterceptors, UploadedFile, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { safeEnum, paginate, meta } from '../../common/utils/helpers';
import { Prisma } from '@prisma/client';
import { DocumentCategory } from '../../prisma-types';;

const CATEGORIES: DocumentCategory[] = [
  'PASSPORT', 'VISA', 'TICKET', 'CONTRACT', 'INVOICE', 'RECEIPT', 'PHOTO', 'OTHER',
];

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_FILE_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB || '20')) * 1024 * 1024;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService) {}

  async list(tenantId: string, userId: string, role: string, params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where: any = { tenantId };
    if (params.clientId) where.clientId = params.clientId;
    if (params.bookingId) where.bookingId = params.bookingId;
    if (params.category) where.category = params.category as DocumentCategory;
    if (role === 'AGENT') {
      where.OR = [
        { uploadedById: userId },
        { client: { assignedAgentId: userId } },
        { booking: { agentId: userId } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.document.findMany({
        where, skip, take,
        include: {
          uploadedBy: { select: { id: true, name: true } },
          client: { select: { id: true, fullName: true } },
          booking: { select: { id: true, bookingRef: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.document.count({ where }),
    ]);
    return { data, meta: meta(total, page, limit) };
  }

  async create(tenantId: string, userId: string, file: Express.Multer.File, data: any) {
    if (!file) throw new BadRequestException('Fayl yuklanmagan');

    return this.prisma.document.create({
      data: {
        tenantId,
        uploadedById: userId,
        clientId: data.clientId,
        bookingId: data.bookingId,
        name: data.name || file.originalname,
        category: safeEnum(data.category, CATEGORIES, 'OTHER'),
        fileName: file.originalname,
        // BUG FIX: avval `|| process.env.FRONTEND_URL?.replace('3001','3000')`
        // degan noto'g'ri zaxira bor edi — agar API_BASE_URL o'rnatilmagan bo'lsa,
        // bu FRONTEND (Vercel) domenidan URL yasab, "/uploads/..." fayllarini
        // frontendning o'zidan qidirar edi (u yerda bunday route yo'q — 404).
        // Endi boshqa barcha joylardagi (telegram modullari) bilan bir xil: faqat
        // API_BASE_URL (backend manzili) ishlatiladi.
        fileUrl: `${process.env.API_BASE_URL || 'http://localhost:3000'}/uploads/${file.filename}`,
        fileMimeType: file.mimetype,
        fileSize: file.size,
        description: data.description,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        documentNo: data.documentNo,
      },
    });
  }

  async delete(tenantId: string, userId: string, role: string, id: string) {
    const doc = await this.prisma.document.findFirst({ where: { id, tenantId } });
    if (!doc) throw new NotFoundException('Topilmadi');
    if (role === 'AGENT' && doc.uploadedById !== userId) {
      throw new BadRequestException("Faqat o'zingiz yuklagan faylni o'chira olasiz");
    }
    // Delete file from disk
    try {
      const filePath = path.join(UPLOAD_DIR, path.basename(doc.fileUrl));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
    await this.prisma.document.delete({ where: { id } });
    return { ok: true };
  }
}

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private svc: DocumentsService) {}

  @Get()
  list(
    @CurrentUser() u: any,
    @Query('clientId') clientId?: string,
    @Query('bookingId') bookingId?: string,
    @Query('category') category?: string,
    @Query('page') page?: any,
    @Query('limit') limit?: any,
  ) {
    return this.svc.list(u.tenantId, u.sub, u.role, { clientId, bookingId, category, page, limit });
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: UPLOAD_DIR,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || '';
        cb(null, `${uuid()}${ext}`);
      },
    }),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
      const ok = /\.(jpg|jpeg|png|gif|pdf|docx?|xlsx?|txt|webp)$/i.test(file.originalname);
      if (!ok) return cb(new BadRequestException('Fayl turi qabul qilinmaydi'), false);
      cb(null, true);
    },
  }))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @CurrentUser() u: any,
  ) {
    return this.svc.create(u.tenantId, u.sub, file, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, u.sub, u.role, id);
  }
}

@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}