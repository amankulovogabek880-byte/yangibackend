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
exports.TenantsModule = exports.TenantsController = exports.TenantsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
let TenantsService = class TenantsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getSettings(tenantId) {
        return this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: {
                id: true, name: true, slug: true, status: true, plan: true,
                logoUrl: true, brandColor: true, timezone: true, locale: true,
                currency: true, settings: true, maxUsers: true, maxClients: true,
                maxBookings: true, createdAt: true, expiresAt: true,
                phoneProvider: true, phoneConfig: true,
            },
        });
    }
    async updateSettings(tenantId, data) {
        const allowed = {};
        const safeKeys = ['name', 'logoUrl', 'brandColor', 'timezone', 'locale', 'currency', 'settings'];
        for (const k of safeKeys) {
            if (data[k] !== undefined)
                allowed[k] = data[k];
        }
        return this.prisma.tenant.update({
            where: { id: tenantId },
            data: allowed,
            select: { id: true, name: true, brandColor: true, timezone: true, currency: true, settings: true },
        });
    }
    async updatePhoneProvider(tenantId, data) {
        const validProviders = ['STUB', 'TEL_LINK', 'TWILIO', 'ONLINEPBX', 'MYATI'];
        if (!validProviders.includes(data.provider)) {
            throw new Error(`Noma'lum provayder: ${data.provider}`);
        }
        return this.prisma.tenant.update({
            where: { id: tenantId },
            data: {
                phoneProvider: data.provider,
                phoneConfig: data.config || {},
            },
            select: {
                id: true, phoneProvider: true, phoneConfig: true,
            },
        });
    }
    async getPhoneProvider(tenantId) {
        const t = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { phoneProvider: true, phoneConfig: true },
        });
        if (!t)
            return null;
        const cfg = JSON.parse(JSON.stringify(t.phoneConfig || {}));
        for (const provider of ['onlinepbx', 'twilio', 'myati']) {
            if (cfg[provider]) {
                for (const key of ['apiKey', 'apiId', 'authToken']) {
                    if (cfg[provider][key]) {
                        cfg[provider][key] = cfg[provider][key].slice(0, 4) + '****';
                    }
                }
            }
        }
        return {
            provider: t.phoneProvider,
            config: cfg,
        };
    }
    async getSourceRouting(tenantId) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { sourceRouting: true },
        });
        if (!tenant)
            return null;
        return tenant.sourceRouting || {};
    }
    async updateSourceRouting(tenantId, sourceRouting) {
        if (sourceRouting && typeof sourceRouting === 'object') {
            for (const [source, agentId] of Object.entries(sourceRouting)) {
                if (agentId && agentId !== 'ROUND_ROBIN') {
                    const agent = await this.prisma.user.findFirst({
                        where: { id: agentId, tenantId, status: 'ACTIVE' },
                        select: { id: true },
                    });
                    if (!agent) {
                        throw new Error(`Agent topilmadi: ${agentId} (${source})`);
                    }
                }
            }
        }
        return this.prisma.tenant.update({
            where: { id: tenantId },
            data: { sourceRouting: sourceRouting || {} },
            select: { id: true, sourceRouting: true },
        });
    }
    async stats(tenantId) {
        const [users, clients, bookings] = await Promise.all([
            this.prisma.user.count({ where: { tenantId, status: 'ACTIVE' } }),
            this.prisma.client.count({ where: { tenantId } }),
            this.prisma.booking.count({ where: { tenantId } }),
        ]);
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { maxUsers: true, maxClients: true, maxBookings: true, plan: true },
        });
        return {
            usage: { users, clients, bookings },
            limits: tenant,
        };
    }
};
exports.TenantsService = TenantsService;
exports.TenantsService = TenantsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], TenantsService);
let TenantsController = class TenantsController {
    constructor(svc) {
        this.svc = svc;
    }
    get(u) {
        return this.svc.getSettings(u.tenantId);
    }
    update(body, u) {
        return this.svc.updateSettings(u.tenantId, body);
    }
    stats(u) {
        return this.svc.stats(u.tenantId);
    }
    getPhone(u) {
        return this.svc.getPhoneProvider(u.tenantId);
    }
    updatePhone(body, u) {
        return this.svc.updatePhoneProvider(u.tenantId, body);
    }
    getSourceRouting(u) {
        return this.svc.getSourceRouting(u.tenantId);
    }
    updateSourceRouting(body, u) {
        return this.svc.updateSourceRouting(u.tenantId, body.sourceRouting || {});
    }
};
exports.TenantsController = TenantsController;
__decorate([
    (0, common_1.Get)('settings'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TenantsController.prototype, "get", null);
__decorate([
    (0, common_1.Patch)('settings'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TenantsController.prototype, "update", null);
__decorate([
    (0, common_1.Get)('stats'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TenantsController.prototype, "stats", null);
__decorate([
    (0, common_1.Get)('phone-provider'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TenantsController.prototype, "getPhone", null);
__decorate([
    (0, common_1.Patch)('phone-provider'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TenantsController.prototype, "updatePhone", null);
__decorate([
    (0, common_1.Get)('source-routing'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TenantsController.prototype, "getSourceRouting", null);
__decorate([
    (0, common_1.Patch)('source-routing'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TenantsController.prototype, "updateSourceRouting", null);
exports.TenantsController = TenantsController = __decorate([
    (0, common_1.Controller)('tenants'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [TenantsService])
], TenantsController);
let TenantsModule = class TenantsModule {
};
exports.TenantsModule = TenantsModule;
exports.TenantsModule = TenantsModule = __decorate([
    (0, common_1.Module)({
        controllers: [TenantsController],
        providers: [TenantsService],
    })
], TenantsModule);
//# sourceMappingURL=tenants.module.js.map