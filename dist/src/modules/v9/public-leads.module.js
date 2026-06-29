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
exports.PublicLeadsModule = exports.WebhookLogsController = exports.ApiKeysController = exports.PublicLeadsController = exports.PublicLeadsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
const round_robin_module_1 = require("./round-robin.module");
const lead_scoring_module_1 = require("./lead-scoring.module");
const auto_reply_module_1 = require("./auto-reply.module");
const notifications_service_1 = require("../notifications/notifications.service");
const audit_module_1 = require("../audit/audit.module");
const realtime_gateway_1 = require("../realtime/realtime.gateway");
const realtime_module_1 = require("../realtime/realtime.module");
const crypto = __importStar(require("crypto"));
const SOURCE_MAP = {
    WEB: 'WEBSITE',
    WEBSITE: 'WEBSITE',
    TELEGRAM: 'TELEGRAM',
    TELEGRAM_BOT: 'TELEGRAM',
    INSTAGRAM: 'INSTAGRAM',
    WHATSAPP: 'WHATSAPP',
    FACEBOOK: 'FACEBOOK',
    FACEBOOK_ADS: 'FACEBOOK',
    GOOGLE_ADS: 'GOOGLE_ADS',
    REFERRAL: 'REFERRAL',
    WALKIN: 'WALKIN',
    CALL: 'CALL',
};
function mapSource(raw) {
    return SOURCE_MAP[(raw || '').toUpperCase()] || 'OTHER';
}
let PublicLeadsService = class PublicLeadsService {
    constructor(prisma, roundRobin, scoring, autoReply, notifications, audit, realtime) {
        this.prisma = prisma;
        this.roundRobin = roundRobin;
        this.scoring = scoring;
        this.autoReply = autoReply;
        this.notifications = notifications;
        this.audit = audit;
        this.realtime = realtime;
        this.logger = new common_1.Logger('PublicLeads');
    }
    async createLead(tenantId, apiKey, data, meta) {
        const startedAt = Date.now();
        let logClientId = null;
        let logApiKey = null;
        let logSuccess = false;
        let logError = null;
        let logResponse = null;
        let logStatus = 200;
        const writeLog = async () => {
            try {
                await this.prisma.webhookLog.create({
                    data: {
                        tenantId,
                        apiKeyId: logApiKey?.id || null,
                        apiKeyPrefix: logApiKey?.prefix || null,
                        apiKeyName: logApiKey?.name || null,
                        endpoint: `/public/leads/${tenantId}`,
                        method: 'POST',
                        requestBody: data,
                        responseBody: logResponse,
                        statusCode: logStatus,
                        success: logSuccess,
                        errorMessage: logError,
                        clientId: logClientId,
                        ip: meta?.ip || null,
                        userAgent: meta?.userAgent || null,
                        duration: Date.now() - startedAt,
                    },
                });
            }
            catch (e) {
                this.logger.error('WebhookLog yozilmadi: ' + e);
            }
        };
        try {
            const tenant = await this.prisma.tenant.findFirst({
                where: { id: tenantId, status: 'ACTIVE' },
                select: { id: true, name: true, sourceRouting: true },
            });
            if (!tenant) {
                throw new common_1.UnauthorizedException('Tenant topilmadi yoki nofaol');
            }
            const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
            const validKey = await this.prisma.apiKey.findFirst({
                where: {
                    tenantId,
                    keyHash,
                    isActive: true,
                    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                },
            });
            logApiKey = validKey;
            if (!validKey) {
                throw new common_1.UnauthorizedException("API key noto'g'ri yoki muddati tugagan");
            }
            if (!validKey.scopes?.includes('leads:write')) {
                throw new common_1.UnauthorizedException("API key'da leads:write huquqi yo'q");
            }
            const fullName = data.fullName?.trim();
            if (!fullName) {
                throw new common_1.BadRequestException('fullName majburiy');
            }
            const phone = data.phone?.trim() || null;
            const email = data.email?.trim().toLowerCase() || null;
            const telegramUsername = data.telegramUsername?.replace(/^@/, '').trim() || null;
            if (!phone && !email && !telegramUsername) {
                throw new common_1.BadRequestException("Kamida bitta aloqa kerak: phone, email yoki telegramUsername");
            }
            const mappedSource = mapSource(data.source);
            let existing = null;
            if (phone) {
                existing = await this.prisma.client.findFirst({
                    where: { tenantId, phone },
                });
            }
            if (!existing && email) {
                existing = await this.prisma.client.findFirst({
                    where: { tenantId, email },
                });
            }
            if (!existing && telegramUsername) {
                existing = await this.prisma.client.findFirst({
                    where: { tenantId, telegramUsername },
                });
            }
            if (existing) {
                logClientId = existing.id;
                await this.prisma.clientTimeline.create({
                    data: {
                        clientId: existing.id,
                        type: 'message',
                        title: `🔁 Qayta murojaat (${mappedSource})`,
                        description: data.message || `Yangi qiziqish: ${data.tourInterest || ''}`,
                        metadata: {
                            isDuplicate: true,
                            source: mappedSource,
                            originalSource: data.source,
                            utmSource: data.utmSource,
                            utmCampaign: data.utmCampaign,
                            ip: meta?.ip,
                        },
                    },
                });
                await this.prisma.apiKey.update({
                    where: { id: validKey.id },
                    data: { lastUsedAt: new Date() },
                }).catch(() => { });
                this.audit.log({
                    tenantId,
                    action: 'UPDATE',
                    entity: 'client',
                    entityId: existing.id,
                    metadata: { isDuplicate: true, source: mappedSource, apiKeyId: validKey.id },
                });
                logSuccess = true;
                logStatus = 200;
                logResponse = { ok: true, isDuplicate: true, clientId: existing.id };
                await writeLog();
                return {
                    ok: true,
                    clientId: existing.id,
                    isDuplicate: true,
                    assignedAgentId: existing.assignedAgentId || null,
                    message: "Mavjud klientga yangi murojaat qo'shildi",
                };
            }
            const newClient = await this.prisma.client.create({
                data: {
                    tenantId,
                    fullName,
                    phone,
                    email,
                    telegramUsername,
                    source: mappedSource,
                    country: data.country || null,
                    city: data.city || null,
                    notes: data.message || null,
                    pipelineStage: 'NEW_LEAD',
                    status: 'ACTIVE',
                    tier: 'REGULAR',
                    utmSource: data.utmSource || null,
                    utmMedium: data.utmMedium || null,
                    utmCampaign: data.utmCampaign || null,
                },
            });
            logClientId = newClient.id;
            this.logger.log(`[PUBLIC LEADS] Yangi client yaratildi: ${newClient.id} (${fullName}) tenant=${tenantId}`);
            await this.prisma.clientTimeline.create({
                data: {
                    clientId: newClient.id,
                    type: 'created',
                    title: `📥 Yangi lead — ${mappedSource}`,
                    description: data.tourInterest
                        ? `Qiziqish: ${data.tourInterest}`
                        : data.message || null,
                    metadata: {
                        source: mappedSource,
                        originalSource: data.source,
                        utmSource: data.utmSource,
                        utmCampaign: data.utmCampaign,
                        ip: meta?.ip,
                        userAgent: meta?.userAgent,
                    },
                },
            }).catch(() => { });
            this.scoring.scoreClient(tenantId, newClient.id).catch((e) => {
                this.logger.error('Scoring error: ' + e?.message);
            });
            this.autoReply.triggerRules(tenantId, newClient.id, mappedSource).catch((e) => {
                this.logger.error('AutoReply error: ' + e?.message);
            });
            let assignedAgentId = null;
            try {
                const sourceRouting = (tenant.sourceRouting || {});
                const routedAgentId = sourceRouting[mappedSource];
                if (routedAgentId && routedAgentId !== 'ROUND_ROBIN') {
                    const routedAgent = await this.prisma.user.findFirst({
                        where: {
                            id: routedAgentId,
                            tenantId,
                            status: 'ACTIVE',
                            isPausedFromAssignment: false,
                        },
                        select: { id: true },
                    });
                    if (routedAgent) {
                        await this.prisma.client.update({
                            where: { id: newClient.id },
                            data: { assignedAgentId: routedAgent.id },
                        });
                        await this.prisma.clientTimeline.create({
                            data: {
                                clientId: newClient.id,
                                userId: routedAgent.id,
                                type: 'assigned',
                                title: `🎯 Tayinlandi (Source Routing: ${mappedSource})`,
                                metadata: { autoAssigned: true, source: mappedSource, strategy: 'SOURCE_ROUTING' },
                            },
                        }).catch(() => { });
                        await this.notifications.create({
                            tenantId,
                            userId: routedAgent.id,
                            type: 'CLIENT_ASSIGNED',
                            title: `🎯 Yangi lead: ${fullName}`,
                            body: `Sizga yangi mijoz tayinlandi. Manba: ${mappedSource}`,
                            link: `/clients/${newClient.id}`,
                            metadata: { clientId: newClient.id, source: mappedSource, autoAssigned: true },
                        }).catch(() => { });
                        assignedAgentId = routedAgent.id;
                        this.logger.log(`[PUBLIC LEADS] Source routing: Lead=${newClient.id} → Agent=${routedAgent.id} (${mappedSource})`);
                    }
                }
                if (!assignedAgentId) {
                    assignedAgentId = await this.roundRobin.assignNewLead({
                        tenantId,
                        clientId: newClient.id,
                        clientName: fullName,
                        source: mappedSource,
                    });
                }
            }
            catch (rrErr) {
                this.logger.error(`[PUBLIC LEADS] Round Robin xato: ${rrErr?.message}`);
            }
            if (assignedAgentId) {
                this.realtime.emitToUser(assignedAgentId, 'lead:assigned', {
                    clientId: newClient.id,
                    fullName,
                    source: mappedSource,
                    assignedAt: new Date().toISOString(),
                });
                this.realtime.emitToTenant(tenantId, 'dashboard:update', {
                    type: 'new_lead',
                    clientId: newClient.id,
                });
            }
            else {
                try {
                    const admins = await this.prisma.user.findMany({
                        where: {
                            tenantId,
                            status: 'ACTIVE',
                            role: { in: ['TENANT_ADMIN', 'MANAGER'] },
                        },
                        select: { id: true },
                    });
                    for (const admin of admins) {
                        await this.notifications.create({
                            tenantId,
                            userId: admin.id,
                            type: 'LEAD_NEW',
                            title: `📥 Yangi lead tayinlanmadi: ${fullName}`,
                            body: `Manba: ${mappedSource}. Agent topilmadi — qo'lda tayinlang.`,
                            link: `/clients/${newClient.id}`,
                            metadata: { clientId: newClient.id, source: mappedSource, unassigned: true },
                        }).catch(() => { });
                    }
                    this.realtime.emitToTenant(tenantId, 'dashboard:update', {
                        type: 'new_lead_unassigned',
                        clientId: newClient.id,
                    });
                }
                catch (e) {
                    this.logger.error('Admin notification xato: ' + e?.message);
                }
            }
            await this.prisma.apiKey.update({
                where: { id: validKey.id },
                data: { lastUsedAt: new Date() },
            }).catch(() => { });
            this.audit.log({
                tenantId,
                action: 'CREATE',
                entity: 'client',
                entityId: newClient.id,
                metadata: {
                    public: true,
                    apiKeyId: validKey.id,
                    source: mappedSource,
                    isDuplicate: false,
                    assignedAgentId,
                    ip: meta?.ip,
                },
            });
            logSuccess = true;
            logStatus = 200;
            logResponse = { ok: true, clientId: newClient.id, assignedAgentId };
            await writeLog();
            this.logger.log(`[PUBLIC LEADS] ✅ Lead yaratildi: ${newClient.id} | Agent: ${assignedAgentId || 'YOQ'} | Tenant: ${tenantId}`);
            return {
                ok: true,
                clientId: newClient.id,
                isDuplicate: false,
                assignedAgentId,
                message: assignedAgentId
                    ? 'Yangi lead yaratildi va agentga tayinlandi'
                    : "Yangi lead yaratildi (agent topilmadi — qo'lda tayinlang)",
            };
        }
        catch (err) {
            logSuccess = false;
            logStatus = err?.status || 500;
            logError = err?.message || 'Noma\'lum xato';
            logResponse = { error: logError };
            await writeLog();
            throw err;
        }
    }
    async listApiKeys(tenantId) {
        return this.prisma.apiKey.findMany({
            where: { tenantId },
            select: {
                id: true, name: true, prefix: true,
                scopes: true, isActive: true,
                lastUsedAt: true, expiresAt: true, createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });
    }
    async createApiKey(tenantId, name, expiresInDays) {
        if (!name?.trim())
            throw new common_1.BadRequestException('Kalit nomi kerak');
        const rawKey = `omon_${crypto.randomBytes(24).toString('hex')}`;
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const prefix = rawKey.slice(0, 12) + '...';
        const expiresAt = expiresInDays
            ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
            : null;
        const apiKey = await this.prisma.apiKey.create({
            data: {
                tenantId,
                name: name.trim(),
                keyHash,
                prefix,
                scopes: ['leads:write'],
                isActive: true,
                expiresAt,
            },
            select: {
                id: true, name: true, prefix: true,
                scopes: true, expiresAt: true, createdAt: true,
            },
        });
        return {
            ...apiKey,
            key: rawKey,
            warning: "Bu kalit faqat hozir ko'rsatiladi. Saqlab oling!",
        };
    }
    async revokeApiKey(tenantId, id) {
        const k = await this.prisma.apiKey.findFirst({ where: { id, tenantId } });
        if (!k)
            throw new common_1.BadRequestException('Kalit topilmadi');
        await this.prisma.apiKey.update({ where: { id }, data: { isActive: false } });
        return { ok: true };
    }
    async deleteApiKey(tenantId, id) {
        const k = await this.prisma.apiKey.findFirst({ where: { id, tenantId } });
        if (!k)
            throw new common_1.BadRequestException('Kalit topilmadi');
        await this.prisma.apiKey.delete({ where: { id } });
        return { ok: true };
    }
};
exports.PublicLeadsService = PublicLeadsService;
exports.PublicLeadsService = PublicLeadsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        round_robin_module_1.RoundRobinService,
        lead_scoring_module_1.LeadScoringService,
        auto_reply_module_1.AutoReplyService,
        notifications_service_1.NotificationsService,
        audit_module_1.AuditService,
        realtime_gateway_1.RealtimeGateway])
], PublicLeadsService);
let PublicLeadsController = class PublicLeadsController {
    constructor(svc) {
        this.svc = svc;
    }
    async create(tenantId, body, queryKey, headerKey, req) {
        const apiKey = queryKey || headerKey;
        if (!apiKey) {
            throw new common_1.UnauthorizedException('API key kerak (?key= yoki X-API-Key header)');
        }
        return this.svc.createLead(tenantId, apiKey, body, {
            ip: req.ip,
            userAgent: req.headers['user-agent'],
        });
    }
};
exports.PublicLeadsController = PublicLeadsController;
__decorate([
    (0, common_1.Post)(':tenantId'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Param)('tenantId')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Query)('key')),
    __param(3, (0, common_1.Headers)('x-api-key')),
    __param(4, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], PublicLeadsController.prototype, "create", null);
exports.PublicLeadsController = PublicLeadsController = __decorate([
    (0, common_1.Controller)('public/leads'),
    __metadata("design:paramtypes", [PublicLeadsService])
], PublicLeadsController);
let ApiKeysController = class ApiKeysController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u) {
        return this.svc.listApiKeys(u.tenantId);
    }
    create(body, u) {
        return this.svc.createApiKey(u.tenantId, body.name, body.expiresInDays);
    }
    revoke(id, u) {
        return this.svc.revokeApiKey(u.tenantId, id);
    }
    delete(id, u) {
        return this.svc.deleteApiKey(u.tenantId, id);
    }
    guide(u) {
        const base = process.env.PUBLIC_API_URL || 'http://localhost:3000/api/v1';
        return {
            endpoint: `POST ${base}/public/leads/${u.tenantId}`,
            auth: [
                `?key=YOUR_API_KEY`,
                `Header: X-API-Key: YOUR_API_KEY`,
            ],
            required: ['fullName', 'phone | email | telegramUsername'],
            optional: ['source', 'message', 'tourInterest', 'country', 'city', 'utmSource', 'utmMedium', 'utmCampaign'],
            example: {
                curl: `curl -X POST "${base}/public/leads/${u.tenantId}?key=YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"fullName":"Aziz Aliyev","phone":"+998901234567","source":"WEB"}'`,
            },
        };
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
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], ApiKeysController.prototype, "create", null);
__decorate([
    (0, common_1.Post)(':id/revoke'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ApiKeysController.prototype, "revoke", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ApiKeysController.prototype, "delete", null);
__decorate([
    (0, common_1.Get)('integration-guide'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ApiKeysController.prototype, "guide", null);
exports.ApiKeysController = ApiKeysController = __decorate([
    (0, common_1.Controller)('api-keys'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [PublicLeadsService])
], ApiKeysController);
let WebhookLogsController = class WebhookLogsController {
    get prisma() { return this.svc.prisma; }
    constructor(svc) {
        this.svc = svc;
    }
    async list(u, apiKeyId, success, limit) {
        const where = { tenantId: u.tenantId };
        if (apiKeyId)
            where.apiKeyId = apiKeyId;
        if (success === 'true')
            where.success = true;
        if (success === 'false')
            where.success = false;
        const take = Math.min(Number(limit) || 100, 500);
        const [logs, total, stats] = await Promise.all([
            this.prisma.webhookLog.findMany({ where, orderBy: { createdAt: 'desc' }, take }),
            this.prisma.webhookLog.count({ where: { tenantId: u.tenantId } }),
            this.prisma.webhookLog.groupBy({
                by: ['success'],
                where: { tenantId: u.tenantId },
                _count: { id: true },
            }),
        ]);
        const successCount = stats.find((s) => s.success === true)?._count.id || 0;
        const failedCount = stats.find((s) => s.success === false)?._count.id || 0;
        return {
            data: logs,
            total,
            stats: {
                successCount,
                failedCount,
                successRate: total > 0 ? Math.round((successCount / total) * 100) : 0,
            },
        };
    }
    async one(id, u) {
        const log = await this.prisma.webhookLog.findFirst({
            where: { id, tenantId: u.tenantId },
        });
        if (!log)
            throw new common_1.BadRequestException('Log topilmadi');
        return log;
    }
    async delete(id, u) {
        const log = await this.prisma.webhookLog.findFirst({
            where: { id, tenantId: u.tenantId },
        });
        if (!log)
            throw new common_1.BadRequestException('Log topilmadi');
        await this.prisma.webhookLog.delete({ where: { id } });
        return { ok: true };
    }
};
exports.WebhookLogsController = WebhookLogsController;
__decorate([
    (0, common_1.Get)(),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('apiKeyId')),
    __param(2, (0, common_1.Query)('success')),
    __param(3, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", Promise)
], WebhookLogsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN', 'MANAGER'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], WebhookLogsController.prototype, "one", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], WebhookLogsController.prototype, "delete", null);
exports.WebhookLogsController = WebhookLogsController = __decorate([
    (0, common_1.Controller)('webhook-logs'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [PublicLeadsService])
], WebhookLogsController);
let PublicLeadsModule = class PublicLeadsModule {
};
exports.PublicLeadsModule = PublicLeadsModule;
exports.PublicLeadsModule = PublicLeadsModule = __decorate([
    (0, common_1.Module)({
        imports: [round_robin_module_1.RoundRobinModule, lead_scoring_module_1.LeadScoringModule, auto_reply_module_1.AutoReplyModule, realtime_module_1.RealtimeModule],
        controllers: [PublicLeadsController, ApiKeysController, WebhookLogsController],
        providers: [PublicLeadsService],
        exports: [PublicLeadsService],
    })
], PublicLeadsModule);
//# sourceMappingURL=public-leads.module.js.map