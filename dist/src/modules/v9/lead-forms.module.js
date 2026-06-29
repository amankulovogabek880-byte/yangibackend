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
exports.LeadFormsModule = exports.PublicFormController = exports.LeadFormsController = exports.LeadFormsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const decorators_1 = require("../../common/decorators");
const round_robin_module_1 = require("./round-robin.module");
let LeadFormsService = class LeadFormsService {
    constructor(prisma, roundRobin) {
        this.prisma = prisma;
        this.roundRobin = roundRobin;
    }
    async list(tenantId) {
        return this.prisma.leadForm.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
        });
    }
    async getBySlug(tenantId, slug) {
        return this.prisma.leadForm.findFirst({
            where: { tenantId, slug, isActive: true },
        });
    }
    async create(tenantId, data) {
        if (!data.name?.trim() || !data.slug?.trim()) {
            throw new common_1.BadRequestException('Nom va slug kerak');
        }
        const slug = data.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const existing = await this.prisma.leadForm.findFirst({
            where: { tenantId, slug },
        });
        if (existing)
            throw new common_1.BadRequestException('Bu slug allaqachon bor');
        return this.prisma.leadForm.create({
            data: {
                tenantId,
                name: data.name.trim(),
                slug,
                description: data.description || null,
                fields: data.fields || [],
                theme: data.theme || { primaryColor: '#3d7eff' },
                successMsg: data.successMsg || 'Rahmat!',
                redirectUrl: data.redirectUrl || null,
                isActive: data.isActive !== false,
            },
        });
    }
    async update(tenantId, formId, data) {
        const form = await this.prisma.leadForm.findFirst({
            where: { id: formId, tenantId },
        });
        if (!form)
            throw new common_1.BadRequestException('Form topilmadi');
        return this.prisma.leadForm.update({
            where: { id: formId },
            data: {
                name: data.name || form.name,
                description: data.description,
                fields: data.fields || form.fields,
                theme: data.theme || form.theme,
                successMsg: data.successMsg || form.successMsg,
                redirectUrl: data.redirectUrl,
                isActive: data.isActive !== undefined ? data.isActive : form.isActive,
            },
        });
    }
    async delete(tenantId, formId) {
        const form = await this.prisma.leadForm.findFirst({
            where: { id: formId, tenantId },
        });
        if (!form)
            throw new common_1.BadRequestException('Form topilmadi');
        await this.prisma.leadForm.delete({ where: { id: formId } });
        return { success: true };
    }
    async submit(tenantId, slug, data) {
        const form = await this.getBySlug(tenantId, slug);
        if (!form)
            throw new common_1.BadRequestException('Form topilmadi');
        const fullName = (data.fullName || data.full_name || '').trim();
        const email = (data.email || data.contact_email || '').trim().toLowerCase() || null;
        const phone = (data.phone || data.contact_phone || '').trim() || null;
        const message = data.message || data.notes || null;
        if (!fullName)
            throw new common_1.BadRequestException('Ism majburiy');
        if (!phone && !email)
            throw new common_1.BadRequestException('Telefon yoki email kerak');
        await this.prisma.leadFormSubmission?.create({
            data: { formId: form.id, tenantId, data, email, phone },
        }).catch(() => { });
        let existing = null;
        if (phone)
            existing = await this.prisma.client.findFirst({ where: { tenantId, phone } });
        if (!existing && email)
            existing = await this.prisma.client.findFirst({ where: { tenantId, email } });
        let clientId;
        let assignedAgentId = null;
        if (existing) {
            clientId = existing.id;
            await this.prisma.clientTimeline?.create({
                data: {
                    clientId, type: 'message',
                    title: `🔁 Web forma orqali yangi murojaat (${form.name})`,
                    description: message,
                    metadata: { isDuplicate: true, formSlug: slug, formName: form.name },
                },
            }).catch(() => { });
        }
        else {
            const newClient = await this.prisma.client.create({
                data: {
                    tenantId, fullName, phone, email, notes: message,
                    source: 'WEBSITE', pipelineStage: 'NEW_LEAD',
                    status: 'ACTIVE', tier: 'REGULAR',
                },
            });
            clientId = newClient.id;
            await this.prisma.clientTimeline?.create({
                data: {
                    clientId, type: 'created',
                    title: `📥 Web forma orqali lead — ${form.name}`,
                    description: message,
                    metadata: { formSlug: slug, formName: form.name, formId: form.id },
                },
            }).catch(() => { });
            assignedAgentId = await this.roundRobin.assignNewLead({
                tenantId,
                clientId,
                clientName: fullName,
                source: 'WEBSITE',
            }).catch(() => null);
        }
        await this.prisma.leadForm.update({
            where: { id: form.id },
            data: { submitCount: form.submitCount + 1, lastSubmitAt: new Date() },
        }).catch(() => { });
        return { success: true, message: form.successMsg || 'Rahmat!', clientId, assignedAgentId };
    }
    async getStats(tenantId, formId) {
        const form = await this.prisma.leadForm.findFirst({
            where: { id: formId, tenantId },
        });
        if (!form)
            throw new common_1.BadRequestException('Form topilmadi');
        return {
            submitCount: form.submitCount,
            lastSubmitAt: form.lastSubmitAt,
        };
    }
};
exports.LeadFormsService = LeadFormsService;
exports.LeadFormsService = LeadFormsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        round_robin_module_1.RoundRobinService])
], LeadFormsService);
let LeadFormsController = class LeadFormsController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u) {
        return this.svc.list(u.tenantId);
    }
    stats(u, id) {
        return this.svc.getStats(u.tenantId, id);
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
};
exports.LeadFormsController = LeadFormsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], LeadFormsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(':id/stats'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LeadFormsController.prototype, "stats", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], LeadFormsController.prototype, "create", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LeadFormsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)('TENANT_ADMIN'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LeadFormsController.prototype, "delete", null);
exports.LeadFormsController = LeadFormsController = __decorate([
    (0, common_1.Controller)('lead-forms'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [LeadFormsService])
], LeadFormsController);
let PublicFormController = class PublicFormController {
    constructor(svc) {
        this.svc = svc;
    }
    async getForm(tenantId, slug) {
        const form = await this.svc.getBySlug(tenantId, slug);
        if (!form)
            throw new common_1.BadRequestException('Form topilmadi');
        return form;
    }
    async submitForm(tenantId, slug, body) {
        return this.svc.submit(tenantId, slug, body);
    }
};
exports.PublicFormController = PublicFormController;
__decorate([
    (0, common_1.Get)(':tenantId/:slug'),
    __param(0, (0, common_1.Param)('tenantId')),
    __param(1, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], PublicFormController.prototype, "getForm", null);
__decorate([
    (0, common_1.Post)(':tenantId/:slug/submit'),
    __param(0, (0, common_1.Param)('tenantId')),
    __param(1, (0, common_1.Param)('slug')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], PublicFormController.prototype, "submitForm", null);
exports.PublicFormController = PublicFormController = __decorate([
    (0, common_1.Controller)('public/forms'),
    __metadata("design:paramtypes", [LeadFormsService])
], PublicFormController);
let LeadFormsModule = class LeadFormsModule {
};
exports.LeadFormsModule = LeadFormsModule;
exports.LeadFormsModule = LeadFormsModule = __decorate([
    (0, common_1.Module)({
        imports: [round_robin_module_1.RoundRobinModule],
        controllers: [LeadFormsController, PublicFormController],
        providers: [LeadFormsService],
        exports: [LeadFormsService],
    })
], LeadFormsModule);
//# sourceMappingURL=lead-forms.module.js.map