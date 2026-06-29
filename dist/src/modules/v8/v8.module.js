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
var V8Service_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.V8Module = exports.V8Controller = exports.V8Service = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
let V8Service = V8Service_1 = class V8Service {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async checkDuplicate(tenantId, params) {
        const conditions = [];
        if (params.phone?.trim()) {
            const normalized = params.phone.replace(/[^\d]/g, '');
            conditions.push({ phone: { contains: normalized.slice(-9) } });
        }
        if (params.email?.trim()) {
            conditions.push({ email: { equals: params.email.toLowerCase().trim(), mode: 'insensitive' } });
        }
        if (params.telegramUsername?.trim()) {
            conditions.push({ telegramUsername: params.telegramUsername.replace(/^@/, '') });
        }
        if (!conditions.length) {
            return { found: false, matches: [] };
        }
        const matches = await this.prisma.client.findMany({
            where: {
                tenantId,
                OR: conditions,
            },
            select: {
                id: true, fullName: true, phone: true, email: true,
                telegramUsername: true, tier: true, pipelineStage: true,
                totalBookings: true, totalRevenue: true, createdAt: true,
                assignedAgent: { select: { id: true, name: true } },
            },
            take: 5,
        });
        return {
            found: matches.length > 0,
            count: matches.length,
            matches,
        };
    }
    async pickAgentForNewLead(tenantId) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { leadAssignmentStrategy: true },
        });
        if (!tenant)
            return null;
        const activeAgents = await this.prisma.user.findMany({
            where: { tenantId, status: 'ACTIVE', role: 'AGENT' },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
        });
        if (!activeAgents.length)
            return null;
        if (tenant.leadAssignmentStrategy === 'MANUAL') {
            return null;
        }
        if (tenant.leadAssignmentStrategy === 'ROUND_ROBIN') {
            const lastAssigned = await this.prisma.client.findFirst({
                where: { tenantId, assignedAgentId: { not: null } },
                orderBy: { createdAt: 'desc' },
                select: { assignedAgentId: true },
            });
            const ids = activeAgents.map((a) => a.id);
            if (!lastAssigned?.assignedAgentId)
                return ids[0];
            const lastIdx = ids.indexOf(lastAssigned.assignedAgentId);
            return ids[(lastIdx + 1) % ids.length];
        }
        if (tenant.leadAssignmentStrategy === 'LEAST_BUSY') {
            const counts = await Promise.all(activeAgents.map(async (a) => ({
                id: a.id,
                count: await this.prisma.client.count({
                    where: {
                        tenantId, assignedAgentId: a.id,
                        pipelineStage: { notIn: ['COMPLETED', 'LOST'] },
                    },
                }),
            })));
            counts.sort((a, b) => a.count - b.count);
            return counts[0]?.id || null;
        }
        return null;
    }
    async reassignClient(tenantId, clientId, newAgentId) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        if (newAgentId) {
            const agent = await this.prisma.user.findFirst({
                where: { id: newAgentId, tenantId, status: 'ACTIVE' },
            });
            if (!agent)
                throw new common_1.BadRequestException("Agent topilmadi yoki nofaol");
        }
        return this.prisma.client.update({
            where: { id: clientId },
            data: { assignedAgentId: newAgentId },
            select: {
                id: true, fullName: true,
                assignedAgent: { select: { id: true, name: true } },
            },
        });
    }
    async bulkAssign(tenantId, ids, agentId) {
        if (!ids?.length)
            throw new common_1.BadRequestException("Klientlar tanlanmadi");
        if (agentId) {
            const agent = await this.prisma.user.findFirst({
                where: { id: agentId, tenantId, status: 'ACTIVE' },
            });
            if (!agent)
                throw new common_1.BadRequestException("Agent topilmadi");
        }
        const res = await this.prisma.client.updateMany({
            where: { tenantId, id: { in: ids } },
            data: { assignedAgentId: agentId },
        });
        return { updated: res.count };
    }
    async bulkChangeStage(tenantId, ids, stage) {
        if (!ids?.length)
            throw new common_1.BadRequestException("Klientlar tanlanmadi");
        const validStages = ['NEW_LEAD', 'CONTACTED', 'INTERESTED', 'OFFER_SENT',
            'NEGOTIATION', 'DEPOSIT_PAID', 'CONFIRMED',
            'TRAVELING', 'COMPLETED', 'LOST'];
        if (!validStages.includes(stage)) {
            throw new common_1.BadRequestException("Noma'lum bosqich");
        }
        const res = await this.prisma.client.updateMany({
            where: { tenantId, id: { in: ids } },
            data: { pipelineStage: stage, pipelineStageAt: new Date() },
        });
        return { updated: res.count };
    }
    async bulkAddTag(tenantId, ids, tag) {
        if (!ids?.length || !tag?.trim())
            throw new common_1.BadRequestException("Parametr xato");
        const t = tag.trim().toLowerCase();
        const clients = await this.prisma.client.findMany({
            where: { tenantId, id: { in: ids } },
            select: { id: true, tags: true },
        });
        await Promise.all(clients.map((c) => this.prisma.client.update({
            where: { id: c.id },
            data: { tags: Array.from(new Set([...(c.tags || []), t])) },
        })));
        return { updated: clients.length };
    }
    async bulkDelete(tenantId, ids, userId) {
        if (!ids?.length)
            throw new common_1.BadRequestException("Klientlar tanlanmadi");
        const withBookings = await this.prisma.client.findMany({
            where: { tenantId, id: { in: ids }, bookings: { some: {} } },
            select: { id: true, fullName: true },
        });
        if (withBookings.length) {
            throw new common_1.BadRequestException(`Quyidagi klientlarning bookingi bor, o'chirib bo'lmaydi: ${withBookings.map((c) => c.fullName).join(', ')}`);
        }
        const res = await this.prisma.client.deleteMany({
            where: { tenantId, id: { in: ids } },
        });
        return { deleted: res.count };
    }
    async listSavedFilters(tenantId, userId, resource) {
        return this.prisma.savedFilter.findMany({
            where: { tenantId, userId, ...(resource ? { resource } : {}) },
            orderBy: [{ isPinned: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
        });
    }
    async createSavedFilter(tenantId, userId, data) {
        if (!data.name?.trim() || !data.resource?.trim()) {
            throw new common_1.BadRequestException("Nom va resource majburiy");
        }
        return this.prisma.savedFilter.create({
            data: {
                tenantId, userId,
                name: data.name.trim(),
                resource: data.resource,
                filters: data.filters || {},
                isPinned: !!data.isPinned,
            },
        });
    }
    async deleteSavedFilter(tenantId, userId, id) {
        const f = await this.prisma.savedFilter.findFirst({
            where: { id, tenantId, userId },
        });
        if (!f)
            throw new common_1.NotFoundException();
        await this.prisma.savedFilter.delete({ where: { id } });
        return { ok: true };
    }
    async getChecklist(tenantId, bookingId) {
        const booking = await this.prisma.booking.findFirst({
            where: { id: bookingId, tenantId },
            select: { id: true },
        });
        if (!booking)
            throw new common_1.NotFoundException('Booking topilmadi');
        let items = await this.prisma.bookingChecklist.findMany({
            where: { bookingId },
            include: { doneBy: { select: { id: true, name: true } } },
            orderBy: { sortOrder: 'asc' },
        });
        if (!items.length) {
            await Promise.all(V8Service_1.DEFAULT_CHECKLIST.map((item, idx) => this.prisma.bookingChecklist.create({
                data: { tenantId, bookingId, item, sortOrder: idx },
            })));
            items = await this.prisma.bookingChecklist.findMany({
                where: { bookingId },
                include: { doneBy: { select: { id: true, name: true } } },
                orderBy: { sortOrder: 'asc' },
            });
        }
        const done = items.filter((i) => i.isDone).length;
        return {
            items,
            total: items.length,
            done,
            progress: items.length > 0 ? Math.round((done / items.length) * 100) : 0,
        };
    }
    async toggleChecklistItem(tenantId, itemId, userId, isDone) {
        const item = await this.prisma.bookingChecklist.findFirst({
            where: { id: itemId, tenantId },
        });
        if (!item)
            throw new common_1.NotFoundException();
        return this.prisma.bookingChecklist.update({
            where: { id: itemId },
            data: {
                isDone,
                doneAt: isDone ? new Date() : null,
                doneById: isDone ? userId : null,
            },
        });
    }
    async addChecklistItem(tenantId, bookingId, item) {
        if (!item?.trim())
            throw new common_1.BadRequestException("Element nomi bo'sh");
        const booking = await this.prisma.booking.findFirst({
            where: { id: bookingId, tenantId },
        });
        if (!booking)
            throw new common_1.NotFoundException();
        const last = await this.prisma.bookingChecklist.findFirst({
            where: { bookingId },
            orderBy: { sortOrder: 'desc' },
        });
        return this.prisma.bookingChecklist.create({
            data: {
                tenantId, bookingId,
                item: item.trim(),
                sortOrder: (last?.sortOrder || 0) + 1,
            },
        });
    }
    async deleteChecklistItem(tenantId, itemId) {
        const item = await this.prisma.bookingChecklist.findFirst({
            where: { id: itemId, tenantId },
        });
        if (!item)
            throw new common_1.NotFoundException();
        await this.prisma.bookingChecklist.delete({ where: { id: itemId } });
        return { ok: true };
    }
    async createCommissionFromBooking(tenantId, bookingId) {
        const booking = await this.prisma.booking.findFirst({
            where: { id: bookingId, tenantId },
            include: { agent: { select: { id: true, role: true } } },
        });
        if (!booking)
            throw new common_1.NotFoundException();
        const existing = await this.prisma.commission.findUnique({ where: { bookingId } });
        if (existing)
            return existing;
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { agentCommissionPercent: true, managerCommissionPercent: true },
        });
        if (!tenant)
            throw new common_1.NotFoundException();
        const manager = await this.prisma.user.findFirst({
            where: { tenantId, role: { in: ['MANAGER', 'TENANT_ADMIN'] }, status: 'ACTIVE' },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
        });
        const profit = booking.profit || 0;
        const agentPct = tenant.agentCommissionPercent;
        const managerPct = tenant.managerCommissionPercent;
        const agentAmount = +(profit * agentPct / 100).toFixed(2);
        const managerAmount = +(profit * managerPct / 100).toFixed(2);
        const companyAmount = +(profit - agentAmount - managerAmount).toFixed(2);
        return this.prisma.commission.create({
            data: {
                tenantId, bookingId,
                agentId: booking.agentId,
                managerId: manager?.id,
                totalProfit: profit,
                agentPercent: agentPct,
                managerPercent: managerPct,
                agentAmount, managerAmount, companyAmount,
            },
        });
    }
    async listCommissions(tenantId, userId, role) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.agentId = userId;
        return this.prisma.commission.findMany({
            where,
            include: {
                booking: { select: { id: true, bookingRef: true, tourName: true, client: { select: { fullName: true } } } },
                agent: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
    }
    async markCommissionPaid(tenantId, id) {
        const c = await this.prisma.commission.findFirst({ where: { id, tenantId } });
        if (!c)
            throw new common_1.NotFoundException();
        return this.prisma.commission.update({
            where: { id },
            data: { isPaid: true, paidAt: new Date() },
        });
    }
    async getClient360(tenantId, clientId, userId, role) {
        const whereFilter = { id: clientId, tenantId };
        if (role === 'AGENT')
            whereFilter.assignedAgentId = userId;
        const client = await this.prisma.client.findFirst({
            where: whereFilter,
            include: {
                assignedAgent: { select: { id: true, name: true, email: true, phone: true } },
                bookings: {
                    orderBy: { createdAt: 'desc' },
                    include: {
                        payments: { select: { id: true, amount: true, currency: true, paidAt: true, method: true } },
                        agent: { select: { id: true, name: true } },
                    },
                },
                timeline: {
                    orderBy: { createdAt: 'desc' },
                    take: 50,
                },
            },
        });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        const totalSpent = client.bookings.reduce((sum, b) => sum + (b.totalPrice || 0), 0);
        const totalProfit = role === 'AGENT' ? 0 : client.bookings.reduce((sum, b) => sum + (b.profit || 0), 0);
        const totalPaid = client.bookings.reduce((sum, b) => sum + (b.paidAmount || 0), 0);
        const balance = totalSpent - totalPaid;
        const activeConversation = await this.prisma.conversation.findFirst({
            where: { tenantId, clientId },
            orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
            select: { id: true, channel: true, lastMessageAt: true, unreadCount: true },
        });
        const activeTasks = await this.prisma.task.findMany({
            where: { tenantId, clientId, status: { notIn: ['DONE', 'CANCELLED'] } },
            include: { assignee: { select: { id: true, name: true } } },
            orderBy: { dueAt: 'asc' },
            take: 20,
        });
        const invoices = await this.prisma.invoice.findMany({
            where: { tenantId, clientId },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, invoiceNumber: true, salePrice: true, paidAmount: true,
                status: true, currency: true, createdAt: true, dueDate: true,
                ...(role !== 'AGENT' ? { profit: true, providerCost: true } : {}),
            },
        });
        const documents = await this.prisma.document.findMany({
            where: { tenantId, clientId },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, fileName: true, fileUrl: true, fileMimeType: true,
                fileSize: true, createdAt: true,
                uploadedBy: { select: { name: true } },
            },
        });
        const followUps = await this.prisma.followUp.findMany({
            where: { tenantId, clientId, done: false },
            orderBy: { dueAt: 'asc' },
            take: 10,
        });
        return {
            client,
            financial: {
                totalSpent,
                totalProfit,
                totalPaid,
                balance,
                bookingsCount: client.bookings.length,
            },
            activeConversation,
            tasks: activeTasks,
            invoices,
            documents,
            followUps,
        };
    }
};
exports.V8Service = V8Service;
V8Service.DEFAULT_CHECKLIST = [
    'Passport',
    'Visa',
    'Hotel voucher',
    'Aviabilet',
    'Sug\'urta polisi',
    'Transfer (taxi)',
    'To\'lov tasdig\'i',
    'Klientga yo\'l-yo\'riq berildi',
];
exports.V8Service = V8Service = V8Service_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], V8Service);
let V8Controller = class V8Controller {
    constructor(svc) {
        this.svc = svc;
    }
    checkDuplicate(u, phone, email, telegramUsername) {
        return this.svc.checkDuplicate(u.tenantId, { phone, email, telegramUsername });
    }
    reassign(id, body, u) {
        return this.svc.reassignClient(u.tenantId, id, body.agentId);
    }
    bulkAssign(body, u) {
        return this.svc.bulkAssign(u.tenantId, body.ids, body.agentId);
    }
    bulkStage(body, u) {
        return this.svc.bulkChangeStage(u.tenantId, body.ids, body.stage);
    }
    bulkTag(body, u) {
        return this.svc.bulkAddTag(u.tenantId, body.ids, body.tag);
    }
    bulkDelete(body, u) {
        return this.svc.bulkDelete(u.tenantId, body.ids, u.sub);
    }
    listFilters(u, resource) {
        return this.svc.listSavedFilters(u.tenantId, u.sub, resource);
    }
    createFilter(body, u) {
        return this.svc.createSavedFilter(u.tenantId, u.sub, body);
    }
    deleteFilter(id, u) {
        return this.svc.deleteSavedFilter(u.tenantId, u.sub, id);
    }
    getChecklist(id, u) {
        return this.svc.getChecklist(u.tenantId, id);
    }
    toggleItem(itemId, body, u) {
        return this.svc.toggleChecklistItem(u.tenantId, itemId, u.sub, body.isDone);
    }
    addChecklistItem(id, body, u) {
        return this.svc.addChecklistItem(u.tenantId, id, body.item);
    }
    deleteChecklistItem(itemId, u) {
        return this.svc.deleteChecklistItem(u.tenantId, itemId);
    }
    listCommissions(u) {
        return this.svc.listCommissions(u.tenantId, u.sub, u.role);
    }
    createCommission(id, u) {
        return this.svc.createCommissionFromBooking(u.tenantId, id);
    }
    markPaid(id, u) {
        return this.svc.markCommissionPaid(u.tenantId, id);
    }
    getClient360(id, u) {
        return this.svc.getClient360(u.tenantId, id, u.sub, u.role);
    }
};
exports.V8Controller = V8Controller;
__decorate([
    (0, common_1.Get)('clients/check-duplicate'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('phone')),
    __param(2, (0, common_1.Query)('email')),
    __param(3, (0, common_1.Query)('telegramUsername')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "checkDuplicate", null);
__decorate([
    (0, common_1.Patch)('clients/:id/reassign'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "reassign", null);
__decorate([
    (0, common_1.Post)('clients/bulk/assign'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "bulkAssign", null);
__decorate([
    (0, common_1.Post)('clients/bulk/stage'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "bulkStage", null);
__decorate([
    (0, common_1.Post)('clients/bulk/tag'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "bulkTag", null);
__decorate([
    (0, common_1.Post)('clients/bulk/delete'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "bulkDelete", null);
__decorate([
    (0, common_1.Get)('saved-filters'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('resource')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "listFilters", null);
__decorate([
    (0, common_1.Post)('saved-filters'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "createFilter", null);
__decorate([
    (0, common_1.Delete)('saved-filters/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "deleteFilter", null);
__decorate([
    (0, common_1.Get)('bookings/:id/checklist'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "getChecklist", null);
__decorate([
    (0, common_1.Patch)('checklist/:itemId'),
    __param(0, (0, common_1.Param)('itemId')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "toggleItem", null);
__decorate([
    (0, common_1.Post)('bookings/:id/checklist'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "addChecklistItem", null);
__decorate([
    (0, common_1.Delete)('checklist/:itemId'),
    __param(0, (0, common_1.Param)('itemId')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "deleteChecklistItem", null);
__decorate([
    (0, common_1.Get)('commissions'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "listCommissions", null);
__decorate([
    (0, common_1.Post)('bookings/:id/commission'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "createCommission", null);
__decorate([
    (0, common_1.Patch)('commissions/:id/paid'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "markPaid", null);
__decorate([
    (0, common_1.Get)('clients/:id/full'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], V8Controller.prototype, "getClient360", null);
exports.V8Controller = V8Controller = __decorate([
    (0, common_1.Controller)('v8'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [V8Service])
], V8Controller);
let V8Module = class V8Module {
};
exports.V8Module = V8Module;
exports.V8Module = V8Module = __decorate([
    (0, common_1.Module)({
        controllers: [V8Controller],
        providers: [V8Service],
        exports: [V8Service],
    })
], V8Module);
//# sourceMappingURL=v8.module.js.map