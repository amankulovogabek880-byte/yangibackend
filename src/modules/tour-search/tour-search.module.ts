import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { TourAdapterRegistry } from './adapters/adapter-registry';
import { RatehawkAdapter } from './adapters/ratehawk.adapter';
import { getCatalog } from '../marketplace/operator-catalog';
import type { NormalizedSearchResult } from './adapters/tour-adapter.types';

/**
 * ═══════════════════════════════════════════════════════════════
 * TOUR-SEARCH MODULI — v1 (jonli qidiruv)
 * ═══════════════════════════════════════════════════════════════
 *
 * `marketplace` moduli — STATIK katalog (import/sync qilingan turlar,
 * DB'da saqlanadi, oddiy filtr/sahifalash bilan ko'riladi).
 *
 * Bu modul — JONLI qidiruv: agent sana/yo'nalish/mehmonlar kiritadi,
 * biz shu ONDA barcha ULANGAN va ADAPTER'GA EGA operatorlarga
 * PARALLEL so'rov yuboramiz va natijalarni bitta ro'yxatga
 * birlashtiramiz. Hech narsa DB'ga yozilmaydi (narx/joy tez eskiradi).
 *
 * Login/parol qayerdan olinadi:
 *   Alohida jadval OCHILMAYDI — `marketplace` moduli allaqachon
 *   `TourOperator` jadvalida (tenant, slug, credLogin, credPassword —
 *   shifrlangan) saqlaydi. Tenant operatorga "Sozlamalar → Tur
 *   operatorlar" orqali (marketplace/catalog/:slug/connect) bir marta
 *   ulanadi — bu modul faqat O'SHA yozuvni o'qiydi.
 * ═══════════════════════════════════════════════════════════════
 */

@Injectable()
export class TourSearchService {
  private readonly logger = new Logger('TourSearch');

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
    private registry: TourAdapterRegistry,
  ) {}

  private get db(): any {
    return this.prisma;
  }

  /** Shu tenant qaysi adapter-qo'llab-quvvatlaydigan operatorlarga ulangan */
  async listSearchableOperators(tenantId: string) {
    const catalog = getCatalog();
    const adapterSlugs = new Set(this.registry.registeredSlugs);

    const relevant = catalog.filter((c) => adapterSlugs.has(c.slug));
    if (relevant.length === 0) return { data: [] };

    const connected = await this.db.tourOperator.findMany({
      where: { tenantId, slug: { in: relevant.map((c) => c.slug) } },
      select: { slug: true, status: true, lastSyncError: true },
    });
    const bySlug = new Map(connected.map((c: any) => [c.slug, c]));

    return {
      data: relevant.map((c) => {
        const conn: any = bySlug.get(c.slug);
        return {
          slug: c.slug,
          name: c.name,
          logoUrl: c.logoUrl,
          connected: Boolean(conn),
          status: conn?.status || null,
        };
      }),
    };
  }

  /**
   * Bir nechta operatorda parallel qidiruv.
   * `operatorSlugs` berilmasa — tenant ulangan BARCHA adapter-qo'llab-
   * quvvatlaydigan operatorlarda qidiradi.
   */
  async search(tenantId: string, body: any) {
    const destination = String(body?.destination || '').trim();
    const checkin = String(body?.checkin || '').trim();
    const checkout = String(body?.checkout || '').trim();
    const adults = Math.max(1, Number(body?.adults) || 2);
    const childrenAges = Array.isArray(body?.childrenAges)
      ? body.childrenAges.map((n: any) => Number(n)).filter(Number.isFinite)
      : [];
    const currency = String(body?.currency || 'USD').toUpperCase();
    const requestedSlugs: string[] | null = Array.isArray(body?.operatorSlugs)
      ? body.operatorSlugs.map((s: any) => String(s).toLowerCase())
      : null;

    if (!destination) throw new BadRequestException('destination (yo\'nalish) kiritilishi shart');
    if (!checkin || !checkout) {
      throw new BadRequestException('checkin va checkout (YYYY-MM-DD) kiritilishi shart');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) {
      throw new BadRequestException('Sana formati: YYYY-MM-DD');
    }

    const adapterSlugs = this.registry.registeredSlugs.filter(
      (s) => !requestedSlugs || requestedSlugs.includes(s),
    );
    if (adapterSlugs.length === 0) {
      return { data: [], errors: [], searchedOperators: [] };
    }

    const operators = await this.db.tourOperator.findMany({
      where: { tenantId, slug: { in: adapterSlugs }, status: { not: 'INACTIVE' } },
    });

    if (operators.length === 0) {
      throw new BadRequestException(
        "Hech qanday operatorga ulanmagansiz. Avval Sozlamalar → Tur operatorlar bo'limida ulaning.",
      );
    }

    const params = {
      destination,
      checkin,
      checkout,
      adults,
      childrenAges,
      currency,
    };

    const errors: { slug: string; name: string; message: string }[] = [];
    const results: NormalizedSearchResult[] = [];

    // Parallel — bitta operator sekin/xato bo'lsa boshqalarni to'xtatmaydi.
    await Promise.all(
      operators.map(async (op: any) => {
        const adapter = this.registry.get(op.slug);
        if (!adapter) return; // ehtiyot chorasi — registryda bo'lmasa o'tkazib yuboriladi

        const login = op.credLogin ? this.encryption.decrypt(op.credLogin) : '';
        const password = op.credPassword ? this.encryption.decrypt(op.credPassword) : '';
        if (!password) {
          errors.push({ slug: op.slug, name: op.name, message: 'Kirish ma\'lumotlari topilmadi' });
          return;
        }

        try {
          const found = await adapter.searchLive(
            { login: login || '', password },
            params,
          );
          for (const item of found) {
            item.operatorName = op.name;
            results.push(item);
          }
        } catch (e: any) {
          this.logger.warn(`Qidiruv xatosi [${op.slug}]: ${e?.message}`);
          errors.push({ slug: op.slug, name: op.name, message: e?.message || "Noma'lum xato" });
        }
      }),
    );

    results.sort((a, b) => a.price - b.price);

    return {
      data: results,
      errors,
      searchedOperators: operators.map((o: any) => o.slug),
    };
  }
}

@Controller('tour-search')
@UseGuards(JwtAuthGuard)
export class TourSearchController {
  constructor(private service: TourSearchService) {}

  @Get('operators')
  operators(@CurrentUser() user: any) {
    return this.service.listSearchableOperators(user.tenantId);
  }

  /**
   * body: { destination, checkin, checkout, adults, childrenAges?, currency?, operatorSlugs? }
   */
  @Post('search')
  search(@CurrentUser() user: any, @Body() body: any) {
    return this.service.search(user.tenantId, body);
  }
}

@Module({
  controllers: [TourSearchController],
  providers: [TourSearchService, TourAdapterRegistry, RatehawkAdapter],
  exports: [TourAdapterRegistry],
})
export class TourSearchModule {}