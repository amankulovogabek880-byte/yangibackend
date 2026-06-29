"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoicesModule = exports.PublicInvoicesController = exports.InvoicesController = exports.InvoicesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const helpers_1 = require("../../common/utils/helpers");
const notifications_service_1 = require("../notifications/notifications.service");
;
const STATUSES = [
    'DRAFT', 'ISSUED', 'SENT', 'PARTIALLY_PAID',
    'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED',
];
const CURRENCIES = ['USD', 'UZS', 'EUR', 'RUB'];
let InvoicesService = class InvoicesService {
    constructor(prisma, notifications) {
        this.prisma = prisma;
        this.notifications = notifications;
    }
    where(tenantId, userId, role, extra = {}) {
        const where = { tenantId, ...extra };
        if (role === 'AGENT')
            where.agentId = userId;
        return where;
    }
    async list(tenantId, userId, role, params) {
        const { skip, take, page, limit } = (0, helpers_1.paginate)(params.page, params.limit);
        const where = this.where(tenantId, userId, role);
        if (params.status)
            where.status = params.status;
        if (params.bookingId)
            where.bookingId = params.bookingId;
        if (params.clientId)
            where.clientId = params.clientId;
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
        return { data, meta: (0, helpers_1.meta)(total, page, limit) };
    }
    async findOne(tenantId, id, userId, role) {
        const inv = await this.prisma.invoice.findFirst({
            where: this.where(tenantId, userId, role, { id }),
            include: {
                client: true,
                booking: true,
                agent: { select: { id: true, name: true, email: true } },
            },
        });
        if (!inv)
            throw new common_1.NotFoundException('Invoice topilmadi');
        return inv;
    }
    async generateNumber(tenantId) {
        const year = new Date().getFullYear();
        const count = await this.prisma.invoice.count({
            where: { tenantId, createdAt: { gte: new Date(`${year}-01-01`) } },
        });
        return `INV-${year}-${String(count + 1).padStart(4, '0')}`;
    }
    calcProfit(data) {
        const sale = Number(data.salePrice) || 0;
        const cost = Number(data.providerCost) || 0;
        const discount = Number(data.discount) || 0;
        return Math.max(0, sale - cost - discount);
    }
    async create(tenantId, userId, role, data) {
        const sale = Number(data.salePrice || data.amount || data.totalAmount);
        if (!Number.isFinite(sale) || sale <= 0) {
            throw new common_1.BadRequestException("Summa (amount) musbat bo'lishi kerak");
        }
        data.salePrice = sale;
        let booking = null;
        if (data.bookingId) {
            booking = await this.prisma.booking.findFirst({
                where: { id: data.bookingId, tenantId },
                include: { client: true },
            });
            if (booking && role === 'AGENT' && booking.agentId !== userId) {
                throw new common_1.ForbiddenException("Bu booking sizga tegishli emas");
            }
        }
        const clientId = data.clientId || booking?.clientId;
        if (!clientId)
            throw new common_1.BadRequestException('clientId yoki bookingId majburiy');
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
                agentId: (booking?.agentId) || userId,
                providerCost: Number(data.providerCost) || 0,
                salePrice: sale,
                discount,
                taxAmount: tax,
                totalAmount,
                profit,
                currency: (0, helpers_1.safeEnum)(data.currency, CURRENCIES, booking.currency),
                status: (0, helpers_1.safeEnum)(data.status, STATUSES, 'DRAFT'),
                dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
                items: Array.isArray(data.items) ? data.items : [],
                notes: data.notes,
                internalNotes: data.internalNotes,
            },
        });
        return invoice;
    }
    async update(tenantId, id, userId, role, data) {
        const existing = await this.findOne(tenantId, id, userId, role);
        if (existing.status === 'PAID' || existing.status === 'CANCELLED') {
            const allowed = ['notes', 'internalNotes'];
            const filtered = {};
            for (const k of allowed)
                if (k in data)
                    filtered[k] = data[k];
            return this.prisma.invoice.update({ where: { id }, data: filtered });
        }
        const sale = data.salePrice !== undefined ? Number(data.salePrice) : existing.salePrice;
        const cost = data.providerCost !== undefined ? Number(data.providerCost) : existing.providerCost;
        const discount = data.discount !== undefined ? Number(data.discount) : existing.discount;
        const tax = data.taxAmount !== undefined ? Number(data.taxAmount) : existing.taxAmount;
        const safe = { ...data };
        if (safe.dueDate)
            safe.dueDate = new Date(safe.dueDate);
        if (safe.status)
            safe.status = (0, helpers_1.safeEnum)(safe.status, STATUSES, existing.status);
        if (safe.currency)
            safe.currency = (0, helpers_1.safeEnum)(safe.currency, CURRENCIES, existing.currency);
        safe.salePrice = sale;
        safe.providerCost = cost;
        safe.discount = discount;
        safe.taxAmount = tax;
        safe.totalAmount = sale - discount + tax;
        safe.profit = Math.max(0, sale - cost - discount);
        if (safe.paidAmount !== undefined) {
            const paid = Number(safe.paidAmount);
            if (paid >= safe.totalAmount)
                safe.status = 'PAID';
            else if (paid > 0)
                safe.status = 'PARTIALLY_PAID';
        }
        return this.prisma.invoice.update({ where: { id }, data: safe });
    }
    async delete(tenantId, id, userId, role) {
        if (role === 'AGENT') {
            throw new common_1.ForbiddenException("Faqat admin invoice o'chira oladi");
        }
        const inv = await this.findOne(tenantId, id, userId, role);
        if (inv.status === 'PAID') {
            throw new common_1.BadRequestException("To'langan invoice'ni o'chirib bo'lmaydi. Refund qiling.");
        }
        await this.prisma.invoice.delete({ where: { id } });
        return { ok: true };
    }
    async generatePdf(tenantId, id, userId, role) {
        const inv = await this.findOne(tenantId, id, userId, role);
        const html = this.buildHtml(inv, role);
        await this.prisma.invoice.update({
            where: { id },
            data: { pdfGeneratedAt: new Date() },
        });
        return { html, invoiceNumber: inv.invoiceNumber };
    }
    async sendViaTelegram(tenantId, id, userId, role) {
        const inv = await this.findOne(tenantId, id, userId, role);
        if (!inv.client?.telegramId && !inv.client?.telegramUsername) {
            throw new common_1.BadRequestException("Klientning Telegram ma'lumotlari yo'q");
        }
        const updated = await this.prisma.invoice.update({
            where: { id },
            data: {
                sentViaTelegram: true,
                sentAt: new Date(),
                status: inv.status === 'DRAFT' ? 'SENT' : inv.status,
            },
        });
        if (inv.agentId) {
            this.notifications.create({
                tenantId, userId: inv.agentId,
                type: 'SYSTEM',
                title: '📨 Invoice yuborildi',
                body: `${inv.invoiceNumber} → ${inv.client?.fullName}`,
                link: `/invoices/${inv.id}`,
                metadata: { invoiceId: inv.id },
            }).catch(() => { });
        }
        return updated;
    }
    async publicView(invoiceNumber) {
        const inv = await this.prisma.invoice.findFirst({
            where: { invoiceNumber },
            include: {
                client: { select: { fullName: true, phone: true, email: true } },
                booking: { select: { bookingRef: true, tourName: true, destination: true, departureDate: true, returnDate: true } },
            },
        });
        if (!inv)
            throw new common_1.NotFoundException('Invoice topilmadi');
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
        };
    }
    buildHtml(inv, role) {
        const showInternal = role !== 'PUBLIC';
        const items = Array.isArray(inv.items) ? inv.items : [];
        const itemRows = items.length > 0
            ? items.map((it) => `
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
};
exports.InvoicesService = InvoicesService;
exports.InvoicesService = InvoicesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_service_1.NotificationsService])
], InvoicesService);
let InvoicesController = class InvoicesController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, search, status, bookingId, clientId, page, limit) {
        return this.svc.list(u.tenantId, u.sub, u.role, {
            search, status, bookingId, clientId, page, limit,
        });
    }
    one(id, u) {
        return this.svc.findOne(u.tenantId, id, u.sub, u.role);
    }
    create(body, u) {
        return this.svc.create(u.tenantId, u.sub, u.role, body);
    }
    update(id, body, u) {
        return this.svc.update(u.tenantId, id, u.sub, u.role, body);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, id, u.sub, u.role);
    }
    async pdf(id, u, res) {
        const { html } = await this.svc.generatePdf(u.tenantId, id, u.sub, u.role);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    }
    sendTelegram(id, u) {
        return this.svc.sendViaTelegram(u.tenantId, id, u.sub, u.role);
    }
};
exports.InvoicesController = InvoicesController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('search')),
    __param(2, (0, common_1.Query)('status')),
    __param(3, (0, common_1.Query)('bookingId')),
    __param(4, (0, common_1.Query)('clientId')),
    __param(5, (0, common_1.Query)('page')),
    __param(6, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, Object, Object]),
    __metadata("design:returntype", void 0)
], InvoicesController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], InvoicesController.prototype, "one", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], InvoicesController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], InvoicesController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], InvoicesController.prototype, "delete", null);
__decorate([
    (0, common_1.Get)(':id/pdf'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], InvoicesController.prototype, "pdf", null);
__decorate([
    (0, common_1.Post)(':id/send-telegram'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], InvoicesController.prototype, "sendTelegram", null);
exports.InvoicesController = InvoicesController = __decorate([
    (0, common_1.Controller)('invoices'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [InvoicesService])
], InvoicesController);
let PublicInvoicesController = class PublicInvoicesController {
    constructor(svc) {
        this.svc = svc;
    }
    view(number) {
        return this.svc.publicView(number);
    }
};
exports.PublicInvoicesController = PublicInvoicesController;
__decorate([
    (0, common_1.Get)(':invoiceNumber'),
    (0, decorators_1.Public)(),
    __param(0, (0, common_1.Param)('invoiceNumber')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PublicInvoicesController.prototype, "view", null);
exports.PublicInvoicesController = PublicInvoicesController = __decorate([
    (0, common_1.Controller)('public/invoices'),
    __metadata("design:paramtypes", [InvoicesService])
], PublicInvoicesController);
let InvoicesModule = class InvoicesModule {
};
exports.InvoicesModule = InvoicesModule;
exports.InvoicesModule = InvoicesModule = __decorate([
    (0, common_1.Module)({
        controllers: [InvoicesController, PublicInvoicesController],
        providers: [InvoicesService],
        exports: [InvoicesService],
    })
], InvoicesModule);
//# sourceMappingURL=invoices.module.js.map