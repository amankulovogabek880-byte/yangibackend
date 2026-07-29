// src/prisma/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { installTenantGuard } from '../common/tenant/tenant-guard.prisma';

/**
 * 🩹 MUHIM TUZATISH: Render'dagi Postgres (ayniqsa bepul/kichik tarif)
 * uzoq bo'sh turgan ulanishlarni o'zi yopib qo'yadi ("Server has closed
 * the connection" / Prisma xato kodi P1017). Bu holatda Prisma o'sha
 * "o'lik" ulanishdan foydalanishga urinib, so'rovni butunlay
 * muvaffaqiyatsizlikka uchratadi — garchi bazaning o'zi ishlab turgan
 * bo'lsa ham. Natijada foydalanuvchiga tushunarsiz "Invalid
 * prisma.tenant.findUnique() invocation" xatosi chiqadi va (frontendda
 * bu xato yashirilgan joylarda) butunlay bo'sh sahifa ko'rinadi.
 *
 * YECHIM: har bir so'rovni $use middleware orqali o'raymiz — agar
 * xato "ulanish yopilgan" turkumidan bo'lsa, ulanishni QAYTA o'rnatib,
 * so'rovni BIR MARTA qayta urinib ko'ramiz (foydalanuvchiga sezilmaydi).
 */
const CONN_CLOSED_RE = /server has closed the connection|connection.*(closed|reset|terminated)|econnreset|the database server was reachable/i;

function isConnClosedError(e: any): boolean {
  if (!e) return false;
  if (e.code === 'P1017' || e.code === 'P1001' || e.code === 'P1008') return true;
  return CONN_CLOSED_RE.test(String(e.message || ''));
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');

  async onModuleInit() {
    await this.connectWithRetry();
    installTenantGuard(this);

    this.$use(async (params, next) => {
      try {
        return await next(params);
      } catch (e: any) {
        if (!isConnClosedError(e)) throw e;
        this.logger.warn(
          `DB ulanishi uzilgan edi (${params.model || ''}.${params.action}) — qayta ` +
          `ulanib, so'rovni qayta yubormoqda...`,
        );
        try {
          await this.$disconnect();
          await this.$connect();
          return await next(params);
        } catch {
          throw e; // qayta urinish ham muvaffaqiyatsiz — asl xatoni chiqaramiz
        }
      }
    });
  }

  private async connectWithRetry(retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        await this.$connect();
        this.logger.log('Database connected');
        return;
      } catch (e: any) {
        this.logger.warn(`DB ulanish urinishi ${i + 1}/${retries} muvaffaqiyatsiz: ${e?.message}`);
        if (i === retries - 1) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}