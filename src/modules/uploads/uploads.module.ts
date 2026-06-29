import {
  Module, Injectable, Controller, Post, UseGuards,
  UploadedFile, UseInterceptors, BadRequestException,
  UploadedFiles,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

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
export class UploadsService {}

@Controller('uploads')
export class UploadsController {
  /**
   * v6: Bitta fayl yuklash (inbox, template, klient hujjati uchun)
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
  uploadOne(@UploadedFile() file: Express.Multer.File, @CurrentUser() u: any) {
    if (!file) throw new BadRequestException('Fayl yuklanmadi');
    const isImage = file.mimetype.startsWith('image/');
    const isVideo = file.mimetype.startsWith('video/');
    return {
      url: publicUrl(file.filename),
      filename: file.filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      type: isImage ? 'image' : isVideo ? 'video' : 'document',
    };
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
  providers: [UploadsService],
})
export class UploadsModule {}
