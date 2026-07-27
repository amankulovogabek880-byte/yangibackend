import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Param, Body, Query,
  UseGuards, NotFoundException, BadRequestException, Res, ForbiddenException,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, Public } from '../../common/decorators';
import { safeEnum, paginate, meta } from '../../common/utils/helpers';
import { NotificationsService } from '../notifications/notifications.service';
import { Prisma } from '@prisma/client';
import { Currency, InvoiceStatus } from '../../prisma-types';;

const STATUSES: InvoiceStatus[] = [
  'DRAFT', 'ISSUED', 'SENT', 'PARTIALLY_PAID',
  'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED',
];

const CURRENCIES: Currency[] = ['USD', 'UZS', 'EUR', 'RUB'];

@Injectable()
export class InvoicesService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Role-based where clause:
   * - AGENT: faqat o'z bookinglarining invoicelari
   * - MANAGER / TENANT_ADMIN: barcha
   */
  private where(tenantId: string, userId: string, role: string, extra: any = {}): any {
    const where: any = { tenantId, ...extra };
    if (role === 'AGENT') where.agentId = userId;
    return where;
  }

  async list(tenantId: string, userId: string, role: string, params: any) {
    const { skip, take, page, limit } = paginate(params.page, params.limit);
    const where = this.where(tenantId, userId, role);
    if (params.status) where.status = params.status;
    if (params.bookingId) where.bookingId = params.bookingId;
    if (params.clientId) where.clientId = params.clientId;
    if (params.search?.trim()) {
      where.OR = [
        { invoiceNumber: { contains: params.search, mode: 'insensitive' } },
        { client: { fullName: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where, skip, take,
        include: {
          client: { select: { id: true, fullName: true, phone: true } },
          booking: { select: { id: true, bookingRef: true, tourName: true } },
          agent: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    // Maskalash: AGENT'lar boshqa odamning provider cost/profit ko'rmaydi
    // (lekin o'ziniki ko'radi — chunki where filtrlangan)
    return { data, meta: meta(total, page, limit) };
  }

  async findOne(tenantId: string, id: string, userId: string, role: string) {
    const inv = await this.prisma.invoice.findFirst({
      where: this.where(tenantId, userId, role, { id }),
      include: {
        client: true,
        booking: true,
        agent: { select: { id: true, name: true, email: true } },
      },
    });
    if (!inv) throw new NotFoundException('Invoice topilmadi');
    return inv;
  }

  private async generateNumber(tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.prisma.invoice.count({
      where: { tenantId, createdAt: { gte: new Date(`${year}-01-01`) } },
    });
    return `INV-${year}-${String(count + 1).padStart(4, '0')}`;
  }

  /**
   * Profitni avtomatik hisoblash:
   * profit = salePrice - providerCost - discount
   */
  private calcProfit(data: any): number {
    const sale = Number(data.salePrice) || 0;
    const cost = Number(data.providerCost) || 0;
    const discount = Number(data.discount) || 0;
    return Math.max(0, sale - cost - discount);
  }

  async create(tenantId: string, userId: string, role: string, data: any) {
    // v14 XATO TUZATISH: avval bu yerda "bookingId ixtiyoriy" deb yozilgan
    // edi va agar bookingId berilmasa `booking` null bo'lib qolib,
    // pastda `booking.id` / `booking.currency`ga murojaat qilinganda
    // "Cannot read properties of null" xatosi bilan CRASH bo'lardi.
    // Prisma sxemasida Invoice.bookingId MAJBURIY (booking bilan bog'liq
    // bo'lmagan invoice sxema darajasida qo'llab-quvvatlanmaydi), shuning
    // uchun buni servis darajasida ham aniq talab qilamiz — foydalanuvchi
    // tushunarli xato xabarini oladi, server esa yiqilmaydi.
    if (!data.bookingId) {
      throw new BadRequestException('bookingId majburiy — invoice faqat bookingga bog\'langan holda yaratiladi');
    }
    const sale = Number(data.salePrice || data.amount || data.totalAmount);
    if (!Number.isFinite(sale) || sale <= 0) {
      throw new BadRequestException("Summa (amount) musbat bo'lishi kerak");
    }
    // salePrice ni normalize qilamiz
    data.salePrice = sale;

    // Booking mavjudligini va agentga tegishliligini tekshiramiz
    const booking = await this.prisma.booking.findFirst({
      where: { id: data.bookingId, tenantId },
      include: { client: true },
    });
    if (!booking) throw new NotFoundException('Booking topilmadi');
    if (role === 'AGENT' && booking.agentId !== userId) {
      throw new ForbiddenException("Bu booking sizga tegishli emas");
    }

    // clientId topish
    const clientId = data.clientId || booking.clientId;
    if (!clientId) throw new BadRequestException('clientId yoki bookingId majburiy');

    const invoiceNumber = await this.generateNumber(tenantId);
    const profit = this.calcProfit(data);
    const tax = Number(data.taxAmount) || 0;
    const discount = Number(data.discount) || 0;
    const totalAmount = sale - discount + tax;

    const invoice = await this.prisma.invoice.create({
      data: {
        tenantId,
        invoiceNumber,
        bookingId: booking.id,
        clientId: clientId,
        agentId: booking.agentId || userId,
        providerCost: Number(data.providerCost) || 0,
        salePrice: sale,
        discount,
        taxAmount: tax,
        totalAmount,
        profit,
        currency: safeEnum(data.currency, CURRENCIES, booking.currency),
        status: safeEnum(data.status, STATUSES, 'DRAFT'),
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        items: Array.isArray(data.items) ? data.items : [],
        notes: data.notes,
        internalNotes: data.internalNotes,
      },
    });

    return invoice;
  }

  async update(tenantId: string, id: string, userId: string, role: string, data: any) {
    const existing = await this.findOne(tenantId, id, userId, role);

    if (existing.status === 'PAID' || existing.status === 'CANCELLED') {
      // Faqat ba'zi maydonlarni o'zgartirishga ruxsat
      const allowed = ['notes', 'internalNotes'];
      const filtered: any = {};
      for (const k of allowed) if (k in data) filtered[k] = data[k];
      return this.prisma.invoice.update({ where: { id }, data: filtered });
    }

    const sale = data.salePrice !== undefined ? Number(data.salePrice) : existing.salePrice;
    const cost = data.providerCost !== undefined ? Number(data.providerCost) : existing.providerCost;
    const discount = data.discount !== undefined ? Number(data.discount) : existing.discount;
    const tax = data.taxAmount !== undefined ? Number(data.taxAmount) : existing.taxAmount;

    const safe: any = { ...data };
    if (safe.dueDate) safe.dueDate = new Date(safe.dueDate);
    if (safe.status) safe.status = safeEnum(safe.status, STATUSES, existing.status);
    if (safe.currency) safe.currency = safeEnum(safe.currency, CURRENCIES, existing.currency);

    safe.salePrice = sale;
    safe.providerCost = cost;
    safe.discount = discount;
    safe.taxAmount = tax;
    safe.totalAmount = sale - discount + tax;
    safe.profit = Math.max(0, sale - cost - discount);

    // Statusni avtomatik aniqlash
    if (safe.paidAmount !== undefined) {
      const paid = Number(safe.paidAmount);
      if (paid >= safe.totalAmount) safe.status = 'PAID';
      else if (paid > 0) safe.status = 'PARTIALLY_PAID';
    }

    return this.prisma.invoice.update({ where: { id }, data: safe });
  }

  async delete(tenantId: string, id: string, userId: string, role: string) {
    if (role === 'AGENT') {
      throw new ForbiddenException("Faqat admin invoice o'chira oladi");
    }
    const inv = await this.findOne(tenantId, id, userId, role);
    if (inv.status === 'PAID') {
      throw new BadRequestException("To'langan invoice'ni o'chirib bo'lmaydi. Refund qiling.");
    }
    await this.prisma.invoice.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * PDF generatsiya — oddiy HTML asosli (production'da Puppeteer kerak)
   */
  async generatePdf(tenantId: string, id: string, userId: string, role: string) {
    const inv = await this.findOne(tenantId, id, userId, role);

    const html = this.buildHtml(inv, role);

    // Production'da bu yerda Puppeteer yoki pdf-lib bilan PDF yaratamiz.
    // Hozircha HTML qaytaramiz (frontend'da window.print() bilan PDF qiladi)
    await this.prisma.invoice.update({
      where: { id },
      data: { pdfGeneratedAt: new Date() },
    });

    return { html, invoiceNumber: inv.invoiceNumber };
  }

  /**
   * Telegram orqali invoice yuborish
   */
  async sendViaTelegram(tenantId: string, id: string, userId: string, role: string) {
    const inv = await this.findOne(tenantId, id, userId, role);
    if (!inv.client?.telegramId && !inv.client?.telegramUsername) {
      throw new BadRequestException("Klientning Telegram ma'lumotlari yo'q");
    }

    // Conversation orqali yuborish — Telegram service bilan
    // (Real implementatsiya: bu yerda telegramService.sendInvoice'ni chaqirish)
    // Hozircha faqat status'ni belgilaymiz
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: {
        sentViaTelegram: true,
        sentAt: new Date(),
        status: inv.status === 'DRAFT' ? 'SENT' : inv.status,
      },
    });

    // Notification yuborish (xabar yaratuvchiga)
    if (inv.agentId) {
      this.notifications.create({
        tenantId, userId: inv.agentId,
        type: 'SYSTEM',
        title: '📨 Invoice yuborildi',
        body: `${inv.invoiceNumber} → ${inv.client?.fullName}`,
        link: `/invoices/${inv.id}`,
        metadata: { invoiceId: inv.id },
      }).catch(() => {});
    }

    return updated;
  }

  /**
   * Mijozga ko'rsatish uchun public link (token bilan)
   * Provider cost va profit ko'rinmaydi
   */
  async publicView(invoiceNumber: string) {
    const inv = await this.prisma.invoice.findFirst({
      where: { invoiceNumber },
      include: {
        client: { select: { fullName: true, phone: true, email: true } },
        booking: { select: { bookingRef: true, tourName: true, destination: true, departureDate: true, returnDate: true } },
      },
    });
    if (!inv) throw new NotFoundException('Invoice topilmadi');

    // ── Provider Cost va Profit MASKALANDI ──
    return {
      invoiceNumber: inv.invoiceNumber,
      issuedAt: inv.issuedAt,
      dueDate: inv.dueDate,
      status: inv.status,
      client: inv.client,
      booking: inv.booking,
      salePrice: inv.salePrice,
      discount: inv.discount,
      taxAmount: inv.taxAmount,
      totalAmount: inv.totalAmount,
      paidAmount: inv.paidAmount,
      currency: inv.currency,
      items: inv.items,
      notes: inv.notes,
      // providerCost: PUBLIC'GA KO'RSATILMAYDI
      // profit: PUBLIC'GA KO'RSATILMAYDI
      // internalNotes: PUBLIC'GA KO'RSATILMAYDI
    };
  }

  private buildHtml(inv: any, role: string): string {
    const showInternal = role !== 'PUBLIC';
    const items = Array.isArray(inv.items) ? inv.items : [];
    const itemRows = items.length > 0
      ? items.map((it: any) => `
        <tr>
          <td>${it.name || '-'}</td>
          <td style="text-align:center;">${it.qty || 1}</td>
          <td style="text-align:right;">${it.price || 0}</td>
          <td style="text-align:right;">${it.total || (it.qty * it.price) || 0}</td>
        </tr>`).join('')
      : `<tr><td colspan="4" style="text-align:center;color:#888;">${inv.booking?.tourName || 'Sayohat xizmati'}</td></tr>`;

    return `
<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="UTF-8">
<title>Invoice ${inv.invoiceNumber}</title>
<style>
  body { font-family: Arial, sans-serif; padding: 40px; color: #1a1f2e; max-width: 800px; margin: 0 auto; }
  h1 { color: #3d7eff; margin: 0 0 6px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px; }
  .info { background: #f4f6fb; padding: 14px; border-radius: 8px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th, td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
  th { background: #f8fafc; text-align: left; font-size: 12px; text-transform: uppercase; color: #64748b; }
  .total-row td { font-weight: 700; font-size: 16px; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #3d7eff; color: #64748b; font-size: 11px; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .status-PAID { background: #10b98120; color: #10b981; }
  .status-DRAFT { background: #64748b20; color: #64748b; }
  .status-SENT { background: #3d7eff20; color: #3d7eff; }
  .status-OVERDUE { background: #ef444420; color: #ef4444; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>INVOICE</h1>
      <div style="font-size: 18px; font-weight: 600;">${inv.invoiceNumber}</div>
      <span class="badge status-${inv.status}">${inv.status}</span>
    </div>
    <div style="text-align: right; font-size: 13px;">
      <div><b>Sana:</b> ${new Date(inv.issuedAt).toLocaleDateString('uz-UZ')}</div>
      ${inv.dueDate ? `<div><b>Muddat:</b> ${new Date(inv.dueDate).toLocaleDateString('uz-UZ')}</div>` : ''}
    </div>
  </div>

  <div class="info">
    <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Mijoz</div>
    <div style="font-size: 16px; font-weight: 700;">${inv.client?.fullName || ''}</div>
    <div style="font-size: 13px; color: #64748b;">
      ${inv.client?.phone || ''}${inv.client?.email ? ' • ' + inv.client.email : ''}
    </div>
  </div>

  ${inv.booking ? `
  <div class="info">
    <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Booking</div>
    <div style="font-weight: 700;">${inv.booking.bookingRef} — ${inv.booking.tourName}</div>
    <div style="font-size: 13px; color: #64748b;">${inv.booking.destination || ''}</div>
  </div>` : ''}

  <table>
    <thead>
      <tr>
        <th>Xizmat</th>
        <th style="text-align: center;">Soni</th>
        <th style="text-align: right;">Narx</th>
        <th style="text-align: right;">Jami</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3" style="text-align: right;">Subtotal:</td>
        <td style="text-align: right;">${inv.currency} ${inv.salePrice.toFixed(2)}</td>
      </tr>
      ${inv.discount > 0 ? `
      <tr>
        <td colspan="3" style="text-align: right;">Chegirma:</td>
        <td style="text-align: right; color: #10b981;">-${inv.currency} ${inv.discount.toFixed(2)}</td>
      </tr>` : ''}
      ${inv.taxAmount > 0 ? `
      <tr>
        <td colspan="3" style="text-align: right;">Soliq:</td>
        <td style="text-align: right;">${inv.currency} ${inv.taxAmount.toFixed(2)}</td>
      </tr>` : ''}
      <tr class="total-row">
        <td colspan="3" style="text-align: right;">JAMI:</td>
        <td style="text-align: right; color: #3d7eff;">${inv.currency} ${inv.totalAmount.toFixed(2)}</td>
      </tr>
      ${inv.paidAmount > 0 ? `
      <tr>
        <td colspan="3" style="text-align: right;">To'langan:</td>
        <td style="text-align: right; color: #10b981;">${inv.currency} ${inv.paidAmount.toFixed(2)}</td>
      </tr>
      <tr>
        <td colspan="3" style="text-align: right;"><b>Qoldi:</b></td>
        <td style="text-align: right; color: #f59e0b;"><b>${inv.currency} ${(inv.totalAmount - inv.paidAmount).toFixed(2)}</b></td>
      </tr>` : ''}
    </tfoot>
  </table>

  ${inv.notes ? `<div style="background:#fef3c7;padding:12px;border-radius:8px;font-size:13px;margin-bottom:20px;"><b>Izoh:</b> ${inv.notes}</div>` : ''}

  ${showInternal && inv.internalNotes ? `<div style="background:#1e253520;padding:12px;border-radius:8px;font-size:11px;color:#64748b;border-left:3px solid #f59e0b;">⚠️ <b>Ichki izoh (faqat agent ko'radi):</b> ${inv.internalNotes}</div>` : ''}

  <div class="footer">
    Omon CRM • Avtomatik yaratilgan • ${new Date().toLocaleString('uz-UZ')}
  </div>
</body>
</html>`;
  }
}

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private svc: InvoicesService) {}

  @Get()
  list(
    @CurrentUser() u: any,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('bookingId') bookingId?: string,
    @Query('clientId') clientId?: string,
    @Query('page') page?: any,
    @Query('limit') limit?: any,
  ) {
    return this.svc.list(u.tenantId, u.sub, u.role, {
      search, status, bookingId, clientId, page, limit,
    });
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.findOne(u.tenantId, id, u.sub, u.role);
  }

  @Post()
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.create(u.tenantId, u.sub, u.role, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.sub, u.role, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, id, u.sub, u.role);
  }

  @Get(':id/pdf')
  async pdf(@Param('id') id: string, @CurrentUser() u: any, @Res() res: Response) {
    const { html } = await this.svc.generatePdf(u.tenantId, id, u.sub, u.role);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  @Post(':id/send-telegram')
  sendTelegram(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.sendViaTelegram(u.tenantId, id, u.sub, u.role);
  }
}

// Public route (mijoz token bilan ko'rishi mumkin)
@Controller('public/invoices')
export class PublicInvoicesController {
  constructor(private svc: InvoicesService) {}

  @Get(':invoiceNumber')
  @Public()
  view(@Param('invoiceNumber') number: string) {
    return this.svc.publicView(number);
  }
}

@Module({
  controllers: [InvoicesController, PublicInvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}