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
exports.DocumentsModule = exports.DocumentsController = exports.DocumentsService = void 0;
const common_1 = require("@nestjs/common");
const platform_express_1 = require("@nestjs/platform-express");
const multer_1 = require("multer");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const uuid_1 = require("uuid");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
const helpers_1 = require("../../common/utils/helpers");
;
const CATEGORIES = [
    'PASSPORT', 'VISA', 'TICKET', 'CONTRACT', 'INVOICE', 'RECEIPT', 'PHOTO', 'OTHER',
];
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_FILE_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB || '20')) * 1024 * 1024;
if (!fs.existsSync(UPLOAD_DIR))
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
let DocumentsService = class DocumentsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async list(tenantId, userId, role, params) {
        const { skip, take, page, limit } = (0, helpers_1.paginate)(params.page, params.limit);
        const where = { tenantId };
        if (params.clientId)
            where.clientId = params.clientId;
        if (params.bookingId)
            where.bookingId = params.bookingId;
        if (params.category)
            where.category = params.category;
        if (role === 'AGENT') {
            where.OR = [
                { uploadedById: userId },
                { client: { assignedAgentId: userId } },
                { booking: { agentId: userId } },
            ];
        }
        const [data, total] = await Promise.all([
            this.prisma.document.findMany({
                where, skip, take,
                include: {
                    uploadedBy: { select: { id: true, name: true } },
                    client: { select: { id: true, fullName: true } },
                    booking: { select: { id: true, bookingRef: true } },
                },
                orderBy: { createdAt: 'desc' },
            }),
            this.prisma.document.count({ where }),
        ]);
        return { data, meta: (0, helpers_1.meta)(total, page, limit) };
    }
    async create(tenantId, userId, file, data) {
        if (!file)
            throw new common_1.BadRequestException('Fayl yuklanmagan');
        return this.prisma.document.create({
            data: {
                tenantId,
                uploadedById: userId,
                clientId: data.clientId,
                bookingId: data.bookingId,
                name: data.name || file.originalname,
                category: (0, helpers_1.safeEnum)(data.category, CATEGORIES, 'OTHER'),
                fileName: file.originalname,
                fileUrl: `${process.env.API_BASE_URL || process.env.FRONTEND_URL?.replace('3001', '3000') || 'http://localhost:3000'}/uploads/${file.filename}`,
                fileMimeType: file.mimetype,
                fileSize: file.size,
                description: data.description,
                expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
                documentNo: data.documentNo,
            },
        });
    }
    async delete(tenantId, userId, role, id) {
        const doc = await this.prisma.document.findFirst({ where: { id, tenantId } });
        if (!doc)
            throw new common_1.NotFoundException('Topilmadi');
        if (role === 'AGENT' && doc.uploadedById !== userId) {
            throw new common_1.BadRequestException("Faqat o'zingiz yuklagan faylni o'chira olasiz");
        }
        try {
            const filePath = path.join(UPLOAD_DIR, path.basename(doc.fileUrl));
            if (fs.existsSync(filePath))
                fs.unlinkSync(filePath);
        }
        catch { }
        await this.prisma.document.delete({ where: { id } });
        return { ok: true };
    }
};
exports.DocumentsService = DocumentsService;
exports.DocumentsService = DocumentsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], DocumentsService);
let DocumentsController = class DocumentsController {
    constructor(svc) {
        this.svc = svc;
    }
    list(u, clientId, bookingId, category, page, limit) {
        return this.svc.list(u.tenantId, u.sub, u.role, { clientId, bookingId, category, page, limit });
    }
    upload(file, body, u) {
        return this.svc.create(u.tenantId, u.sub, file, body);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, u.sub, u.role, id);
    }
};
exports.DocumentsController = DocumentsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('clientId')),
    __param(2, (0, common_1.Query)('bookingId')),
    __param(3, (0, common_1.Query)('category')),
    __param(4, (0, common_1.Query)('page')),
    __param(5, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, Object, Object]),
    __metadata("design:returntype", void 0)
], DocumentsController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', {
        storage: (0, multer_1.diskStorage)({
            destination: UPLOAD_DIR,
            filename: (_req, file, cb) => {
                const ext = path.extname(file.originalname) || '';
                cb(null, `${(0, uuid_1.v4)()}${ext}`);
            },
        }),
        limits: { fileSize: MAX_FILE_SIZE },
        fileFilter: (_req, file, cb) => {
            const ok = /\.(jpg|jpeg|png|gif|pdf|docx?|xlsx?|txt|webp)$/i.test(file.originalname);
            if (!ok)
                return cb(new common_1.BadRequestException('Fayl turi qabul qilinmaydi'), false);
            cb(null, true);
        },
    })),
    __param(0, (0, common_1.UploadedFile)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], DocumentsController.prototype, "upload", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], DocumentsController.prototype, "delete", null);
exports.DocumentsController = DocumentsController = __decorate([
    (0, common_1.Controller)('documents'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [DocumentsService])
], DocumentsController);
let DocumentsModule = class DocumentsModule {
};
exports.DocumentsModule = DocumentsModule;
exports.DocumentsModule = DocumentsModule = __decorate([
    (0, common_1.Module)({
        controllers: [DocumentsController],
        providers: [DocumentsService],
    })
], DocumentsModule);
//# sourceMappingURL=documents.module.js.map