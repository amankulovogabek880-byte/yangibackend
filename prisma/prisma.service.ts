import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { installTenantGuard } from '../common/tenant/tenant-guard.prisma';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');

    // v12.7: tenant izolyatsiyasining IKKINCHI himoya qatlami.
    // Servis metodidagi `where: { tenantId }` unutilsa, bu yerda
    // ushlanadi. TENANT_GUARD env bilan boshqariladi
    // (off | warn | enforce, standart: warn).
    installTenantGuard(this);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}