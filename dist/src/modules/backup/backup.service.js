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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackupService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const axios_1 = __importDefault(require("axios"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
let BackupService = class BackupService {
    constructor() {
        this.logger = new common_1.Logger('Backup');
        this.enabled = false;
        this.bucket = '';
        this.endpoint = '';
        this.accessKey = '';
        this.secretKey = '';
        this.region = '';
        this.enabled = process.env.BACKUP_ENABLED === 'true';
        this.bucket = process.env.S3_BUCKET || '';
        this.endpoint = process.env.S3_ENDPOINT || '';
        this.accessKey = process.env.S3_ACCESS_KEY || '';
        this.secretKey = process.env.S3_SECRET_KEY || '';
        this.region = process.env.S3_REGION || 'us-east-1';
        if (this.enabled) {
            if (!this.bucket || !this.accessKey || !this.secretKey) {
                this.logger.warn('⚠️  Backup yoqilgan, lekin S3 sozlamalari to\'liq emas');
                this.enabled = false;
            }
            else {
                this.logger.log(`✅ Backup tayyor (bucket: ${this.bucket})`);
            }
        }
        else {
            this.logger.log('Backup yoqilmagan (.env: BACKUP_ENABLED=false)');
        }
    }
    async scheduled() {
        if (!this.enabled)
            return;
        try {
            await this.runBackup();
        }
        catch (e) {
            this.logger.error(`Avtomatik backup xatosi: ${e.message}`);
        }
    }
    async runBackup() {
        if (!this.enabled)
            return { ok: false, error: 'Backup yoqilmagan' };
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl)
            return { ok: false, error: 'DATABASE_URL yo\'q' };
        const tempDir = process.env.TEMP || '/tmp';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `tourcrm-backup-${timestamp}.sql.gz`;
        const localPath = path.join(tempDir, filename);
        try {
            this.logger.log(`Backup boshlandi: ${filename}`);
            await execAsync(`pg_dump "${dbUrl}" | gzip > "${localPath}"`);
            const stat = fs.statSync(localPath);
            this.logger.log(`Dump tayyor: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
            await this.uploadToS3(localPath, filename);
            fs.unlinkSync(localPath);
            this.logger.log(`✅ Backup yuklandi: ${filename}`);
            return { ok: true, file: filename, size: stat.size };
        }
        catch (e) {
            this.logger.error(`Backup xatosi: ${e.message}`);
            if (fs.existsSync(localPath))
                fs.unlinkSync(localPath);
            return { ok: false, error: e.message };
        }
    }
    async uploadToS3(filePath, key) {
        const fileContent = fs.readFileSync(filePath);
        const url = `${this.endpoint}/${this.bucket}/${key}`;
        const date = new Date();
        const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);
        const host = new URL(this.endpoint).host;
        const payloadHash = crypto.createHash('sha256').update(fileContent).digest('hex');
        const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
        const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
        const canonicalRequest = [
            'PUT',
            `/${this.bucket}/${key}`,
            '',
            canonicalHeaders,
            signedHeaders,
            payloadHash,
        ].join('\n');
        const algorithm = 'AWS4-HMAC-SHA256';
        const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
        const stringToSign = [
            algorithm,
            amzDate,
            credentialScope,
            crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
        ].join('\n');
        const kDate = crypto.createHmac('sha256', `AWS4${this.secretKey}`).update(dateStamp).digest();
        const kRegion = crypto.createHmac('sha256', kDate).update(this.region).digest();
        const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
        const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
        const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
        const authHeader = `${algorithm} Credential=${this.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
        await axios_1.default.put(url, fileContent, {
            headers: {
                Authorization: authHeader,
                'x-amz-content-sha256': payloadHash,
                'x-amz-date': amzDate,
                'Content-Type': 'application/gzip',
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });
    }
    async triggerManual() {
        return this.runBackup();
    }
};
exports.BackupService = BackupService;
__decorate([
    (0, schedule_1.Cron)(process.env.BACKUP_CRON || '0 */6 * * *'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], BackupService.prototype, "scheduled", null);
exports.BackupService = BackupService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], BackupService);
//# sourceMappingURL=backup.service.js.map