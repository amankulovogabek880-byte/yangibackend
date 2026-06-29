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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditInterceptor = void 0;
const common_1 = require("@nestjs/common");
const rxjs_1 = require("rxjs");
const operators_1 = require("rxjs/operators");
const prisma_service_1 = require("../../prisma/prisma.service");
const METHOD_TO_ACTION = {
    POST: 'CREATE',
    PUT: 'UPDATE',
    PATCH: 'UPDATE',
    DELETE: 'DELETE',
};
let AuditInterceptor = class AuditInterceptor {
    constructor(prisma) {
        this.prisma = prisma;
    }
    intercept(context, next) {
        const req = context.switchToHttp().getRequest();
        const method = req.method;
        const user = req.user;
        if (!METHOD_TO_ACTION[method] || !user?.sub) {
            return next.handle();
        }
        const path = req.path;
        const action = METHOD_TO_ACTION[method];
        const entity = path.split('/')[3] || 'unknown';
        return next.handle().pipe((0, operators_1.tap)(async (result) => {
            try {
                await this.prisma.auditLog.create({
                    data: {
                        tenantId: user.tenantId,
                        userId: user.sub,
                        action,
                        entity,
                        entityId: result?.id,
                        metadata: { method, path, params: req.params || {} },
                        ip: req.ip,
                        userAgent: req.headers['user-agent']?.slice(0, 200),
                    },
                });
            }
            catch {
            }
        }), (0, operators_1.catchError)((err) => {
            this.prisma.auditLog
                .create({
                data: {
                    tenantId: user.tenantId,
                    userId: user.sub,
                    action,
                    entity,
                    metadata: { method, path, error: err?.message?.slice(0, 200) },
                    ip: req.ip,
                },
            })
                .catch(() => { });
            return (0, rxjs_1.throwError)(() => err);
        }));
    }
};
exports.AuditInterceptor = AuditInterceptor;
exports.AuditInterceptor = AuditInterceptor = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AuditInterceptor);
//# sourceMappingURL=audit.interceptor.js.map