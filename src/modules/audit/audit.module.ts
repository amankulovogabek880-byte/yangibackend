import { Module, Global, Injectable, Controller, Get, Query, UseGuards, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermission } from '../../common/decorators';
import { paginate, meta } from '../../common/utils/helpers';

@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');
  constructor(private prisma: PrismaService) {}

  /**
   * Yangi audit log yaratish.
   * Hech qanday xatolikni yuqoriga uloqtirmaydi — log yozish faqat audit uchun.
   */
  async log(data: {
    tenantId?: string;
    userId?: string;
    action: string;
    entity: string;
    entityId?: string;
    changes?: any;
    metadata?: any;
    ip?: string;
    userAgent?: string;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: data.tenantId,
          userId: data.userId,
          action: data.action as any,
          entity: data.entity,
          entityId: data.entityId,
          changes: data.changes || {},
          metadata: data.metadata || {},
          ip: data.ip,
          userAgent: data.userAgent,
        },
      });
    } catch (e: any) {
      this.logger.warn(`Audit log yaratilmadi: ${e.message}`);
    }
  }

  async list(
    tenantId: string,
    params: {
      entity?: string;
      action?: string;
      userId?: string;
      from?: string;
      to?: string;
      page?: any;
      limit?: any;
    },
  ) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where: any = { tenantId };
    if (params.entity) where.entity = params.entity;
    if (params.action) where.action = params.action;
    if (params.userId) where.userId = params.userId;
    if (params.from || params.to) {
      where.createdAt = {};
      if (params.from) where.createdAt.gte = new Date(params.from);
      if (params.to) where.createdAt.lte = new Date(params.to);
    }
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take,
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data, meta: meta(total, page, limit) };
  }

  /** v17: Filtrlash uchun mavjud entity/action turlari (frontend dropdown uchun) */
  async filterOptions(tenantId: string) {
    const [entities, actions] = await Promise.all([
      this.prisma.auditLog.findMany({ where: { tenantId }, select: { entity: true }, distinct: ['entity'] }),
      this.prisma.auditLog.findMany({ where: { tenantId }, select: { action: true }, distinct: ['action'] }),
    ]);
    return {
      entities: entities.map((e) => e.entity).filter(Boolean).sort(),
      actions: actions.map((a) => a.action).filter(Boolean).sort(),
    };
  }
}

@Controller('audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('view_audit_log')
export class AuditController {
  constructor(private svc: AuditService) {}

  @Get()
  list(
    @CurrentUser() u: any,
    @Query('entity') entity?: string,
    @Query('action') action?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: any,
    @Query('limit') limit?: any,
  ) {
    return this.svc.list(u.tenantId, { entity, action, userId, from, to, page, limit });
  }

  @Get('filter-options')
  filterOptions(@CurrentUser() u: any) {
    return this.svc.filterOptions(u.tenantId);
  }
}

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}