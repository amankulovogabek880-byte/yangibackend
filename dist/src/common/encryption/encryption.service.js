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
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncryptionService = void 0;
const common_1 = require("@nestjs/common");
const crypto = __importStar(require("crypto"));
let EncryptionService = class EncryptionService {
    constructor() {
        this.logger = new common_1.Logger('Encryption');
        this.algorithm = 'aes-256-gcm';
    }
    onModuleInit() {
        const keyHex = process.env.ENCRYPTION_KEY;
        if (!keyHex) {
            throw new Error('ENCRYPTION_KEY .env faylda mavjud emas! Generatsiya: openssl rand -hex 32');
        }
        if (keyHex.length !== 64) {
            throw new Error(`ENCRYPTION_KEY 64 belgi bo'lishi kerak (32 bayt hex). Hozir: ${keyHex.length}`);
        }
        this.key = Buffer.from(keyHex, 'hex');
        this.logger.log('✅ Encryption service tayyor (AES-256-GCM)');
    }
    encrypt(plaintext) {
        if (!plaintext)
            return null;
        try {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
            const encrypted = Buffer.concat([
                cipher.update(plaintext, 'utf8'),
                cipher.final(),
            ]);
            const authTag = cipher.getAuthTag();
            return [
                iv.toString('base64'),
                authTag.toString('base64'),
                encrypted.toString('base64'),
            ].join(':');
        }
        catch (e) {
            this.logger.error(`Encrypt xatosi: ${e.message}`);
            return null;
        }
    }
    decrypt(ciphertext) {
        if (!ciphertext)
            return null;
        try {
            const parts = ciphertext.split(':');
            if (parts.length !== 3)
                return ciphertext;
            const [ivB64, authTagB64, encryptedB64] = parts;
            const iv = Buffer.from(ivB64, 'base64');
            const authTag = Buffer.from(authTagB64, 'base64');
            const encrypted = Buffer.from(encryptedB64, 'base64');
            const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
            decipher.setAuthTag(authTag);
            const decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final(),
            ]);
            return decrypted.toString('utf8');
        }
        catch (e) {
            this.logger.warn(`Decrypt xatosi (eski format bo'lishi mumkin): ${e.message}`);
            return null;
        }
    }
    mask(value, visibleStart = 2, visibleEnd = 3) {
        if (!value)
            return '';
        if (value.length <= visibleStart + visibleEnd)
            return '•'.repeat(value.length);
        return (value.slice(0, visibleStart) +
            '•'.repeat(Math.max(3, value.length - visibleStart - visibleEnd)) +
            value.slice(-visibleEnd));
    }
    maskPhone(phone) {
        if (!phone)
            return '';
        const cleaned = phone.replace(/[^\d+]/g, '');
        if (cleaned.length < 7)
            return cleaned;
        return cleaned.slice(0, -5) + '***' + cleaned.slice(-2);
    }
    hash(value) {
        return crypto.createHash('sha256').update(value).digest('hex');
    }
};
exports.EncryptionService = EncryptionService;
exports.EncryptionService = EncryptionService = __decorate([
    (0, common_1.Injectable)()
], EncryptionService);
//# sourceMappingURL=encryption.service.js.map