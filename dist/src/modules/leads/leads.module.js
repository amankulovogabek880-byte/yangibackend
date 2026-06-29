"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LeadsModule = exports.ApiKeysController = exports.PublicLeadsController = exports.LeadsService = exports.ApiKeyGuard = void 0;
exports.hashApiKey = hashApiKey;
const common_1 = require("@nestjs/common");
const crypto = __importStar(require("crypto"));
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
const notifications_service_1 = require("../notifications/notifications.service");
const helpers_1 = require("../../common/utils/helpers");
const round_robin_module_1 = require("../v9/round-robin.module");
;
const SOURCES = [
    'TELEGRAM', 'INSTAGRAM', 'WHATSAPP', 'REFERRAL', 'WALKIN',
    'WEBSITE', 'CALL', 'FACEBOOK', 'GOOGLE_ADS', 'OTHER',
];
const LANGS = ['UZ', 'RU', 'EN'];
function hashApiKey(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}
let ApiKeyGuard = class ApiKeyGuard {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async canActivate(ctx) {
        const req = ctx.switchToHttp().getRequest();
        const raw = req.headers['x-api-key'] ||
            (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
        if (!raw || typeof raw !== 'string') {
            throw new common_1.UnauthorizedException('API key kerak (x-api-key header)');
        }
        const key = await this.prisma.apiKey.findFirst({
            where: { keyHash: hashApiKey(raw), isActive: true },
        });
        if (!key)
            throw new common_1.UnauthorizedException("API key noto'g'ri");
        if (key.expiresAt && key.expiresAt < new Date()) {
            throw new common_1.UnauthorizedException('API key muddati tugagan');
        }
        await this.prisma.apiKey.update({
            where: { id: key.id }, data: { lastUsedAt: new Date() },
        });
        req.apiKey = key;
        return true;
    }
};
exports.ApiKeyGuard = ApiKeyGuard;
exports.ApiKeyGuard = ApiKeyGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ApiKeyGuard);
let LeadsService = class LeadsService {
    constructor(prisma, notifications, roundRobin) {
        this.prisma = prisma;
        this.notifications = notifications;
        this.roundRobin = roundRobin;
    }
    async pickAgent(tenantId) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { leadAssignmentStrategy: true },
        });
        if (tenant?.leadAssignmentStrategy === 'MANUAL') {
            return null;
        }
        return this.roundRobin.getNextAgent(tenantId);
    }
    async importLead(tenantId, data) {
        if (!data.fullName?.trim() || !data.phone?.trim()) {
            throw new common_1.BadRequestException('fullName va phone majburiy');
        }
        const phone = String(data.phone).trim();
        const dup = await this.prisma.client.findFirst({
            where: { tenantId, phone },
        });
        let clientId;
        let assignedAgentId = null;
        if (dup) {
            clientId = dup.id;
            assignedAgentId = dup.assignedAgentId || (await this.pickAgent(tenantId));
            if (assignedAgentId && !dup.assignedAgentId) {
                await this.prisma.client.update({
                    where: { id: dup.id },
                    data: { assignedAgentId },
                });
            }
            await this.prisma.clientTimeline.create({
                data: {
                    clientId: dup.id,
                    type: 'duplicate_lead',
                    title: 'Yana lead keldi (API)',
                    description: data.note || data.sourceCampaign,
                    metadata: { source: data.source, campaign: data.sourceCampaign },
                },
            });
        }
        else {
            assignedAgentId = data.assignTo || (await this.pickAgent(tenantId));
            const client = await this.prisma.client.create({
                data: {
                    tenantId,
                    assignedAgentId,
                    fullName: data.fullName.trim(),
                    phone,
                    email: data.email?.trim()?.toLowerCase(),
                    source: (0, helpers_1.safeEnum)(data.source, SOURCES, 'OTHER'),
                    sourceCampaign: data.sourceCampaign,
                    utmSource: data.utmSource,
                    utmMedium: data.utmMedium,
                    utmCampaign: data.utmCampaign,
                    tags: Array.isArray(data.tags) ? data.tags : [],
                    language: (0, helpers_1.safeEnum)(data.language, LANGS, 'UZ'),
                    notes: data.note,
                    lastContactAt: new Date(),
                },
            });
            clientId = client.id;
            await this.prisma.clientTimeline.create({
                data: {
                    clientId,
                    type: 'created',
                    title: 'API orqali lead keldi',
                    description: data.sourceCampaign,
                    metadata: { source: data.source, campaign: data.sourceCampaign },
                },
            });
        }
        if (assignedAgentId) {
            await this.notifications.create({
                tenantId, userId: assignedAgentId,
                type: 'LEAD_NEW',
                title: '🔥 Yangi API lead',
                body: `${data.fullName} — ${data.sourceCampaign || data.source || ''}`,
                link: `/clients/${clientId}`,
                metadata: { clientId },
            });
        }
        return { id: clientId, assignedAgentId, isDuplicate: !!dup };
    }
    async listKeys(tenantId) {
        return this.prisma.apiKey.findMany({
            where: { tenantId },
            select: {
                id: true, name: true, prefix: true, scopes: true,
                isActive: true, lastUsedAt: true, createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });
    }
    async createKey(tenantId, name) {
        if (!name?.trim())
            throw new common_1.BadRequestException('name majburiy');
        const raw = 'lk_' + crypto.randomBytes(24).toString('base64url');
        const keyHash = hashApiKey(raw);
        const prefix = raw.slice(0, 10) + '…';
        const key = await this.prisma.apiKey.create({
            data: { tenantId, name: name.trim(), keyHash, prefix },
        });
        return {
            id: key.id, name: key.name, key: raw, prefix,
            warning: 'BU KALITNI SAQLANG — qaytadan ko\'rsatilmaydi',
        };
    }
    async revokeKey(tenantId, id) {
        await this.prisma.apiKey.updateMany({
            where: { id, tenantId }, data: { isActive: false },
        });
        return { ok: true };
    }
};
exports.LeadsService = LeadsService;
exports.LeadsService = LeadsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_service_1.NotificationsService,
        round_robin_module_1.RoundRobinService])
], LeadsService);
let PublicLeadsController = class PublicLeadsController {
    constructor(svc) {
        this.svc = svc;
    }
    import(body, req) {
        return this.svc.importLead(req.apiKey.tenantId, body);
    }
};
exports.PublicLeadsController = PublicLeadsController;
__decorate([
    (0, common_1.Post)(),
    (0, decorators_1.Public)(),
    (0, common_1.UseGuards)(ApiKeyGuard),
    (0, common_1.HttpCode)(201),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PublicLeadsController.prototype, "import", null);
exports.PublicLeadsController = PublicLeadsController = __decorate([
    (0, common_1.Controller)('public/leads'),
    __metadata("design:paramtypes", [LeadsService])
], PublicLeadsController);
let ApiKeysController = class ApiKeysController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u) {
        return this.svc.listKeys(u.tenantId);
    }
    create(body, u) {
        return this.svc.createKey(u.tenantId, body.name);
    }
    revoke(id, u) {
        return this.svc.revokeKey(u.tenantId, id);
    }
    async testSend(id, body, u) {
        const key = await this.svc['prisma'].apiKey.findFirst({
            where: { id, tenantId: u.tenantId, isActive: true },
        });
        if (!key)
            throw new common_1.BadRequestException('API key topilmadi');
        const testPhone = body.phone && body.phone !== '+998901234567'
            ? body.phone
            : `+99890${Date.now().toString().slice(-7)}`;
        return this.svc.importLead(u.tenantId, {
            fullName: body.fullName || 'Test Klient',
            phone: testPhone,
            email: body.email,
            source: body.source || 'OTHER',
            note: body.message,
            utmSource: body.utmSource,
            utmMedium: body.utmMedium,
            utmCampaign: body.utmCampaign,
        });
    }
};
exports.ApiKeysController = ApiKeysController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ApiKeysController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], ApiKeysController.prototype, "create", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ApiKeysController.prototype, "revoke", null);
__decorate([
    (0, common_1.Post)(':id/test-send'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], ApiKeysController.prototype, "testSend", null);
exports.ApiKeysController = ApiKeysController = __decorate([
    (0, common_1.Controller)('api-keys'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __metadata("design:paramtypes", [LeadsService])
], ApiKeysController);
let LeadsModule = class LeadsModule {
};
exports.LeadsModule = LeadsModule;
exports.LeadsModule = LeadsModule = __decorate([
    (0, common_1.Module)({
        imports: [round_robin_module_1.RoundRobinModule],
        controllers: [PublicLeadsController, ApiKeysController],
        providers: [LeadsService, ApiKeyGuard],
        exports: [LeadsService],
    })
], LeadsModule);
//# sourceMappingURL=leads.module.js.map