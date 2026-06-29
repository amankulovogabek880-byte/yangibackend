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
exports.LeadScoringModule = exports.LeadScoringController = exports.LeadScoringService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
let LeadScoringService = class LeadScoringService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async calculateScore(clientData) {
        let score = 0;
        const now = new Date();
        const createdAt = clientData.createdAt ? new Date(clientData.createdAt) : now;
        const hoursDiff = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
        const daysDiff = hoursDiff / 24;
        const sourceScores = {
            'GOOGLE_ADS': 20, 'WEBSITE': 20,
            'INSTAGRAM': 15, 'TELEGRAM': 15, 'FACEBOOK': 12,
            'REFERRAL': 25,
            'WALKIN': 10, 'CALL': 10,
            'WHATSAPP': 10, 'OTHER': 5,
        };
        score += sourceScores[clientData.source] || 5;
        if (clientData.phone)
            score += 10;
        if (clientData.email)
            score += 5;
        if (clientData.country === 'Uzbekistan' || clientData.country === 'UZ')
            score += 10;
        if (clientData.utmCampaign)
            score += 5;
        if (hoursDiff <= 1)
            score += 15;
        else if (daysDiff <= 1)
            score += 10;
        if (clientData.telegramUsername)
            score += 20;
        return Math.min(score, 100);
    }
    async scoreClient(tenantId, clientId) {
        const client = await this.prisma.client.findUnique({
            where: { id: clientId },
            select: {
                source: true, phone: true, email: true, country: true,
                utmCampaign: true, telegramUsername: true, createdAt: true,
            },
        });
        if (!client)
            throw new Error('Klient topilmadi');
        const score = await this.calculateScore(client);
        await this.prisma.client.update({
            where: { id: clientId },
            data: { leadScore: score },
        });
        return score;
    }
    async recalculateAll(tenantId) {
        const clients = await this.prisma.client.findMany({
            where: { tenantId },
            select: { id: true, source: true, phone: true, email: true, country: true, utmCampaign: true, telegramUsername: true, createdAt: true },
        });
        let updated = 0;
        for (const client of clients) {
            const score = await this.calculateScore(client);
            await this.prisma.client.update({
                where: { id: client.id },
                data: { leadScore: score },
            });
            updated++;
        }
        return { updated };
    }
};
exports.LeadScoringService = LeadScoringService;
exports.LeadScoringService = LeadScoringService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], LeadScoringService);
let LeadScoringController = class LeadScoringController {
    constructor(svc) {
        this.svc = svc;
    }
    async recalculate(u) {
        return this.svc.recalculateAll(u.tenantId);
    }
};
exports.LeadScoringController = LeadScoringController;
__decorate([
    (0, common_1.Post)('recalculate'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], LeadScoringController.prototype, "recalculate", null);
exports.LeadScoringController = LeadScoringController = __decorate([
    (0, common_1.Controller)('lead-scoring'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [LeadScoringService])
], LeadScoringController);
let LeadScoringModule = class LeadScoringModule {
};
exports.LeadScoringModule = LeadScoringModule;
exports.LeadScoringModule = LeadScoringModule = __decorate([
    (0, common_1.Module)({
        controllers: [LeadScoringController],
        providers: [LeadScoringService],
        exports: [LeadScoringService],
    })
], LeadScoringModule);
//# sourceMappingURL=lead-scoring.module.js.map