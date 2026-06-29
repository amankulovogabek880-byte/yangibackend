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
exports.PassengersModule = exports.PassengersController = exports.PassengersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const decorators_1 = require("../../common/decorators");
let PassengersService = class PassengersService {
    constructor(_prisma) {
        this._prisma = _prisma;
    }
    get prisma() { return this._prisma; }
    async verifyBookingAccess(tenantId, bookingId, userId, role) {
        const where = { id: bookingId, tenantId };
        if (role === 'AGENT')
            where.agentId = userId;
        const booking = await this.prisma.booking.findFirst({ where });
        if (!booking)
            throw new common_1.NotFoundException('Booking topilmadi');
        return booking;
    }
    async list(tenantId, bookingId, userId, role) {
        await this.verifyBookingAccess(tenantId, bookingId, userId, role);
        return this.prisma.passenger.findMany({
            where: { bookingId, tenantId },
            orderBy: [{ passengerType: 'asc' }, { createdAt: 'asc' }],
        });
    }
    async create(tenantId, bookingId, userId, role, data) {
        await this.verifyBookingAccess(tenantId, bookingId, userId, role);
        if (!data.fullName?.trim()) {
            throw new common_1.BadRequestException("To'liq ism kerak");
        }
        return this.prisma.passenger.create({
            data: {
                tenantId,
                bookingId,
                fullName: data.fullName.trim(),
                dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
                gender: data.gender,
                passengerType: data.passengerType || 'ADULT',
                passportNo: data.passportNo,
                passportCountry: data.passportCountry,
                passportExpiry: data.passportExpiry ? new Date(data.passportExpiry) : null,
                nationality: data.nationality,
                phone: data.phone,
                email: data.email,
                mealPreference: data.mealPreference,
                seatPreference: data.seatPreference,
                specialRequest: data.specialRequest,
                pricePerPerson: data.pricePerPerson,
            },
        });
    }
    async update(tenantId, passengerId, userId, role, data) {
        const passenger = await this.prisma.passenger.findFirst({
            where: { id: passengerId, tenantId },
        });
        if (!passenger)
            throw new common_1.NotFoundException('Yo\'lovchi topilmadi');
        await this.verifyBookingAccess(tenantId, passenger.bookingId, userId, role);
        const safe = {};
        if (typeof data.fullName === 'string')
            safe.fullName = data.fullName.trim();
        if (data.dateOfBirth !== undefined)
            safe.dateOfBirth = data.dateOfBirth ? new Date(data.dateOfBirth) : null;
        if (typeof data.gender === 'string')
            safe.gender = data.gender;
        if (typeof data.passengerType === 'string')
            safe.passengerType = data.passengerType;
        if (typeof data.passportNo === 'string')
            safe.passportNo = data.passportNo;
        if (typeof data.passportCountry === 'string')
            safe.passportCountry = data.passportCountry;
        if (data.passportExpiry !== undefined)
            safe.passportExpiry = data.passportExpiry ? new Date(data.passportExpiry) : null;
        if (typeof data.nationality === 'string')
            safe.nationality = data.nationality;
        if (typeof data.phone === 'string')
            safe.phone = data.phone;
        if (typeof data.email === 'string')
            safe.email = data.email;
        if (typeof data.mealPreference === 'string')
            safe.mealPreference = data.mealPreference;
        if (typeof data.seatPreference === 'string')
            safe.seatPreference = data.seatPreference;
        if (typeof data.specialRequest === 'string')
            safe.specialRequest = data.specialRequest;
        if (typeof data.pricePerPerson === 'number')
            safe.pricePerPerson = data.pricePerPerson;
        return this.prisma.passenger.update({
            where: { id: passengerId },
            data: safe,
        });
    }
    async delete(tenantId, passengerId, userId, role) {
        const passenger = await this.prisma.passenger.findFirst({
            where: { id: passengerId, tenantId },
        });
        if (!passenger)
            throw new common_1.NotFoundException();
        await this.verifyBookingAccess(tenantId, passenger.bookingId, userId, role);
        await this.prisma.passenger.delete({ where: { id: passengerId } });
        return { ok: true };
    }
    async stats(tenantId, bookingId, userId, role) {
        await this.verifyBookingAccess(tenantId, bookingId, userId, role);
        const passengers = await this.prisma.passenger.findMany({
            where: { bookingId, tenantId },
            select: { passengerType: true, pricePerPerson: true },
        });
        return {
            total: passengers.length,
            adults: passengers.filter((p) => p.passengerType === 'ADULT').length,
            children: passengers.filter((p) => p.passengerType === 'CHILD').length,
            infants: passengers.filter((p) => p.passengerType === 'INFANT').length,
            seniors: passengers.filter((p) => p.passengerType === 'SENIOR').length,
            totalIndividualPrices: passengers.reduce((s, p) => s + (p.pricePerPerson || 0), 0),
        };
    }
};
exports.PassengersService = PassengersService;
exports.PassengersService = PassengersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], PassengersService);
let PassengersController = class PassengersController {
    constructor(svc) {
        this.svc = svc;
    }
    list(bookingId, u) {
        return this.svc.list(u.tenantId, bookingId, u.sub, u.role);
    }
    stats(bookingId, u) {
        return this.svc.stats(u.tenantId, bookingId, u.sub, u.role);
    }
    create(bookingId, body, u) {
        return this.svc.create(u.tenantId, bookingId, u.sub, u.role, body);
    }
    update(id, body, u) {
        return this.svc.update(u.tenantId, id, u.sub, u.role, body);
    }
    delete(id, u) {
        return this.svc.delete(u.tenantId, id, u.sub, u.role);
    }
};
exports.PassengersController = PassengersController;
__decorate([
    (0, common_1.Get)('booking/:bookingId'),
    __param(0, (0, common_1.Param)('bookingId')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PassengersController.prototype, "list", null);
__decorate([
    (0, common_1.Get)('booking/:bookingId/stats'),
    __param(0, (0, common_1.Param)('bookingId')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PassengersController.prototype, "stats", null);
__decorate([
    (0, common_1.Post)('booking/:bookingId'),
    __param(0, (0, common_1.Param)('bookingId')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], PassengersController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], PassengersController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PassengersController.prototype, "delete", null);
exports.PassengersController = PassengersController = __decorate([
    (0, common_1.Controller)('passengers'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [PassengersService])
], PassengersController);
let PassengersModule = class PassengersModule {
};
exports.PassengersModule = PassengersModule;
exports.PassengersModule = PassengersModule = __decorate([
    (0, common_1.Module)({
        controllers: [PassengersController],
        providers: [PassengersService],
        exports: [PassengersService],
    })
], PassengersModule);
//# sourceMappingURL=passengers.module.js.map