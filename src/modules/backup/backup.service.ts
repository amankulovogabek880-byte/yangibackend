import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import axios from 'axios';

const execAsync = promisify(exec);

/**
 * Backup Service
 *
 * Har 6 soatda PostgreSQL bazasini eksport qilib, S3-compatible storage'ga yuklaydi.
 *
 * .env'da kerakli:
 * - DATABASE_URL (parsing uchun)
 * - S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY
 * - BACKUP_ENABLED="true"
 *
 * Backup nomi: tourcrm-backup-YYYY-MM-DD-HH-mm.sql.gz
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger('Backup');
  private enabled = false;
  private bucket = '';
  private endpoint = '';
  private accessKey = '';
  private secretKey = '';
  private region = '';

  constructor() {
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
      } else {
        this.logger.log(`✅ Backup tayyor (bucket: ${this.bucket})`);
      }
    } else {
      this.logger.log('Backup yoqilmagan (.env: BACKUP_ENABLED=false)');
    }
  }

  @Cron(process.env.BACKUP_CRON || '0 */6 * * *')
  async scheduled() {
    if (!this.enabled) return;
    try {
      await this.runBackup();
    } catch (e: any) {
      this.logger.error(`Avtomatik backup xatosi: ${e.message}`);
    }
  }

  async runBackup(): Promise<{ ok: boolean; file?: string; size?: number; error?: string }> {
    if (!this.enabled) return { ok: false, error: 'Backup yoqilmagan' };

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return { ok: false, error: 'DATABASE_URL yo\'q' };

    const tempDir = process.env.TEMP || '/tmp';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `tourcrm-backup-${timestamp}.sql.gz`;
    const localPath = path.join(tempDir, filename);

    try {
      this.logger.log(`Backup boshlandi: ${filename}`);

      // PostgreSQL dump (gz bilan)
      // pg_dump avtomatik DATABASE_URL'dan ma'lumotlarni o'qiydi
      await execAsync(`pg_dump "${dbUrl}" | gzip > "${localPath}"`);

      const stat = fs.statSync(localPath);
      this.logger.log(`Dump tayyor: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

      // S3'ga yuklash
      await this.uploadToS3(localPath, filename);

      // Temp faylni o'chirish
      fs.unlinkSync(localPath);

      this.logger.log(`✅ Backup yuklandi: ${filename}`);
      return { ok: true, file: filename, size: stat.size };
    } catch (e: any) {
      this.logger.error(`Backup xatosi: ${e.message}`);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      return { ok: false, error: e.message };
    }
  }

  /**
   * S3-compatible upload (AWS Signature V4)
   */
  private async uploadToS3(filePath: string, key: string) {
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

    await axios.put(url, fileContent, {
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

  /** Qo'lda backup ishga tushirish */
  async triggerManual() {
    return this.runBackup();
  }
}
