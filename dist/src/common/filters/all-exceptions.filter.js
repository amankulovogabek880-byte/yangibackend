"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AllExceptionsFilter = void 0;
const common_1 = require("@nestjs/common");
const library_1 = require("@prisma/client/runtime/library");
let AllExceptionsFilter = class AllExceptionsFilter {
    constructor() {
        this.logger = new common_1.Logger('Exception');
    }
    catch(exception, host) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse();
        const request = ctx.getRequest();
        let status = common_1.HttpStatus.INTERNAL_SERVER_ERROR;
        let message = 'Ichki server xatosi';
        let errorCode;
        if (exception instanceof common_1.HttpException) {
            status = exception.getStatus();
            const r = exception.getResponse();
            message = typeof r === 'string' ? r : r.message || r.error || message;
        }
        else if (exception instanceof library_1.PrismaClientKnownRequestError) {
            if (exception.code === 'P2002') {
                status = common_1.HttpStatus.CONFLICT;
                const field = exception.meta?.target?.[0] || 'qiymat';
                message = `Bu ${field} allaqachon mavjud`;
                errorCode = 'DUPLICATE';
            }
            else if (exception.code === 'P2025') {
                status = common_1.HttpStatus.NOT_FOUND;
                message = 'Topilmadi';
                errorCode = 'NOT_FOUND';
            }
            else if (exception.code === 'P2003') {
                status = common_1.HttpStatus.BAD_REQUEST;
                message = "Bog'liq ma'lumot topilmadi";
                errorCode = 'FK_VIOLATION';
            }
            else {
                status = common_1.HttpStatus.BAD_REQUEST;
                message = exception.message;
                errorCode = exception.code;
            }
        }
        else if (exception instanceof library_1.PrismaClientValidationError) {
            status = common_1.HttpStatus.BAD_REQUEST;
            message = "Ma'lumot formati noto'g'ri";
        }
        else if (exception instanceof Error) {
            message = exception.message;
        }
        if (status >= 500) {
            this.logger.error(`${request.method} ${request.url} → ${status}`, exception.stack);
        }
        response.status(status).json({
            statusCode: status,
            message,
            errorCode,
            timestamp: new Date().toISOString(),
            path: request.url,
        });
    }
};
exports.AllExceptionsFilter = AllExceptionsFilter;
exports.AllExceptionsFilter = AllExceptionsFilter = __decorate([
    (0, common_1.Catch)()
], AllExceptionsFilter);
//# sourceMappingURL=all-exceptions.filter.js.map