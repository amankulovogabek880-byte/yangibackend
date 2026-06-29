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
exports.OffersModule = exports.OffersController = exports.OffersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
let OffersService = class OffersService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async list(tenantId, clientId) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
        if (!client)
            throw new common_1.NotFoundException();
        const prefs = client.preferences || {};
        return (prefs.offers || []).reverse();
    }
    async create(tenantId, agentId, data) {
        const client = await this.prisma.client.findFirst({ where: { id: data.clientId, tenantId } });
        if (!client)
            throw new common_1.NotFoundException();
        const prefs = client.preferences || {};
        if (!prefs.offers)
            prefs.offers = [];
        const offer = {
            id: Date.now().toString(),
            agentId,
            tourName: data.tourName,
            destination: data.destination || null,
            departDate: data.departDate || null,
            returnDate: data.returnDate || null,
            pax: data.pax || 1,
            actualPrice: Number(data.actualPrice),
            markup: Number(data.markup) || 0,
            clientPrice: Number(data.actualPrice) + (Number(data.markup) || 0),
            currency: data.currency || 'USD',
            hotelName: data.hotelName || null,
            hotelStars: data.hotelStars || null,
            includesVisa: data.includesVisa || false,
            includesFlight: data.includesFlight !== false,
            includesHotel: data.includesHotel !== false,
            notes: data.notes || null,
            status: 'DRAFT',
            createdAt: new Date().toISOString(),
        };
        prefs.offers.push(offer);
        const advanceStages = ['NEW_LEAD', 'CONTACTED', 'INTERESTED'];
        const updateData = { preferences: prefs };
        if (advanceStages.includes(client.pipelineStage)) {
            updateData.pipelineStage = 'OFFER_SENT';
            updateData.pipelineStageAt = new Date();
        }
        await this.prisma.client.update({ where: { id: data.clientId }, data: updateData });
        await this.prisma.clientTimeline.create({
            data: {
                clientId: data.clientId,
                userId: agentId,
                type: 'offer_created',
                title: 'Taklif yaratildi: ' + data.tourName,
                description: '$' + (Number(data.actualPrice) + Number(data.markup || 0)).toLocaleString(),
                metadata: { offerId: offer.id, tourName: data.tourName },
            },
        }).catch(() => { });
        return offer;
    }
    async send(tenantId, clientId, offerId) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
        if (!client)
            throw new common_1.NotFoundException();
        const prefs = client.preferences || {};
        prefs.offers = (prefs.offers || []).map((o) => o.id === offerId ? { ...o, status: 'SENT', sentAt: new Date().toISOString() } : o);
        const updateData = { preferences: prefs };
        const curStage = client.pipelineStage;
        if (['OFFER_SENT', 'NEW_LEAD', 'CONTACTED', 'INTERESTED'].includes(curStage)) {
            updateData.pipelineStage = 'NEGOTIATION';
            updateData.pipelineStageAt = new Date();
        }
        await this.prisma.client.update({ where: { id: clientId }, data: updateData });
        await this.prisma.clientTimeline.create({
            data: {
                clientId,
                type: 'offer_sent',
                title: 'Taklif yuborildi',
                metadata: { offerId },
            },
        }).catch(() => { });
        return { success: true };
    }
};
exports.OffersService = OffersService;
exports.OffersService = OffersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], OffersService);
let OffersController = class OffersController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, id) {
        return this.svc.list(u.tenantId, id);
    }
    create(u, body) {
        return this.svc.create(u.tenantId, u.id || u.sub, body);
    }
    send(u, body, offerId) {
        return this.svc.send(u.tenantId, body.clientId, offerId);
    }
};
exports.OffersController = OffersController;
__decorate([
    (0, common_1.Get)('client/:clientId'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], OffersController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], OffersController.prototype, "create", null);
__decorate([
    (0, common_1.Post)(':id/send'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], OffersController.prototype, "send", null);
exports.OffersController = OffersController = __decorate([
    (0, common_1.Controller)('offers'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [OffersService])
], OffersController);
let OffersModule = class OffersModule {
};
exports.OffersModule = OffersModule;
exports.OffersModule = OffersModule = __decorate([
    (0, common_1.Module)({
        controllers: [OffersController],
        providers: [OffersService],
        exports: [OffersService],
    })
], OffersModule);
//# sourceMappingURL=offers.module.js.map