import { Module, Controller, Get, Injectable, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators';

@Injectable()
export class HealthService {
  constructor(private prisma: PrismaService) {}

  async check() {
    const start = Date.now();
    let dbOk = false;
    let dbMs = 0;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
      dbMs = Date.now() - start;
    } catch {}

    const mem = process.memoryUsage();
    return {
      status: dbOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
      database: { status: dbOk ? 'connected' : 'disconnected', responseMs: dbMs },
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
    };
  }

  async ready() {
    try { await this.prisma.$queryRaw`SELECT 1`; return { ready: true }; }
    catch { return { ready: false }; }
  }

  // ═══════════════════════════════════════════════════════════════
  // XOTIRA DIAGNOSTIKASI (v20) — RAM sizib chiqishi (memory leak)ni
  // ANIQ topish uchun. Render grafigida RAM ko'tarilib ketayotganini
  // ko'rish mumkin, lekin QAYSI obyektlar xotirani band qilib
  // turganini KOD O'QISH orqali 100% aniqlab bo'lmaydi — buning
  // uchun jarayonning o'zidan "heap snapshot" (V8 xotira suratini)
  // olish kerak.
  //
  // ISHLATISH: RAM yana ko'tarilib, masalan 1.5GB+ ga yetganda,
  // shu endpointni chaqiring — u `.heapsnapshot` faylini qaytaradi.
  // Faylni yuklab, Claude'ga yuboring (yoki Chrome DevTools →
  // Memory → Load) — shunda ANIQ qaysi obyekt turlari (masalan
  // qandaydir Array, Buffer, EventEmitter listener) eng ko'p joy
  // band qilganini son bilan ko'rsatib beraman, taxmin qilmasdan.
  //
  // XAVFSIZLIK: faqat PLATFORM_OWNER chaqira oladi (controller'da
  // @Roles bilan himoyalangan). Snapshot olish paytida jarayon
  // bir necha soniya "qotib qolishi" mumkin (V8'ning normal xatti-
  // harakati) — shuning uchun buni faqat kerak bo'lganda, tekshirish
  // uchun chaqiring, doimiy monitoring sifatida emas.
  // ═══════════════════════════════════════════════════════════════
  async writeHeapSnapshot(): Promise<string> {
    // Dinamik import — `inspector` moduli faqat shu funksiya
    // chaqirilganda yuklanadi, oddiy ishlashga hech qanday
    // qo'shimcha xarajat qo'shmaydi.
    const inspector = await import('inspector');
    const filePath = path.join(
      os.tmpdir(),
      `heap-${new Date().toISOString().replace(/[:.]/g, '-')}.heapsnapshot`,
    );
    const fileStream = fs.createWriteStream(filePath);

    await new Promise<void>((resolve, reject) => {
      const session = new inspector.Session();
      session.connect();
      session.on('HeapProfiler.addHeapSnapshotChunk', (m: any) => {
        fileStream.write(m.params.chunk);
      });
      session.post('HeapProfiler.takeHeapSnapshot', undefined as any, (err: any) => {
        session.disconnect();
        fileStream.end();
        if (err) reject(err); else resolve();
      });
    });

    return filePath;
  }
}

@Controller()
export class HealthController {
  constructor(private svc: HealthService) {}
  @Get('health') health() { return this.svc.check(); }
  @Get('health/ready') ready() { return this.svc.ready(); }
  @Get('health/live') live() { return { alive: true, time: new Date().toISOString() }; }

  // Faqat PLATFORM_OWNER. RAM ko'tarilib ketganda chaqirib, faylni
  // yuklab oling va tahlil uchun yuboring.
  @Get('health/heap-dump')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PLATFORM_OWNER')
  async heapDump(@Res() res: Response) {
    const filePath = await this.svc.writeHeapSnapshot();
    res.download(filePath, path.basename(filePath), (err) => {
      // Yuklab bo'lingach vaqtinchalik faylni o'chiramiz — diskda
      // keraksiz qolib ketmasin.
      fs.unlink(filePath, () => {});
      if (err) res.status?.(500);
    });
  }
}

@Module({ controllers: [HealthController], providers: [HealthService] })
export class HealthModule {}