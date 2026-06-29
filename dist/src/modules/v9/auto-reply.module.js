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
exports.AutoReplyModule = exports.AutoReplyController = exports.AutoReplyService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
let AutoReplyService = class AutoReplyService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async list(tenantId) {
        return this.prisma.autoReplyRule.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
        });
    }
    async create(tenantId, data) {
        if (!data.name?.trim())
            throw new common_1.BadRequestException('Nom kerak');
        if (!data.channel || !['TELEGRAM', 'EMAIL'].includes(data.channel)) {
            throw new common_1.BadRequestException('Kanal: TELEGRAM yoki EMAIL');
        }
        if (!data.template?.trim())
            throw new common_1.BadRequestException('Matn kerak');
        return this.prisma.autoReplyRule.create({
            data: {
                tenantId,
                name: data.name.trim(),
                source: data.source || null,
                channel: data.channel,
                template: data.template,
                delayMs: Math.max(0, parseInt(data.delayMs) || 0),
                isActive: data.isActive !== false,
            },
        });
    }
    async update(tenantId, ruleId, data) {
        const rule = await this.prisma.autoReplyRule.findFirst({
            where: { id: ruleId, tenantId },
        });
        if (!rule)
            throw new common_1.BadRequestException('Qoida topilmadi');
        return this.prisma.autoReplyRule.update({
            where: { id: ruleId },
            data: {
                name: data.name || rule.name,
                source: data.source !== undefined ? data.source : rule.source,
                channel: data.channel || rule.channel,
                template: data.template || rule.template,
                delayMs: data.delayMs !== undefined ? Math.max(0, parseInt(data.delayMs)) : rule.delayMs,
                isActive: data.isActive !== undefined ? data.isActive : rule.isActive,
            },
        });
    }
    async delete(tenantId, ruleId) {
        const rule = await this.prisma.autoReplyRule.findFirst({
            where: { id: ruleId, tenantId },
        });
        if (!rule)
            throw new common_1.BadRequestException('Qoida topilmadi');
        await this.prisma.autoReplyRule.delete({ where: { id: ruleId } });
        return { success: true };
    }
    async toggle(tenantId, ruleId) {
        const rule = await this.prisma.autoReplyRule.findFirst({
            where: { id: ruleId, tenantId },
        });
        if (!rule)
            throw new common_1.BadRequestException('Qoida topilmadi');
        return this.prisma.autoReplyRule.update({
            where: { id: ruleId },
            data: { isActive: !rule.isActive },
        });
    }
    async renderTemplate(template, client) {
        let result = template;
        const placeholders = {
            'client.fullName': client.fullName || '',
            'client.phone': client.phone || '',
            'client.email': client.email || '',
            'client.source': client.source || '',
        };
        for (const [key, value] of Object.entries(placeholders)) {
            result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
        }
        return result;
    }
    async triggerRules(tenantId, clientId, source) {
        const client = await this.prisma.client.findFirst({
            where: { id: clientId, tenantId },
        });
        if (!client)
            return;
        const rules = await this.prisma.autoReplyRule.findMany({
            where: {
                tenantId,
                isActive: true,
                OR: [{ source: null }, { source }],
            },
        });
        for (const rule of rules) {
            const message = await this.renderTemplate(rule.template, client);
            setTimeout(async () => {
                try {
                    if (rule.channel === 'TELEGRAM' && client.telegramId) {
                        const accounts = await this.prisma.telegramAccount.findMany({
                            where: { tenantId, isActive: true, botToken: { not: null } },
                            take: 1,
                        });
                        if (accounts.length > 0 && accounts[0].botToken) {
                            const chatId = client.telegramId;
                            const token = accounts[0].botToken;
                            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
                            }).catch((e) => console.error('[AutoReply] Telegram send error:', e?.message));
                        }
                    }
                    else if (rule.channel === 'EMAIL' && client.email) {
                        console.log(`[AutoReply] Email to ${client.email}: ${message}`);
                    }
                    await this.prisma.autoReplyRule.update({
                        where: { id: rule.id },
                        data: { triggerCount: { increment: 1 } },
                    });
                }
                catch (e) {
                    console.error(`[AutoReply] Error rule ${rule.id}:`, e?.message);
                }
            }, rule.delayMs || 0);
        }
    }
};
exports.AutoReplyService = AutoReplyService;
exports.AutoReplyService = AutoReplyService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AutoReplyService);
let AutoReplyController = class AutoReplyController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u) {
        return this.svc.list(u.tenantId);
    }
    create(u, body) {
        return this.svc.create(u.tenantId, body);
    }
    update(u, id, body) {
        return this.svc.update(u.tenantId, id, body);
    }
    delete(u, id) {
        return this.svc.delete(u.tenantId, id);
    }
    toggle(u, id) {
        return this.svc.toggle(u.tenantId, id);
    }
};
exports.AutoReplyController = AutoReplyController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AutoReplyController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], AutoReplyController.prototype, "create", null);
__decorate([
    (0, common_1.Put)(':id'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], AutoReplyController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], AutoReplyController.prototype, "delete", null);
__decorate([
    (0, common_1.Post)(':id/toggle'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], AutoReplyController.prototype, "toggle", null);
exports.AutoReplyController = AutoReplyController = __decorate([
    (0, common_1.Controller)('auto-reply-rules'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __metadata("design:paramtypes", [AutoReplyService])
], AutoReplyController);
let AutoReplyModule = class AutoReplyModule {
};
exports.AutoReplyModule = AutoReplyModule;
exports.AutoReplyModule = AutoReplyModule = __decorate([
    (0, common_1.Module)({
        controllers: [AutoReplyController],
        providers: [AutoReplyService],
        exports: [AutoReplyService],
    })
], AutoReplyModule);
//# sourceMappingURL=auto-reply.module.js.map