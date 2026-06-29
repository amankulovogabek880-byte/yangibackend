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
const crypto = __importStar(require("crypto"));
describe('Password Reset Token', () => {
    function generateResetToken() {
        const raw = crypto.randomBytes(32).toString('hex');
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        return { raw, hash };
    }
    function hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }
    it('token 64 hex belgi', () => {
        const { raw } = generateResetToken();
        expect(raw).toHaveLength(64);
        expect(raw).toMatch(/^[a-f0-9]+$/);
    });
    it('hash SHA-256 format', () => {
        const { hash } = generateResetToken();
        expect(hash).toHaveLength(64);
    });
    it('raw va hash har xil', () => {
        const { raw, hash } = generateResetToken();
        expect(raw).not.toBe(hash);
    });
    it('bir xil raw - bir xil hash', () => {
        const raw = 'test-token-12345';
        const h1 = hashToken(raw);
        const h2 = hashToken(raw);
        expect(h1).toBe(h2);
    });
    it('har xil raw - har xil hash', () => {
        const { raw: r1, hash: h1 } = generateResetToken();
        const { raw: r2, hash: h2 } = generateResetToken();
        expect(r1).not.toBe(r2);
        expect(h1).not.toBe(h2);
    });
    it('token muddati tekshirish', () => {
        const now = new Date();
        const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
        const expired = new Date(now.getTime() - 1000);
        expect(oneHourLater > now).toBe(true);
        expect(expired > now).toBe(false);
    });
    it('muddati o\'tgan token rad etiladi', () => {
        const expiredAt = new Date(Date.now() - 1000);
        const isExpired = expiredAt < new Date();
        expect(isExpired).toBe(true);
    });
    it('amal qiluvchi token qabul qilinadi', () => {
        const validUntil = new Date(Date.now() + 3600000);
        const isValid = validUntil > new Date();
        expect(isValid).toBe(true);
    });
});
describe('Password Strength', () => {
    function validatePassword(password, minLen = 8) {
        if (!password || password.length < minLen)
            return `Parol kamida ${minLen} belgi`;
        return null;
    }
    it('8 belgi qabul qilinadi', () => {
        expect(validatePassword('12345678')).toBeNull();
    });
    it('7 belgi rad etiladi', () => {
        expect(validatePassword('1234567')).not.toBeNull();
    });
    it('bo\'sh parol rad etiladi', () => {
        expect(validatePassword('')).not.toBeNull();
    });
    it('uzun parol qabul qilinadi', () => {
        expect(validatePassword('A'.repeat(100))).toBeNull();
    });
});
//# sourceMappingURL=password-reset.spec.js.map