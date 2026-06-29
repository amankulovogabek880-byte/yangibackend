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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PhoneProvidersModule = exports.PhoneProviderFactory = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const stub_provider_1 = require("./stub.provider");
const tel_link_provider_1 = require("./tel-link.provider");
const onlinepbx_provider_1 = require("./onlinepbx.provider");
const twilio_provider_1 = require("./twilio.provider");
const custom_sip_provider_1 = require("./custom-sip.provider");
__exportStar(require("./provider.interface"), exports);
let PhoneProviderFactory = class PhoneProviderFactory {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger('PhoneProviderFactory');
    }
    async getProvider(tenantId) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { phoneProvider: true, phoneConfig: true },
        });
        if (!tenant)
            return new stub_provider_1.StubProvider();
        const config = tenant.phoneConfig || {};
        switch (tenant.phoneProvider) {
            case 'ONLINEPBX':
                return new onlinepbx_provider_1.OnlinePbxProvider(config.onlinepbx);
            case 'TWILIO':
                return new twilio_provider_1.TwilioProvider(config.twilio);
            case 'TEL_LINK':
                return new tel_link_provider_1.TelLinkProvider();
            case 'CUSTOM_SIP':
                return new custom_sip_provider_1.CustomSipProvider(config.customSip);
            case 'MYATI':
                this.logger.warn("MyAti hozircha qo'llab-quvvatlanmaydi, STUB ishlaydi");
                return new stub_provider_1.StubProvider();
            case 'STUB':
            default:
                return new stub_provider_1.StubProvider();
        }
    }
    identifyProvider(body) {
        if (body?.CallSid)
            return 'TWILIO';
        if (body?.uuid || body?.call_id)
            return 'ONLINEPBX';
        if (body?.uniqueid || body?.disposition)
            return 'CUSTOM_SIP';
        return null;
    }
};
exports.PhoneProviderFactory = PhoneProviderFactory;
exports.PhoneProviderFactory = PhoneProviderFactory = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], PhoneProviderFactory);
let PhoneProvidersModule = class PhoneProvidersModule {
};
exports.PhoneProvidersModule = PhoneProvidersModule;
exports.PhoneProvidersModule = PhoneProvidersModule = __decorate([
    (0, common_1.Module)({
        providers: [PhoneProviderFactory],
        exports: [PhoneProviderFactory],
    })
], PhoneProvidersModule);
//# sourceMappingURL=phone-providers.module.js.map