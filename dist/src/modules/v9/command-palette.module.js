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
exports.CommandPaletteModule = exports.CommandPaletteController = exports.CommandPaletteService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
let CommandPaletteService = class CommandPaletteService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async search(tenantId, userId, role, query) {
        const q = query.trim();
        if (q.length < 1) {
            return { results: [], actions: this.getActions(role) };
        }
        const limit = 5;
        const agentFilter = role === 'AGENT';
        const [clients, bookings, invoices, conversations] = await Promise.all([
            this.prisma.client.findMany({
                where: {
                    tenantId,
                    ...(agentFilter ? { assignedAgentId: userId } : {}),
                    OR: [
                        { fullName: { contains: q, mode: 'insensitive' } },
                        { phone: { contains: q } },
                        { email: { contains: q, mode: 'insensitive' } },
                    ],
                },
                select: { id: true, fullName: true, phone: true, tier: true, pipelineStage: true },
                take: limit,
            }),
            this.prisma.booking.findMany({
                where: {
                    tenantId,
                    ...(agentFilter ? { agentId: userId } : {}),
                    OR: [
                        { bookingRef: { contains: q, mode: 'insensitive' } },
                        { tourName: { contains: q, mode: 'insensitive' } },
                        { destination: { contains: q, mode: 'insensitive' } },
                    ],
                },
                select: {
                    id: true, bookingRef: true, tourName: true, destination: true,
                    totalPrice: true, currency: true, status: true,
                },
                take: limit,
            }),
            this.prisma.invoice.findMany({
                where: {
                    tenantId,
                    ...(agentFilter ? { agentId: userId } : {}),
                    OR: [
                        { invoiceNumber: { contains: q, mode: 'insensitive' } },
                    ],
                },
                select: { id: true, invoiceNumber: true, salePrice: true, currency: true, status: true },
                take: limit,
            }),
            this.prisma.conversation.findMany({
                where: {
                    tenantId,
                    ...(agentFilter ? { OR: [{ assignedAgentId: userId }, { assignedAgentId: null }] } : {}),
                    OR: [
                        { firstName: { contains: q, mode: 'insensitive' } },
                        { username: { contains: q, mode: 'insensitive' } },
                    ],
                },
                select: { id: true, firstName: true, lastName: true, username: true, channel: true },
                take: 3,
            }),
        ]);
        const results = [
            ...clients.map((c) => ({
                type: 'client',
                id: c.id,
                title: c.fullName,
                subtitle: `${c.phone || '—'} • ${c.tier}`,
                icon: '👤',
                url: `/clients/${c.id}`,
            })),
            ...bookings.map((b) => ({
                type: 'booking',
                id: b.id,
                title: b.tourName,
                subtitle: `${b.bookingRef} • ${b.destination} • ${b.currency} ${b.totalPrice}`,
                icon: '✈️',
                url: `/bookings/${b.id}`,
            })),
            ...invoices.map((i) => ({
                type: 'invoice',
                id: i.id,
                title: `Invoice ${i.invoiceNumber}`,
                subtitle: `${i.currency} ${i.salePrice} • ${i.status}`,
                icon: '🧾',
                url: `/invoices/${i.id}`,
            })),
            ...conversations.map((c) => ({
                type: 'conversation',
                id: c.id,
                title: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.username || 'Suhbat',
                subtitle: `${c.channel} • @${c.username || '—'}`,
                icon: '💬',
                url: `/inbox?conv=${c.id}`,
            })),
        ];
        return {
            query: q,
            results,
            actions: this.getActions(role).filter((a) => a.title.toLowerCase().includes(q.toLowerCase()) ||
                a.keywords?.some((k) => k.toLowerCase().includes(q.toLowerCase()))),
        };
    }
    getActions(role) {
        const all = [
            { type: 'action', id: 'new-client', title: '👤 Yangi mijoz', subtitle: 'Yangi klient yaratish', url: '/clients?new=1', icon: '➕', shortcut: 'C', keywords: ['mijoz', 'klient', 'new', 'create', 'create client'] },
            { type: 'action', id: 'new-booking', title: '✈️ Yangi booking', subtitle: 'Yangi sayohat buyurtmasi', url: '/bookings?new=1', icon: '➕', shortcut: 'B', keywords: ['booking', 'buyurtma', 'sayohat', 'tur'] },
            { type: 'action', id: 'new-invoice', title: '🧾 Yangi invoice', subtitle: 'Hisob-faktura yaratish', url: '/invoices?new=1', icon: '➕', shortcut: 'I', keywords: ['invoice', 'hisob', 'faktura'] },
            { type: 'action', id: 'new-task', title: '☑ Yangi vazifa', subtitle: 'Vazifa qo\'shish', url: '/tasks?new=1', icon: '➕', keywords: ['task', 'vazifa', 'topshiriq'] },
            { type: 'action', id: 'inbox', title: '✉ Inbox', subtitle: 'Suhbatlar', url: '/inbox', icon: '💬', keywords: ['inbox', 'chat', 'xabar', 'suhbat'] },
            { type: 'action', id: 'pipeline', title: '⊞ Pipeline', subtitle: 'Sotuv bosqichlari', url: '/pipeline', icon: '📊', keywords: ['pipeline', 'kanban', 'sotuv'] },
            { type: 'action', id: 'reports', title: '◬ Hisobotlar', subtitle: 'Statistika va tahlil', url: '/reports', icon: '📈', keywords: ['report', 'hisobot', 'stat', 'kpi'] },
            { type: 'action', id: 'settings', title: '⚙ Sozlamalar', subtitle: 'Profil va kompaniya', url: '/settings', icon: '⚙', keywords: ['settings', 'sozlama', 'profil'] },
        ];
        if (['TENANT_ADMIN', 'MANAGER'].includes(role)) {
            all.push({ type: 'action', id: 'team', title: '👥 Jamoa', subtitle: 'Agentlar va xodimlar', url: '/settings?tab=team', icon: '👥', keywords: ['team', 'jamoa', 'agent'] }, { type: 'action', id: 'approvals', title: '✅ Tasdiqlar', subtitle: 'Kutilayotgan so\'rovlar', url: '/approvals', icon: '✅', keywords: ['approval', 'tasdiq', 'so\'rov'] });
        }
        return all;
    }
};
exports.CommandPaletteService = CommandPaletteService;
exports.CommandPaletteService = CommandPaletteService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CommandPaletteService);
let CommandPaletteController = class CommandPaletteController {
    constructor(svc) {
        this.svc = svc;
    }
    search(q, u) {
        return this.svc.search(u.tenantId, u.sub, u.role, q || '');
    }
};
exports.CommandPaletteController = CommandPaletteController;
__decorate([
    (0, common_1.Get)('search'),
    __param(0, (0, common_1.Query)('q')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], CommandPaletteController.prototype, "search", null);
exports.CommandPaletteController = CommandPaletteController = __decorate([
    (0, common_1.Controller)('command-palette'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [CommandPaletteService])
], CommandPaletteController);
let CommandPaletteModule = class CommandPaletteModule {
};
exports.CommandPaletteModule = CommandPaletteModule;
exports.CommandPaletteModule = CommandPaletteModule = __decorate([
    (0, common_1.Module)({
        controllers: [CommandPaletteController],
        providers: [CommandPaletteService],
        exports: [CommandPaletteService],
    })
], CommandPaletteModule);
//# sourceMappingURL=command-palette.module.js.map