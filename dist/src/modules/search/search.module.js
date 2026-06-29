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
exports.SearchModule = exports.SearchController = exports.SearchService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
let SearchService = class SearchService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async global(tenantId, userId, role, q) {
        if (!q?.trim() || q.trim().length < 2) {
            throw new common_1.BadRequestException("Kamida 2 belgi kiriting");
        }
        const search = q.trim();
        const limit = 8;
        const agentFilter = role === 'AGENT';
        const [clients, bookings, conversations, tasks, invoices, documents] = await Promise.all([
            this.prisma.client.findMany({
                where: {
                    tenantId,
                    ...(agentFilter ? { assignedAgentId: userId } : {}),
                    OR: [
                        { fullName: { contains: search, mode: 'insensitive' } },
                        { phone: { contains: search } },
                        { email: { contains: search, mode: 'insensitive' } },
                        { passportNo: { contains: search } },
                        { telegramUsername: { contains: search, mode: 'insensitive' } },
                    ],
                },
                select: {
                    id: true, fullName: true, phone: true, email: true,
                    tier: true, pipelineStage: true,
                },
                take: limit,
            }),
            this.prisma.booking.findMany({
                where: {
                    tenantId,
                    ...(agentFilter ? { agentId: userId } : {}),
                    OR: [
                        { bookingRef: { contains: search, mode: 'insensitive' } },
                        { tourName: { contains: search, mode: 'insensitive' } },
                        { destination: { contains: search, mode: 'insensitive' } },
                    ],
                },
                select: {
                    id: true, bookingRef: true, tourName: true, destination: true,
                    totalPrice: true, status: true,
                    client: { select: { id: true, fullName: true } },
                },
                take: limit,
            }),
            this.prisma.conversation.findMany({
                where: {
                    tenantId,
                    ...(agentFilter ? { OR: [{ assignedAgentId: userId }, { assignedAgentId: null }] } : {}),
                    OR: [
                        { firstName: { contains: search, mode: 'insensitive' } },
                        { lastName: { contains: search, mode: 'insensitive' } },
                        { username: { contains: search, mode: 'insensitive' } },
                        { lastMessageText: { contains: search, mode: 'insensitive' } },
                    ],
                },
                select: {
                    id: true, firstName: true, lastName: true, username: true,
                    channel: true, lastMessageText: true,
                },
                take: limit,
            }),
            this.prisma.task.findMany({
                where: {
                    tenantId,
                    ...(agentFilter ? { assigneeId: userId } : {}),
                    OR: [
                        { title: { contains: search, mode: 'insensitive' } },
                        { description: { contains: search, mode: 'insensitive' } },
                    ],
                },
                select: { id: true, title: true, status: true, priority: true, dueAt: true },
                take: limit,
            }),
            this.prisma.invoice.findMany({
                where: {
                    tenantId,
                    ...(agentFilter ? { agentId: userId } : {}),
                    OR: [
                        { invoiceNumber: { contains: search, mode: 'insensitive' } },
                        { client: { fullName: { contains: search, mode: 'insensitive' } } },
                    ],
                },
                select: {
                    id: true, invoiceNumber: true, salePrice: true, status: true, currency: true,
                    client: { select: { id: true, fullName: true } },
                },
                take: limit,
            }),
            this.prisma.document.findMany({
                where: {
                    tenantId,
                    OR: [
                        { fileName: { contains: search, mode: 'insensitive' } },
                        { name: { contains: search, mode: 'insensitive' } },
                        { description: { contains: search, mode: 'insensitive' } },
                    ],
                },
                select: {
                    id: true, fileName: true, name: true, fileUrl: true, category: true,
                    client: { select: { id: true, fullName: true } },
                },
                take: limit,
            }),
        ]);
        return { clients, bookings, conversations, tasks, invoices, documents };
    }
};
exports.SearchService = SearchService;
exports.SearchService = SearchService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], SearchService);
let SearchController = class SearchController {
    constructor(svc) {
        this.svc = svc;
    }
    global(u, q) {
        return this.svc.global(u.tenantId, u.sub, u.role, q);
    }
};
exports.SearchController = SearchController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('q')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], SearchController.prototype, "global", null);
exports.SearchController = SearchController = __decorate([
    (0, common_1.Controller)('search'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [SearchService])
], SearchController);
let SearchModule = class SearchModule {
};
exports.SearchModule = SearchModule;
exports.SearchModule = SearchModule = __decorate([
    (0, common_1.Module)({
        controllers: [SearchController],
        providers: [SearchService],
    })
], SearchModule);
//# sourceMappingURL=search.module.js.map