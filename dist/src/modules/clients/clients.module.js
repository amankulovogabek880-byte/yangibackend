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
exports.ClientsModule = exports.ClientsController = void 0;
const common_1 = require("@nestjs/common");
const clients_service_1 = require("./clients.service");
const event_emitter_1 = require("@nestjs/event-emitter");
const round_robin_module_1 = require("../v9/round-robin.module");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
let ClientsController = class ClientsController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, search, status, tier, source, stage, agentId, tag, sortBy, page, limit) {
        return this.svc.findAll(u.tenantId, u.sub, u.role, {
            search, status, tier, source, stage, agentId, tag, sortBy, page, limit,
        });
    }
    stats(u) {
        return this.svc.getStats(u.tenantId, u.sub, u.role);
    }
    one(id, u) {
        return this.svc.findOne(u.tenantId, id, u.sub, u.role);
    }
    timeline(id, u) {
        return this.svc.getTimeline(u.tenantId, id, u.sub, u.role);
    }
    create(body, u) {
        return this.svc.create(u.tenantId, u.sub, body);
    }
    update(id, body, u) {
        return this.svc.update(u.tenantId, id, u.sub, u.role, body);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, id, u.sub, u.role);
    }
    addNote(id, note, u) {
        return this.svc.addNote(u.tenantId, id, u.sub, u.role, note);
    }
    setTier(id, tier, u) {
        return this.svc.setTier(u.tenantId, id, u.sub, u.role, tier);
    }
    getConversation(id, u) {
        return this.svc.findOrCreateConversation(u.tenantId, id, u.sub, u.role);
    }
    checkConversation(id, u) {
        return this.svc.getExistingConversation(u.tenantId, id, u.sub, u.role);
    }
    callClient(id, u) {
        return this.svc.initiateCall(u.tenantId, id, u.sub, u.role);
    }
    exportCsv(u) {
        return this.svc.exportCsv(u.tenantId, u.sub, u.role);
    }
    statsBySource(u) {
        return this.svc.statsBySource(u.tenantId, u.sub, u.role);
    }
    statsByStage(u) {
        return this.svc.statsByStage(u.tenantId, u.sub, u.role);
    }
};
exports.ClientsController = ClientsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('search')),
    __param(2, (0, common_1.Query)('status')),
    __param(3, (0, common_1.Query)('tier')),
    __param(4, (0, common_1.Query)('source')),
    __param(5, (0, common_1.Query)('stage')),
    __param(6, (0, common_1.Query)('agentId')),
    __param(7, (0, common_1.Query)('tag')),
    __param(8, (0, common_1.Query)('sortBy')),
    __param(9, (0, common_1.Query)('page')),
    __param(10, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, String, String, String, Object, Object, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)('stats'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "stats", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "one", null);
__decorate([
    (0, common_1.Get)(':id/timeline'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "timeline", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "create", null);
__decorate([
    (0, common_1.Put)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "delete", null);
__decorate([
    (0, common_1.Post)(':id/notes'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)('note')),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "addNote", null);
__decorate([
    (0, common_1.Patch)(':id/tier'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)('tier')),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "setTier", null);
__decorate([
    (0, common_1.Get)(':id/conversation'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "getConversation", null);
__decorate([
    (0, common_1.Get)(':id/conversation/check'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "checkConversation", null);
__decorate([
    (0, common_1.Post)(':id/call'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "callClient", null);
__decorate([
    (0, common_1.Get)('actions/export'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "exportCsv", null);
__decorate([
    (0, common_1.Get)('stats/by-source'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "statsBySource", null);
__decorate([
    (0, common_1.Get)('stats/by-stage'),
    __param(0, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "statsByStage", null);
exports.ClientsController = ClientsController = __decorate([
    (0, common_1.Controller)('clients'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [clients_service_1.ClientsService])
], ClientsController);
let ClientsModule = class ClientsModule {
};
exports.ClientsModule = ClientsModule;
exports.ClientsModule = ClientsModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        imports: [round_robin_module_1.RoundRobinModule, event_emitter_1.EventEmitterModule.forRoot()],
        controllers: [ClientsController],
        providers: [clients_service_1.ClientsService],
        exports: [clients_service_1.ClientsService],
    })
], ClientsModule);
//# sourceMappingURL=clients.module.js.map