import { Module, Controller, Get, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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
}

@Controller()
export class HealthController {
  constructor(private svc: HealthService) {}
  @Get('health') health() { return this.svc.check(); }
  @Get('health/ready') ready() { return this.svc.ready(); }
  @Get('health/live') live() { return { alive: true, time: new Date().toISOString() }; }
}

@Module({ controllers: [HealthController], providers: [HealthService] })
export class HealthModule {}
