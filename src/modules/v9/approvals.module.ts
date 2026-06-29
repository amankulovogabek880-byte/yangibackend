import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.module';

/**
 * v9: APPROVAL WORKFLOW
 *
 * Agent muhim o'zgarishlar uchun admin yoki manager tasdiqini so'raydi.
 *
 * Misol:
 *   - Chegirma berish (10%+)
 *   - Refund qaytarish
 *   - Booking bekor qilish
 *   - Narx o'zgarishi
 *
 * Jarayon:
 *   1. Agent yangi ApprovalRequest yaratadi (status: PENDING)
 *   2. Admin/Manager xabar oladi
 *   3. Admin tasdiqlash yoki rad etish bilan javob beradi
 *   4. Agar APPROVED bo'lsa - agent kerakli o'zgarishni qila oladi
 *   5. Audit log yoziladi
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private _prisma: PrismaService,
    private notifications: NotificationsService,
    private audit: AuditService,
  ) {}
  // v9: cast — yangi modellar uchun (Prisma generate kerak)
  private get prisma(): any { return this._prisma; }

  async create(
    tenantId: string,
    requesterId: string,
    data: {
      type: string;
      entityType: string;
      entityId: string;
      title: string;
      reason?: string;
      oldValue?: any;
      newValue?: any;
      amount?: number;
    }
  ) {
    if (!data.type) throw new BadRequestException('type kerak');
    if (!data.entityType || !data.entityId) {
      throw new BadRequestException('entityType va entityId kerak');
    }
    if (!data.title?.trim()) throw new BadRequestException('Sarlavha kerak');

    const request = await this.prisma.approvalRequest.create({
      data: {
        tenantId,
        requesterId,
        type: data.type as any,
        status: 'PENDING',
        entityType: data.entityType,
        entityId: data.entityId,
        title: data.title.trim(),
        reason: data.reason,
        oldValue: data.oldValue || null,
        newValue: data.newValue || null,
        amount: data.amount,
      },
      include: {
        requester: { select: { id: true, name: true } },
      },
    });

    // Adminlarga xabar yuboramiz
    const admins = await this.prisma.user.findMany({
      where: { tenantId, role: { in: ['TENANT_ADMIN', 'MANAGER'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.notifications.create({
        tenantId,
        userId: admin.id,
        type: 'APPROVAL_REQUESTED' as any,
        title: `🔔 Tasdiq so'raldi: ${data.title}`,
        body: `${request.requester.name} ${this.typeLabel(data.type)} bo'yicha tasdiq so'rayapti`,
        link: `/approvals/${request.id}`,
        metadata: { approvalId: request.id, type: data.type },
      });
    }

    // Audit
    this.audit.log({
      tenantId, userId: requesterId,
      action: 'CREATE', entity: 'approval', entityId: request.id,
      metadata: { type: data.type, entityType: data.entityType, entityId: data.entityId },
    });

    return request;
  }

  async list(
    tenantId: string,
    userId: string,
    role: string,
    params: { status?: string; type?: string; mine?: string }
  ) {
    const where: any = { tenantId };
    if (params.status) where.status = params.status;
    if (params.type) where.type = params.type;

    // Agent faqat o'z so'rovlarini ko'radi
    if (role === 'AGENT') {
      where.requesterId = userId;
    } else if (params.mine === 'true') {
      where.requesterId = userId;
    }

    return this.prisma.approvalRequest.findMany({
      where,
      include: {
        requester: { select: { id: true, name: true, avatarUrl: true } },
        reviewer: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async findOne(tenantId: string, id: string, userId: string, role: string) {
    const request = await this.prisma.approvalRequest.findFirst({
      where: { id, tenantId },
      include: {
        requester: { select: { id: true, name: true, avatarUrl: true, email: true } },
        reviewer: { select: { id: true, name: true, avatarUrl: true, email: true } },
      },
    });
    if (!request) throw new NotFoundException();

    // Agent faqat o'ziniki ko'radi
    if (role === 'AGENT' && request.requesterId !== userId) {
      throw new ForbiddenException();
    }
    return request;
  }

  async approve(tenantId: string, id: string, reviewerId: string, role: string, note?: string) {
    if (!['TENANT_ADMIN', 'MANAGER'].includes(role)) {
      throw new ForbiddenException('Faqat admin yoki manager tasdiqlay oladi');
    }

    const request = await this.prisma.approvalRequest.findFirst({
      where: { id, tenantId },
    });
    if (!request) throw new NotFoundException();
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Bu so\'rov allaqachon ko\'rib chiqilgan');
    }

    const updated = await this.prisma.approvalRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        reviewerId,
        reviewNote: note,
        reviewedAt: new Date(),
      },
    });

    // Tasdiq nimani qildi - ish bajaramiz
    await this.applyApproval(tenantId, updated);

    // Agentga xabar
    await this.notifications.create({
      tenantId,
      userId: request.requesterId,
      type: 'APPROVAL_APPROVED' as any,
      title: `✅ Tasdiqlandi: ${request.title}`,
      body: note || 'So\'rovingiz tasdiqlandi',
      link: `/approvals/${request.id}`,
      metadata: { approvalId: request.id },
    });

    this.audit.log({
      tenantId, userId: reviewerId,
      action: 'UPDATE', entity: 'approval', entityId: request.id,
      metadata: { action: 'approved', note },
    });

    return updated;
  }

  async reject(tenantId: string, id: string, reviewerId: string, role: string, note?: string) {
    if (!['TENANT_ADMIN', 'MANAGER'].includes(role)) {
      throw new ForbiddenException('Faqat admin yoki manager rad eta oladi');
    }

    const request = await this.prisma.approvalRequest.findFirst({
      where: { id, tenantId },
    });
    if (!request) throw new NotFoundException();
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Bu so\'rov allaqachon ko\'rib chiqilgan');
    }

    const updated = await this.prisma.approvalRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewerId,
        reviewNote: note,
        reviewedAt: new Date(),
      },
    });

    await this.notifications.create({
      tenantId,
      userId: request.requesterId,
      type: 'APPROVAL_REJECTED' as any,
      title: `❌ Rad etildi: ${request.title}`,
      body: note || 'So\'rovingiz rad etildi',
      link: `/approvals/${request.id}`,
      metadata: { approvalId: request.id },
    });

    this.audit.log({
      tenantId, userId: reviewerId,
      action: 'UPDATE', entity: 'approval', entityId: request.id,
      metadata: { action: 'rejected', note },
    });

    return updated;
  }

  async cancel(tenantId: string, id: string, userId: string) {
    const request = await this.prisma.approvalRequest.findFirst({
      where: { id, tenantId, requesterId: userId },
    });
    if (!request) throw new NotFoundException();
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Faqat kutilayotgan so\'rovni bekor qilish mumkin');
    }
    return this.prisma.approvalRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }

  /**
   * Tasdiqlangandan keyin haqiqiy ish bajariladi.
   * Masalan: chegirma tasdiqlangan bo'lsa - Booking narxini yangilash.
   */
  private async applyApproval(tenantId: string, request: any) {
    try {
      switch (request.type) {
        case 'DISCOUNT':
        case 'PRICE_CHANGE':
          if (request.entityType === 'booking' && request.newValue?.totalPrice) {
            await this.prisma.booking.update({
              where: { id: request.entityId },
              data: { totalPrice: request.newValue.totalPrice },
            });
          }
          break;

        case 'BOOKING_CANCEL':
          if (request.entityType === 'booking') {
            await this.prisma.booking.update({
              where: { id: request.entityId },
              data: {
                status: 'CANCELLED',
                cancelReason: request.reason || 'Approval orqali bekor qilindi',
              },
            });
          }
          break;

        // v9-FINAL: REFUND tasdiqlangach booking CANCELLED + profit nolga tushadi
        // Shu booking endi hisobotlarda foydaga qo'shilmaydi
        case 'REFUND':
          if (request.entityType === 'booking' || request.entityType === 'BOOKING') {
            await this.prisma.booking.update({
              where: { id: request.entityId },
              data: {
                status: 'CANCELLED',
                cancelReason: request.reason || `Refund: ${request.amount || 0}`,
                profit: 0,        // Foyda nolga
              } as any,
            });

            // Refund Payment record yaratamiz (manfiy summa bilan)
            try {
              const booking: any = await this.prisma.booking.findUnique({
                where: { id: request.entityId },
                select: { tenantId: true, clientId: true, currency: true } as any,
              });
              if (booking) {
                await this.prisma.payment.create({
                  data: {
                    tenantId: booking.tenantId,
                    clientId: booking.clientId,
                    bookingId: request.entityId,
                    amount: -Math.abs(request.amount || 0),
                    currency: booking.currency || 'USD',
                    method: 'CASH' as any,
                    status: 'COMPLETED' as any,
                    paidAt: new Date(),
                    note: `↩️ Refund: ${request.reason || 'Approval orqali'}`,
                  } as any,
                });
              }
            } catch (e) {
              // Payment yaratilmasa - approval baribir tasdiqlangan
            }
          }
          break;

        case 'PAYMENT_DELETE':
          if (request.entityType === 'payment') {
            await this.prisma.payment.delete({
              where: { id: request.entityId },
            });
          }
          break;

        case 'COMMISSION_OVERRIDE':
          // Faqat log qilamiz, haqiqiy o'zgarish qo'lda qilinadi
          break;
      }
    } catch (e) {
      // Apply muvaffaqiyatsiz bo'lsa ham approval qoldi
      console.error('Approval apply error:', e);
    }
  }

  private typeLabel(type: string): string {
    const labels: Record<string, string> = {
      DISCOUNT: '💰 Chegirma',
      REFUND: '↩️ Pul qaytarish',
      PRICE_CHANGE: '💵 Narx o\'zgarishi',
      BOOKING_CANCEL: '❌ Booking bekor',
      PAYMENT_DELETE: '🗑 To\'lov o\'chirish',
      COMMISSION_OVERRIDE: '📊 Komissiya o\'zgarishi',
      OTHER: 'Boshqa',
    };
    return labels[type] || type;
  }
}

@Controller('approvals')
@UseGuards(JwtAuthGuard)
export class ApprovalsController {
  constructor(private svc: ApprovalsService) {}

  @Get()
  list(
    @CurrentUser() u: any,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('mine') mine?: string,
  ) {
    return this.svc.list(u.tenantId, u.sub, u.role, { status, type, mine });
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.findOne(u.tenantId, id, u.sub, u.role);
  }

  @Post()
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.create(u.tenantId, u.sub, body);
  }

  @Post(':id/approve')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  approve(@Param('id') id: string, @Body() body: { note?: string }, @CurrentUser() u: any) {
    return this.svc.approve(u.tenantId, id, u.sub, u.role, body.note);
  }

  @Post(':id/reject')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  reject(@Param('id') id: string, @Body() body: { note?: string }, @CurrentUser() u: any) {
    return this.svc.reject(u.tenantId, id, u.sub, u.role, body.note);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.cancel(u.tenantId, id, u.sub);
  }
}

@Module({
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
